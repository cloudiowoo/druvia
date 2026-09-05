# Druvia Codex Design Decisions

面向 Codex 的长期设计决策摘要。保留 `.claude/memory/design-decisions.md`，这里记录当前仍应优先相信的结论。

## 产品定位

- 当前主叙事是“单租户 + 多项目”。
- 多租户能力保留在架构与数据模型中，但不是当前默认产品表达。

## 数据与权限

- 核心元数据在 `public` schema。
- 业务数据隔离当前更接近 Schema-per-Project。
- 权限主要依赖 Hasura permissions，而不是 PostgreSQL RLS。

## 迁移兼容策略

- 涉及 Auth、GraphQL 代理、SDK 返回结构、Functions invoke 时，优先考虑 Supabase/taro-app 兼容需求。
- 不以“接口形状相似”判断兼容完成，必须结合真实迁移路径验证。

## 项目终端用户认证策略

- 平台用户认证与项目终端用户认证必须分层，不能继续共用一套 session 签发语义。
- 项目终端用户 access token / refresh token 由 Druvia API 正式签发，不再由 Edge Function 自造。
- “已有业务用户 -> 标准 project session”的正式受控补口采用 trusted backend key + trusted issuer：
  - issuer route 只接受 `x-druvia-trusted-backend-key`
  - 返回仍是标准 `ProjectSession`
  - refresh / logout 不再额外扩 fork API 形态
- Phase 1 复用 `<project schema>.users`，但必须兼容 taro-app 现存 `wx_open_id` 数据形态。
- `project-auth` 创建项目业务用户时必须尊重 `<project schema>.users.id` 的真实类型：
  - 不能把平台风格 `user_xxx` 字符串强写进 UUID 主键业务表
  - UUID 主键项目由 API 显式生成合法 UUID，不依赖业务表一定存在默认值
- `project-auth` 暴露给客户端的失败语义应是 auth 级错误，而不是原始数据库约束错误直出。
- `PROJECT_AUTH_JWT_SECRET` 可以独立配置；中间件必须同时支持 platform-user 与 project-user token 验签。
- SDK 侧 `projectAuth` 与 `auth` 分开存储，避免平台后台登录与项目业务登录污染同一 session 槽。
- provider 扩展策略采用“通用 auth 核心 + provider adapter”：
  - 不为每个 provider 重写整套 project-auth 模块
  - 共享用户查找/创建、refresh、logout、session 签发
  - 仅在 adapter / provider config 映射层处理差异

## Functions 权限策略

- 匿名 `apikey` 能力存在，但必须按模块和场景精细化控制。
- GraphQL 匿名访问是已允许模式。
- Functions invoke 必须默认 `jwt_required`。
- 只有显式配置为 `anon_allowed` 的函数，才允许同项目匿名 `apikey` 调用。
- 对匿名开放的函数应限定在登录前场景，不得扩散为上传类或用户态函数的默认策略。
- `jwt_required` 的正式含义已扩展为：
  - 允许 platform user
  - 允许同项目 project user
  - 拒绝 anonymous apikey
- trusted-issued session 的 project-user claim 应继续走同一套 auth 分支，不为 `trusted_backend` 再开特殊鉴权分支。
- Function Worker caller 上下文不再使用模糊的 `jwt/apikey` 二值模型，应显式区分：
  - `platform_user`
  - `project_user`
  - `apikey`

## Project Actor、RPC 与 Worker 边界

- 应用执行路径统一使用 API 拥有的版本化 `ProjectActorContext`，稳定区分 `platform_user / project_user / apikey`；各模块不得自行拼装替代 actor。
- API Key actor 只携带数据库 ID 和非秘密 prefix。完整 key、hash、原始凭证、Function payload 不得进入 actor、内部 token、Worker caller 或持久执行日志。
- Platform User 是管理身份，不会被隐式转换成 Project User：
  - RPC 仅在 controller 已完成项目访问校验后允许显式管理调用
  - Function 可用于显式管理测试，但 `druvia.graphql()` 必须拒绝 Platform actor
