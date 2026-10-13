#!/usr/bin/env node
'use strict';
// Claude Code notification hook. Single file, zero dependencies (node built-ins only).
//
// Events handled (register all four in ~/.claude/settings.json):
//   UserPromptSubmit -> 记录任务开始时间 + 清除 pending（用户回来了 => 取消排队中的兜底推送）
//   Stop             -> 任务完成通知（短于 minDurationSec 的任务不打扰）
//   Notification     -> 权限请求 / 等待输入通知（idle 在同一会话内重复触发会被抑制）
//   SessionEnd       -> 清理本会话状态 + 扫掉过期状态文件
//
// Tiered delivery (borrowed from cc-notify-hooks): 快渠道（desktop / ntfy / bark）秒级即发；
// 兜底渠道（dingtalk / feishu / wecom）延迟 delaySec 后才发，发之前先看 pending 是否还在——
// 用户已响应（pending 被删或代次号变了）则整条取消，不会离开回来还挨一顿推。
//
// 钩子本体不碰网络：只写 pending 与任务描述，然后 spawn 一个分离子进程去发（--job=<file>），
// 子进程 unref 后与钩子生命周期无关，故 Claude Code 侧零等待。
//
// 配置 ~/.claude/notify-config.json（含 webhook 凭据，永不入库；仓库只放 example 模板）。
// 任何异常一律 fail-open 退出，通知钩子绝不阻塞 Bash/会话。

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const http = require('http');
const https = require('https');
const { spawn } = require('child_process');

const HOME = os.homedir();
const DEFAULT_STATE_DIR = path.join(HOME, '.claude', 'notify-state');
const DEFAULT_CONFIG_PATH = path.join(HOME, '.claude', 'notify-config.json');
const REQUEST_TIMEOUT_MS = 8000;

