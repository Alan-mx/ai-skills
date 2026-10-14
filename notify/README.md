# notify-hook

AI 编码 agent 的任务提醒钩子：**单文件 node 实现，零依赖**（只用 node 内置模块），Windows / Git Bash 直接可用。**同一个脚本、同一份配置可同时挂给 Claude Code、Codex 或任何走 hook 机制的 agent**。任务跑完或 agent 等你操作时，往桌面与 IM 推一条消息。

## 推送时机：每个渠道一个「宽限期」

不区分轻重地推会变噪音，所以每个渠道各配一个 `delaySec`（宽限期）：事件发生先记账，**到点前你只要提交一条消息（UserPromptSubmit），该渠道这条推送就整体作废**；到点你还没回，才真发出去。

| 渠道 | 默认宽限 | 定位 |
|------|---------|------|
| 桌面通知、ntfy、Bark | 0 秒 | 立即触达——你可能只是切了个窗口 |
| 钉钉、飞书、企业微信 | 10 秒 | 给 10 秒「回到电脑前」的宽限，你一回话就作废，不会打扰 |

宽限期逐渠道独立可调：调大（如 300 秒）就退化成「离开电脑/开会时的兜底」，调成 0 就是任务一结束立刻推。

到点真发之前会再确认一次标记，故同一会话连续两次任务完成只保留最新一次（标记带代次号，旧任务自行作废），不会重复推。

## 事件

事件名按大小写/分隔符归一化后匹配（`UserPromptSubmit` / `user-prompt-submit` / `prompt_submit` 等价），各客户端命名差异由代码吸收。

| 事件 | 行为 |
|------|------|
| `UserPromptSubmit` | 记录任务开始时间；清除待发标记（=取消排队中的兜底推送） |
| `Stop` | 任务完成通知，含耗时；短于 `minDurationSec` 的任务不打扰 |
| `Notification` | 权限请求 / 等待输入等通知；同一会话内 idle 首次提醒，`idleSuppressMin` 分钟内重复 idle 静默 |
| `PreToolUse` / `PostToolUse` / `SessionStart` | 只当作「用户在动」的信号，清除待发标记（没有 UserPromptSubmit 的 agent 靠它取消） |
| `SessionEnd` | 清理本会话状态，并扫掉超过 `cleanupDays` 的旧状态文件 |

## 消息格式

标题 + 三～四行正文；**客户端名在标题里，正文与客户端无关**。内容只定义一次，**各渠道各自渲染**：钉钉/企微走 `markdown`（有加粗与引用条），桌面通知 / Bark / ntfy / 飞书走纯文本（不会把 `**`、`>` 记号印出来）。

钉钉 / 企业微信渲染后：

```
**✔ 任务完成 · Claude Code**

> **会话 ID:** 9e4c8bea-628a-43
>
> **状态:** 已完成
>
> **耗时:** 1分35秒
>
> **项目:** D:\ideaProject\seacon-pms-service-parent
```

桌面通知 / 推送类渠道（纯文本）：

```
✔ 任务完成 · Claude Code
会话 ID: 9e4c8bea-628a-43
状态: 已完成
耗时: 1分35秒
项目: D:\ideaProject\seacon-pms-service-parent
```

- 图标按事件区分、量级轻于 emoji：完成 `✔`、权限请求 `❗`、等待输入 `…`；未知类型不加图标（`KIND_ICON` 一处可改，去掉图标就是留空）
- 耗时人类可读（`44秒` / `1分35秒` / `1小时39分`）；**耗时未知时整行省略**，不印「未知」废行
- 通知类事件（权限请求 / 等待输入 / 未知类型）同构：`状态` 行放原始 message，无耗时行
- 会话 ID 取前 16 位

## 多客户端

**客户端名**（标题里的 `· XXX`）三级来源，先命中先用：

1. 注册命令里的 `--app="Claude Code"`（最稳，推荐）
2. 配置 `appName`
3. 环境变量推断（`CLAUDECODE`/`CLAUDE_PROJECT_DIR` → Claude Code；`CODEX_HOME`/`CODEX_SANDBOX` → Codex）

**载荷字段**兼容读取，换 agent 换字段名不会静默失灵：

| 语义 | 接受的键 |
|------|---------|
| 事件名 | `hook_event_name` / `event_name` / `eventName` / `event` / `type` |
| 会话 ID | `session_id` / `sessionId` / `thread_id` / `threadId` / `conversation_id` |
| 工作目录 | `cwd` / `project_path` / `working_dir` / `workdir` … |
| 状态 / 消息 | `status` / `stop_reason` / `reason`；`message` / `text` / `summary` |

**通知类型**：已知类型（`permission_prompt` / `idle_prompt` / `auth_success` / `elicitation_dialog`）按 `notificationTypes` 白名单过滤；**类型缺失或本客户端不认识时照发**，宁可多一条也不漏报。

## 渠道配置