- RPC 将可信 actor claims 写入同一数据库连接的事务级设置；这些 claims 供业务函数鉴权和审计，不代表 Druvia 已为项目 schema 启用 PostgreSQL RLS。
- Functions 的 `invoke_auth_mode` 在 service 使用即将执行的同一函数记录校验；不能只依赖 controller 预检或二次读取。
- Function internal GraphQL 继续使用 Hasura admin secret 做服务间认证，但始终附加服务端派生的项目 role/session variables；Project User/API Key 数据能力由现有 Hasura permissions 决定。
- API-to-Worker 使用独立 `DENO_WORKER_SECRET`，要求至少 32 UTF-8 字节并在读取执行 body 前验证。Function 子 Worker 没有真实 env 权限，只能读取 invocation-local Function secret shim。
- 该不对称协议的部署顺序固定为新 API 先于新 Worker；回滚顺序固定为旧 Worker 先于旧 API。升级器的自动和手动回滚必须遵循同一顺序。
- SDK Database/RPC/Functions 不得隐式使用 Platform Session。直接 Storage 已由后续独立 actor/object authorization 切片完成 Project User cutover，同样不得回退 Platform Session；该能力不是从 RPC/Functions 决策中隐式派生。

## Edge Function 数据访问策略

- 平台级 Hasura secret 只留在平台服务端。
- 项目级 Edge Function 的正式数据访问模型应走 API internal proxy，而不是直连 Hasura admin 通道。
- 运行时 helper 可以向函数暴露受控能力，如 `druvia.graphql()`；但 internal token 不应作为项目 secret 暴露给用户。
- 项目级 Edge Function 的 storage 写入也遵循同一原则：
  - 正式模型是 API internal storage proxy
  - 运行时 helper 目前包含 `druvia.storage.upload()` 与受控 `druvia.storage.remove()`
  - 不向项目函数下发 `DRUVIA_TOKEN`、管理 JWT、或其他平台级 storage 写入凭证
- storage 上传审计先落在 `druvia_storage_objects.metadata` JSONB，而不是立即扩表加独立列。
- helper 可在运行时内部附带可信 `callerContext`，但这不是函数作者可自定义的公开 helper 参数。
- 外部应用终端用户上传图片的正式能力采用“双层模型”：
  - project session 解决统一身份
  - storage ticket 解决受限文件操作
- storage ticket 不是 project session 的替代品，而是能力更窄的补充：
  - 上传票据只允许受限 `pathPrefix`
  - 删除票据只允许精确 `path`
  - browser / H5 上传链路不直接持有 trusted backend key
- storage ticket 必须使用独立于 platform/project JWT 的专用签名 secret：
  - 不允许回退复用 `PROJECT_AUTH_JWT_SECRET` 或 `JWT_SECRET`
  - auth 中间件也不应把 storage ticket 识别为正常 Bearer token
- storage ticket Phase 1 的审计落点仍是：
  - stdout-first 结构化日志
  - `druvia_storage_objects.metadata` 中的 `issued_by / issued_via / created_by_*`
- trusted issuer 签发的 session provider 固定为 `trusted_backend`：
  - 不复用原始业务用户的 `wechat/oidc/...` provider claim
  - 这样 Functions/RPC/审计链路才能区分 trusted-issued session 与普通终端登录

## 平台日志策略

- Phase 1 采用 backend-agnostic 的 stdout-first 模型：
  - 各服务输出结构化 JSON 日志到 stdout / stderr
  - 不把集中式日志系统作为默认部署强依赖
- Phase 2 继续采用可选部署策略：
  - 官方提供 `Loki + Promtail + Grafana` 作为推荐组合
  - 通过 compose `with-logs` profile 启用
  - 不改变 Druvia 的最小运行依赖
- 共享的是“日志契约”，不是强制一份跨运行时实现：
  - Node 服务可以复用共享 helper
  - Deno Worker 允许保持本地实现，只需对齐字段与错误序列化约定
- API 以 Fastify logger 为锚点，不额外引入重量级日志框架。
- Node 服务的共享错误序列化必须对 message 和 stack 统一清理常见凭据格式，包括
  Bearer/Basic、敏感键值和 URL userinfo；结构化 context 仍只允许放入明确的非秘密字段，
  不能依赖文本脱敏替代调用方的数据最小化。
- Deno Worker 日志必须携带可信执行上下文：
  - `projectId`
  - `functionName`
  - `executionId`
