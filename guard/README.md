# claude-guard-hook

Windows / Git Bash 环境下的 PreToolUse 安全钩子（个人安全基线，与 `permissions.deny` 分层配合：deny 管前缀稳定的灾难级动作，钩子管模糊/组合场景）。

**通用**：任何实现 Claude Code hook 协议的宿主都能挂（Claude Code、Codex CLI 已实测同源——Codex 二进制内含 `hookSpecificOutput` / `permissionDecision` / `hook_event_name` 等同一套协议字段）。

- **输入字段容错**：`tool_name|toolName|tool|capability`、`tool_input|input|arguments|args`、`cwd|working_dir|workdir`；工具名缺失时不跳过，按「有命令就分析」处理（fail-safe）
- **shell 工具名按集合识别**：`Bash` / `shell` / `local_shell` / `shell_command` / `run_command` / `exec` / `terminal`（归一化后比对，忽略大小写与 `_`/`-`）；明确非 shell 类工具直接放行
- **输出同时给两种拦截形状**：`decision:block` + `reason`（旧写法，Claude Code 与 Codex 都认）与 `hookSpecificOutput.permissionDecision:deny` + `permissionDecisionReason`（新写法），哪家认哪种都能拦住，reason 必非空（Codex 会校验 deny 必须带非空 reason）

## 拦截范围（2026-10-13 版，127 用例 + 输出形状全绿）

- **数据库严格只读**：mysql/psql/sqlite 等经 CLI 时只放行 SELECT/SHOW/EXPLAIN/DESCRIBE；`mysql < file`、`cat x | mysql`、source 全拦
- **受控操作**：mvn/mvnw deploy（任意调用路径）、docker push、npm 全局安装（install/i/add -g）
- **远程脚本**：curl/wget | bash/sh
- **密钥读取与搬运**：读类命令（cat/grep/sed…）与搬运类命令（cp/mv/scp/rsync/tar/zip…）命中密钥路径（.env / ~/.ssh / *.pem / application-prod 等）即拦；token 级匹配，搜索模式 `grep "\.env"` 不误拦
- **规则 A（cwd 外只读）**：写/删/移/touch/重定向目标在 cwd 外且非临时区 → 拦；`/dev/null`、`NUL` 等设备白名单
- **规则 B（删除引导回收站）**：cwd 内删除非可重建产物（源码等）→ 拦并给 PowerShell SendToRecycleBin 模板；target/node_modules/*.log 等可重建产物放行

## 安装

```powershell
# 1. 拷贝到 Claude 配置目录
Copy-Item guard-hook.js C:\Users\<你>\.claude\
Copy-Item guard-hook.test.js C:\Users\<你>\.claude\
```

2. 在 `~/.claude/settings.json` 手动加两段（**该文件含个人凭据，永不入库**）：

hooks 注册：

```json
"hooks": {
  "PreToolUse": [
    { "matcher": "Bash", "hooks": [ { "type": "command", "command": "node \"C:\\Users\\<你>\\.claude\\guard-hook.js\"" } ] }
  ]
}
```

Codex 侧 `~/.codex/hooks.json` 同构（matcher 用正则，改完在 Codex 里 `/hooks` 信任）：

```json
"hooks": {
  "PreToolUse": [
    { "matcher": "^Bash$", "hooks": [ { "type": "command", "command": "node \"C:\\Users\\<你>\\.claude\\guard-hook.js\"", "timeout": 10 } ] }
  ]
}
```

deny 清单（灾难级，deny > allow 不可被覆盖）：

```json
"permissions": {
  "deny": [
    "Bash(rm -rf /)", "Bash(rm -rf /*)", "Bash(rm -rf ~)", "Bash(format *)",
    "Bash(git push --force *)", "Bash(git push -f *)", "Bash(git reset --hard *)",
    "Bash(git clean -fd *)", "Bash(git clean -fdx *)",
    "Bash(mysqladmin drop *)", "Bash(mysqladmin shutdown *)",
    "Read(~/.ssh/**)", "Read(**/.env*)", "Read(**/*.pem)"
  ]
}
```

3. 回归验证：`node ~/.claude/guard-hook.test.js`，期望 `ALL PASS (127 cases + 输出形状)`。

## 维护约定

本目录是**源**；`~/.claude/` 下是**生效副本**。修改流程：改本目录 → 跑测试全绿 → commit → 拷回 `~/.claude/`。新规则优先加本钩子，勿往 deny 堆组合变体。

## 已知局限

递归 `grep -r .` 隐式扫到 `.env` 不拦（命令无密钥路径 token）；SQL 字符串字面量内的写关键字可能误杀；`EXPLAIN UPDATE` 误拦；`cd` 不跟踪（结果仍 fail-safe）；引号内含 `|`/`&&` 的分段可能误切（写命令罕见）。命令替换 `$(...)` 内的目标已削尾部标点（2026-10-13 修 `/dev/null)` 被当路径误拦）。设计上意外错误 fail-open，钩子 bug 不会堵死 Bash。
