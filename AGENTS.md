# Druvia Agent Notes

Codex 在本仓库的根级工作说明。进入子目录后，继续读取最近的局部 `AGENTS.md`；局部规则覆盖同主题的根规则。

## Product

- Druvia 是面向中文开发者的自托管 BaaS，体验目标接近 Supabase，底层以 Hasura GraphQL/Subscriptions 为核心。
- 当前产品默认按“单租户 + 多项目”理解；多租户能力保留为远期企业版方向。
- 当前阶段是 MVP 后的生产加固与迁移兼容，不应把“已有界面或接口”直接表述为生产能力已经闭环。

## Architecture

- `apps/admin`: Next.js 16 + React 19 管理后台
- `apps/api`: Fastify 5 管理层 API
- `apps/updater`: Docker Compose 在线升级控制面
- `packages/sdk`: `@druvia/sdk`
- `packages/mcp-server`: 实验性 MCP Server 原型（非生产运行链路）
- `packages/shared`: 共享类型与工具
- `hasura/metadata`: Hasura metadata
- `migrations`: SQL 迁移
- `docker`: Docker Compose、nginx、Deno worker、独立 Registry 部署包

技术底座为 Node.js 22、PostgreSQL 17、Hasura CE、Redis 7、Deno Worker、pnpm 和 turbo。

## Data And Identity

- 平台核心元数据位于 `public` schema。
- 业务数据按 tenant/project schema 隔离，当前实际运行更接近 Schema-per-Project。
- 权限主要依赖 Hasura permissions，不依赖 PostgreSQL RLS。
- 平台用户、项目终端用户、匿名项目 API key、trusted backend key 是不同身份边界，不得在新代码中合并语义。
- 平台角色 `admin` 只表示可登录管理后台，不自动获得 workspace 或项目权限；项目管理权限必须由数据库当前 `super_admin`、workspace `owner_uid` 或 migration `022` 的项目成员关系解析，并由路由声明固定 capability。
- Project User、项目 API Key 和 Trusted Backend Key 不得进入平台项目成员 RBAC；平台项目成员资格也不得赋予应用 GraphQL、Realtime token 或 SDK 数据凭证能力。
- Project Data Access Batch 3A/3B 后，公开项目 GraphQL 和 Realtime token exchange 只接受同项目 `project_user` / `apikey`；平台 session 不能作为应用数据凭证，SDK 也不得把长期项目凭证直传 Hasura。
- Project Data Access Batch 4 后，已有 compatibility 项目只能通过迁移 `019` 支撑的预检/apply/recovery/rollback 状态机激活；不得直接修改 `data_access_mode`，不得绕过相关管理写锁。
- migration `023` 后，表级 Data Access 受管状态以持久 baseline、显式列 grants 和 policy operation 为准；baseline 与 operation 必须绑定创建时的项目 schema，operation 的 schema 身份不可变。没有 provenance 的 scoped permission 必须先 adoption，新增列默认不授权，真实 custom/legacy/external role 不得被 reconcile 覆盖。
- migration `025` 后，Apple Project User 自助删除以 PostgreSQL operation/fence 为唯一事实源；删除目标只能来自当前 Project Session，接受后旧 Session/refresh/login 必须失败关闭。业务清理由项目 schema 中通过静态安全检查的固定函数负责，API 内执行器只清理 Druvia Storage、Project User/identity 和最小 Provider revoke material。删除执行、Apple revoke、新 identity generation 与 project schema restore 必须共享项目锁；restore 开放项目前必须重放全部已 accepted fence。
- migration `026` 后，设备擦除采用 Druvia 平台凭证/签名投递与项目业务 obligation 分离模型：注册 owner 只能来自同项目 Project Session；sessionless 查询只接受独立 binding handle/token；原始 binding identity、lookup token 和私钥不得持久化明文或进入日志，query、编码或畸形 URL 中的 handle 也必须在访问日志序列化前移除。Project User ID 只允许作为 `SECRETS_ENCRYPTION_KEY` 保护的注册恢复材料持久化，不得写入日志或公开响应。项目 schema 通过三条固定安全 Hook 维护业务关系，Druvia 保存不可变签名快照和回执恢复围栏。Hook owner 当前必须隔离到单一项目 schema，不能继承其他角色，也不能被任何非 superuser 角色直接或间接继承；同时不得拥有 `REPLICATION`，或借助其他业务 schema 的 relation/column/sequence/CREATE/`SECURITY DEFINER` 权限越权。所有 Device Wipe 写入/Hook 路径与 project schema restore 必须共享 project-auth 项目锁，并在锁后以同一连接检查 runtime gate；restore 清除 gate 前必须按 identity/revision 重放 binding 注册，再依次重放账户删除 fence 和 acknowledged receipt，并在每一阶段复验 Hook 快照。设备擦除注册与 sessionless 查询限流必须用单条 Redis 原子脚本建立或修复 TTL，不得拆分 `INCR`/`EXPIRE`。
- migration `029` 后，项目受管服务环境只存于 `druvia_project_runtime_contexts`，并以 `druvia_project_runtime_context_fences` 保留首次启用围栏；无记录保持兼容行为。仅项目 owner、workspace owner 或 super admin 可写入 allow-listed 的 `local / sandbox / testflight / production`，更新必须审计。RPC 仅在同一事务内写入 `druvia.service_environment`；GraphQL、Functions、Realtime 与 Data Access verifier 只使用服务端从该表派生的 `x-hasura-druvia-service-environment`，公开 nginx 路径必须清除客户端同名 Header。读取损坏或不可用时 fail closed，不能退回数据库全局默认值；已签发 Realtime token 在刷新前仍保持旧 claim。
- Project GraphQL Actor Contract v1 通过服务端派生的 `x-hasura-druvia-actor-*` session variables 让 Hasura 所执行的 trigger、`SECURITY DEFINER` 和权限函数读取版本、actor type/source、项目和 Project User 身份；Project Session 固定为 `project_user / project_session`。它不是 API RPC 的 `druvia.actor` GUC，数据库 GraphQL 路径必须从 `current_setting('hasura.user', true)::jsonb` 读取。公开 GraphQL/WS nginx 路径必须清除全部合同 Header，functions-capable local、prod/release 都不得发布 Hasura host port；Deno Function worker 不得与 Hasura 共享 Docker 网络，API 是唯一可连接 Functions 网络与 Hasura 核心网络的桥接服务；Data Access verifier 不得伪造 `project_session` 合同。
- RPC 与 Functions 共用版本化 `ProjectActorContext`；SDK 的 RPC/Functions 只选择 Project Session 或项目 API Key，不得隐式回退 Platform Session。Functions 内部 GraphQL 必须使用服务端派生的 Hasura role/session variables，Platform User 不具备该应用数据能力。
- 直接 Storage 对象路由已完成 Project User cutover：bucket 使用 `admin_only / owner_only / authenticated_read` 三种预设，对象以 `owner_project_user_id` 判定所有权；公开下载是独立开关，trusted ticket/Functions 是独立 capability。
- SDK 直接 Storage 只选择 Project Session 或项目 API Key，不得使用 Platform Session；trusted ticket 方法只发送显式 trusted/ticket header。
- 改权限、GraphQL 代理、Realtime、Storage、Functions 或 SDK Auth 返回结构时，必须检查 Supabase 迁移和 taro-app 兼容路径。