- 平台 Phase 1 只覆盖服务端运行日志，不包含浏览器日志采集。

## Hasura 同步策略

- `track-all` 与 `reload metadata` 是两类不同操作，不能混用概念：
  - `track-all` 只负责表和关系等结构 metadata 同步，不创建、覆盖或清理数据 permissions
  - `reload metadata` 负责刷新 Hasura schema / cache 视图
- 新建表和同步数据接口默认不生成 `user` / `anonymous` CRUD permissions；数据访问必须通过独立的显式配置和迁移路径完成。
- `_meta_tables.realtime_enabled` 只表示应用是否需要该表的实时更新能力：
  - 开启或关闭 Realtime 不得创建、覆盖或删除 select permission
  - Realtime 就绪状态由能力开关和已有读取权限共同推导
  - Batch 3B 后就绪状态按项目运行模式同时检查认证与匿名读取路径；SDK 建连前必须先交换短期 actor token
- 项目数据角色采用“逻辑 actor -> data scope -> 版本化物理 role”的内部映射：
  - 物理 role 名不进入 SDK 公共契约和 Admin 默认表单
  - 当前公共运行时只覆盖项目默认 schema；非默认环境对外开放前必须先定义环境级 API Key/session audience
  - 独立 Worker 不自动获得通用 `worker` role；代表用户执行时复用 Project Session，跨用户服务身份留待独立凭证和权限生命周期
- 表级数据访问 Batch 2A 采用受约束的逻辑权限预设：
  - 仅管理项目默认生产 schema，不接受环境参数
  - 认证用户 CRUD 分别支持 `none / all / owner`
  - `owner` 统一使用 `X-Hasura-User-Id`，写入时排除并预设所有者字段
  - 匿名客户端仅提供 select 开关，不生成匿名写权限
  - 只替换当前项目两个 scoped role 的权限；旧 `user / anonymous` 及其他 role 均保留
  - scoped role 中出现非精确受支持形态时按 custom 只读处理，不允许 UI 覆盖
  - permission columns 按操作区分：select 使用全部可读列，insert/update 使用各自可写列；PostgreSQL `GENERATED ALWAYS` 与 `IDENTITY ALWAYS` 只读，`IDENTITY BY DEFAULT` 保持可写
  - owner insert 的所有者列必须可由 Hasura preset 写入；不可写 owner 列在生成 metadata 前按无效策略拒绝
  - Data Access migration v2 snapshot 持久化操作级列能力；v1 未应用 preview 必须重新生成，v1 已应用记录继续按旧 digest 语义支持恢复和回滚
- Batch 2A 最初只完成 scoped permission 物化；Batch 3A/3B 已分别切换 explicit 项目的 HTTP 与 WebSocket actor，Batch 4 已提供已有项目的受控激活路径。
- 表级数据访问 Batch 2B 的项目概览固定为默认生产 schema 的只读治理视图：
  - API 用一次 PostgreSQL 清单查询和一次默认 source metadata 导出组成项目快照，不逐表调用管理接口
  - 清单读取不得创建 `_meta_tables`、追踪表或改写权限；辅助表不存在时 Realtime 默认按未启用展示
  - authenticated / anonymous 的 custom 状态分别判定，公开响应只返回应用状态和旧规则布尔值，不返回物理 role
  - Admin 项目设置页负责汇总、筛选和导航，编辑仍在表详情；`scope=default` 是从概览切回默认 schema 的唯一显式入口
  - Batch 2B 最初固定展示 `compatibility`；Batch 3A 后改为返回项目持久化的实际运行模式
- Project Data Access Batch 3A 的 HTTP actor 边界：
  - `druvia_projects.data_access_mode` 持久化为 `compatibility | explicit`
  - 迁移 `018` 将已有项目保守保持在 `compatibility`，新项目由服务显式创建为 `explicit`
  - 公开项目 GraphQL 只接受同项目 `project_user` 或 `apikey`，拒绝 `platform_user`
  - `compatibility` 保留旧 `user` role；`explicit` 使用服务端生成的 scoped role/session variables
  - Admin Playground 与 SDK Database 不再把平台 session 用作应用 GraphQL 身份
  - 已有项目禁止手工改字段，必须使用 Batch 4 的清单、确认、验证与回滚流程
