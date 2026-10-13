# claude-notify-hook

Claude Code 任务提醒钩子：单文件 node 实现，零依赖（只用 node 内置模块），Windows / Git Bash 直接可用。任务跑完或 Claude 等你操作时，往桌面与 IM 推一条消息。

## 分级推送与「响应即取消」

不区分轻重地推会变噪音，所以按「你还在不在电脑前」分两级：

| 级别 | 渠道 | 默认延迟 | 适用 |
|------|------|---------|------|
| 快（即时触达） | 桌面通知、ntfy、Bark | 0 秒 | 你可能只是切了个窗口 |
| 兜底（异步） | 钉钉、飞书、企业微信 | 300 秒 | 你离开电脑 / 在开会 |

兜底渠道发之前会先确认标记还在不在：**你一旦回来发消息（UserPromptSubmit），排队中的兜底推送整条作废**，不会回来晚了还挨一顿推。同一会话连续两次任务完成也只保留最新一次（标记带代次号，旧任务自行作废）。

## 事件

| 事件 | 行为 |
|------|------|
| `UserPromptSubmit` | 记录任务开始时间；清除待发标记（=取消排队中的兜底推送） |
| `Stop` | 任务完成通知，含项目名与用时；短于 `minDurationSec` 的任务不打扰 |
| `Notification` | 权限请求 / 等待输入通知；同一会话内 idle 首次提醒，`idleSuppressMin` 分钟内重复 idle 静默 |
| `SessionEnd` | 清理本会话状态，并扫掉超过 `cleanupDays` 的旧状态文件 |

钩子本体不碰网络：只写状态并 spawn 一个分离子进程去发，子进程 `unref()` 后与钩子生命周期无关，Claude Code 侧零等待。任何异常一律 fail-open 退出，通知钩子不会阻塞会话。

## 渠道配置

| 渠道 | 需要的字段 | 说明 |
|------|-----------|------|
| `desktop` | 无 | Windows 托盘气泡通知（Win10/11 渲染为系统通知），仅 win32 生效 |
| `ntfy` | `url` | `https://ntfy.sh/<随机topic>`，手机装 ntfy App 订阅同一 topic；可自建 |
| `bark` | `url` | `https://api.day.app/<deviceKey>`，iOS |
| `dingtalk` | `url` + `secret` | 群机器人加签：`timestamp`(毫秒) 与 HMAC-SHA256(`secret`, `ts\nsecret`) |
| `feishu` | `url` + `secret` | 加签口径与钉钉不同：密钥是 `ts\nsecret`（秒级时间戳），待签内容为空串 |
| `wecom` | `url` | 群机器人 webhook，key 在 url 里 |

`delaySec` 逐渠道独立配置，`enabled` 关掉即跳过；未填 `url` 的渠道自动跳过，不会报错。

## 安装

```powershell
# 1. 拷贝到 Claude 配置目录
Copy-Item notify-hook.js C:\Users\<你>\.claude\
Copy-Item notify-config.example.json C:\Users\<你>\.claude\notify-config.json   # 填好自己的 url/secret
```

2. 在 `~/.claude/settings.json` 注册四个事件（**该文件含个人凭据，永不入库**）：

```json
"hooks": {
  "UserPromptSubmit": [ { "hooks": [ { "type": "command", "command": "node \"C:\\Users\\<你>\\.claude\\notify-hook.js\"" } ] } ],
  "Stop":             [ { "hooks": [ { "type": "command", "command": "node \"C:\\Users\\<你>\\.claude\\notify-hook.js\"" } ] } ],
  "Notification":     [ { "hooks": [ { "type": "command", "command": "node \"C:\\Users\\<你>\\.claude\\notify-hook.js\"" } ] } ],
  "SessionEnd":       [ { "hooks": [ { "type": "command", "command": "node \"C:\\Users\\<你>\\.claude\\notify-hook.js\"" } ] } ]
}
```

3. 单次发送排障：

```powershell
'{"hook_event_name":"Stop","session_id":"smoke","cwd":"D:/x/demo"}' | node $env:USERPROFILE\.claude\notify-hook.js
```

4. 回归验证：`node notify-hook.test.js`，期望 `ALL PASS (23 cases)`。

状态文件在 `~/.claude/notify-state/`（会话开始时间、待发标记、任务描述），可随时清空；`NOTIFY_CONFIG` 环境变量可指向替代配置，便于试跑。

## 维护约定

本目录是**源**；`~/.claude/` 下是**生效副本**。修改流程：改本目录 → 跑测试全绿 → commit → 拷回 `~/.claude/`。

## 已知局限

- 桌面通知走 PowerShell 托盘气泡（额外进程存活 9 秒），无 WinRT 应用标识注册问题；但仅实现 Windows，其他平台该渠道直接跳过。
- 兜底渠道靠分离子进程 `setTimeout` 排队，机器重启/关机则排队丢失（不会补发）——兜底本就允许丢，快渠道在事件当时已发。
- node 的 HTTP 请求不读系统代理；若某渠道需经代理访问，得给该渠道单独配代理（当前未实现）。
- 企业微信文本消息上限 2048 字节，超长内容会被截断（本钩子消息很短，未做处理）。
- idle 抑制按会话记录，多会话并行时各自独立。
