const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const hook = require('./notify-hook.js');

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log('OK   ' + name); }
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
function makeCtx(dir) { const spawns = []; return { dir, spawnJob: f => spawns.push(f), spawns }; }
function stopInput(sid, cwd) { return { hook_event_name: 'Stop', session_id: sid, cwd: cwd || 'D:/ideaProject/seacon-pms-service-parent' }; }
function seedTask(dir, sid, secondsAgo) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${sid}.json`), JSON.stringify({ taskStartTime: Math.floor(Date.now() / 1000) - secondsAgo, cwd: 'x' }));
}

// --- 签名（硬编码向量，防实现与用例同时写错） ---
t('signDingtalk 签名向量', () => {
  assert.strictEqual(hook.signDingtalk('SECtest1234567890', '1700000000000'), 'OlY4D3DeSyEApeL6Jt0WKSv4Ba33VsvixmcZAoyTGGM=');
});
t('signFeishu 签名向量（空内容 + stringToSign 作密钥）', () => {
  assert.strictEqual(hook.signFeishu('SECtest9876543210', '1700000000'), 'zh3v5aYP0rF1DQYIfl+MvKfY0/DutPSMif5zlkskwzQ=');
});
t('dingtalkUrl 无 secret 原样返回', () => {
  assert.strictEqual(hook.dingtalkUrl('https://oapi.dingtalk.com/robot/send?access_token=abc', '', '1'), 'https://oapi.dingtalk.com/robot/send?access_token=abc');
});
t('dingtalkUrl 有 secret 追加 timestamp 与 sign', () => {
  const u = hook.dingtalkUrl('https://oapi.dingtalk.com/robot/send?access_token=abc', 'SECx', '1700000000000');
  assert.ok(u.includes('&timestamp=1700000000000&sign='), u);
  assert.ok(u.includes(encodeURIComponent(hook.signDingtalk('SECx', '1700000000000'))), u);
});

// --- 工具函数 ---
t('fmtDuration 秒/分/时', () => {
  assert.strictEqual(hook.fmtDuration(8), '8秒');
  assert.strictEqual(hook.fmtDuration(60), '1分');
  assert.strictEqual(hook.fmtDuration(75), '1分15秒');
  assert.strictEqual(hook.fmtDuration(3700), '1小时1分');
});
t('projectName 取末级目录', () => {
  assert.strictEqual(hook.projectName('D:/ideaProject/seacon-pms-service-parent'), 'seacon-pms-service-parent');
  assert.strictEqual(hook.projectName('D:\\a\\b\\'), 'b');
});

// --- 分级派发 ---
t('planJobs: 快渠道即发、兜底渠道带延迟', () => {
  const cfg = cfgWith({
    desktop: { enabled: true, delaySec: 0 },
    ntfy: { enabled: true, delaySec: 0, url: 'https://ntfy.sh/x' },
    dingtalk: { enabled: true, delaySec: 300, url: 'https://oapi.dingtalk.com/x', secret: '' },
    bark: { enabled: false, delaySec: 0, url: 'https://api.day.app/k' }
  });
  const j = hook.planJobs(cfg);
  assert.deepStrictEqual(j.immediate.sort(), ['desktop', 'ntfy']);
  assert.deepStrictEqual(j.fallback, [{ name: 'dingtalk', delaySec: 300 }]);
});
t('planJobs: 未填 url 的渠道自动跳过', () => {
  const cfg = cfgWith({ ntfy: { enabled: true, delaySec: 0, url: '' }, dingtalk: { enabled: true, delaySec: 0, url: '' } });
  const j = hook.planJobs(cfg);
  assert.deepStrictEqual(j.immediate, ['desktop']);
  assert.deepStrictEqual(j.fallback, []);
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
  assert.ok(job.title.includes('任务完成'), job.title);
  assert.ok(job.msg.includes('[seacon-pms-service-parent]'), job.msg);
  assert.ok(job.msg.includes('用时 1分35秒'), job.msg);
  assert.deepStrictEqual(job.immediate, ['desktop']);      // 默认只开桌面渠道
});
t('Stop: 无开始时间记录时仍通知（时长未知）', () => {
  const dir = freshDir('stop-nometa');
  const ctx = makeCtx(dir);
  hook.onStop(stopInput('s3'), cfgWith(), ctx);
  assert.strictEqual(ctx.spawns.length, 1);
  assert.ok(!readJob(ctx.spawns[0]).msg.includes('用时'));
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

// --- UserPromptSubmit：响应即取消 ---
t('UserPromptSubmit: 清 pending 并记录开始时间', () => {
  const dir = freshDir('ups'); seedTask(dir, 's6', 95);
  fs.writeFileSync(path.join(dir, 's6.pending'), 'oldgen');
  const ctx = makeCtx(dir);
  const before = Math.floor(Date.now() / 1000);
  hook.onUserPromptSubmit({ hook_event_name: 'UserPromptSubmit', session_id: 's6', cwd: 'D:/x' }, cfgWith(), ctx);
  assert.strictEqual(fs.existsSync(path.join(dir, 's6.pending')), false);
  const meta = JSON.parse(fs.readFileSync(path.join(dir, 's6.json'), 'utf8'));
  assert.ok(meta.taskStartTime >= before);
});

// --- Notification 事件 ---
t('Notification: 未在 notificationTypes 内的类型不通知', () => {
  const dir = freshDir('notif-type');
  const ctx = makeCtx(dir);
  hook.onNotification({ hook_event_name: 'Notification', session_id: 'n1', cwd: 'D:/p', notification_type: 'auth_success', message: 'x' }, cfgWith(), ctx);
  assert.strictEqual(ctx.spawns.length, 0);
});
t('Notification: 权限请求派发，标题带 ⚠️ 与项目名', () => {
  const dir = freshDir('notif-perm');
  const ctx = makeCtx(dir);
  hook.onNotification({ hook_event_name: 'Notification', session_id: 'n2', cwd: 'D:/p/pms', notification_type: 'permission_prompt', message: 'Claude needs your permission to use Bash' }, cfgWith(), ctx);
  const job = readJob(ctx.spawns[0]);
  assert.ok(job.title.includes('权限请求') && job.title.includes('⚠️'), job.title);
  assert.ok(job.msg.includes('[pms]') && job.msg.includes('permission'), job.msg);
});
t('Notification: idle 首次提醒、窗口内二次静默', () => {
  const dir = freshDir('notif-idle');
  const ctx = makeCtx(dir);
  const input = { hook_event_name: 'Notification', session_id: 'n3', cwd: 'D:/p', notification_type: 'idle_prompt', message: 'waiting' };
  hook.onNotification(input, cfgWith(), ctx);
  assert.strictEqual(ctx.spawns.length, 1);
  hook.onNotification(input, cfgWith(), ctx);
  assert.strictEqual(ctx.spawns.length, 1, '窗口内第二次 idle 应被抑制');
});
t('Notification: idle 超过抑制窗口后再次提醒', () => {
  const dir = freshDir('notif-idle-old');
  fs.writeFileSync(path.join(dir, 'n4.json'), JSON.stringify({ firstIdleAt: Date.now() - 10 * 60 * 1000 }));
  const ctx = makeCtx(dir);
  hook.onNotification({ hook_event_name: 'Notification', session_id: 'n4', cwd: 'D:/p', notification_type: 'idle_prompt', message: 'w' }, cfgWith(), ctx);
  assert.strictEqual(ctx.spawns.length, 1);
});

// --- SessionEnd 清理 ---
t('SessionEnd: 清本会话状态并扫掉过期文件', () => {
  const dir = freshDir('sessend');
  seedTask(dir, 's7', 10);
  fs.writeFileSync(path.join(dir, 's7.pending'), 'g');
  fs.writeFileSync(path.join(dir, 'old.json'), '{}');
  const old = Date.now() - 30 * 24 * 60 * 60 * 1000;
  fs.utimesSync(path.join(dir, 'old.json'), new Date(old), new Date(old));
  hook.onSessionEnd({ hook_event_name: 'SessionEnd', session_id: 's7' }, cfgWith(), { dir, spawnJob: () => {} });
  assert.strictEqual(fs.existsSync(path.join(dir, 's7.json')), false);
  assert.strictEqual(fs.existsSync(path.join(dir, 's7.pending')), false);
  assert.strictEqual(fs.existsSync(path.join(dir, 'old.json')), false);
});

// --- 配置合并 ---
t('loadConfig: 文件缺失用默认值', () => {
  const cfg = hook.loadConfig(path.join(TMP, 'nope.json'));
  assert.strictEqual(cfg.minDurationSec, 10);
  assert.strictEqual(cfg.channels.desktop.enabled, true);
});
t('loadConfig: 用户配置覆盖默认渠道', () => {
  const p = path.join(TMP, 'cfg.json');
  fs.writeFileSync(p, JSON.stringify({ minDurationSec: 30, channels: { dingtalk: { enabled: true, delaySec: 0, url: 'https://oapi.dingtalk.com/x', secret: 'S' } } }));
  const cfg = hook.loadConfig(p);
  assert.strictEqual(cfg.minDurationSec, 30);
  assert.strictEqual(cfg.channels.dingtalk.enabled, true);
  assert.strictEqual(cfg.channels.desktop.enabled, true, '未覆盖的渠道保留默认');
});

// --- 子进程发送与取消（真等 1 秒验证） ---
async function jobSendScenario() {
  const log = [];
  const send = (name) => { log.push(name); return Promise.resolve(); };
  const dir = freshDir('job-send');
  const pending = path.join(dir, 'p.pending'); fs.writeFileSync(pending, 'genA');
  const jobFile = path.join(dir, 'jobA.json');
  fs.writeFileSync(jobFile, JSON.stringify({ gen: 'genA', pendingFile: pending, channels: { ntfy: { url: 'x' }, dingtalk: { url: 'x' } }, immediate: ['ntfy'], fallback: [{ name: 'dingtalk', delaySec: 1 }], title: 'T', msg: 'M' }));
  await hook.runJob(jobFile, { send });
  return { log, jobFileLeft: fs.existsSync(jobFile) };
}

async function jobCancelScenario() {
  const log = [];
  const send = (name) => { log.push(name); return Promise.resolve(); };
  const dir = freshDir('job-cancel');
  const pending = path.join(dir, 'p.pending'); fs.writeFileSync(pending, 'genB');
  const jobFile = path.join(dir, 'jobB.json');
  fs.writeFileSync(jobFile, JSON.stringify({ gen: 'genB', pendingFile: pending, channels: { dingtalk: { url: 'x' } }, immediate: [], fallback: [{ name: 'dingtalk', delaySec: 1 }], title: 'T', msg: 'M' }));
  const running = hook.runJob(jobFile, { send });
  await new Promise(r => setTimeout(r, 250));
  fs.unlinkSync(pending);                                  // 模拟 UserPromptSubmit：用户回来了
  await running;
  return { log };
}

(async () => {
  const s1 = await jobSendScenario();
  t('runJob: pending 存活 -> 快渠道立即发、兜底渠道延迟后发', () => {
    assert.deepStrictEqual(s1.log, ['ntfy', 'dingtalk']);
    assert.strictEqual(s1.jobFileLeft, false, '任务完成后应删除 job 文件');
  });

  const s2 = await jobCancelScenario();
  t('runJob: 等待期间用户已响应 -> 兜底渠道取消（一条都不发）', () => {
    assert.deepStrictEqual(s2.log, []);
  });

  console.log('\n' + (fail === 0 ? `ALL PASS (${pass} cases)` : `${fail} FAILED / ${pass} passed`));
  fs.rmSync(TMP, { recursive: true, force: true });
  process.exit(fail === 0 ? 0 : 1);
})();
