# API Agent Notes

适用于 `apps/api` 目录及其子树。

## 模块职责

- Fastify 管理 API
- 认证、中间件、Functions、RPC、项目管理
- 对 Hasura、数据库迁移、Deno Worker 的管理层编排

## 当前高优先级

- 保持 Supabase / taro-app 迁移兼容
- 细化 `apikey`、Functions、GraphQL 代理权限模型
- 修改认证或项目访问校验时，优先检查匿名 `apikey` 与 JWT 的分支差异
- 收紧自动生成的 Hasura permissions；当前存在过宽的 `user` CRUD 与匿名写权限，不能视为生产安全基线
- 统一 project-user 在 GraphQL、Realtime、Storage、Functions 和 RPC 中的身份语义

## 工作规则

- 管理类路由默认保持 JWT-only。
- 项目管理路由必须使用 `project-authorization.ts` 的 project/schema/tenant capability guard；不得只检查已认证、JWT 中的 role、资源 ID 或旧布尔 access helper。
- 平台 `admin` 不自动拥有项目权限。`super_admin`、workspace owner、成员角色和用户 active 状态必须按数据库当前值解析；Project User/API Key 不得进入管理 RBAC。
- 匿名 `apikey` 能力必须是显式允许，不要扩散成默认放开。
- 新建或同步 Hasura permissions 时，禁止默认生成无行过滤的写权限；任何匿名写入都必须有明确业务理由和测试。
- Hasura 表权限必须使用操作级列能力：select 使用全部可读列，insert/update 分别使用 PostgreSQL 实际可写列；`GENERATED ALWAYS` 与 `IDENTITY ALWAYS` 不得进入客户端写权限或 owner insert preset，materialization、inspection、overview 和 migration 必须共用同一能力集合。
- 表级 Data Access provenance 依赖 migration `023`：baseline 和 operation 必须按项目当前 schema 精确读取，operation 创建时的 schema 身份不可变，schema 漂移后的 apply/recover 必须失败关闭。无 baseline 的受支持 scoped permission 只能显式 adoption；有 baseline 时 metadata 与基线不变、列能力变化才进入 `refresh_required`，新增列默认零授权，普通 PUT 必须携带 operation ID 和 expected baseline revision。
- `refresh_required` 的 target policy 只能保持原访问模式或收紧为 `none`；owner 列删除/generated/identity always 收缩只能保留原 owner 或关闭受影响操作，禁止在 reconcile 中更换 owner 或放宽为 `all`。需更换 owner 时先收敛到 managed，再走普通 policy update。持久 grants 必须排除关闭操作和 owner preset 列。
- 列删除或能力收缩使 Hasura metadata inconsistent 时，只允许基于同一次 v2 export 快照、携带 `resource_version` 的受控 `replace_metadata` 修复目标表当前项目 scoped permissions；必须保留 legacy、external role 和其他 metadata，禁止使用 `drop_inconsistent_metadata` 全局清理。
- Hasura metadata 写入只有带结构化 Hasura error code 的确定性 4xx 拒绝才能直接结束为 failed；5xx、transport、timeout 和非原子 fallback 错误都按结果未知处理并保留 recovery gate。表删除 outbox 只能通过带超时的 v2 metadata export 确认目标表已不存在，不能依赖错误文本推断 untrack 成功。
- policy operation 恢复只能覆盖 source、target 或受记录的 drop-then-create 命令前缀解释的 scoped permission；恢复前已存在的第三方 filter/preset/columns 变化必须保持 recovery gate。表删除 outbox 在 untrack 前还必须确认 PostgreSQL 中精确同名 relation 仍不存在，同名重建时不得触碰 Hasura。
- schema 级 Hasura 状态接口必须从授权 guard 写入的 `request.projectAccess.projectId` 读取项目当前 `data_access_mode`：`compatibility` 只检查 `user / anonymous`，`explicit` 只检查项目 scoped roles，不得合并两套角色造成误报；非默认环境在环境 actor 身份未实现前必须明确返回运行时不可用，状态响应不得暴露物理 Hasura role。
- 修改认证请求头时，要联动检查 SDK、MCP Server、Admin server routes 和 nginx 代理是否使用同一契约。
- Apple Project Auth 使用平台级 identity binding：Apple subject 只能存在于 `druvia_project_auth_identities`，不得写入项目业务 `users.provider_id`、email 或日志。
- Apple `.p8` 与 provider refresh token 必须使用独立 `SECRETS_ENCRYPTION_KEY` 加密；缺失或无效时 Apple 配置和运行必须失败，不得回退 `JWT_SECRET`。禁用 provider 只阻止新登录，已有 refresh 校验与 revoke 仍需可用。
- Apple 登录、refresh、revoke、notification、用户/provider/项目删除必须遵守 project lock 先于 identity/user lock 的顺序；有 active/pending identity、provider token 或待处理 lifecycle event 时不得直接删除用户、provider 或项目。
- Project Account Self-Deletion 只支持 active Apple Project User。intent 的目标只取 Project Session `sub`；confirm 以 deletion token、服务端 nonce、新鲜 Apple credential 和当前 identity generation 共同绑定。accepted 后 GraphQL、Realtime、Storage、RPC、Functions、refresh、login 和 trusted issue 都必须查询 authoritative operation/runtime gate，不得只信任 JWT。
- 账户删除执行器嵌入 API 并使用 PostgreSQL lease/renew/CAS；Hook schema/function/contract 来自 operation 不可变快照，契约摘要校验与函数调用必须绑定同一数据库 statement，且除 owner 外任何角色都不得持有 EXECUTE。临时失败退避，deadline 或 contract drift 保留原失败 phase 并进入 `attention_required`。删除 phase、Apple revoke、新 generation 登录与 project schema restore 必须共享 project-auth 项目锁，claim 必须在锁内复验 runtime gate 和 token 状态。Apple revoke 独立重试，不得阻塞业务删除完成；新 generation 必须等待旧 fence 完成，只能 supersede 尚未发出的旧 revoke，不能与 in-flight revoke 并发。project schema restore 对恢复后的 Hook 重新执行完整安全预检，再以恢复后摘要重放历史 fence。
- 公开项目 GraphQL 路由 `/api/v1/projects/:projectId/graphql` 只接受同项目 `project_user` 或 `apikey`：
  - `platform_user` 必须返回 `PROJECT_ACTOR_REQUIRED`，不能恢复为 Hasura admin passthrough
  - 客户端 `x-hasura-*` 头和角色声明不能进入执行上下文
  - Hasura role/session variables 必须由服务端根据项目 `data_access_mode` 和已认证 actor 生成
  - `compatibility` 仅保留旧 `user` role 行为；`explicit` 才使用项目 scoped role