| 渠道 | 需要的字段 | 说明 |
|------|-----------|------|
| `desktop` | 无 | Windows WinRT toast（**留在通知中心，事后能翻到**；调用失败退回托盘气泡），非 win32 平台自动跳过。**系统「通知」总开关关着（设置 → 系统 → 通知，或 `HKCU\...\PushNotifications\ToastEnabled=0`）时命令不报错但屏幕无显示**，用不了就把该渠道 `enabled` 置 false |
| `ntfy` | `url` | `https://ntfy.sh/<随机topic>`，手机装 ntfy App 订阅同一 topic；可自建 |
| `bark` | `url` | `https://api.day.app/<deviceKey>`，iOS |
| `dingtalk` | `url` + `secret` | 群机器人加签：`timestamp`(毫秒) 与 HMAC-SHA256(`secret`, `ts\nsecret`) |
| `feishu` | `url` + `secret` | 加签口径与钉钉不同：密钥是 `ts\nsecret`（秒级时间戳），待签内容为空串 |
| `wecom` | `url` | 群机器人 webhook，key 在 url 里 |

`delaySec` 逐渠道独立配置，`enabled` 关掉即跳过；未填 `url` 的渠道自动跳过，不会报错。

## 安装

```powershell
# 1. 拷到任一固定绝对路径（本机约定 ~/.claude/，Claude 与 Codex 都引用这里）
Copy-Item notify-hook.js C:\Users\<你>\.claude\
Copy-Item notify-config.example.json C:\Users\<你>\.claude\notify-config.json   # 填好自己的 url/secret
```

2. 注册 hooks（**这两个文件都含个人凭据，永不入库**）：

Claude Code `~/.claude/settings.json`：

```json
"hooks": {
  "UserPromptSubmit": [ { "hooks": [ { "type": "command", "command": "node \"C:\\Users\\<你>\\.claude\\notify-hook.js\" --app=\"Claude Code\"" } ] } ],
  "Stop":             [ { "hooks": [ { "type": "command", "command": "node \"C:\\Users\\<你>\\.claude\\notify-hook.js\" --app=\"Claude Code\"" } ] } ],
  "Notification":     [ { "hooks": [ { "type": "command", "command": "node \"C:\\Users\\<你>\\.claude\\notify-hook.js\" --app=\"Claude Code\"" } ] } ],
  "SessionEnd":       [ { "hooks": [ { "type": "command", "command": "node \"C:\\Users\\<你>\\.claude\\notify-hook.js\" --app=\"Claude Code\"" } ] } ]
}
```

Codex `~/.codex/hooks.json`（命令换成 `--app="Codex"`，其余同上；改完需在 Codex 里 `/hooks` 复核信任）：

```json
"hooks": {
  "UserPromptSubmit": [ { "hooks": [ { "type": "command", "command": "node \"C:\\Users\\<你>\\.claude\\notify-hook.js\" --app=\"Codex\"" } ] } ],
  "Stop":             [ { "hooks": [ { "type": "command", "command": "node \"C:\\Users\\<你>\\.claude\\notify-hook.js\" --app=\"Codex\"" } ] } ]
}
```

3. 自检（把已启用渠道各打一遍，打印返回码；有失败渠道退出码为 1）：

```powershell
node $env:USERPROFILE\.claude\notify-hook.js --app="Claude Code" --test
```

4. 回归验证：`node notify-hook.test.js`，期望 `ALL PASS (32 cases)`。

## 命令行与配置查找

| 参数 | 作用 |
|------|------|
| `--app=<名称>` | 标题里的客户端名（也可用配置 `appName`） |
| `--config=<路径>` | 指定配置文件；等价于环境变量 `NOTIFY_CONFIG` |
| `--test` | 自检发送，忽略 `delaySec`、不写 pending |
| `--job=<文件>` | 内部分离子进程入口，勿手动调用 |

配置查找顺序：`--config=` > `NOTIFY_CONFIG` > `~/.claude/notify-config.json`（都没有则用内置默认值）。状态目录默认 `~/.claude/notify-state/`（配置 `stateDir` 可改），多客户端共用一个目录没有冲突（键是会话 ID）；配置缺失/损坏一律回落默认值，不报错。

## 维护约定

本目录是**源**；`~/.claude/` 下是**生效副本**。修改流程：改本目录 → 跑测试全绿 → commit → 拷回 `~/.claude/`（Claude 与 Codex 共用这一个副本）。

## 已知局限

- 桌面通知走 WinRT toast（`ToastGeneric` 两段文本，标题 + 正文），会留在 Windows 通知中心；调用失败退回 9 秒托盘气泡。二者都受系统通知总开关管辖：开关关着时命令成功但屏幕上什么都没有。只实现了 Windows，其他平台该渠道跳过。
- 兜底渠道靠分离子进程 `setTimeout` 排队，机器重启/关机则排队丢失（不会补发）——兜底本就允许丢，快渠道在事件当时已发。
- node 的 HTTP 请求不读系统代理；若某渠道需经代理访问，得单独配代理（当前未实现）。
- 企业微信文本消息上限 2048 字节，超长内容会被截断（本钩子消息很短，未做处理）。
- idle 抑制按会话记录，多会话并行时各自独立。
- 客户端名靠 `--app` 显式传入最可靠；环境变量推断只覆盖 Claude Code / Codex 两家的已知变量名。