- Project Data Access Batch 3B 的 Realtime actor 边界：
  - Realtime 不直接复用长期 Project JWT/API key；Druvia API 验证同项目 actor 后签发短期 Hasura-verifiable token
  - compatibility Project User/API key 分别映射到旧 `user` / `anonymous` role；explicit actor 使用项目 scoped role
  - SDK 在建连前交换令牌，在令牌续期和项目身份变化时重建 socket 并恢复订阅；断线期间事件不重放
  - SDK 统一校验显式 override 与 token 响应中的 WebSocket URL，解析过程不依赖全局 `URL`；没有 `URL` 或只有受限 HTTP(S) `URL` 的小程序运行时均可建连，但仍拒绝 credentials、query、fragment 和无效 authority；hostname 只接受 ASCII（含调用方预先转换的 punycode），不隐式转换 Unicode IDN，应用侧不得注入全局 monkeypatch
  - API 与 Hasura 共享独立 `HASURA_JWT_SECRET`，固定 issuer `druvia`、audience `druvia-hasura`；`JWT_SECRET` 仅保留迁移期回退
  - Admin 只用内存中的应用凭证执行真实 token exchange 和 WebSocket 探测，不读取平台 session
  - 非默认环境在具备不可变 environment identity 前不开放运行时 Realtime token
  - 令牌到期可阻止新连接并触发合作式 SDK 续期，但当前不保证恶意客户端的已建立 socket 在到期瞬间被 Hasura 强制关闭
  - compatibility 的全局 `user` / `anonymous` role 不提供 scoped-role 级跨项目隔离保证；Batch 4 激活并移除旧权限后才闭合该边界
- Project Data Access Batch 4 的已有项目迁移边界：
  - 迁移 `019_data_access_migrations` 保存项目级不可变 permission 快照、计划、阶段、恢复目标和 digest；包含 Batch 4 的 API 启动前必须先应用 `019`
  - 只自动迁移精确匹配历史 Druvia 默认形态的规则；自定义、重复、跨项目或不支持对象一律阻断，不做模糊推断；顶层 Action、Remote Schema 和 inherited role 的 `role_name` / `role_set` 中出现迁移 actor role 也必须阻断
  - source snapshot 保留 Hasura `columns: '*'`，不得为了摘要归一化改写成当前列数组；二者当下可分类为同一历史能力，但回滚后的未来新增列语义不同
  - 已存在且可管理的 scoped 规则优先；旧规则推断必须逐表复核，用户可选择迁移后保持关闭
  - 匿名 insert/update/delete 不迁移，认证 select aggregate 能力会移除；两者都属于需独立确认的风险收紧
  - apply/recovery/rollback 与相关 DDL、Realtime 配置、raw SQL、clean restore、项目/环境删除共享 PostgreSQL advisory-lock 协议；状态推进使用带期望状态的单条原子更新，不在 Hasura/WebSocket 调用期间持有数据库事务；直接 SQL/Hasura Console 仍需运维静默窗口
  - Hasura v2.48 不支持 permission command 的 `bulk_atomic` 时，只对该明确错误回退到 `bulk`；回退本身非事务，安全边界依赖持久阶段、重新导出验证和 source/applied 快照恢复
  - apply 失败恢复 source snapshot/compatibility，rollback 失败恢复 applied snapshot/explicit；无法验证时持久化 recovery target，禁止继续受影响的管理写入和删除
  - Admin 只展示业务化摘要、确认、进度和恢复入口，不暴露物理 role、原始 metadata 或 Hasura secret
  - `019` 为增量恢复依据，镜像/OTA 回滚不得自动 down；人工回滚旧权限可能重新引入匿名写入和兼容模式隔离风险
