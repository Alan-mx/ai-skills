#!/usr/bin/env node
'use strict';
// Generic notification hook for AI coding agents (Claude Code / Codex / others).
// Single file, zero dependencies (node built-ins only).
//
// Events (register in the agent's hook config; names are matched case/separator-insensitively):
//   UserPromptSubmit -> 记录任务开始时间 + 清除 pending（用户回来了 => 取消排队中的兜底推送）
//   Stop             -> 任务完成通知（短于 minDurationSec 的任务不打扰）
//   Notification     -> 权限请求 / 等待输入等通知（同一会话 idle 重复触发会被抑制）
//   PreToolUse/PostToolUse/SessionStart -> 只当作"用户在动"的信号，清除 pending
//   SessionEnd       -> 清理本会话状态 + 扫掉过期状态文件
//
// 推送时机：每个渠道各配一个宽限期 delaySec——事件发生先记账，到点前用户只要提交一条消息
// （UserPromptSubmit）该渠道整条作废，到点还没回才真发。桌面/ntfy/Bark 默认 0 秒（立即触达），
// IM 渠道默认 10 秒（给「回到电脑前」的宽限）；调大即退化为离开电脑时的兜底，调 0 即立刻推。
//
// 钩子本体不碰网络：只写 pending 与任务描述，然后 spawn 一个分离子进程去发（--job=<file>），
// 子进程 unref 后与钩子生命周期无关，故 agent 侧零等待。
//
// 多客户端：标题里的客户端名按 --app= > 配置 appName > 环境变量推断（Claude Code / Codex）；
// 载荷字段按多套命名兼容读取，换 agent 换字段名不会静默失灵。
//
// CLI:
//   --job=<file>     内部分离子进程入口（勿手动调用）
//   --test           自检：给所有已启用渠道各发一条，打印返回码（忽略 delaySec，不走 pending）
//   --app=<name>     指定标题里的客户端名（注册时写进 command 最稳妥）
//   --config=<path>  指定配置文件（等价于环境变量 NOTIFY_CONFIG）
//
// 配置默认 ~/.claude/notify-config.json（含 webhook 凭据，永不入库；仓库只放 example 模板）。
// 任何异常一律 fail-open 退出，通知钩子绝不阻塞工具调用与会话。

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const http = require('http');
const https = require('https');
const { spawn, execFileSync } = require('child_process');

const HOME = os.homedir();
const DEFAULT_CONFIG_PATH = path.join(HOME, '.claude', 'notify-config.json');
const DEFAULT_STATE_DIR = path.join(HOME, '.claude', 'notify-state');
const REQUEST_TIMEOUT_MS = 8000;