## Current Priorities

1. 以真实 taro-app/H5/小程序完成 Project Auth、GraphQL、Realtime、Storage、RPC 和 Functions 全链路及生产上线验收，只修复实际阻塞、安全或正确性缺口。
2. 为 taro-app stable 基线补齐确定性的 build/lint/核心测试、migration、备份、健康检查和恢复门禁，再进入实际发布窗口。
3. 继续补齐真实迁移暴露的 SDK 能力，避免以抽象完整性替代迁移验证；足球应用、Swift、Recipe 和 Phase D 不阻塞 taro-app 上线。

完整现状和分阶段建议见 `docs/plans/2026-08-14-project-update-direction-analysis.md`。

## Repository Rules

- 修改前先读取当前目录链上的最近 `AGENTS.md`；模块规则放在最接近代码的目录，不堆入根文档。
- 优先相信当前代码与测试；文档冲突时，修正文档，不按过期叙事修改代码。
- 不要把 provider、adapter、路由或 UI 占位误判为完整可用。
- 权限和认证变更默认采用安全值；匿名能力必须按功能显式允许。
- 数据库结构变化必须同时检查 migration、Hasura metadata、回滚策略和旧部署升级路径。
- 发布与 OTA 改动必须检查 GHCR、自建 Registry、本地 release 演练和生产部署四条路径。
- 包含表级 managed-policy reconcile、可恢复表删除、Project Account Self-Deletion、Device Wipe Mandates、Data Access v2 授权投影或 Project Runtime Context 的 API/Admin 启动前必须应用 migration `023`、`024`、`025`、`026`、`027`、`028`、`029`，release manifest migration ceiling 不得低于 `29`。首次发布 migration `027` 前必须先完成 rollback-gate capable updater `0.2.0` bootstrap；bootstrap 只能复用指定旧稳定 release 的不可变 manifest/Compose/digest、不得成为 GitHub latest，客户端只能临时使用显式版本 manifest URL；migration `027+` manifest 的 `minUpdaterVersion` 不得低于 `0.2.0`。文件回滚必须先停止 API/Admin/Worker、持久启用 `file_rollback` gate 并排空写入、检查 v2 状态，再以独立 PostgreSQL session 的全局 exclusive advisory lock 覆盖旧文件恢复与 pre-027 服务健康验证；恢复失败时旧服务必须停止且 gate/holder 保持，不能用手工清除代替恢复。
- 生产启用 migration `025` 对应 API 前必须配置并备份彼此独立的 `ACCOUNT_DELETION_STATUS_SECRET`、`ACCOUNT_DELETION_FENCE_SECRET`，且不得与身份、Hasura、Functions、Worker 或 Storage 签名密钥复用。项目 schema restore 必须先写 runtime gate 并重放 fence；外部 deletion ledger 未实现前不得宣称整库灾难恢复可阻止旧账户复活。
- 启用 migration `026` 对应项目能力前必须配置并稳定备份彼此独立的 `DEVICE_WIPE_BINDING_SECRET`、`DEVICE_WIPE_CREDENTIAL_SECRET` 和原 `SECRETS_ENCRYPTION_KEY`；三者丢失或替换都会破坏既有 binding 查询、签名私钥或注册恢复材料，不能靠重置配置修复。
- Phase 开发、镜像构建、stable release 和生产 OTA 是独立动作；生产只跟随通过 taro-app 兼容回归的 stable manifest，并由运维人工 apply。
- release workflow 必须由 SemVer 后缀推导并校验 stable/beta/nightly；非 stable GitHub Release 必须标记为 prerelease，不得覆盖生产使用的 `releases/latest/download` stable manifest。
- release 版本与 channel 必须在登录 Registry 或 push 镜像前通过统一的严格 SemVer 预检；预发布首段只接受 `beta` 或 `nightly`，后续标识只接受数字，`alpha`、`rc`、`preview` 及混合通道后缀必须失败。manifest 生成必须复用同一校验，禁止产生 `latest` 等非版本 tag 或版本/channel 矛盾的发布物。
- `packages/mcp-server` 当前只保留实验性原型；在明确管理型或项目型身份、完成真实 API 契约测试并解除私有包状态前，不得宣称可发布或用于生产。
- 不提交非 example 的 `.env` 配置、Registry 凭证、证书、数据库/Redis/Storage 运行数据或生产绝对路径。
- 保留用户已有未提交改动；不要使用破坏性 Git 命令。