- Realtime token 路由 `/api/v1/projects/:projectId/realtime/token` 采用相同项目 actor 边界：
  - 只接受同项目 `project_user` / `apikey`，拒绝 `platform_user` 和跨项目凭证
  - `compatibility` 将 Project User/API key 分别映射为 `user` / `anonymous`；`explicit` 使用项目 scoped role
  - Hasura session variables 只能由服务端 actor 生成，令牌必须使用短期 TTL、固定 issuer `druvia` 和 audience `druvia-hasura`
  - API 与 Hasura 必须使用同一个有效 `HASURA_JWT_SECRET`；`JWT_SECRET` 仅是迁移期回退
  - 当前只保证新连接的令牌有效性；不能宣称已建立的恶意 socket 会在 JWT 到期瞬间被强制断开
- 已有项目数据访问迁移依赖 `019_data_access_migrations`：
  - 只允许状态机切换 `data_access_mode`，禁止新增直接切换接口
  - permission/DDL/Realtime 配置等项目写入必须遵守 shared-global/project advisory lock；raw SQL、clean restore、全量 metadata 和破坏性删除使用 exclusive-global
  - 自定义旧规则必须阻断，匿名写权限不得自动映射到 scoped role；Action、Remote Schema、inherited role 等顶层 actor 绑定也不得被预检忽略
  - apply/rollback 失败必须恢复并验证持久化 source/applied snapshot，无法验证时保留 recovery-required gate
- 涉及 Functions invoke 时，优先检查：
  - `functions.controller.ts`
  - `functions.service.ts`
  - `docker/deno-worker/*`