const DEFAULT_CONFIG = {
  appName: '',                                    // 留空则按 --app / 环境变量 / 默认值推断
  stateDir: '',                                   // 留空则用 DEFAULT_STATE_DIR
  minDurationSec: 10,
  events: { Stop: true, Notification: true },
  notificationTypes: ['permission_prompt', 'idle_prompt'],
  idleSuppressMin: 5,
  cleanupDays: 7,
  channels: {
    desktop:  { enabled: true,  delaySec: 0 },
    ntfy:     { enabled: false, delaySec: 0,   url: 'https://ntfy.sh/your-random-topic' },
    bark:     { enabled: false, delaySec: 0,   url: 'https://api.day.app/your-device-key' },
    dingtalk: { enabled: false, delaySec: 10,  url: 'https://oapi.dingtalk.com/robot/send?access_token=xxx', secret: '' },
    feishu:   { enabled: false, delaySec: 10,  url: 'https://open.feishu.cn/open-apis/bot/v2/hook/xxx', secret: '' },
    wecom:    { enabled: false, delaySec: 10,  url: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=xxx' }
  }
};

// 已知通知类型的中文名；不认识的类型原样显示，不因此漏发
const NOTIFY_TYPE_LABEL = {
  permission_prompt: '权限请求',
  idle_prompt: '等待输入',
  auth_success: '认证成功',
  elicitation_dialog: 'MCP 输入'
};

function readStdin() { try { return fs.readFileSync(0, 'utf8'); } catch (e) { return ''; } }

function getDefaultConfig() { return JSON.parse(JSON.stringify(DEFAULT_CONFIG)); }

// 配置文件优先级：--config= > NOTIFY_CONFIG > ~/.claude/notify-config.json
function resolveConfigPath(argv, env) {
  const flag = (argv || []).find(a => a.startsWith('--config='));
  if (flag) return flag.slice('--config='.length);
  if (env && env.NOTIFY_CONFIG) return env.NOTIFY_CONFIG;
  return DEFAULT_CONFIG_PATH;
}

function loadConfig(configPath) {
  const cfg = getDefaultConfig();
  try {
    const user = JSON.parse(fs.readFileSync(configPath || DEFAULT_CONFIG_PATH, 'utf8'));
    Object.assign(cfg, user);
    cfg.channels = Object.assign({}, DEFAULT_CONFIG.channels, user.channels || {});
    cfg.events = Object.assign({}, DEFAULT_CONFIG.events, user.events || {});
  } catch (e) { /* 配置缺失/损坏 -> 用默认值 */ }
  return cfg;
}

function stateDirOf(cfg) { return (cfg && cfg.stateDir) || DEFAULT_STATE_DIR; }

// 标题里的客户端名：--app= > 配置 appName > 环境变量推断 > 'AI'
function resolveApp(cfg, argv, env) {
  const flag = (argv || []).find(a => a.startsWith('--app='));
  if (flag) return flag.slice('--app='.length).trim() || 'AI';
  if (cfg && cfg.appName) return String(cfg.appName);
  const e = env || {};
  if (e.CLAUDECODE || e.CLAUDE_PROJECT_DIR || e.CLAUDE_CODE_ENTRYPOINT) return 'Claude Code';
  if (e.CODEX_HOME || e.CODEX_SANDBOX || e.CODEX_THREAD_ID) return 'Codex';
  return 'AI';
}

// --- 载荷字段兼容读取（各 agent 命名不一：hook_event_name/event/type、session_id/thread_id ...） ---
function firstDefined(obj, keys) {
  for (const k of keys) {
    const v = obj ? obj[k] : undefined;
    if (v !== undefined && v !== null && v !== '') return v;
  }
  return undefined;
}
function normEvent(input) {
  const raw = firstDefined(input, ['hook_event_name', 'event_name', 'eventName', 'event', 'type']) || '';
  return String(raw).replace(/[^a-z0-9]/gi, '').toLowerCase();
}
function pickSessionId(input) {
  return String(firstDefined(input, ['session_id', 'sessionId', 'thread_id', 'threadId', 'conversation_id']) || 'nosession');
}
function pickCwd(input) {
  return String(firstDefined(input, ['cwd', 'project_path', 'projectPath', 'working_dir', 'workingDir', 'workdir']) || process.cwd());
}
function pickMessage(input) {
  return String(firstDefined(input, ['message', 'text', 'summary', 'prompt']) || '');
}
function pickStatus(input) {
  return String(firstDefined(input, ['status', 'stop_reason', 'stopReason', 'reason']) || '已完成');
}

function ensureDir(dir) { try { fs.mkdirSync(dir, { recursive: true }); } catch (e) {} }

function newGen() { return crypto.randomBytes(8).toString('hex'); }

// 人类可读耗时：44秒 / 1分35秒 / 1小时39分
function fmtDuration(sec) {
  const s = Math.max(0, Math.floor(sec));
  if (s < 60) return s + '秒';
  if (s < 3600) return Math.floor(s / 60) + '分' + (s % 60 ? (s % 60) + '秒' : '');
  const h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60);
  return h + '小时' + (m ? m + '分' : '');
}

// 结构化消息：内容一处定义、各渠道各自渲染——钉钉/企微走 markdown 才有加粗与引用条，
// 桌面通知/Bark/ntfy/飞书是纯文本，绝不能把 ** 和 > 直接印出来。
function fieldsOf(sid, status, durSec, cwd) {
  const f = [['会话 ID', String(sid).slice(0, 16)], ['状态', status]];
  if (durSec !== null && durSec !== undefined) f.push(['耗时', fmtDuration(durSec)]);   // 耗时未知则整行省略
  f.push(['项目', cwd]);
  return f;
}
// 图标按事件区分、量级轻于 emoji：完成 ✔ / 权限请求 ❗ / 等待输入 …；未知类型不加图标
const KIND_ICON = { done: '✔', permission_prompt: '❗', idle_prompt: '…' };
function withIcon(icon, text) { return icon ? `${icon} ${text}` : text; }

