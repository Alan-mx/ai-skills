#!/usr/bin/env node
'use strict';
// PreToolUse guard. Minimal permissions.deny handles prefix-stable catastrophic actions;
// this hook handles the fuzzy/combinatorial ones.
//
// Blocked:
//   - mvn/mvnw deploy (any invocation path: mvn / mvn.cmd / mvn.exe / mvnw / full path / JAVA_HOME=x mvn)
//   - SQL file execution: mysql < file or `source` (mysql/mysqlsh/mysqladmin as command; output > allowed)
//   - pipe input into mysql/mysqlsh/mysqladmin (cat x | mysql)
//   - DB writes via SQL CLI (CREATE/ALTER/DROP/TRUNCATE/RENAME/INSERT/UPDATE/DELETE/REPLACE INTO/
//     MERGE/GRANT...TO/REVOKE/CALL/LOAD/INTO OUTFILE/SET PASSWORD) -- DB strictly read-only
//   - curl/wget piped to a shell (curl URL | bash/sh) -- remote script execution
//   - npm install -g / npm i -g / --global -- global package install
//   - docker push
//   - secret handling: read-class (cat/head/grep/...) AND carry-class (cp/mv/scp/rsync/install/tar/zip/7z)
//     commands touching secret paths (.env, ~/.ssh/, id_rsa, *.pem, application-prod.*, ...).
//     Token-based + end-anchored matching: search patterns like grep "\.env" no longer false-positive.
//   - Rule A (cwd write-protect): write/del/move/touch/redirect target outside cwd AND not a temp dir
//     (/tmp, /temp, $TMPDIR) -> block (read-only outside cwd). Reads anywhere allowed.
//     Device sinks (/dev/null, NUL, /dev/stderr, ...) are whitelisted -- discarding output isn't a write.
//   - Rule B (recycle-bin delete): rm/del of a cwd-in (or temp) NON-rebuildable file -> block + guide to
//     PowerShell SendToRecycleBin. Rebuildable (target/, node_modules/, dist/, *.log, *.tmp, *.class, /tmp/*)
//     passes so dev workflows aren't disturbed.
//
// Reads PreToolUse payload from stdin; on match emits {"decision":"block","reason":"..."}.
// Fails open on any unexpected error so a guard bug never bricks Bash.

const fs = require('fs');

function readStdin() { try { return fs.readFileSync(0, 'utf8'); } catch (e) { return ''; } }