- RPC 与 Functions 必须从 `project-actor.ts` 取得版本化 actor，禁止模块自行拼装或把 Platform User 静默转换为 Project User。
- RPC 只接受同项目 Project User 或已通过项目访问校验的 Platform User；API Key 不获得匿名 RPC。写入 PostgreSQL 的 claims 必须使用同一连接、事务级 `set_config(..., true)`，业务函数仍需自行鉴权。
- RPC 仅将业务函数实际调用阶段的 PostgreSQL `P0001` 映射为 HTTP 400 `RPC_REJECTED`；不得向客户端返回数据库原始错误。连接、事务设置、commit、rollback 或其他 SQLSTATE 故障仍按 500 处理，rollback 失败不得被业务拒绝掩盖。
- Device Wipe binding 注册只接受同项目 Project User，owner 从 Session 派生；后续 mandate query/receipt 不得依赖已失效 Session，只接受独立 handle/token possession credential。所有 Device Wipe 写入或 Hook 路径必须先持有与 project schema restore 相同的 project-auth 项目锁，再在同一连接检查 runtime gate；`restoring/recovery_required` 下统一 503，不能因已有 pending snapshot 或认证中间件已检查而绕过。原始 binding identity、binding handle、lookup token、Project User ID、receipt 内容和私有签名材料不得进入日志；Project User ID 只允许以专用 encryption key 加密后作为不可变注册恢复材料持久化；任意位置、query、非法转义或多层编码中的 binding handle 都必须在 Fastify request serializer 中 fail-closed 替换，所有 request log 只记录 path，默认 404 不得回显原 URL。项目 Hook 必须复验固定签名、owner、ACL、search path、双向角色成员关系（owner 不继承其他角色，任何非 superuser 角色也不能继承 owner）、`REPLICATION`、其他 schema 的非 extension relation/column/sequence 权限与 CREATE，以及可直接调用的非 extension 外部 `SECURITY DEFINER` 函数，并在同一 statement 中绑定 contract hash 后调用；`RETURNS trigger/event_trigger` 因不能由普通 SQL 直接调用，不计入外部 definer execute，但外部 relation 的 `TRIGGER` 权限仍必须拒绝。普通请求与 restore 重放分别使用有界事务级 statement timeout，超时不得无限占用项目锁。当前 MVP 只允许 `db_user` 隔离到一个项目 schema；共享同一 `db_user` 的多环境项目必须保持该能力禁用。project schema restore 必须在原项目锁和 runtime gate 内先复验并按 binding identity/revision 顺序重放全部注册，再重放账户删除 fence，最后复验并回放全部 acknowledged core receipt；任一阶段失败保留对应的 `DEVICE_WIPE_BINDING_REPLAY_REQUIRED`、`DEVICE_WIPE_RECEIPT_REPLAY_REQUIRED` 或超时 gate。注册和 sessionless lookup 限流使用单条 Redis Lua 操作原子递增并确保 TTL；Redis 故障必须以脱敏 503 fail closed，且限流故障日志必须显式移除继承的 Project User ID。
- Functions 的 `invoke_auth_mode` 必须在 service 对实际执行的同一函数记录上校验；`anon_allowed` 只允许同项目 API Key，所有 service 调用都必须显式传 actor。
- `/api/internal/functions/graphql` 只允许签名 token 中的同项目 Project User/API Key，并根据项目 `data_access_mode` 派生 Hasura role/session variables；Platform User 必须返回 `PROJECT_ACTOR_REQUIRED`。
- 直接 Storage 对象路由只接受已授权 Platform User 或同项目 Project User；API Key 返回 `PROJECT_ACTOR_REQUIRED`。Project User 必须服从 bucket 的 `admin_only / owner_only / authenticated_read`，其他用户对象按矩阵返回 404/409，不得泄露 owner。
- Storage actor-aware list/read 不能信任 controller 传入的 bucket preset；service 必须按 `bucket_id` 重读当前 bucket 并再次校验 project scope 后再判权。不存在和不可见的受保护对象统一使用 `OBJECT_NOT_FOUND`。
- Storage 所有上传、覆盖、删除和 bucket 删除必须遵守 bucket-before-object 锁顺序，在同一 checked-out client 上使用 bucket row lock 与 transaction advisory path lock。新 provider key 只使用 server ID，不能重新使用用户逻辑路径。
- 公开 Storage 下载只由 `bucket.public` 决定；HTML、SVG 和未知类型必须 attachment，只有受支持的公开图片可 inline。对象 JSON 只能通过安全 DTO 返回，历史非法 MIME 进入响应头或签名参数前必须降级为 `application/octet-stream`。
- API 调用 Worker 必须发送 `x-druvia-worker-secret`。`DENO_WORKER_SECRET` 至少 32 UTF-8 字节，不能进入 Function token、caller、日志或用户函数环境。
- 如新增需要匿名开放的函数能力，先确认 Worker 本身是否具备调用者身份校验。
- 涉及 GraphQL 代理限流时：
  - Redis key 必须包含 `projectId`
  - `perUser` 实际是“项目内 actor”限额，不是跨项目全局用户限额
  - 当前匿名 `apikey` 流量仍按 `request.ip` 归并；认证上下文虽已有稳定 API Key ID，但更改限流维度仍需独立兼容性设计
  - 若 API 部署在 nginx / ingress 后，必须开启 `TRUST_PROXY`；否则 `request.ip` 会退化为代理地址，匿名 GraphQL 限流会把多用户错误合并

