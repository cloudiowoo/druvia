# 项目数据访问升级操作手册

本文用于将迁移 `018` 后仍处于 `compatibility` 的已有项目升级到项目级数据访问模式。正常操作在 Admin 的“项目设置 -> 数据访问”中完成；Hasura metadata 只用于升级前备份和阻断项的高级处置。

## 上线前提

1. 先完整备份 PostgreSQL，并导出当前 Hasura metadata。
2. 应用数据库迁移 `019_data_access_migrations`，确认 `druvia_data_access_migrations` 存在，再启动包含 Batch 4 的 API/Admin。
3. API 必须能通过内部地址访问 Hasura HTTP 和 WebSocket；`HASURA_JWT_SECRET` 必须与 Hasura verifier 一致。
4. 迁移期间停止直接 SQL DDL、Hasura Console 修改、备份恢复和其他会改变项目 schema/permission 的运维操作。

Hasura v2.48 对 permission command 不支持 `bulk_atomic`。Druvia 只在收到该明确错误时回退到单个 `bulk` 请求；每个阶段随后都会重新导出 metadata 并验证，失败时按持久化快照执行差异恢复。因此迁移期间的安静窗口和完整 metadata 备份仍是必需条件。

示例检查：

```bash
pnpm migrate up
pnpm migrate status
```

发布 manifest 必须把 `019` 标记为所需迁移。`019` 是增量控制面数据，OTA 回滚镜像时不得自动执行它的 down migration。

## Admin 操作流程

1. 打开项目的“设置 -> 数据访问”，点击“生成迁移预检”。
2. 检查每张表的认证用户和匿名读取范围。无法确认旧意图时，可选择“迁移后保持关闭”并重新生成预检。
3. 处理所有阻断项。自定义旧规则、自定义 scoped 规则、重复规则、跨项目角色绑定和不支持的数据对象不会自动改写。
4. 分别确认自动推断和风险收紧项；需要时输入项目别名。
5. 点击“开始升级”，保持页面打开观察持久化阶段。浏览器刷新或代理超时不会取消服务端操作，页面会重新读取当前状态。
6. 完成后分别使用项目 API Key 和 Project Session 验证 GraphQL 与 Realtime 业务路径。

自动迁移只接受 Druvia 历史生成的精确规则。旧匿名 insert/update/delete 会被移除，不会转换为新的匿名写权限；旧认证 select 的 aggregate 能力也会被移除。这两类变化必须显式确认。

## 阻断项处理

先保留完整 metadata 导出，再由熟悉业务权限的管理员处理：

- 能用 Druvia 表级数据访问预设表达的规则，先在表详情中配置目标范围，再重新生成预检。
- 自定义 filter、preset、列范围、Action、Remote Schema、继承角色或高级对象权限不能由简化界面无损表达，当前版本会持续阻断而不会接受“已映射”的 scoped 绑定。应保留项目在兼容模式，或在确认业务影响后移除该能力再迁移；迁移完成后重新增加这些外部绑定会形成 metadata drift，并使既有回滚预检失效。
- 不要直接修改 `druvia_projects.data_access_mode`。该字段只由迁移状态机在验证通过后切换。
- 不要删除迁移记录来解除阻塞；这会丢失恢复依据，并受到数据库 guard 限制。

## 失败与恢复

普通失败会自动恢复迁移前快照和 `compatibility` 模式。若界面出现“恢复迁移前状态”或“恢复升级后状态”，表示自动恢复没有完成：

1. 停止直接 SQL/Console 变更，保留数据库、API 和 Hasura 日志。
2. 确认 PostgreSQL、Hasura HTTP/WebSocket 和签名密钥恢复可用。
3. 在界面输入项目别名并执行对应恢复操作。
4. 恢复完成前，不要删除项目/租户，不要执行 clean restore、全量 metadata 替换或 raw SQL import。

服务端只保存该项目相关 permission 的不可变前后快照，不保存完整 Hasura metadata。若快照恢复仍失败，使用上线前的完整 metadata 备份进行人工处置。

## 回滚风险

“回滚预检”只对最新、未发生 metadata/schema 漂移的已应用迁移开放。回滚会恢复旧 `user` / `anonymous` 权限，可能重新引入跨项目隔离不足、匿名写入和认证 aggregate 能力。执行前必须重新备份，并在回滚后验证旧客户端与数据访问范围。

代码或镜像回滚时保留迁移 `019`。它的 down migration 只用于受控开发重置或永久移除功能，而且会拒绝在存在 active、applied 或 recovery-required 记录时执行。

## 自动化验证

常规发布运行 unit、API 装配、管理写锁和 Admin 回归。真实 PostgreSQL/Hasura 集成测试按需启用：

```bash
DRUVIA_RUN_DATA_ACCESS_MIGRATION_INTEGRATION=1 \
DRUVIA_INTEGRATION_HASURA_ADMIN_SECRET='<running-admin-secret>' \
DRUVIA_INTEGRATION_HASURA_JWT_SECRET='<running-verifier-key>' \
pnpm vitest run tests/integration/data-access-migration.test.ts
```

集成环境必须已应用 `019`，并提供与运行中 Hasura 一致的 admin/JWT secrets。测试创建两个临时项目，验证跨项目隔离、成功 apply/rollback 以及 source/applied 两侧故障恢复；它不会作为无依赖的常规 unit test 静默模拟通过。
