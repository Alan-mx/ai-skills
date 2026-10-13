# ai-skills

个人 AI 编程工作流 skills 源（Claude Code / Codex / cc-switch 通用）。

## Skills 索引

| Skill | 用途 |
|---|---|
| [dev-flow](./dev-flow/) | 开发流程关口。新需求 G1-G6：需求澄清 → 规格（EARS 验收标准）→ 先设计表再设计接口 → 逐接口垂直实现 → 收敛验证；修 bug B1-B3：根因四阶段 → 最小修复 → 验证（verified/partial/failed）；G3.5 工作量评估：人+AI 协作口径、条目 0.2~1 天、+1 天缓冲，核心输出预计完成日期。借鉴 obra/superpowers `v7.0.0` 与 github/spec-kit `v1.1.3`，版本基准见 SKILL.md 末尾「借鉴来源」。 |
| [agents-template.md](./agents-template.md) | AGENTS.md 骨架模板。新仓库起步用：拷到仓库根改名为 AGENTS.md，填 `{{占位符}}`、删不适用节。通用节（总原则/分层/事务/编码口径/字段链路/Git/验证/禁止清单）已固化，领域硬规则留占位。由 pms 与 ship-shore-sync 两份实战版提炼（2026-10-10）。 |
| [guard](./guard/) | claude-guard-hook：Windows/Git Bash 的 Claude Code PreToolUse 安全钩子（DB 只读/密钥读取与搬运/cwd 外只读/回收站删除引导，115 用例回归）。`~/.claude/` 下为生效副本，本目录为源；settings.json 含凭据永不入库。 |
| [notify](./notify/) | claude-notify-hook：任务提醒钩子（Stop/Notification/UserPromptSubmit/SessionEnd 四事件）。单文件 node 零依赖，分级推送（桌面/ntfy/Bark 秒级 → 钉钉/飞书/企微延迟兜底）+ 响应即取消（用户一发消息即作废排队中的兜底推送），23 用例回归。配置 `~/.claude/notify-config.json` 含 webhook 凭据，永不入库。 |

## 安装

- **Claude Code skill**：把 skill 文件夹拷到 `~/.claude/skills/`（用户级，全部项目生效）或项目 `.claude/skills/`（单项目）
- **Codex**：拷到 `~/.codex/skills/`
- **cc-switch**：Skills 管理 → 从 GitHub 仓库安装，勾选同步目标工具
- **钩子（guard / notify）**：不是 skill，拷 `*.js` 到 `~/.claude/` 后在 `~/.claude/settings.json` 注册 hooks；各目录 README 有完整片段

## 维护约定

本仓库是**源**；各机器的 skills 目录是**生效副本**。修改流程：改本仓库 → commit → 手动同步到各生效目录（或经 cc-switch 重新安装）。skill 的 description 决定自动触发时机，改动时注意保持触发词覆盖（新需求 / PRD / bug 等自然说法）。