## Subagent Triggers

- GraphQL、Realtime、Storage、RPC、Functions 间的 actor 调用链和跨模块契约使用 `explorer`。
- 认证、权限、migration、锁、数据完整性或恢复逻辑变更在最终验证前必须使用 `critical_reviewer`。

## 近期风险

- MCP Server 当前使用的 API key 请求头和部分 schema 路由的身份要求仍需与 API 对齐，完成前不要把 MCP 标记为生产就绪。
- `invoke_auth_mode` 依赖数据库迁移；代码先行、数据库未升级时，管理端会报保存失败。
- 上传类函数若未做调用者鉴权，不应依赖平台层匿名放行。
- `druvia_projects.settings` 更新虽已改为 JSONB 顶层 merge，但 `rateLimits` 等嵌套对象仍不是深合并；路由和前端都不能误判。
- migration `020_storage_project_user_access` 必须先于包含直接 Storage actor cutover 的 API/Admin 启动；升级前必须审计旧逻辑名和 Local 大小写物理 key 冲突。
- migration `021_project_auth_identities` 必须先于包含 Apple Project Auth 的 API/Admin 启动；release manifest migration ceiling 不得低于 `21`。
- migration `022_project_members` 必须先于包含项目成员授权的 API/Admin 启动；成员表非空时不得执行 down，release manifest migration ceiling 不得低于 `22`。
- migration `023_data_access_managed_policies` 与 `024_table_deletion_outbox` 必须先于包含受管策略 adoption/reconcile 和可恢复表删除的 API/Admin 启动；存在 baseline、operation 或 pending deletion 时不得 down，release manifest migration ceiling 不得低于 `24`。
- migration `025_project_account_deletions` 必须先于包含账户删除、session/runtime gate 或 fence replay 的 API/Admin 启动；存在 accepted/completed operation、Provider revoke material 或 restore gate 时不得 down，release manifest migration ceiling 不得低于 `25`。
- migration `026_project_device_wipe_mandates` 必须先于包含 binding、sessionless mandate、回执或签名密钥管理的 API/Admin 启动；存在 config、key、binding 或 mandate 时不得 down，release manifest migration ceiling 不得低于 `26`。项目删除和独立项目数据库用户删除必须持有同一 project-auth 锁，并在任何 owner 转移、角色、schema 或 Storage 副作用之前检查设备擦除生命周期记录并失败关闭；完整项目删除必须复用外层锁连接，不能另开连接自锁等待。
- managed baseline 的数据库主键、repository 读写和 operation 身份必须统一使用 `project + schema + table`，不得退化为只按项目和表名寻址。
- 表删除必须将业务表、`_meta_tables`、精确 `project + schema + table` baseline 和 deletion outbox 写入同一 PostgreSQL 事务；提交后再 untrack Hasura。pending outbox 必须阻断同 scope 管理写入，并由启动恢复及运行期定时重试清除，不能依赖进程重启或人工删记录。migration `024` 的 event trigger 必须在 pending 期间保留同名 relation，所有数据库连接上的创建/重命名冲突都应以 SQLSTATE `55006` 失败；执行该 migration 的数据库角色必须具备创建 event trigger 的权限。
- migration CLI 只能在迁移 SQL 同时存在最外层 `BEGIN` 与 `COMMIT` 时剥离包装；孤立事务边界必须保留并由 PostgreSQL 报错。

## 参考入口

- `docs/agent/design-decisions.md`
- `docs/plans/2026-08-14-project-update-direction-analysis.md`
- `docs/plans/2026-03-19-apikey-auth-design.md`
- `docs/plans/2026-03-23-function-invoke-auth-ui-design.md`
