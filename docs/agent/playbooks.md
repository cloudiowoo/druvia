# Druvia Playbooks

常用操作手册。用于新会话快速恢复高频验证和排查动作。

## 运行常用验证

- API 定向构建：
  - `pnpm --filter @druvia/api build`
- Functions 相关单测：
  - `pnpm test tests/unit/functions-controller.test.ts tests/unit/functions-service.test.ts tests/unit/api-app.test.ts`
- Admin 侧 invoke auth helper 单测：
  - `pnpm test tests/unit/admin/function-invoke-auth-mode.test.ts`

## 数据库迁移

- 执行全部未应用迁移：
  - `pnpm --filter @druvia/api exec node --import tsx/esm src/cli/migrate.ts up`

## Functions invoke 配置排查

如果在 Admin UI 更新函数时报 500，并带有：

- `column "invoke_auth_mode" of relation "druvia_functions" does not exist`

优先结论：

- 后端字段已接入
- 数据库缺少 `015_function_invoke_auth_mode` 迁移

先执行迁移，再重试页面保存。

## 文档回填手册

发生下列情况后，记得同步文档：

- 权限模型变化：更新 `docs/agent/project-memory.md`
- 长期架构决策变化：更新 `docs/agent/design-decisions.md`
- 新模块局部规则变化：更新对应子目录 `AGENTS.md`
- 完整设计或实施过程：新增 `docs/plans/YYYY-MM-DD-*.md`
