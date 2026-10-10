# ai-skills

个人 AI 编程工作流 skills 源（Claude Code / Codex / cc-switch 通用）。

## Skills 索引

| Skill | 用途 |
|---|---|
| [dev-flow](./dev-flow/) | 开发流程关口。新需求 G1-G6：需求澄清 → 规格（EARS 验收标准）→ 先设计表再设计接口 → 逐接口垂直实现 → 收敛验证；修 bug B1-B3：根因四阶段 → 最小修复 → 验证（verified/partial/failed）。借鉴 obra/superpowers `v7.0.0` 与 github/spec-kit `v1.1.3`，版本基准见 SKILL.md 末尾「借鉴来源」。 |
| [agents-template.md](./agents-template.md) | AGENTS.md 骨架模板。新仓库起步用：拷到仓库根改名为 AGENTS.md，填 `{{占位符}}`、删不适用节。通用节（总原则/分层/事务/编码口径/字段链路/Git/验证/禁止清单）已固化，领域硬规则留占位。由 pms 与 ship-shore-sync 两份实战版提炼（2026-10-10）。 |

## 安装

- **Claude Code**：把 skill 文件夹拷到 `~/.claude/skills/`（用户级，全部项目生效）或项目 `.claude/skills/`（单项目）
- **Codex**：拷到 `~/.codex/skills/`
- **cc-switch**：Skills 管理 → 从 GitHub 仓库安装，勾选同步目标工具

## 维护约定

本仓库是**源**；各机器的 skills 目录是**生效副本**。修改流程：改本仓库 → commit → 手动同步到各生效目录（或经 cc-switch 重新安装）。skill 的 description 决定自动触发时机，改动时注意保持触发词覆盖（新需求 / PRD / bug 等自然说法）。