- Functions internal GraphQL 已完成 Project Actor cutover：Project User/API Key 使用与公开数据路径一致的服务端 role/session-variable 映射，Platform actor 被拒绝。平台 SQL/管理接口的跨 schema 能力仍需独立安全审计。
- Admin 默认使用“数据接口、数据访问、实时更新”等应用概念；Hasura role、metadata 和 secret 只属于高级诊断或服务端实现。
- 直接 Storage Project User 授权采用 bucket 三预设与独立公开开关：`admin_only` 禁止 Project User，`owner_only` 仅对象 owner 可见可写，`authenticated_read` 登录用户可读全部但只能写自己的对象；API Key 不获得受保护对象能力。
- Storage 对象所有权持久化在 `owner_project_user_id`。平台管理覆盖保持 owner，Project User 新对象归本人，trusted ticket/代表 Project User 的 Function 可归属或重新归属；Platform/API Key Function 不自动声明 owner。
- 新 Storage provider key 固定为 `projectId/bucketId/objects/objectId`，逻辑名称只用于数据库和响应。所有 mutation 使用 bucket row lock 后再取 transaction advisory path lock，并在同一数据库连接内完成权限检查和元数据写入。
- Storage 对象响应不暴露 provider path、metadata 或审计字段。私有对象强制 attachment/no-store，公开对象仅安全图片 inline 且最多缓存 5 分钟；Local/R2 signed URL 固定 attachment 参数。
- Storage actor-aware list/read 必须按 `bucket_id` 重读当前 bucket 后判权，避免复用过期或调用方构造的 preset；受保护对象的不存在与不可见统一为 `OBJECT_NOT_FOUND`。历史非法 MIME 只按 `application/octet-stream` 交付。
- 迁移 CLI 只剥离成对包围整个文件的外层 `BEGIN`/`COMMIT`；单边事务边界必须保留，使残缺迁移失败而不是被静默修复。
- Druvia 管理端对列级 DDL 的正式策略是：
  - Admin Tables 页面内的 `add/drop/rename column` 自动触发 `reload metadata`
  - 外部 SQL / migration 导致的 schema 漂移，由用户显式触发 `刷新数据结构`（内部执行 reload metadata）

## Apple Project Auth identity 与生命周期

- Sign in with Apple 作为一等 Project Auth provider 接入，不复用平台 OAuth，也不改变 WeChat/OIDC adapter 契约。
- 权威映射位于平台表 `(project_id, provider, issuer, subject) -> project_user_id`；Apple subject 和 provider refresh token 不进入项目业务 Schema 或 Hasura actor claims。
- Apple `.p8` 与 provider refresh token 使用独立 `SECRETS_ENCRYPTION_KEY` 加密。provider 禁用只阻止新登录，已有 session 的每日上游校验、撤销和 decommission 继续保留。
- Druvia refresh token 绑定 identity 与 audience；Apple 上游校验在消费 Druvia token 前执行，暂时失败不消费 token，`invalid_grant` 则撤销 identity 和全部关联会话。
- revoke 使用 `revoke_pending -> Apple revoke -> revoked` 两阶段状态；Apple notification 只信任固定 issuer/JWKS、allowlisted audience 和幂等 `jti`。`account-deleted` 先冻结会话并保留待处理事件，应用领域数据清理完成后才由管理员确认删除 Project User。
- Apple 登录及 lifecycle mutation 与用户/provider/项目删除共享项目级 advisory lock，并固定 project lock 先于 identity/user lock。未完成 revoke 或 lifecycle action 时禁止破坏性删除。
- lifecycle event list/ack 可由平台管理员或同项目 trusted backend key 调用；服务端 key 必须显式持有 `project_auth_lifecycle:manage`，该删除能力不属于默认 trusted key scopes。
- migration `021_project_auth_identities` 是运行前置条件；GHCR 与自建 Registry 的 stable manifest 必须使用相同镜像 digest 对应构建，并将 migration ceiling 设置为至少 `21`。
- 当前仅完成本地 mock Apple 协议和 Druvia 侧开发门禁；真实 Apple Developer 配置、真机登录、公网 notification 和 PITCHETCH actor 验收属于独立非生产验收，不据此宣称生产就绪。

## 平台项目成员与管理授权

