# Windows ConPTY 实操

仅在使用 Windows 或需要排查包装器问题时读取本文件。主 skill 默认使用 `scripts/freebuff_conpty.py`；`SendInput` 是最后兜底。

## 一次性准备

```powershell
python scripts/freebuff_conpty.py setup
```

脚本默认把 `pywinpty` 安装到 `~/.freebuff-conpty-deps`。可用 `FREEBUFF_CONPTY_DEPS` 指定其他目录。

## 标准流程

```powershell
python scripts/freebuff_conpty.py start --cwd "C:\repo"
python scripts/freebuff_conpty.py status --tail 12
python scripts/freebuff_conpty.py send --text "/model"
python scripts/freebuff_conpty.py key enter
python scripts/freebuff_conpty.py status --tail 20
python scripts/freebuff_conpty.py key down
python scripts/freebuff_conpty.py key enter
python scripts/freebuff_conpty.py send --text-file "C:\task-packet.txt"
python scripts/freebuff_conpty.py key enter
python scripts/freebuff_conpty.py wait --idle-ms 5000 --timeout 3600
python scripts/freebuff_conpty.py status --tail 20
python scripts/freebuff_conpty.py send --text "/end-session"
python scripts/freebuff_conpty.py key enter
python scripts/freebuff_conpty.py stop
```

- `start` 会拒绝在已有 `freebuff.exe` 运行时再启动。
- `start` 不会发送第一条消息，因此尚未开始计费。
- `send` 发送文本。长任务实测用 `send` 后再单独 `key enter` 更可靠；`--enter` 仅作为简单文本的实验选项。`key` 支持 `enter/esc/up/down/left/right/tab/backspace/ctrl-c`。
- `status --tail` 返回净化后的屏幕尾部，不返回完整 ANSI 重绘流。
- `wait` 默认在输出空闲 3 秒或进程结束时返回。
- `stop` 只结束本包装器创建的本地进程树，不等于服务端 `End session`；不退款，倒计时也不暂停。
- `/end-session` 或界面 `✕ End session` 才会结束服务端会话，并按实际使用结算、退回未使用积分。

如果会话目录由主控显式指定，可给每条命令加 `--session <session_dir>`；否则使用最近一次会话。

## 模型前置

第一条消息开始计费且占用会话。任务下发前：

1. 通过包装器发送 `/model`，再发送一次 `key enter` 执行命令。
2. 用 `status --tail` 查看模型列表。
3. 用 `key down/up` 调整选择，再发送 `key enter` 确认。
4. 确认界面显示的模型、额度和连接模式后，发送任务文本，再单独发送 `key enter` 提交。

模型选择方式随 Freebuff UI 变化；若包装器无法可靠确认，停止自动化并让用户手动确认。

## 会话观察

Freebuff 本地会话文件通常位于：

```text
~/.config/manicode/projects/<project>/chats/<timestamp>/
  chat-messages.json
  log.jsonl
  run-state.json
```

用途：

- 判断进行到哪里、是否报错、是否结束。
- `log.jsonl` 可查 `Main prompt finished`、`Agent execution failed` 等事件。
- 这些文件是 Freebuff 内部格式，可能变化；只用于观察，不用于宣告完成。

## 网络中断恢复

常见错误为 `unknown certificate verification error`，日志通常依次出现：

```text
Agent execution failed
Main prompt finished ... outputType: 'error'
Processing lock released
```

会话仍在时，重发同一条消息即可继续，不必重开会话。

## 其他实测事项

- 启动器可能自动更新 Freebuff；更新完成后才能稳定启动。
- 面板显示 `Your first message starts the session` 时，尚未计费。
- 会话运行时输入可能排队；`--continue` 可续接已有会话。
- 实测只执行 `stop` 后，积分仍为 `10/25`，重新启动会显示 `Session active`；本地进程关闭期间仍按真实时间倒计时。随后执行 `/end-session`，余额从 `10/25` 回到 `24/25`，界面恢复为 `Your first message starts the session`，证明服务端会话结束并退还了未使用积分。
- 包装器直接运行 `~/.config/manicode/freebuff.exe`，绕过启动器更新检查；需要更新时先正常运行一次 `freebuff`。
- 派发测试型任务前先确认 `python`、`node` 等命令指向真实运行时；Windows Store 别名可能返回 `exit 49`，会浪费会话时间。任务包优先写明确的解释器路径或预先修正 PATH。
- `raw.log` 可能包含提示词、代码和广告。命中敏感内容时，任务结束后删除对应会话目录。

## SendInput 兜底

只有包装器不可用且用户明确接受时才使用：

1. 用户手动启动 Freebuff 并选好模型。
2. 每次发送前确认目标窗口句柄和当前前台窗口一致；不一致就停止，不进行盲发。
3. 用 `KEYEVENTF_UNICODE` 发送文本，回车使用 `VK_RETURN`，每块约 25 字符、间隔 100–150ms。
4. 一旦焦点不确定、用户开始操作其他窗口或发送结果无法从会话状态确认，立即停止自动化。

不要把 `SendInput` 作为默认路径；窗口切换时全局按键可能进入其他程序。

## 隐私执行步骤

- 给 Freebuff 专用临时工作目录，不放真实个人资料、凭据或客户数据。
- 个人信息默认禁止委派；样本先脱敏，再扫描复核姓名、手机号、证件号、住址、学号/工号、学校/单位和账号标识。
- 其他非个人信息可按用户授权和仓库规则委派；凭据、私钥、生产令牌和数据库导出仍禁止。
- 派单文本明确禁止读写工作目录之外的路径。
- `raw.log` 和 Freebuff 会话目录可能保留提示词与代码；任务结束后按需要清理本次会话目录。