function buildStopMsg(app, sid, status, durSec, cwd) { return { title: withIcon(KIND_ICON.done, `任务完成 · ${app}`), fields: fieldsOf(sid, status, durSec, cwd) }; }
function buildNotifyMsg(label, app, sid, status, cwd, icon) { return { title: withIcon(icon, `${label} · ${app}`), fields: fieldsOf(sid, status, null, cwd) }; }

function renderBody(msg) { return msg.fields.map(([k, v]) => `${k}: ${v}`).join('\n'); }
function renderPlain(msg) { return `${msg.title}\n${renderBody(msg)}`; }
function renderMarkdown(msg) { return `**${msg.title}**\n\n` + msg.fields.map(([k, v]) => `> **${k}:** ${v}`).join('\n>\n'); }

// --- 状态文件 ---
function sessionFile(dir, sid) { return path.join(dir, `${sid}.json`); }
function pendingFile(dir, sid) { return path.join(dir, `${sid}.pending`); }
function readSession(dir, sid) { try { return JSON.parse(fs.readFileSync(sessionFile(dir, sid), 'utf8')); } catch (e) { return null; } }

// pending 存代次号：新事件换新代次，旧子进程看到代次不符即自行取消（同会话连续两次 Stop 不会重复推）
function writePending(dir, sid, gen) { try { fs.writeFileSync(pendingFile(dir, sid), gen); } catch (e) {} }
function clearPending(dir, sid) { try { fs.unlinkSync(pendingFile(dir, sid)); } catch (e) {} }
function isPendingAlive(file, gen) {
  try { return fs.readFileSync(file, 'utf8').trim() === gen; } catch (e) { return false; }
}

// --- 各渠道签名（纯函数，便于回归） ---
function signDingtalk(secret, ts) {
  return crypto.createHmac('sha256', secret).update(`${ts}\n${secret}`).digest('base64');
}
function dingtalkUrl(url, secret, ts) {
  if (!secret) return url;
  const sign = encodeURIComponent(signDingtalk(secret, ts));
  return `${url}${url.includes('?') ? '&' : '?'}timestamp=${ts}&sign=${sign}`;
}
// 飞书加签与其他家不同：待签内容为空串，密钥为 `${ts}\n${secret}`
function signFeishu(secret, ts) {
  return crypto.createHmac('sha256', `${ts}\n${secret}`).update('').digest('base64');
}

// --- HTTP：永不 reject，返回 {ok,status,body} / {ok:false,error}，便于自检打印返回码 ---
function request(url, body, contentType, timeoutMs) {
  return new Promise(resolve => {
    let u; try { u = new URL(url); } catch (e) { return resolve({ ok: false, error: 'bad url' }); }
    const lib = u.protocol === 'http:' ? http : https;
    const buf = Buffer.from(body, 'utf8');
    let req;
    try {
      req = lib.request({
        hostname: u.hostname, port: u.port || undefined, path: u.pathname + u.search, method: 'POST',
        headers: { 'Content-Type': contentType, 'Content-Length': buf.length }
      }, res => {
        let d = ''; res.setEncoding('utf8');
        res.on('data', c => d += c);
        res.on('end', () => resolve({ ok: true, status: res.statusCode, body: d.slice(0, 300) }));
      });
    } catch (e) { return resolve({ ok: false, error: e.message }); }
    req.on('error', e => resolve({ ok: false, error: e.message }));
    req.setTimeout(timeoutMs || REQUEST_TIMEOUT_MS, () => { req.destroy(); resolve({ ok: false, error: 'timeout' }); });
    req.write(buf); req.end();
  });
}
function postJson(url, obj) { return request(url, JSON.stringify(obj), 'application/json'); }
function postText(url, text) { return request(url, text, 'text/plain'); }