// Is the command's first token (after leading VAR=value assignments, path/quotes stripped)
// one of `names` (optionally .cmd/.exe)? Confirms the tool is the actual command, not an arg.
function commandIs(norm, names) {
  let s = norm.trim();
  const envRe = /^[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|[^\s]*)\s+/;
  while (envRe.test(s)) s = s.replace(envRe, '');
  const m = s.match(/^("[^"]*"|'[^']*'|[^\s]+)/);
  if (!m) return false;
  const tok = m[1].replace(/^["']|["']$/g, '');
  const base = tok.split(/[\/\\]/).pop();
  return names.some(n => new RegExp('^' + n + '(\\.cmd|\\.exe)?$', 'i').test(base));
}

// Tokenize a command segment into args (quotes stripped). Used by both the secret
// check (token-level, not whole-string) and Rule A/B target parsing.
function tokenizeArgs(seg) {
  const toks = []; const re = /"([^"]*)"|'([^']*)'|(\S+)/g; let m;
  while ((m = re.exec(seg)) !== null) toks.push(m[1] !== undefined ? m[1] : (m[2] !== undefined ? m[2] : m[3]));
  return toks;
}

try {
  const raw = readStdin();
  if (!raw) process.exit(0);
  let payload;
  try { payload = JSON.parse(raw); } catch (e) { process.exit(0); }
  if (!payload || payload.tool_name !== 'Bash') process.exit(0);
  const command = (payload.tool_input && payload.tool_input.command) || '';
  if (!command) process.exit(0);

  const norm = command.replace(/\s+/g, ' ');
  // Quote-stripped copy: for redirect/pipe checks so < > | inside SQL/strings aren't matched.
  const stripped = norm.replace(/"[^"]*"/g, '').replace(/'[^']*'/g, '');

  function block(reason) {
    process.stdout.write(JSON.stringify({ decision: 'block', reason }));
    process.exit(0);
  }

  // --- mvn/mvnw deploy (any path) ---
  if (commandIs(norm, ['mvn', 'mvnw']) && /(^|\s)deploy(\s|$)/i.test(norm)) {
    block('检测到 mvn deploy：发布到远程 Maven 仓库属于受控操作，已被安全钩子拦截。如需发布请手动执行。');
  }

  // --- SQL file execution: < or source (output > allowed) ---
  if (commandIs(norm, ['mysql', 'mysqlsh', 'mysqladmin'])) {
    const seg = stripped.split(/[;|&]/)[0];
    if (/(<|\bsource\s+)/i.test(seg)) {
      block('检测到 SQL 文件执行（mysql < file 或 source）：数据库为只读，已被安全钩子拦截。如需执行请手动运行。');
    }
  }

  // --- pipe input into mysql/mysqlsh/mysqladmin ---
  if (/\|\s*(mysqladmin|mysqlsh|mysql)\b/i.test(stripped)) {
    block('检测到管道输入到 mysql（cat x | mysql）：数据库为只读，已被安全钩子拦截。如需执行请手动运行。');
  }

  // --- DB writes via SQL CLI (read-only) ---
  if (commandIs(norm, ['mysql', 'mysqlsh', 'mysqladmin', 'psql', 'sqlplus', 'sqlite3', 'sqlcmd'])) {
    const n = norm.replace(/SHOW\s+CREATE\b/gi, 'SHOW_XCREATE');
    const dbPatterns = [
      [/\bCREATE\b(?=\s)/i,    'CREATE'],
      [/\bALTER\b(?=\s)/i,     'ALTER'],
      [/\bDROP\b(?=\s)/i,      'DROP'],
      [/\bTRUNCATE\b(?!\.\w)/i, 'TRUNCATE'],
      [/\bRENAME\b(?=\s)/i,    'RENAME'],
      [/\bINSERT\b(?=\s)/i,    'INSERT'],
      [/\bUPDATE\b(?=\s)/i,    'UPDATE'],
      [/\bDELETE\b(?=\s)/i,    'DELETE'],
      [/\bREPLACE\s+INTO\b/i,  'REPLACE INTO'],
      [/\bMERGE\b(?=\s)/i,     'MERGE'],
      [/\bGRANT\b.*\bTO\b/i,   'GRANT PRIVILEGE'],
      [/\bREVOKE\b(?=\s)/i,    'REVOKE'],
      [/\bCALL\b(?=\s)/i,      'CALL'],
      [/\bLOAD\b(?=\s)/i,      'LOAD'],
      [/\bINTO\s+(OUTFILE|DUMPFILE)\b/i, 'INTO OUTFILE/DUMPFILE'],
      [/\bSET\s+PASSWORD\b/i,  'SET PASSWORD'],
    ];
    for (const [re, kw] of dbPatterns) {
      if (re.test(n)) block(`检测到 ${kw}：数据库为只读，该写操作已被安全钩子拦截。如需执行请手动运行。`);
    }
  }

  // --- curl/wget piped to a shell (remote script execution) ---
  if (commandIs(norm, ['curl', 'wget']) && /\|\s*(sudo\s+)?(bash|sh|zsh|dash|ksh|fish)(\s|$)/i.test(stripped)) {
    block('检测到 curl/wget | shell：远程脚本直接执行属于高危操作，已被安全钩子拦截。如需安装请手动执行并先核对脚本。');
  }

  // --- npm install -g / npm i -g / --global ---
  if (commandIs(norm, ['npm']) && /\b(install|i|add)\b/i.test(norm) && /(^|\s)(-g|--global)(\s|$)/i.test(norm)) {
    block('检测到 npm 全局安装（npm install -g）：可能安装恶意 CLI，已被安全钩子拦截。如需安装请手动执行并先核对包。');
  }

  // --- docker push ---
  if (commandIs(norm, ['docker']) && /(^|\s)push(\s|$)/i.test(norm)) {
    block('检测到 docker push：推送镜像属于受控操作，已被安全钩子拦截。如需推送请手动执行。');
  }

  // --- secret handling: read-class commands touching a sensitive path, plus carry-class
  //     (cp/mv/scp/rsync/install/tar/zip/7z) exfiltrating one. Token-based matching:
  //     only args are tested, so a search PATTERN like grep "\.env" doesn't false-positive.
  const readCmds = ['cat','head','tail','less','more','tac','nl','xxd','od','hexdump','strings','base64','bat','grep','egrep','fgrep','rg','awk','sed','cut','wc','file','sort','uniq','dd'];
  const carryCmds = ['cp','copy','mv','move','scp','rsync','install','tar','zip','7z'];
  if (commandIs(norm, readCmds) || commandIs(norm, carryCmds)) {
    const secretToken = /(^|\/)\.env(\.|$)|~\/\.ssh\/|(^|\/)\.ssh(\/|$)|\bid_rsa\b|\bid_ed25519\b|\bid_ecdsa\b|\bid_dsa\b|application-prod\.|\.pem$|\.key$|\.p12$|\.keystore$|\.aws\/credentials$|\.kube\/config$|(^|\/)\.npmrc$|(^|\/)\.netrc$|(^|\/)\.pypirc$/i;
    let toks = tokenizeArgs(norm);
    while (toks.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(toks[0])) toks.shift();
    if (toks.slice(1).some(t => secretToken.test(t))) {
      block('检测到读取/搬运敏感文件（密钥/凭据/生产配置）：已被安全钩子拦截。如需操作请手动执行。');
    }
  }

  // --- Rule A: cwd write-protection (outside cwd = read-only; temp dirs allowed) ---
  // --- Rule B: recycle-bin delete guidance (cwd-in delete of non-rebuildable -> block) ---
  // 写/删/移/改类命令的目标路径解析：cwd 外且非临时区直接 block(只读)；cwd 内删除非可重建产物 block 并引导送回收站。
  // 路径规范化处理 ~、C:\、/c/、相对(基于 cwd)；用 norm(保留引号) 分段解析，解析失败 fail-open 放行。
  const cwd = payload.cwd || process.cwd();
  if (cwd) {
    const home = (payload.env && (payload.env.HOME || payload.env.USERPROFILE)) || process.env.HOME || process.env.USERPROFILE || '';
    const tmpdirEnv = (payload.env && (payload.env.TMPDIR || payload.env.TMP || payload.env.TEMP)) || process.env.TMPDIR || process.env.TMP || process.env.TEMP || '';

    function resolvePath(arg) {
      if (!arg) return null;
      let p = String(arg).replace(/\\/g, '/').replace(/\/+/g, '/').replace(/\/$/, '');
      if (p === '~') p = home.replace(/\\/g, '/');
      else if (p.startsWith('~/')) p = home.replace(/\\/g, '/') + p.slice(1);
      let dm = p.match(/^\/([a-zA-Z])\//);
      if (dm) p = dm[1].toUpperCase() + ':/' + p.slice(3);
      if (/^[a-zA-Z]:\//.test(p)) return p.toLowerCase();
      if (p.startsWith('/')) return p.toLowerCase();           // unix-style abs (e.g. /tmp)
      let base = cwd.replace(/\\/g, '/');
      let bdm = base.match(/^\/([a-zA-Z])\//);
      if (bdm) base = bdm[1].toUpperCase() + ':/' + base.slice(3);
      base = base.replace(/\/+$/, '');
      if (!base) return p.toLowerCase();
      return (base + '/' + p).toLowerCase();
    }
    function isTempDir(rp) {
      if (!rp) return false;
      if (/^\/(tmp|temp|var\/tmp)(\/|$)/.test(rp)) return true;
      if (/\/appdata\/local\/temp\//.test(rp)) return true;
      if (tmpdirEnv) { const t = resolvePath(tmpdirEnv); if (t && (rp === t || rp.startsWith(t + '/'))) return true; }
      return false;
    }
    function isRebuildable(rp) {
      if (!rp) return false;
      if (isTempDir(rp)) return true;
      if (/(^|\/)(target|node_modules|dist|build|out|coverage|\.tmp|\.cache)(\/|$)/.test(rp)) return true;
      if (/\.(log|tmp|bak|class|o|pyc|pyo|swp|swo|lock|orig|rej)$/.test(rp)) return true;
      return false;
    }
    const cwdResolved = resolvePath(cwd);
    function isInCwd(rp) { return !!rp && !!cwdResolved && (rp === cwdResolved || rp.startsWith(cwdResolved + '/')); }

    function targetsOf(seg) {
      let toks = tokenizeArgs(seg);
      while (toks.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(toks[0])) toks.shift();  // strip leading VAR=value
      if (!toks.length) return { cmd: null, kind: null, targets: [] };
      const cmd = toks[0].split(/[\/\\]/).pop().toLowerCase();
      const args = toks.slice(1);
      const nonOpt = args.filter(a => !a.startsWith('-'));
      const targets = []; let kind = null;
      const redirRe = />>?\s*("[^"]*"|'[^']*'|[^\s&|;<]+)/g; let rm;
      while ((rm = redirRe.exec(seg)) !== null) { targets.push(rm[1].replace(/^["']|["']$/g, '')); kind = 'write'; }
      switch (cmd) {
        case 'rm': case 'del': case 'rmdir': case 'unlink': case 'remove-item':
          kind = 'delete'; nonOpt.forEach(t => targets.push(t)); break;
        case 'cp': case 'copy': case 'mv': case 'move': case 'move-item': case 'install':
          kind = 'write'; if (nonOpt.length) targets.push(nonOpt[nonOpt.length - 1]); break;
        case 'mkdir': case 'md': case 'touch': case 'new-item': case 'tee':
          kind = 'write'; nonOpt.forEach(t => targets.push(t)); break;
        case 'sed': case 'perl':
          if (args.some(a => a === '-i' || a.startsWith('-i'))) { kind = 'write'; nonOpt.forEach(t => targets.push(t)); }
          break;
        case 'dd':
          args.forEach(a => { const mm = a.match(/^of=(.+)/); if (mm) { targets.push(mm[1].replace(/^["']|["']$/g, '')); kind = 'write'; } });
          break;
        default: break;
      }
      return { cmd, kind, targets };
    }

    const RECYCLE_HINT = `检测到删除操作(rm/del)。为可恢复，请改用送回收站方式删除：
  删文件: powershell -NoProfile -Command "Add-Type -AssemblyName Microsoft.VisualBasic; [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile('<路径>','OnlyErrorDialogs','SendToRecycleBin')"
  删目录: powershell -NoProfile -Command "Add-Type -AssemblyName Microsoft.VisualBasic; [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory('<路径>','OnlyErrorDialogs','SendToRecycleBin')"
或用 ! 前缀手动执行原命令(永久删除)。`;

    for (const segRaw of norm.split(/\s*(?:&&|\|\||;|\|)\s*/)) {
      const seg = segRaw.trim(); if (!seg) continue;
      const { cmd, kind, targets } = targetsOf(seg); if (!cmd) continue;
      for (const t of targets) {
        if (/^(\/dev\/(null|zero|full|random|urandom|tty|stdout|stderr)|nul|con)$/i.test(t)) continue; // device sink: discard output, not a file write
        const rp = resolvePath(t); if (!rp) continue;
        const inCwd = isInCwd(rp); const temp = isTempDir(rp);
        if (!inCwd && !temp) {
          block(`目标路径 "${t}" 在当前目录(${cwd})之外且非临时区，按规则仅允许读。如需操作请用 ! 前缀手动执行。`);
        }
        if (kind === 'delete' && (inCwd || temp) && !isRebuildable(rp)) {
          block(RECYCLE_HINT);
        }
      }
    }
  }
} catch (e) {
  // Fail open: never let a guard bug block everything.
}
process.exit(0);