const DEFAULT_CONFIG = {
  minDurationSec: 10,
  events: { Stop: true, Notification: true },
  notificationTypes: ['permission_prompt', 'idle_prompt'],
  idleSuppressMin: 5,
  cleanupDays: 7,
  channels: {
    desktop:  { enabled: true,  delaySec: 0 },
    ntfy:     { enabled: false, delaySec: 0,   url: 'https://ntfy.sh/your-random-topic' },
    bark:     { enabled: false, delaySec: 0,   url: 'https://api.day.app/your-device-key' },
    dingtalk: { enabled: false, delaySec: 300, url: 'https://oapi.dingtalk.com/robot/send?access_token=xxx', secret: '' },
    feishu:   { enabled: false, delaySec: 300, url: 'https://open.feishu.cn/open-apis/bot/v2/hook/xxx', secret: '' },
    wecom:    { enabled: false, delaySec: 300, url: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=xxx' }
  }
};

const NOTIFY_TYPE_LABEL = {
  permission_prompt: '权限请求',
  idle_prompt: '等待输入',
  auth_success: '认证成功',
  elicitation_dialog: 'MCP 输入'
};

function readStdin() { try { return fs.readFileSync(0, 'utf8'); } catch (e) { return ''; } }

function getDefaultConfig() { return JSON.parse(JSON.stringify(DEFAULT_CONFIG)); }

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

function ensureDir(dir) { try { fs.mkdirSync(dir, { recursive: true }); } catch (e) {} }

function newGen() { return crypto.randomBytes(8).toString('hex'); }

function projectName(cwd) {
  const p = String(cwd || process.cwd()).replace(/[\\/]+$/, '');
  return p.split(/[\\/]/).pop() || 'unknown';
}

function fmtDuration(sec) {
  const s = Math.max(0, Math.floor(sec));
  if (s < 60) return s + '秒';
  if (s < 3600) return Math.floor(s / 60) + '分' + (s % 60 ? (s % 60) + '秒' : '');
  return Math.floor(s / 3600) + '小时' + (Math.floor(s % 3600 / 60) ? Math.floor(s % 3600 / 60) + '分' : '');
}

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

// --- HTTP（失败静默，不抛不阻塞） ---
function request(url, body, contentType, timeoutMs) {
  return new Promise(resolve => {
    let u; try { u = new URL(url); } catch (e) { return resolve(); }
    const lib = u.protocol === 'http:' ? http : https;
    const buf = Buffer.from(body, 'utf8');
    let req;
    try {
      req = lib.request({
        hostname: u.hostname, port: u.port || undefined, path: u.pathname + u.search, method: 'POST',
        headers: { 'Content-Type': contentType, 'Content-Length': buf.length }
      }, res => { res.resume(); res.on('end', resolve); });
    } catch (e) { return resolve(); }
    req.on('error', () => resolve());
    req.setTimeout(timeoutMs || REQUEST_TIMEOUT_MS, () => { req.destroy(); resolve(); });
    req.write(buf); req.end();
  });
}
function postJson(url, obj) { return request(url, JSON.stringify(obj), 'application/json'); }
function postText(url, text) { return request(url, text, 'text/plain'); }

// --- 渠道发送 ---
function psQuote(s) { return "'" + String(s).replace(/'/g, "''") + "'"; }

function sendDesktop(title, msg) {
  if (process.platform !== 'win32') return Promise.resolve();   // 当前只实现 Windows 桌面通知
  const ps = 'Add-Type -AssemblyName System.Windows.Forms;Add-Type -AssemblyName System.Drawing;' +
    '$n=New-Object System.Windows.Forms.NotifyIcon;$n.Icon=[System.Drawing.SystemIcons]::Information;$n.Visible=$true;' +
    `$n.ShowBalloonTip(8000,${psQuote(title)},${psQuote(msg)},[System.Windows.Forms.ToolTipIcon]::Info);` +
    'Start-Sleep -Seconds 9;$n.Dispose()';
  try {
    spawn('powershell.exe', ['-NoProfile', '-WindowStyle', 'Hidden', '-Command', ps], { detached: true, stdio: 'ignore' }).unref();
  } catch (e) {}
  return Promise.resolve();
}

function sendChannel(name, cfg, title, msg) {
  try {
    if (name === 'desktop') return sendDesktop(title, msg);
    if (!cfg || !cfg.url) return Promise.resolve();
    if (name === 'ntfy') return postText(cfg.url, `${title}\n${msg}`);
    if (name === 'bark') return postJson(cfg.url, { title, body: msg });
    if (name === 'dingtalk') {
      const ts = String(Date.now());
      return postJson(dingtalkUrl(cfg.url, cfg.secret, ts), { msgtype: 'text', text: { content: `${title}\n${msg}` } });
    }
    if (name === 'feishu') {
      const body = { msg_type: 'text', content: { text: `${title}\n${msg}` } };
      if (cfg.secret) { const ts = String(Math.floor(Date.now() / 1000)); body.timestamp = ts; body.sign = signFeishu(cfg.secret, ts); }
      return postJson(cfg.url, body);
    }
    if (name === 'wecom') return postJson(cfg.url, { msgtype: 'text', text: { content: `${title}\n${msg}` } });
  } catch (e) {}
  return Promise.resolve();
}

// --- 任务派发：钩子内只落盘 + 起分离子进程 ---
function planJobs(cfg) {
  const immediate = [], fallback = [];
  for (const name of Object.keys(cfg.channels)) {
    const c = cfg.channels[name];
    if (!c || !c.enabled) continue;
    if (name !== 'desktop' && !c.url) continue;
    if ((c.delaySec || 0) > 0) fallback.push({ name, delaySec: c.delaySec }); else immediate.push(name);
  }
  return { immediate, fallback };
}

function dispatch(sid, cwd, title, msg, cfg, ctx) {
  ensureDir(ctx.dir);
  const gen = newGen();
  writePending(ctx.dir, sid, gen);
  const jobFile = path.join(ctx.dir, `job-${gen}.json`);
  const jobs = planJobs(cfg);
  try {
    fs.writeFileSync(jobFile, JSON.stringify({ gen, pendingFile: pendingFile(ctx.dir, sid), channels: cfg.channels, immediate: jobs.immediate, fallback: jobs.fallback, title, msg, cwd }, null, 2));
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
  await Promise.allSettled((job.immediate || []).map(n => send(n, job.channels[n], job.title, job.msg)));
  await Promise.all((job.fallback || []).map(f => (async () => {
    await new Promise(r => setTimeout(r, (f.delaySec || 0) * 1000));
    if (!isPendingAlive(job.pendingFile, job.gen)) return;   // 用户已响应 -> 取消
    await send(f.name, job.channels[f.name], job.title, job.msg);
  })()));
  try { fs.unlinkSync(jobFile); } catch (e) {}
}

// --- 事件处理 ---
function onUserPromptSubmit(input, cfg, ctx) {
  ensureDir(ctx.dir);
  clearPending(ctx.dir, input.session_id);           // 用户回来了 -> 排队中的兜底推送作废
  try {
    fs.writeFileSync(sessionFile(ctx.dir, input.session_id), JSON.stringify({ taskStartTime: Math.floor(Date.now() / 1000), cwd: input.cwd }, null, 2));
  } catch (e) {}
}

function onStop(input, cfg, ctx) {
  if (!cfg.events.Stop) return;
  const meta = readSession(ctx.dir, input.session_id);
  const dur = meta && meta.taskStartTime ? Math.floor(Date.now() / 1000) - meta.taskStartTime : null;
  if (dur !== null && dur < cfg.minDurationSec) return;   // 短任务不打扰
  const title = '✅ Claude Code 任务完成';
  const msg = `[${projectName(input.cwd)}] 任务完成${dur !== null ? `，用时 ${fmtDuration(dur)}` : ''}，请查看结果`;
  dispatch(input.session_id, input.cwd, title, msg, cfg, ctx);
}

function onNotification(input, cfg, ctx) {
  if (!cfg.events.Notification) return;
  const type = input.notification_type;
  if (!cfg.notificationTypes.includes(type)) return;
  if (type === 'idle_prompt' && suppressIdle(input.session_id, cfg, ctx)) return;
  const label = NOTIFY_TYPE_LABEL[type] || type;
  const title = `${type === 'permission_prompt' ? '⚠️' : '⏳'} Claude Code ${label}`;
  const msg = `[${projectName(input.cwd)}] ${input.message || '需要你的操作'}`;
  dispatch(input.session_id, input.cwd, title, msg, cfg, ctx);
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

function onSessionEnd(input, cfg, ctx) {
  for (const f of [sessionFile(ctx.dir, input.session_id), pendingFile(ctx.dir, input.session_id)]) {
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

function handleEvent(input, cfg, ctx) {
  switch (input.hook_event_name) {
    case 'UserPromptSubmit': return onUserPromptSubmit(input, cfg, ctx);
    case 'Stop': return onStop(input, cfg, ctx);
    case 'Notification': return onNotification(input, cfg, ctx);
    case 'SessionEnd': return onSessionEnd(input, cfg, ctx);
    default: return;
  }
}

function main() {
  const jobArg = process.argv.slice(2).find(a => a.startsWith('--job='));
  if (jobArg) { runJob(jobArg.slice('--job='.length)).finally(() => process.exit(0)); return; }
  const raw = readStdin();
  if (!raw) return;
  let input;
  try { input = JSON.parse(raw); } catch (e) { return; }
  if (!input || !input.hook_event_name || !input.session_id) return;
  handleEvent(input, loadConfig(process.env.NOTIFY_CONFIG), { dir: DEFAULT_STATE_DIR, spawnJob: defaultSpawnJob });
}

module.exports = {
  DEFAULT_CONFIG, getDefaultConfig, loadConfig, projectName, fmtDuration,
  signDingtalk, signFeishu, dingtalkUrl, planJobs, dispatch, runJob,
  handleEvent, onStop, onNotification, onUserPromptSubmit, onSessionEnd,
  isPendingAlive, suppressIdle, sweepOld, sendChannel
};

if (require.main === module) {
  const isJob = process.argv.slice(2).some(a => a.startsWith('--job='));
  try { main(); } catch (e) { /* fail-open */ }
  if (!isJob) process.exit(0);   // 子进程模式由 runJob 自己收尾，此处不能提前退出
}
