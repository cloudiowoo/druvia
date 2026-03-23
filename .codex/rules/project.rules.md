# Druvia Project Rules

## Product Framing

- 当前产品默认按“单租户 + 多项目”理解。
- 多租户能力保留，但不是当前默认产品叙事。

## Compatibility

- 涉及 Auth、SDK、GraphQL 代理、Functions 时，优先检查 Supabase / taro-app 迁移影响。
- 不要把“预留接口”误判成“功能已完整可用”。

## Security

- 权限默认从严。
- 匿名能力必须显式开启，不允许因方便迁移而默认放开敏感路径。
- 上传、用户态、后台函数不得因项目级匿名 `apikey` 能力而默认开放。

## Documentation

- 稳定事实放 `AGENTS.md` 与 `docs/agent/*`。
- 任务进度与阶段性里程碑放 `docs/progress.md`。
- 完整方案和过程放 `docs/plans/*`。
- 保留 `.claude/*`，但 Codex 的新增沉淀优先写入 `docs/agent/*`。
- 不要在每个小修任务后机械更新项目记忆或进度文档；优先遵循 `.codex/rules/memory-sync.rules.md` 中的触发条件。