- 当前产品仍是单租户多项目。平台角色 `admin` 只表示可登录控制台，不授予全局、workspace 或项目管理能力。
- 项目有效角色按数据库当前状态解析：`super_admin` 全局覆盖、workspace `owner_uid` 隐式 owner、`druvia_project_members` 显式 `project_admin / database_admin / viewer`。JWT 中的旧 role 不能替代数据库检查。
- 项目角色只映射到服务端固定 capability；路由声明 capability，不在 controller/UI 散落角色比较。成员不能管理其他成员、Trusted Backend Key、数据库连接凭证或项目删除。
- workspace owner 不写入成员表。成员新增、改角色、移除与审计日志在同一事务内完成；停用用户立即失去访问，但仍允许 owner 清理其成员关系。
- tenant/project/schema/backup 列表在 SQL 层按当前身份过滤；backup 必须先确认 schema 仅归属一个项目且 tenant/project 三方一致，再执行分页，并只返回不含 storage key、内部错误和表清单的摘要 DTO。仅有项目关系的用户只得到 tenant 导航字段，不得到 owner、settings 或 quota 等敏感配置。
- 项目基础 schema 与环境 schema 共用同名 advisory lock；两条创建路径都必须拒绝已分配或物理存在的 schema。历史多项目归属必须在发布前审计，运行时解析遇到零归属或多归属均失败关闭。
- `database:read` 的 SQL 查询必须同时使用 PostgreSQL extended protocol 和 `BEGIN READ ONLY` 事务：前者拒绝多语句，后者阻止 writable CTE 与数据库写副作用；首词检查只能提供输入反馈，不能作为授权边界。
- 平台项目成员是管理身份，不是 Project User。它不会获得应用 GraphQL、Realtime token、Project Session、项目 API Key 或 SDK 数据身份。
- migration `022_project_members` 是该授权代码的运行前置。成员表非空时 down 必须拒绝，生产镜像回滚不得自动删除成员关系。

## 项目删除策略

- 项目删除是“全量清理”操作，不是单纯删除 `druvia_projects` 行。
- 平台管理接口删除项目时，调用者必须是 `platform_user`，并通过统一授权服务的 `project:delete` capability；普通项目成员和旧布尔 access helper 不能授权删除。
- 删除路径必须覆盖三类残留资源：
  - 项目 schema / 环境 schema
  - 项目数据库用户
  - 物理存储副产物，包括：
    - `druvia_storage_objects` 对应对象文件
    - 旧 `druvia_files` 项目路径
    - `druvia_backups` 的备份文件
- 如果项目数据库用户删除失败，项目删除流程必须中止，不能继续删除 `druvia_projects`。
- 物理存储 cleanup 应放在 schema / db user 等关键数据库删除步骤之后，避免后置失败时先丢文件。
- 对本地存储适配器，删除文件后应继续清理空目录，避免 Admin/UI 看似已删但磁盘目录残留。

## Docker Compose 在线升级策略

- Druvia 生产在线升级采用 Compose-native 模型，不采用 Sub2API 式容器内替换单个可执行文件模型。
- PostgreSQL 扩展保持可选部署能力：默认镜像仍为 `postgres:17-alpine`，PostGIS 使用独立 `docker-compose.postgis.yml` 叠加 local/prod/release，并由显式一次性任务为已有数据库启用扩展。Updater 的 migration/apply/rollback 对受管应用服务统一使用 `--no-deps`，不得通过 Compose 依赖图收敛 PostgreSQL；数据库镜像、扩展升级和回退必须人工执行并先完成备份。已有空间依赖时不能把原数据目录直接切回普通 PostgreSQL 镜像。本地可通过 `docker-compose.local.dual-db.yml` 并行运行普通 PostgreSQL 与 PostGIS，但普通库的 `postgres` / `postgres_data` 契约保持首要和默认，PostGIS 使用独立服务与数据目录；两套数据不自动同步，生产与 OTA 不采用双库模式。
- 系统升级控制面必须独立为 `updater` 服务：
  - `updater` 持有 Docker socket、部署目录和 update state volume
  - API 只做 `platform_user + super_admin` 鉴权代理
  - Admin 只做通知、状态展示和确认操作
- API、Admin、Deno Worker 不挂载 Docker socket。
- 生产在线升级发布物以 release manifest 为准：
  - `api/admin/worker/updater` 使用版本化镜像
  - 实际应用镜像使用 digest
  - 不依赖 `latest`
  - 不依赖生产节点本地 `build:`
- 外部管理 API 的系统更新接口继续使用 Druvia 标准响应 envelope：
  - 成功：`{ success: true, data }`
  - 失败：`{ success: false, error }`
  - updater 内部接口才使用裸 `DruviaUpdateStatus` / `UpdateOperationAccepted`