// --- 渠道发送 ---
function psQuote(s) { return "'" + String(s).replace(/'/g, "''") + "'"; }
function xmlEscape(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;'); }

// 桌面通知 XML：ToastGeneric 两段文本（标题 + 正文，正文换行原样保留）
function toastXml(title, msg) {
  return '<toast><visual><binding template="ToastGeneric">' +
    `<text>${xmlEscape(title)}</text><text>${xmlEscape(msg)}</text>` +
    '</binding></visual></toast>';
}

// 桌面通知走 WinRT toast（会留在 Windows 通知中心，事后能翻到）；失败退回托盘气泡。
// 注意：系统「通知」总开关关着（HKCU\...\PushNotifications\ToastEnabled=0）时，两种都看不见——
// 命令不报错但屏幕上没东西，所以配置里该渠道默认由使用方决定开关。
function sendDesktop(title, msg) {
  if (process.platform !== 'win32') return Promise.resolve({ ok: true, skipped: 'non-win32' });
  const ps = [
    '[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType=WindowsRuntime] | Out-Null;',
    '[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom, ContentType=WindowsRuntime] | Out-Null;',
    `$xml = New-Object Windows.Data.Xml.Dom.XmlDocument; $xml.LoadXml(${psQuote(toastXml(title, msg))});`,
    '$appId = (Get-StartApps | Where-Object { $_.Name -like "*PowerShell*" } | Select-Object -First 1).AppID;',
    'if (-not $appId) { $appId = "{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe" }',
    '$toast = New-Object Windows.UI.Notifications.ToastNotification $xml;',
    '[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($appId).Show($toast);'
  ].join(' ');
  try {
    execFileSync('powershell.exe', ['-NoProfile', '-WindowStyle', 'Hidden', '-Command', ps], { timeout: 8000, stdio: ['ignore', 'pipe', 'pipe'] });
    return Promise.resolve({ ok: true, body: 'toast' });
  } catch (e) {
    const balloon = 'Add-Type -AssemblyName System.Windows.Forms;Add-Type -AssemblyName System.Drawing;' +
      '$n=New-Object System.Windows.Forms.NotifyIcon;$n.Icon=[System.Drawing.SystemIcons]::Information;$n.Visible=$true;' +
      `$n.ShowBalloonTip(8000,${psQuote(title)},${psQuote(msg)},[System.Windows.Forms.ToolTipIcon]::Info);` +
      'Start-Sleep -Seconds 9;$n.Dispose()';
    try { spawn('powershell.exe', ['-NoProfile', '-WindowStyle', 'Hidden', '-Command', balloon], { detached: true, stdio: 'ignore' }).unref(); } catch (e2) {}
    return Promise.resolve({ ok: true, body: 'toast 失败，已退托盘气泡: ' + String(e.message).slice(0, 80) });
  }
}

function sendChannel(name, cfg, msg) {
  try {
    if (name === 'desktop') return sendDesktop(msg.title, renderBody(msg));
    if (!cfg || !cfg.url) return Promise.resolve({ ok: false, error: 'no url' });
    if (name === 'ntfy') return postText(cfg.url, renderPlain(msg));
    if (name === 'bark') return postJson(cfg.url, { title: msg.title, body: renderBody(msg) });
    if (name === 'dingtalk') {
      const ts = String(Date.now());
      return postJson(dingtalkUrl(cfg.url, cfg.secret, ts), { msgtype: 'markdown', markdown: { title: msg.title, text: renderMarkdown(msg) } });
    }
    if (name === 'feishu') {
      const body = { msg_type: 'text', content: { text: renderPlain(msg) } };
      if (cfg.secret) { const ts = String(Math.floor(Date.now() / 1000)); body.timestamp = ts; body.sign = signFeishu(cfg.secret, ts); }
      return postJson(cfg.url, body);
    }
    if (name === 'wecom') return postJson(cfg.url, { msgtype: 'markdown', markdown: { content: renderMarkdown(msg) } });
  } catch (e) {}
  return Promise.resolve({ ok: false, error: 'unsupported channel' });
}

// --- 任务派发：钩子内只落盘 + 起分离子进程 ---
function enabledChannels(cfg, ignoreDelay) {
  const immediate = [], fallback = [];
  for (const name of Object.keys(cfg.channels)) {
    const c = cfg.channels[name];
    if (!c || !c.enabled) continue;
    if (name !== 'desktop' && !c.url) continue;
    if (!ignoreDelay && (c.delaySec || 0) > 0) fallback.push({ name, delaySec: c.delaySec }); else immediate.push(name);
  }
  return { immediate, fallback };
}
function planJobs(cfg) { return enabledChannels(cfg, false); }

function dispatch(sid, cwd, msg, cfg, ctx) {
  const dir = ctx.dir;
  ensureDir(dir);
  const gen = newGen();
  writePending(dir, sid, gen);
  const jobFile = path.join(dir, `job-${gen}.json`);
  const jobs = planJobs(cfg);
  try {
    fs.writeFileSync(jobFile, JSON.stringify({ gen, pendingFile: pendingFile(dir, sid), channels: cfg.channels, app: ctx.app, immediate: jobs.immediate, fallback: jobs.fallback, msg, cwd }, null, 2));
  } catch (e) { return; }
  try { ctx.spawnJob(jobFile); } catch (e) {}
}

function defaultSpawnJob(jobFile) {
  spawn(process.execPath, [__filename, '--job=' + jobFile], { detached: true, stdio: 'ignore' }).unref();
}

// 分离子进程入口：快渠道立即发，兜底渠道睡够 delaySec 再确认 pending 是否仍然有效
async function runJob(jobFile, opts) {
  const send = (opts && opts.send) || sendChannel;
  let job;
  try { job = JSON.parse(fs.readFileSync(jobFile, 'utf8')); } catch (e) { return; }
  await Promise.allSettled((job.immediate || []).map(n => send(n, job.channels[n], job.msg)));
  await Promise.all((job.fallback || []).map(f => (async () => {
    await new Promise(r => setTimeout(r, (f.delaySec || 0) * 1000));
    if (!isPendingAlive(job.pendingFile, job.gen)) return;   // 用户已响应 -> 取消
    await send(f.name, job.channels[f.name], job.msg);
  })()));
  try { fs.unlinkSync(jobFile); } catch (e) {}
}

// 自检：所有已启用渠道各发一条（忽略延迟、不写 pending），返回逐渠道结果
async function runSelfTest(cfg, app, opts) {
  const send = (opts && opts.send) || sendChannel;
  const { immediate, fallback } = enabledChannels(cfg, true);
  const names = immediate.concat(fallback.map(f => f.name));
  const msg = buildStopMsg(app || 'AI', 'selftest-0000', '自检消息，忽略即可', 1, 'notify-hook --test');
  const results = [];
  for (const name of names) {
    const r = await send(name, cfg.channels[name], msg);
    results.push(Object.assign({ channel: name }, r || { ok: false }));
  }
  return results;
}

// --- 事件处理 ---
function onUserPromptSubmit(input, cfg, ctx) {
  ensureDir(ctx.dir);
  clearPending(ctx.dir, pickSessionId(input));       // 用户回来了 -> 排队中的兜底推送作废
  try {
    fs.writeFileSync(sessionFile(ctx.dir, pickSessionId(input)), JSON.stringify({ taskStartTime: Math.floor(Date.now() / 1000), cwd: pickCwd(input) }, null, 2));
  } catch (e) {}
}

function onStop(input, cfg, ctx) {
  if (!cfg.events.Stop) return;
  const sid = pickSessionId(input);
  const meta = readSession(ctx.dir, sid);
  const dur = meta && meta.taskStartTime ? Math.floor(Date.now() / 1000) - meta.taskStartTime : null;
  if (dur !== null && dur < cfg.minDurationSec) return;   // 短任务不打扰
  dispatch(sid, pickCwd(input), buildStopMsg(ctx.app, sid, pickStatus(input), dur, pickCwd(input)), cfg, ctx);
}

function onNotification(input, cfg, ctx) {
  if (!cfg.events.Notification) return;
  const type = firstDefined(input, ['notification_type', 'notificationType', 'type']);
  // 已知类型但不想要 -> 跳过（如 auth_success）；类型缺失或本客户端不认识 -> 照发，不漏报
  const known = type && Object.prototype.hasOwnProperty.call(NOTIFY_TYPE_LABEL, type);
  if (known && !cfg.notificationTypes.includes(type)) return;
  if (type === 'idle_prompt' && suppressIdle(pickSessionId(input), cfg, ctx)) return;
  const label = NOTIFY_TYPE_LABEL[type] || (type ? String(type) : '需要操作');
  dispatch(pickSessionId(input), pickCwd(input),
    buildNotifyMsg(label, ctx.app, pickSessionId(input), pickMessage(input) || '需要你的操作', pickCwd(input), KIND_ICON[type]), cfg, ctx);
}

// 同一会话内首次 idle 才提醒，窗口内重复 idle 静默（用户可能已离开，反复推无意义）；
// 窗口过后允许再提醒一次，并重置计时。
function suppressIdle(sid, cfg, ctx) {
  const file = sessionFile(ctx.dir, sid);
  const now = Date.now();
  const windowMs = cfg.idleSuppressMin * 60 * 1000;
  try {
    const meta = readSession(ctx.dir, sid) || {};
    if (meta.firstIdleAt && now - meta.firstIdleAt <= windowMs) return true;
    meta.firstIdleAt = now;
    ensureDir(ctx.dir);
    fs.writeFileSync(file, JSON.stringify(meta, null, 2));
  } catch (e) {}
  return false;
}

// 用户"在动"的信号：清 pending 即取消排队中的兜底推送（未注册这些事件的 agent 自然跳过）
function onActivity(input, cfg, ctx) { clearPending(ctx.dir, pickSessionId(input)); }

function onSessionEnd(input, cfg, ctx) {
  for (const f of [sessionFile(ctx.dir, pickSessionId(input)), pendingFile(ctx.dir, pickSessionId(input))]) {
    try { fs.unlinkSync(f); } catch (e) {}
  }
  sweepOld(ctx.dir, cfg.cleanupDays);
}

function sweepOld(dir, days) {
  const maxAge = (days || 7) * 24 * 60 * 60 * 1000;
  let files;
  try { files = fs.readdirSync(dir); } catch (e) { return; }
  const now = Date.now();
  for (const f of files) {
    const p = path.join(dir, f);
    try { if (now - fs.statSync(p).mtimeMs > maxAge) fs.unlinkSync(p); } catch (e) {}
  }
}

// 事件名归一化后分发：名称大小写/分隔符差异、以及各 agent 的别名都能对上
function handleEvent(input, cfg, ctx) {
  switch (normEvent(input)) {
    case 'userpromptsubmit': case 'promptsubmit': return onUserPromptSubmit(input, cfg, ctx);
    case 'stop': case 'taskcomplete': return onStop(input, cfg, ctx);
    case 'notification': return onNotification(input, cfg, ctx);
    case 'sessionend': return onSessionEnd(input, cfg, ctx);
    case 'pretooluse': case 'posttooluse': case 'sessionstart': return onActivity(input, cfg, ctx);
    default: return;
  }
}

function main() {
  const argv = process.argv.slice(2);
  const flagVal = (k) => { const a = argv.find(x => x.startsWith(k)); return a ? a.slice(k.length) : null; };

  const jobArg = flagVal('--job=');
  if (jobArg) { runJob(jobArg).finally(() => process.exit(0)); return; }

  const cfg = loadConfig(resolveConfigPath(argv, process.env));
  const app = resolveApp(cfg, argv, process.env);
  const ctx = { dir: stateDirOf(cfg), spawnJob: defaultSpawnJob, app };

  if (argv.includes('--test')) {
    runSelfTest(cfg, app).then(results => {
      console.log(`自检（客户端: ${app}）`);
      if (!results.length) console.log('  无已启用渠道：检查配置里 channels.*.enabled 与 url');
      let bad = 0;
      for (const r of results) {
        if (!r.ok) bad++;
        const detail = r.ok ? (r.body || (r.skipped ? `跳过(${r.skipped})` : '已发送')) : (r.error || '失败');
        console.log(`  ${r.channel.padEnd(9)} ${r.ok ? 'OK  ' : 'FAIL'} ${detail}`);
      }
      process.exit(bad ? 1 : 0);   // 有失败渠道给非零退出码，便于脚本判断
    });
    return;
  }

  const raw = readStdin();
  if (!raw) return;
  let input;
  try { input = JSON.parse(raw); } catch (e) { return; }
  if (!input || typeof input !== 'object') return;
  handleEvent(input, cfg, ctx);
}

module.exports = {
  DEFAULT_CONFIG, getDefaultConfig, loadConfig, resolveConfigPath, stateDirOf, resolveApp,
  fmtDuration, fieldsOf, KIND_ICON, withIcon, buildStopMsg, buildNotifyMsg, renderBody, renderPlain, renderMarkdown,
  xmlEscape, toastXml,
  firstDefined, normEvent, pickSessionId, pickCwd, pickMessage, pickStatus,
  signDingtalk, signFeishu, dingtalkUrl, enabledChannels, planJobs, dispatch, runJob, runSelfTest,
  handleEvent, onStop, onNotification, onUserPromptSubmit, onActivity, onSessionEnd,
  isPendingAlive, suppressIdle, sweepOld, sendChannel
};

if (require.main === module) {
  // 子进程模式与自检模式都是异步收尾，不能在这里提前退出
  const asyncMode = process.argv.slice(2).some(a => a.startsWith('--job=') || a === '--test');
  try { main(); } catch (e) { /* fail-open */ }
  if (!asyncMode) process.exit(0);
}
