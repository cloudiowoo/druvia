# Druvia Documentation Rules

## Placement

- 设计与实施文档统一放 `docs/plans/`。
- Codex 项目记忆放 `docs/agent/`。
- 项目进展摘要放 `docs/progress.md`。
- 模块特有规则优先写对应子目录 `AGENTS.md`。

## Naming

- `docs/plans` 文件名使用：`YYYY-MM-DD-topic.md`
- topic 使用英文短语和连字符
- 一个主题的 design / implementation 文档允许成对出现

## Update Triggers

以下情况至少更新一处文档：

- 权限模型变化
- 迁移兼容结论变化
- 新的高频踩坑出现
- 新增模块级工作约束

以下情况应考虑更新 `docs/progress.md`：

- 某阶段目标完成
- 形成新的阶段性结论
- 影响多个子项目的任务完成或阻塞解除
- 用户显式发送 `/update_progress` 或 `/sync_memory`

## Priority

更新顺序建议：

1. 代码
2. `docs/agent/project-memory.md` 或 `docs/progress.md`
3. 必要时 `docs/agent/design-decisions.md`
4. 必要时对应模块 `AGENTS.md`
5. 如需完整背景，再新增 `docs/plans/*`
