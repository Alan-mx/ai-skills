---
name: freebuff-delegate
description: 将明确授权且可隔离的编码子任务交给本机 Freebuff CLI 执行，再独立复核改动与验证结果；仅在用户明确要求使用 Freebuff 或调用 $freebuff-delegate 时启用。
---

# Freebuff 委派

把 Freebuff 当作受监督的外部编码执行者，而不是可信的最终决策者。Codex 负责界定任务、控制数据边界、检查改动并给出验证证据。

## 启用边界

- 只在用户明确要求“用 Freebuff”或调用 `$freebuff-delegate` 时启用，不因任务类型相似而自动改用 Freebuff。
- 启动前确认任务范围清楚、目标目录明确、验收方式可执行。范围过大时先拆成可独立审查的子任务。
- Freebuff 界面明确提示可能将数据用于 AI 训练。不要把凭据、私钥、生产令牌、客户隐私数据、数据库导出或未获授权的私有代码交给它；不确定时先问用户。
- 额度绑定 Freebuff 账号和当前网络。启动后查看界面显示的剩余 Freebucks 与可用模式，并向用户说明本次委派会消耗同一份额度。

## 启动前

1. 运行 `Get-Command freebuff` 和 `freebuff --version`。若命令不存在，停止并说明；若要求登录，让用户完成登录，不代填或读取凭据。
2. 优先在独立 Git worktree 或专用临时目录中执行。若必须在现有目录执行，先记录 `git status --short`、当前提交和已有改动，不能把用户原有改动误归因于 Freebuff。
3. 检查目标仓库是否含 `.agents` 或 `mcp.json`。不要主动使用 `--trust-agents`；只有用户明确授权且已确认这些配置可信时才加该参数。
4. 给 Freebuff 的任务提示至少包含：
   - 目标、非目标、相关文件或模块。
   - 当前仓库的构建、测试和静态检查命令。
   - “不要 commit、push、改无关文件、访问凭据或扩大范围”。
   - 遇到阻塞先报告，不猜测；完成后列出改动文件和已执行的验证命令。

## PTY 交互

Freebuff 是交互式 TUI，没有稳定的一次性 prompt 参数。

1. 用 `exec_command` 启动长驻 PTY：

   ```text
   freebuff --cwd <绝对路径>
   ```

2. 用 `write_stdin` 发送任务，按界面的实际提示继续交互。需要继续已有会话时，按帮助信息使用 `freebuff --continue [conversation-id]`。
3. 把连续输出视为过程信息，不把 Freebuff 的“完成”声明当作证据。若它提出问题，只在用户已授权的范围内回答；涉及敏感数据、扩大范围或外部副作用时回到用户确认。
4. 优先用界面的 `/exit` 命令退出。若 TUI 未退出，只终止本次 Freebuff 子进程，不终止无关 Node 或其他 Agent 进程。

## 独立复核

- 对比启动前后的 `git status` 和 `git diff`，确认改动只落在授权范围。
- 阅读实际差异，检查逻辑、兼容性、安全和越界修改；不要仅复述 Freebuff 的总结。
- 运行仓库原有构建、测试或最小可复现验证。无法验证时明确标记 `partial` 或 `failed`，不要声称完成。
- 在隔离 worktree 中，如发现 Freebuff 改坏了非目标内容，可只回退它造成的改动；在共享目录中不得自行回退来源不明或用户已有的改动。
- 汇报以下内容：Freebuff 实际改动、Codex 独立验证证据、未验证项、额度与数据边界风险、是否需要用户继续决策。

## Git 边界

Freebuff 和本 skill 都不得自行 commit 或 push。除非用户在当前任务中单独明确授权，只保留工作区改动并汇报。
