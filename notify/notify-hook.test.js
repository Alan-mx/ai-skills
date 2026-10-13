const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const hook = require('./notify-hook.js');

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log('OK   ' + name); }
  catch (e) { fail++; console.log('FAIL ' + name + '  >> ' + e.message); }
}
async function ta(name, fn) {
  try { await fn(); pass++; console.log('OK   ' + name); }
  catch (e) { fail++; console.log('FAIL ' + name + '  >> ' + e.message); }
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'notify-hook-test-'));
function freshDir(name) { const d = path.join(TMP, name); fs.rmSync(d, { recursive: true, force: true }); fs.mkdirSync(d, { recursive: true }); return d; }
function cfgWith(channels) {
  const c = hook.getDefaultConfig();
  Object.assign(c.channels, channels || {});
  return c;
}
function readJob(jobFile) { return JSON.parse(fs.readFileSync(jobFile, 'utf8')); }
function makeCtx(dir) { const spawns = []; return { dir, app: 'TestAgent', spawnJob: f => spawns.push(f), spawns }; }
function stopInput(sid, cwd) { return { hook_event_name: 'Stop', session_id: sid, cwd: cwd || 'D:/ideaProject/seacon-pms-service-parent' }; }
function seedTask(dir, sid, secondsAgo) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${sid}.json`), JSON.stringify({ taskStartTime: Math.floor(Date.now() / 1000) - secondsAgo, cwd: 'x' }));
}

// --- 渠道签名（硬编码向量，防实现与用例同时写错） ---
t('signDingtalk 签名向量', () => {
  assert.strictEqual(hook.signDingtalk('SECtest1234567890', '1700000000000'), 'OlY4D3DeSyEApeL6Jt0WKSv4Ba33VsvixmcZAoyTGGM=');
});
t('signFeishu 签名向量（空内容 + stringToSign 作密钥）', () => {
  assert.strictEqual(hook.signFeishu('SECtest9876543210', '1700000000'), 'zh3v5aYP0rF1DQYIfl+MvKfY0/DutPSMif5zlkskwzQ=');
});
t('dingtalkUrl 无 secret 原样返回 / 有 secret 追加 timestamp 与 sign', () => {
  assert.strictEqual(hook.dingtalkUrl('https://oapi.dingtalk.com/robot/send?access_token=abc', '', '1'), 'https://oapi.dingtalk.com/robot/send?access_token=abc');
  const u = hook.dingtalkUrl('https://oapi.dingtalk.com/robot/send?access_token=abc', 'SECx', '1700000000000');
  assert.ok(u.includes('&timestamp=1700000000000&sign='), u);
  assert.ok(u.includes(encodeURIComponent(hook.signDingtalk('SECx', '1700000000000'))), u);
});

// --- 格式化 ---
t('fmtDuration 人类可读（秒/分/时）', () => {
  assert.strictEqual(hook.fmtDuration(44), '44秒');
  assert.strictEqual(hook.fmtDuration(95), '1分35秒');
  assert.strictEqual(hook.fmtDuration(120), '2分');
  assert.strictEqual(hook.fmtDuration(3600), '1小时');
  assert.strictEqual(hook.fmtDuration(5940), '1小时39分');
});
t('消息结构：字段固定顺序、耗时未知则省略该行、图标按事件区分', () => {
  const m = hook.buildStopMsg('Codex', '9e4c8bea-628a-4377-b1f0-aaaaaaaaaaaa', '已完成', 95, 'D:\\pms');
  assert.strictEqual(m.title, '✔ 任务完成 · Codex');
  assert.deepStrictEqual(m.fields, [['会话 ID', '9e4c8bea-628a-43'], ['状态', '已完成'], ['耗时', '1分35秒'], ['项目', 'D:\\pms']]);
  const n = hook.buildNotifyMsg('权限请求', 'Claude Code', 'n2', 'Claude needs your permission', 'D:/p/pms', hook.KIND_ICON.permission_prompt);
  assert.strictEqual(n.title, '❗ 权限请求 · Claude Code');
  assert.deepStrictEqual(n.fields.map(f => f[0]), ['会话 ID', '状态', '项目']);
  const noIcon = hook.buildNotifyMsg('tool_approval', 'Codex', 'n3', 'Approve?', 'D:/p', undefined);
  assert.strictEqual(noIcon.title, 'tool_approval · Codex', '未知类型不加图标');
});
t('渲染：纯文本不带 markdown 记号、markdown 带加粗与引用条', () => {
  const m = hook.buildStopMsg('Codex', 's', '已完成', 44, 'D:\\pms');
  assert.strictEqual(hook.renderPlain(m), '✔ 任务完成 · Codex\n会话 ID: s\n状态: 已完成\n耗时: 44秒\n项目: D:\\pms');
  assert.ok(!hook.renderPlain(m).includes('**'), '纯文本渠道不得出现 ** 记号');
  assert.strictEqual(hook.renderMarkdown(m), '**✔ 任务完成 · Codex**\n\n> **会话 ID:** s\n>\n> **状态:** 已完成\n>\n> **耗时:** 44秒\n>\n> **项目:** D:\\pms');
});

// --- 客户端名解析：--app= > appName > 环境变量 > AI ---
t('resolveApp 优先级与推断', () => {
  const empty = hook.getDefaultConfig();
  assert.strictEqual(hook.resolveApp(empty, ['--app=My Agent'], { CLAUDECODE: '1' }), 'My Agent');
  assert.strictEqual(hook.resolveApp({ appName: 'Configured' }, [], { CLAUDECODE: '1' }), 'Configured');
  assert.strictEqual(hook.resolveApp(empty, [], { CLAUDECODE: '1' }), 'Claude Code');
  assert.strictEqual(hook.resolveApp(empty, [], { CODEX_HOME: 'C:/x' }), 'Codex');
  assert.strictEqual(hook.resolveApp(empty, [], {}), 'AI');
});

// --- 配置路径解析 ---
t('resolveConfigPath: --config > NOTIFY_CONFIG > 默认', () => {
  assert.strictEqual(hook.resolveConfigPath(['--config=D:/a.json'], { NOTIFY_CONFIG: 'D:/b.json' }), 'D:/a.json');
  assert.strictEqual(hook.resolveConfigPath([], { NOTIFY_CONFIG: 'D:/b.json' }), 'D:/b.json');
  assert.ok(hook.resolveConfigPath([], {}).endsWith(path.join('.claude', 'notify-config.json')));
});
t('loadConfig: 文件缺失用默认值 / 用户配置覆盖渠道', () => {
  const d = hook.loadConfig(path.join(TMP, 'nope.json'));
  assert.strictEqual(d.minDurationSec, 10);
  assert.strictEqual(d.channels.desktop.enabled, true);
  const p = path.join(TMP, 'cfg.json');
  fs.writeFileSync(p, JSON.stringify({ minDurationSec: 30, appName: 'X', channels: { dingtalk: { enabled: true, delaySec: 0, url: 'https://x', secret: 'S' } } }));
  const c = hook.loadConfig(p);
  assert.strictEqual(c.minDurationSec, 30);
  assert.strictEqual(c.appName, 'X');
  assert.strictEqual(c.channels.dingtalk.enabled, true);
  assert.strictEqual(c.channels.desktop.enabled, true, '未覆盖的渠道保留默认');
});
t('stateDirOf: 默认目录 / 配置覆盖', () => {
  assert.ok(hook.stateDirOf(hook.getDefaultConfig()).endsWith(path.join('.claude', 'notify-state')));
  assert.strictEqual(hook.stateDirOf({ stateDir: 'D:/s' }), 'D:/s');
});

// --- 载荷字段容错（换 agent 换字段名不静默失灵） ---
t('事件名归一化：大小写/分隔符/别名', () => {
  assert.strictEqual(hook.normEvent({ hook_event_name: 'UserPromptSubmit' }), 'userpromptsubmit');
  assert.strictEqual(hook.normEvent({ event: 'user-prompt-submit' }), 'userpromptsubmit');
  assert.strictEqual(hook.normEvent({ type: 'STOP' }), 'stop');
  assert.strictEqual(hook.normEvent({ eventName: 'Notification' }), 'notification');
});
t('字段兼容读取：session_id/thread_id、cwd/working_dir 等', () => {
  assert.strictEqual(hook.pickSessionId({ thread_id: 'T-1' }), 'T-1');
  assert.strictEqual(hook.pickCwd({ working_dir: 'D:/w' }), 'D:/w');
  assert.strictEqual(hook.pickMessage({ text: 'hi' }), 'hi');
  assert.strictEqual(hook.pickStatus({ stop_reason: 'done' }), 'done');
  assert.strictEqual(hook.pickStatus({}), '已完成');
  assert.strictEqual(hook.pickSessionId({}), 'nosession');
});
t('Codex 风格载荷（event/thread_id/working_dir）也能完整派发', () => {
  const dir = freshDir('codex-shape'); seedTask(dir, 'T-77', 200);
  const ctx = makeCtx(dir);
  hook.handleEvent({ event: 'Stop', thread_id: 'T-77', working_dir: 'D:\\work\\pms', status: 'completed' }, cfgWith(), ctx);
  const job = readJob(ctx.spawns[0]);
  assert.strictEqual(job.msg.title, '✔ 任务完成 · TestAgent');
  const body = hook.renderBody(job.msg);
  assert.ok(body.includes('会话 ID: T-77'), body);
  assert.ok(body.includes('状态: completed'), body);
  assert.ok(body.includes('耗时: 3分20秒'), body);
  assert.ok(body.includes('项目: D:\\work\\pms'), body);
});

// --- 渠道分级 ---
t('planJobs: 快渠道即发、兜底渠道带延迟；未填 url 自动跳过', () => {
  const cfg = cfgWith({
    desktop: { enabled: true, delaySec: 0 },
    ntfy: { enabled: true, delaySec: 0, url: 'https://ntfy.sh/x' },
    dingtalk: { enabled: true, delaySec: 300, url: 'https://oapi.dingtalk.com/x', secret: '' },
    bark: { enabled: false, delaySec: 0, url: 'https://api.day.app/k' }
  });
  const j = hook.planJobs(cfg);
  assert.deepStrictEqual(j.immediate.sort(), ['desktop', 'ntfy']);
  assert.deepStrictEqual(j.fallback, [{ name: 'dingtalk', delaySec: 300 }]);
  const k = hook.planJobs(cfgWith({ ntfy: { enabled: true, delaySec: 0, url: '' } }));
  assert.deepStrictEqual(k.immediate, ['desktop']);
});
t('runSelfTest: 忽略延迟、把兜底渠道也一起发', async () => {
  const cfg = cfgWith({ desktop: { enabled: true, delaySec: 0 }, dingtalk: { enabled: true, delaySec: 300, url: 'https://x', secret: '' } });
  const sent = [];
  const results = await hook.runSelfTest(cfg, 'TestAgent', { send: (name, c, msg) => { sent.push({ name, msg }); return Promise.resolve({ ok: true, status: 200, body: '{"errcode":0}' }); } });
  assert.deepStrictEqual(sent.map(s => s.name), ['desktop', 'dingtalk']);
  assert.strictEqual(results.length, 2);
  assert.strictEqual(sent[0].msg.title, '✔ 任务完成 · TestAgent');
  assert.ok(hook.renderBody(sent[0].msg).includes('自检'), hook.renderBody(sent[0].msg));
});

// --- Stop 事件 ---
t('Stop: 短任务（时长 < 阈值）不通知', () => {
  const dir = freshDir('stop-short'); seedTask(dir, 's1', 3);
  const ctx = makeCtx(dir);
  hook.onStop(stopInput('s1'), cfgWith(), ctx);
  assert.strictEqual(ctx.spawns.length, 0);
  assert.strictEqual(fs.existsSync(path.join(dir, 's1.pending')), false);
});
t('Stop: 达标任务落 pending + 派发子进程，pending 与 job 代次一致', () => {
  const dir = freshDir('stop-ok'); seedTask(dir, 's2', 95);
  const ctx = makeCtx(dir);
  hook.onStop(stopInput('s2'), cfgWith(), ctx);
  assert.strictEqual(ctx.spawns.length, 1);
  const job = readJob(ctx.spawns[0]);
  assert.strictEqual(fs.readFileSync(path.join(dir, 's2.pending'), 'utf8').trim(), job.gen);
  assert.strictEqual(job.msg.title, '✔ 任务完成 · TestAgent');
  const body = hook.renderBody(job.msg);
  assert.ok(body.includes('状态: 已完成'), body);
  assert.ok(/\n耗时: 1分3[56]秒\n/.test(body), body);
  assert.deepStrictEqual(job.immediate, ['desktop']);      // 默认只开桌面渠道
});
t('Stop: 无开始时间记录时不印耗时行', () => {
  const dir = freshDir('stop-nometa');
  const ctx = makeCtx(dir);
  hook.onStop(stopInput('s3'), cfgWith(), ctx);
  assert.strictEqual(ctx.spawns.length, 1);
  const body = hook.renderBody(readJob(ctx.spawns[0]).msg);
  assert.ok(!body.includes('耗时'), body);
  assert.ok(body.includes('状态: 已完成'), body);
});
t('Stop: events.Stop 关闭时不通知', () => {
  const dir = freshDir('stop-off'); seedTask(dir, 's4', 95);
  const cfg = cfgWith(); cfg.events.Stop = false;
  const ctx = makeCtx(dir);
  hook.onStop(stopInput('s4'), cfg, ctx);
  assert.strictEqual(ctx.spawns.length, 0);
});
t('Stop: 连续两次 Stop，pending 换新代次（旧子进程自行作废）', () => {
  const dir = freshDir('stop-twice'); seedTask(dir, 's5', 95);
  const ctx = makeCtx(dir);
  hook.onStop(stopInput('s5'), cfgWith(), ctx);
  const gen1 = readJob(ctx.spawns[0]).gen;
  hook.onStop(stopInput('s5'), cfgWith(), ctx);
  const gen2 = readJob(ctx.spawns[1]).gen;
  assert.notStrictEqual(gen1, gen2);
  assert.strictEqual(hook.isPendingAlive(path.join(dir, 's5.pending'), gen1), false);
  assert.strictEqual(hook.isPendingAlive(path.join(dir, 's5.pending'), gen2), true);
});

// --- 响应即取消 ---
t('UserPromptSubmit: 清 pending 并记录开始时间', () => {
  const dir = freshDir('ups'); seedTask(dir, 's6', 95);
  fs.writeFileSync(path.join(dir, 's6.pending'), 'oldgen');
  const before = Math.floor(Date.now() / 1000);
  hook.onUserPromptSubmit({ hook_event_name: 'UserPromptSubmit', session_id: 's6', cwd: 'D:/x' }, cfgWith(), makeCtx(dir));
  assert.strictEqual(fs.existsSync(path.join(dir, 's6.pending')), false);
  assert.ok(JSON.parse(fs.readFileSync(path.join(dir, 's6.json'), 'utf8')).taskStartTime >= before);
});
t('onActivity: PreToolUse/PostToolUse/SessionStart 也清 pending（无 UserPromptSubmit 的 agent 靠它取消）', () => {
  const dir = freshDir('activity');
  fs.writeFileSync(path.join(dir, 'a1.pending'), 'gen');
  const ctx = makeCtx(dir);
  hook.handleEvent({ hook_event_name: 'PreToolUse', session_id: 'a1' }, cfgWith(), ctx);
  assert.strictEqual(fs.existsSync(path.join(dir, 'a1.pending')), false);
  fs.writeFileSync(path.join(dir, 'a2.pending'), 'gen');
  hook.handleEvent({ hook_event_name: 'SessionStart', session_id: 'a2' }, cfgWith(), ctx);
  assert.strictEqual(fs.existsSync(path.join(dir, 'a2.pending')), false);
});

// --- Notification 事件 ---
t('Notification: 白名单外的已知类型不通知（auth_success）', () => {
  const dir = freshDir('notif-type');
  const ctx = makeCtx(dir);
  hook.onNotification({ hook_event_name: 'Notification', session_id: 'n1', cwd: 'D:/p', notification_type: 'auth_success', message: 'x' }, cfgWith(), ctx);
  assert.strictEqual(ctx.spawns.length, 0);
});
t('Notification: 类型缺失照样通知（别的 agent 没这个概念，不漏报）', () => {
  const dir = freshDir('notif-notype');
  const ctx = makeCtx(dir);
  hook.onNotification({ hook_event_name: 'Notification', session_id: 'nx', cwd: 'D:/p', message: 'waiting for you' }, cfgWith(), ctx);
  assert.strictEqual(ctx.spawns.length, 1);
  const job = readJob(ctx.spawns[0]);
  assert.strictEqual(job.msg.title, '需要操作 · TestAgent');
  assert.ok(hook.renderBody(job.msg).includes('状态: waiting for you'), hook.renderBody(job.msg));
});
t('Notification: 未知类型原样进标题，不因为不认识就不发', () => {
  const dir = freshDir('notif-unknown');
  const ctx = makeCtx(dir);
  hook.onNotification({ hook_event_name: 'Notification', session_id: 'nu', cwd: 'D:/p', notification_type: 'tool_approval', message: 'Approve?' }, cfgWith(), ctx);
  assert.strictEqual(ctx.spawns.length, 1);
  assert.strictEqual(readJob(ctx.spawns[0]).msg.title, 'tool_approval · TestAgent');
});
t('Notification: 权限请求三行格式（无耗时行），markdown 标题加粗', () => {
  const dir = freshDir('notif-perm');
  const ctx = makeCtx(dir);
  hook.onNotification({ hook_event_name: 'Notification', session_id: 'n2', cwd: 'D:/p/pms', notification_type: 'permission_prompt', message: 'Claude needs your permission' }, cfgWith(), ctx);
  const job = readJob(ctx.spawns[0]);
  assert.strictEqual(hook.renderPlain(job.msg), '❗ 权限请求 · TestAgent\n会话 ID: n2\n状态: Claude needs your permission\n项目: D:/p/pms');
  assert.ok(hook.renderMarkdown(job.msg).startsWith('**❗ 权限请求 · TestAgent**\n\n> **会话 ID:** n2'), hook.renderMarkdown(job.msg));
  assert.ok(!hook.renderMarkdown(job.msg).includes('耗时'), '耗时未知不应出现该行');
});
t('Notification: idle 首次提醒、窗口内二次静默、窗口过后再提醒', () => {
  const dir = freshDir('notif-idle');
  const ctx = makeCtx(dir);
  const input = { hook_event_name: 'Notification', session_id: 'n3', cwd: 'D:/p', notification_type: 'idle_prompt', message: 'waiting' };
  hook.onNotification(input, cfgWith(), ctx);
  assert.strictEqual(ctx.spawns.length, 1);
  hook.onNotification(input, cfgWith(), ctx);
  assert.strictEqual(ctx.spawns.length, 1, '窗口内第二次 idle 应被抑制');
  fs.writeFileSync(path.join(dir, 'n4.json'), JSON.stringify({ firstIdleAt: Date.now() - 10 * 60 * 1000 }));
  hook.onNotification({ hook_event_name: 'Notification', session_id: 'n4', cwd: 'D:/p', notification_type: 'idle_prompt', message: 'w' }, cfgWith(), ctx);
  assert.strictEqual(ctx.spawns.length, 2, '窗口过后应再提醒一次');
});

// --- SessionEnd 清理 ---
t('SessionEnd: 清本会话状态并扫掉过期文件', () => {
  const dir = freshDir('sessend');
  seedTask(dir, 's7', 10);
  fs.writeFileSync(path.join(dir, 's7.pending'), 'g');
  fs.writeFileSync(path.join(dir, 'old.json'), '{}');
  const old = Date.now() - 30 * 24 * 60 * 60 * 1000;
  fs.utimesSync(path.join(dir, 'old.json'), new Date(old), new Date(old));
  hook.onSessionEnd({ hook_event_name: 'SessionEnd', session_id: 's7' }, cfgWith(), { dir, app: 'AI', spawnJob: () => {} });
  assert.strictEqual(fs.existsSync(path.join(dir, 's7.json')), false);
  assert.strictEqual(fs.existsSync(path.join(dir, 's7.pending')), false);
  assert.strictEqual(fs.existsSync(path.join(dir, 'old.json')), false);
});

// --- 异步用例 ---
function withServer(handler) {
  return new Promise(resolve => { const s = http.createServer(handler); s.listen(0, '127.0.0.1', () => resolve(s)); });
}

(async () => {
  // runJob：pending 存活 -> 快渠道立即发、兜底渠道延迟后发；任务完成后自删 job 文件
  const log = [];
  const send = (name) => { log.push(name); return Promise.resolve({ ok: true }); };
  let dir = freshDir('job-send');
  let pending = path.join(dir, 'p.pending'); fs.writeFileSync(pending, 'genA');
  let jobFile = path.join(dir, 'jobA.json');
  fs.writeFileSync(jobFile, JSON.stringify({ gen: 'genA', pendingFile: pending, channels: { ntfy: { url: 'x' }, dingtalk: { url: 'x' } }, immediate: ['ntfy'], fallback: [{ name: 'dingtalk', delaySec: 1 }], title: 'T', msg: 'M' }));
  await hook.runJob(jobFile, { send });
  await ta('runJob: pending 存活 -> 快渠道立即发、兜底渠道延迟后发', () => {
    assert.deepStrictEqual(log, ['ntfy', 'dingtalk']);
    assert.strictEqual(fs.existsSync(jobFile), false, '任务完成后应删除 job 文件');
  });

  // runJob：等待期间用户已响应 -> 兜底渠道取消
  log.length = 0;
  dir = freshDir('job-cancel');
  pending = path.join(dir, 'p.pending'); fs.writeFileSync(pending, 'genB');
  jobFile = path.join(dir, 'jobB.json');
  fs.writeFileSync(jobFile, JSON.stringify({ gen: 'genB', pendingFile: pending, channels: { dingtalk: { url: 'x' } }, immediate: [], fallback: [{ name: 'dingtalk', delaySec: 1 }], title: 'T', msg: 'M' }));
  const running = hook.runJob(jobFile, { send });
  await new Promise(r => setTimeout(r, 250));
  fs.unlinkSync(pending);                                  // 模拟用户回来
  await running;
  await ta('runJob: 等待期间用户已响应 -> 兜底渠道取消（一条都不发）', () => {
    assert.deepStrictEqual(log, []);
  });

  // 渠道请求体真验：本地起 HTTP 服务收包（企业微信 + 钉钉加签）
  const seen = [];
  const server = await withServer((req, res) => {
    let b = ''; req.on('data', c => b += c);
    req.on('end', () => { seen.push({ url: req.url, body: b }); res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"errcode":0,"errmsg":"ok"}'); });
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const demo = hook.buildStopMsg('TestAgent', 'selftest-0000', '已完成', 44, 'D:/pms');
  const r1 = await hook.sendChannel('wecom', { url: base + '/hook?key=K' }, demo);
  const r2 = await hook.sendChannel('dingtalk', { url: base + '/robot/send?access_token=T', secret: 'SEC' }, demo);
  await ta('sendChannel: 钉钉/企微走 markdown 加粗，请求体与返回码（本地服务实测）', () => {
    assert.strictEqual(r1.ok, true);
    assert.strictEqual(r1.status, 200);
    const wecom = JSON.parse(seen[0].body), ding = JSON.parse(seen[1].body);
    assert.strictEqual(wecom.msgtype, 'markdown');
    assert.ok(wecom.markdown.content.includes('> **会话 ID:** selftest-0000'), wecom.markdown.content);
    assert.strictEqual(ding.msgtype, 'markdown');
    assert.strictEqual(ding.markdown.title, '✔ 任务完成 · TestAgent');
    assert.ok(ding.markdown.text.includes('**✔ 任务完成 · TestAgent**'), ding.markdown.text);
    assert.ok(seen[1].url.includes('&timestamp=') && seen[1].url.includes('&sign='), seen[1].url);
    assert.strictEqual(r2.ok, true);
  });
  await ta('sendChannel: 未填 url 的渠道返回失败而不是抛错', async () => {
    const r = await hook.sendChannel('dingtalk', { url: '' }, demo);
    assert.strictEqual(r.ok, false);
  });
  await new Promise(r => server.close(r));

  console.log('\n' + (fail === 0 ? `ALL PASS (${pass} cases)` : `${fail} FAILED / ${pass} passed`));
  fs.rmSync(TMP, { recursive: true, force: true });
  process.exit(fail === 0 ? 0 : 1);
})();