## Subagent Collaboration

- 主 agent 对需求理解、实施计划、代码集成、最终验证和文档同步负责；子 agent 只承担边界清晰、可独立完成的辅助任务。
- 简单任务、强顺序任务和当前主流程的阻塞任务由主 agent 直接处理；不得为每个子任务机械启动 agent 或设置检查点。
- 仅在任务可并行、需要独立证据或需要专项复核时调用子 agent；同时运行不得超过全局配置的 3 个。
- `scout` 用于快速定位文件和符号；`explorer` 用于跨模块调用链与边界分析；`docs_researcher` 用于核对当前官方文档。
- 不得为同一问题同时调用职责重叠的子 agent；优先选择能够完成任务的最轻量角色。
- 常规变更完成后可调用 `reviewer`；身份权限、数据库迁移、数据完整性、发布或 OTA 等高风险变更使用 `critical_reviewer`。
- Druvia 默认由主 agent 在当前主工作区实施。`worker` 仅在用户明确授权并行实现，且需求、允许修改范围和验收条件已经明确时使用；任务之间的写入文件必须互斥，不得创建或依赖 `.worktrees`。
- 子 agent 必须遵守根目录及目标模块最近的 `AGENTS.md`，不得继续派生子 agent，不得覆盖已有未提交内容、扩大任务范围、commit、push 或修改外部系统。
- 主 agent 必须复核子 agent 的结论和改动；子 agent 的完成报告不能替代主流程的测试、review 和最终验证。
- 用户明确要求“不使用子 agent”或“直接在本会话处理”时，不得委派。

## Documentation Model

- `AGENTS.md`: Codex 自动发现的工作约束；根文件保存仓库级规则，局部文件保存子树规则。
- `docs/agent/design-decisions.md`: 已确认、应长期遵守的架构与安全决策。
- `docs/agent/playbooks.md`: 可重复执行的维护流程。
- `docs/progress.md`: 人类可读的阶段状态和下一步。
- `docs/plans/YYYY-MM-DD-*.md`: 日期化功能文档；同一功能的目标、设计决策、实施步骤、验收标准、验证证据和最终状态必须合并在同一文件中。
- `.agents/skills/*`: Codex 按需发现的仓库级可复用工作流；不能替代 `AGENTS.md` 的常驻作用域规则。
- `.claude/*` 仅为兼容现有 Claude 工作流，不是 Codex 的事实来源。

无论使用 Codex、Superpowers 或其他 agent 工作流，新功能都不得创建 `docs/superpowers`、`specs/plans` 双目录或独立的 `*-design.md` / `*-implementation.md` 配对文档。需要规划时，在 `docs/plans` 创建一份综合文档，并在实施过程中持续更新同一文件；历史拆分文档可以保留，但不得作为新文档模板。

仓库不维护额外的 `project-memory.md`。新事实必须按上述职责落入最近的 `AGENTS.md`、长期决策、进度或日期化文档，避免并行事实源漂移。

## Useful Files

- `docs/agent/design-decisions.md`
- `docs/agent/playbooks.md`
- `docs/progress.md`
- `docs/plans/2026-08-14-project-update-direction-analysis.md`
- `.agents/skills/druvia-doc-update/SKILL.md`
- `.agents/skills/taro-migration-memory/SKILL.md`
- `docs/platform-logging-guide.md`