- Deno Worker 生产升级对象是 worker 镜像，不是宿主机挂载源码目录。
- 数据库迁移前由 updater 执行完整 `pg_dump`。不可逆迁移失败时，自动回滚范围限定为镜像和 compose 状态，数据库恢复需要使用升级前 dump 人工执行。
- Updater 通过宿主 Docker socket 执行 `docker compose`，所以 release 部署目录必须以宿主绝对路径 `DRUVIA_DEPLOY_DIR` 挂入 updater 的同一个绝对路径；不能只挂载到容器内 `/deploy`，否则 compose bind mount 源会被宿主 Docker daemon 解析成错误路径。
- Updater 不允许在自身容器进程内同步执行 `docker compose up -d updater` 替换自己；标准 OTA 使用一次性 finalizer 容器执行 updater 自更新。启动 finalizer 后状态进入 `finalizing`，finalizer 通过继承旧 updater 挂载写回共享 update state，成功后再置为 `succeeded`。

## 应用驱动发布与生产兼容策略

- Druvia Phase 表示能力依赖和成熟度，不表示生产环境必须按 Phase 子任务逐次升级。
- main 分支开发、Actions 构建、GitHub Release 和生产 OTA 是独立动作；代码合并或镜像构建不会自动改变生产运行版本。
- taro-app 是当前优先生产验证应用：
  - 不等待 Phase B-D 全部完成
  - 先完成其真实 Auth、GraphQL、Realtime、Storage、RPC、Functions 和部署链路
  - 只把真实阻塞、安全或正确性问题提升为当前 Core 工作
- taro-app 生产只跟随完成兼容回归的 `stable` release，并由运维人工 apply；不启用自动 apply。
- 当前 release workflow 虽接受 `stable / beta / nightly`，但 GitHub `releases/latest/download` 尚未按 prerelease channel 完整隔离。生产使用该 latest URL 时，beta/nightly 不得覆盖同一入口；隔离完成前只将 stable 发布到生产跟随的 Release 路径。
- 生产镜像使用 release manifest 中的 digest，版本 tag 不得覆盖复用。后续 Phase 功能可以持续开发，但只有进入新的 stable manifest 后才成为生产可选升级。
- 紧急 patch 只包含安全、数据一致性、生产故障或 taro-app 兼容修复，不夹带无关 Phase 功能或非必要 migration。
- 服务端至少维持“当前生产客户端 + 下一待发布客户端”的兼容窗口，兼顾小程序审核与客户端发布滞后：
  - 破坏性 API/SDK 行为先弃用，再移除
  - 数据库优先采用 expand-contract
  - 镜像回滚不代表不可逆数据库 migration 已回滚
- 每个 taro-app stable 基线必须记录客户端版本、SDK 版本、Druvia release、migration 范围、备份要求、回滚边界、Registry/manifest 来源和已验证流程。
- taro-app 上线前只要求 Phase B 中与目标生产直接相关的最小子集：生产同构部署、备份、migration、健康检查、恢复演练和一条可靠 Registry 路径。未使用的 PostgreSQL 扩展、第二 Registry 演练、足球/Swift/Recipe 和 Phase D 能力不阻塞上线。

## 文档策略

- Codex 项目说明遵循官方 `AGENTS.md` 分层发现机制：
  - 根 `AGENTS.md` 保存仓库级稳定约束和必要索引
  - 子目录 `AGENTS.md` 保存该子树专用规则，并覆盖同主题的上层规则
  - 不把格式化、lint 等可自动执行的要求大量复制进说明文件，应交给 CI 和工具配置
- 官方机制参考：`https://learn.chatgpt.com/docs/agent-configuration/agents-md`
- 仓库不再维护 `docs/agent/project-memory.md`：
  - 它不是 Codex 自动发现文件
  - 它与根/局部 `AGENTS.md`、进度和设计决策形成并行可变事实源
  - 近期状态写入 `docs/progress.md`，长期决策写入本文件，完整证据写入日期化 `docs/plans/*`
- `.agents/skills/*` 用于按需加载的仓库专用工作流，不替代 `AGENTS.md` 的常驻作用域规则。
- `.claude/*` 保留用于兼容，不作为 Codex 的事实来源。
