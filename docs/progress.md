# Druvia Progress

项目阶段进展摘要。用于记录人类可读的里程碑、当前状态与下一步，而不是每个小任务的流水账。

## Update Policy

- 仅在阶段性完成、关键阻塞解除、跨子项目影响明确时更新
- 用户显式要求同步项目进度时也应更新
- 小修、小范围重构、纯文案调整不应默认写入本文件

## Current Snapshot

- 当前项目已进入 MVP 后的生产加固与迁移兼容阶段
- 真实需求牵引以 taro-app / Supabase -> Druvia 迁移为主
- 后续采用“应用驱动平台演进”框架：taro-app 验证迁移兼容，足球运动数据应用验证原生移动端、离线批量、Storage 和后台分析场景
- 新需求按 `Core / Optional Capability / Application Domain` 分层，只有平台安全基础或经跨应用验证的通用能力进入 Core
- Phase A 的主要 Core 代码切片已落地，但阶段出口仍缺真实 taro-app 全链路验收和统一 release 质量门禁
- 近期最高优先级调整为 taro-app 生产上线验证；Phase B-D 不要求全部完成，只提前处理目标生产直接依赖的发布、备份、migration 和恢复子集
- 平台开发、Actions 构建、stable release 和生产 OTA 已明确解耦；生产只人工应用通过 taro-app 兼容回归的 stable manifest
- 项目整体评估与分阶段路线已归档到 `docs/plans/2026-08-14-project-update-direction-analysis.md`
- 应用驱动的未来开发框架已归档到 `docs/plans/2026-08-17-application-driven-development-framework.md`
- Codex 项目说明已改为官方 `AGENTS.md` 分层模型，不再维护平行的 `project-memory.md`

## Recent Milestones

- Project GraphQL Actor Contract v1 已完成本地实现：公开 Project GraphQL proxy 与已验证的 Functions internal
  GraphQL 在 Hasura request 中服务端生成 version、actor type/source、项目、Project User（仅 project user）和
  既有 service environment session variables。项目数据库 trigger/`SECURITY DEFINER` 可从
  `current_setting('hasura.user', true)::jsonb` 读取，不再错误依赖 RPC 专用的 `druvia.actor` GUC。客户端伪造
  Header 会被覆盖，公开 nginx GraphQL/WS 路径清除该命名空间；本地真实 PostgreSQL 17 + Hasura CE 2.48 已验证
  Project Session mutation、伪造 Header 覆盖、Functions actor 与直连 Hasura 的 JWT 拒绝；release 的真实
  PostgreSQL/Hasura 前置 job 也会以相同 JWT verifier 执行该合同测试。Deno worker 已从 Hasura 核心网络隔离，API
  是唯一双网桥接服务；当前 local+dual-db 运行栈已实测 Deno 可达 API 而不可达容器内 Hasura，项目 Function
  不能直连后者并伪造合同。functions-capable local 也取消 Hasura host port，浏览器 GraphQL/Realtime 改经
  `with-nginx`，阻断 Docker Desktop host gateway 绕过；遗留 host-API Compose 已移除 Deno runtime 并将 Hasura
  收紧到 loopback，明确不支持 Project Functions。该
  切片不含 migration、metadata 或 release ceiling 变化。PITCHETCH 仍需按合同完成 V23 trigger 适配和双用户
  GraphQL/RPC 联合验收，尚未标记生产就绪。
- Project Runtime Context 已完成本地代码切片：migration `028` 新增独立审计化配置表，migration `029` 为已应用早期 `028` 但缺少 fence 表的数据库补齐结构并回填既有配置；服务端仅接受 `local / sandbox / testflight / production`。项目 owner、workspace owner 与 super admin 可经项目设置页或受限 API 更新；Project Session、API Key、Trusted Backend Key 与客户端 Header 均不能声明环境。RPC 在同一事务内设置 `druvia.service_environment`，GraphQL、Functions internal GraphQL、Realtime token 以及 Data Access HTTP/Realtime verifier 由同一项目配置生成 Hasura session variable；公开 GraphQL/WS Nginx 路径清除客户端伪造 Header。无记录维持兼容模式，读取失败返回脱敏 503。活动本地 PostGIS 已实际应用 `029`，release target/ceiling 升至 `29`，并加入镜像构建前测试门禁。单元、API/Admin build 通过；真实 PostgreSQL+Hasura 的两项目交替 RPC/GraphQL/Realtime 联合验收与 PITCHETCH V23 仍待执行，尚未发布 stable 镜像或执行 OTA。
- Updater 回滚故障路径补齐：pre-027 无 gate 表时具名 holder 持续持有 Data Access 全局锁，直到显式释放；migration `027+` 的 gate 关闭前重验 holder。应用中断状态按持久阶段判定，仅文件可能已切换的部署进入只允许回滚的恢复状态；手工回滚保存原始备份 ID，且检查备份文件后才执行 Compose。自动预检拒绝、holder 丢失或 teardown 失败会阻止继续更新并停止旧服务；上述边界已有隔离 PostgreSQL 与单元回归，不代表已实际执行 bootstrap/OTA。
- Data Access v2 authorization projection 已完成 Druvia 本地平台切片：migration `027` 扩展 v1/v2 baseline 并持久化项目级批量 operation 与 `file_rollback` runtime gate；严格合同只允许当前项目 schema 的 regular security-barrier、非 security-invoker view、完整唯一键 object relationship mapping 和固定 owner+actor+allow `AND`。递归依赖闭包覆盖 view rewrite 与 inheritance/partition descendant，全部非系统 relation 必须留在 operation 固定 schema；直接函数和 custom operator implementation 的非系统函数依赖失败关闭，helper view/materialized view 的定义、完整安全属性及表级/列级 PUBLIC ACL 进入 digest；view definition 摘要保留 SQL 字面量内部空白，受管 relationship 必须唯一且完整 `using` 一致。API/Admin 已提供合同导入、preview、完整 metadata resource-version CAS 的单次 `replace_metadata` apply、显式别名确认、未知写结果 drain、最新成功 apply 批次安全关闭与 `dependency_invalid` 展示；成功 apply 标记在 fail-closed 后仍阻断旧 operation 恢复，失败关闭 provenance 不会被 superseded preview 隐藏，未应用 preview 不会阻断 completed recovery。单表保存/adoption 不能绕过 v2 provenance；v2 列能力 drift 可通过受限 reconcile 收缩失效 grants，policy/constraint/dependency 保持不变，扩大 grants 的请求被拒绝且新增列默认不授权，并在 preview、apply 接纳、metadata 写入前及 baseline 提交前复验依赖，完成前项目 preview 失败关闭。真实 PostgreSQL 17 + Hasura CE 2.48 已验证 allow/missing/cross-user 隔离、view/relationship 不暴露、跨环境 relation/partition、自定义 operator function、PUBLIC column ACL 和 helper definition drift 等失败关闭路径，以及重复 apply、metadata reload、`affected_rows`、mutation 回显、列 reconcile、事务化安全关闭和关闭后拒绝。本地活动 PostGIS 已继续迁移到 `028`，临时测试 operation 已清零，备用普通 PostgreSQL 尚未同步。当前 API 启动要求 migration floor/ceiling `28`；updater `0.2.0` 在 migration `027+` 文件回滚期间停止 API/Admin/Worker，以持久 gate 和具名 PostgreSQL session-level exclusive holder 覆盖状态检查、旧文件恢复、pre-027 服务启动及健康验证；持续监测 holder，丢失或 teardown 失败时取消命令并停止旧服务，updater 重启后先停旧服务再将中断部署转换为只允许回滚的失败状态。migration down 遇 holder/gate 快速拒绝。完整 release 要求 `minUpdaterVersion >= 0.2.0` 并包含 projection/rollback 单元与真实并发集成测试；updater-only bootstrap 在 Registry push 前也必须通过 PostgreSQL rollback-gate 集成门禁。独立 bootstrap workflow 已实现严格预检、旧稳定 release manifest/Compose/digest 不可变复用、双 Registry tag 漂移核验及 `make_latest=false` 发布，但首次正式发布前仍需实际执行并由目标客户端临时使用显式版本 manifest URL。PITCHETCH 的 `0004_commercial_access_contract.json` 仍需补 `policyVersion`/每表 `ownerColumn` 并移除顶层 schema、`denialSemantics` 后才能导入；PITCHETCH migration `0014`、九表真实合同、双 Project Session、Realtime 与从空库重建联合验收尚未执行。尚未发布镜像或执行 OTA。
- Project Device Wipe Mandates 已完成 Druvia 侧本地代码切片：migration `026` 持久化项目开关、secret 验证标签、Ed25519 key、不可逆 binding、加密 Project User 注册恢复材料与不可变 mandate/receipt 快照；API 提供 Project Session 注册、独立 handle/token 的 sessionless 查询与回执、公钥读取和 `auth:manage` 配置/轮换；Admin 认证页增加简化开关与 key 状态。三条项目 Hook 使用固定安全合同并在同一 statement 复验摘要，普通请求与恢复重放分别受有界事务超时保护，retired binding 不再发现新 obligation，query/receipt 与 restore 共用项目锁；restore 清除 runtime gate 前按 binding identity/revision 确定顺序重放注册，再依次重放账户删除 fence 和 acknowledged receipt，超时会保留专用恢复原因。sessionless 路由采用 IP/project/handle digest 三层原子限流且 Redis 故障时 fail closed，内置 Nginx 丢弃伪造 forwarding 链，并在解析阶段、命名空间外及多层编码路径的 access/error/referer 日志面保护 handle；项目删除和独立数据库用户删除在 owner/角色/schema/Storage 副作用前共用 project-auth 锁并检查生命周期记录。release/Compose ceiling 已提升到 `26`。隔离 PostGIS 已再次验证完整 up、验证标签列及空状态 down-to-025；当前活动 PostGIS 已按修订后的 migration 重建到 `026`，备用普通 PostgreSQL 仍停在 `025`，切换回普通库并启用该功能前必须迁移。私有本地环境已配置稳定且彼此独立的 Device Wipe 密钥。Taro 已在活动共享本地库完成 ACL 加固，17 个 definer 均撤销 PUBLIC EXECUTE、PITCHETCH callable 为零且 `pg_temp` 显式置末尾，原跨 schema 阻塞已解除；PITCHETCH V12 已应用并通过 Druvia 真实 Hook 合同预检，API 当前报告 `hooksReady=true`。管理面曾启用一次并生成首个 Ed25519 key，随后关闭开关且保留该 active 验证材料；当前 `enabled=false`。双用户/多设备、Watch/iPhone、公钥轮换与恢复验收、stable release 和生产 OTA 尚未完成，因此不标记端到端生产就绪。
- Project Account Self-Deletion 已完成 Druvia 侧本地代码切片：migration `025` 增加 Apple identity generation、持久删除 operation/fence、Provider revoke material、restore gate 和 executor heartbeat；API 提供 intent/confirm/status 与项目管理开关，accepted 后统一阻断 Project Session、GraphQL、Realtime、Storage、RPC、Functions 和 trusted issue。API 内执行器以 lease/renew/CAS 清理业务 Hook、Druvia Storage、Project User/identity，并将 Apple revoke 独立重试；删除 phase、Provider revoke、新 generation 与 restore 共享项目锁，Hook 摘要复验和调用绑定同一 SQL statement，overdue/attention 会使健康检查失败；内建 project schema restore 在开放项目前重放全部 accepted fence。普通 PostgreSQL 与活动 PostGIS 本地库均已应用 `025`，临时 PostGIS 已验证完整 up 及 down-to-024，API executor health 正常。PITCHETCH cleanup Hook、设备 wipe ledger、双用户/多设备验收、真实 Apple reauth/revoke、公网 notification、完整恢复演练、stable release 与生产 OTA 尚未完成；外部 deletion ledger 建成前不支持整库恢复后的防复活保证。
- Data Access managed-policy reconcile 已完成 Druvia 本地平台实现：migration `023` 按 `project + schema + table` 唯一持久化表级 baseline，并将 policy operation 绑定创建时 schema；migration `024` 持久化跨 PostgreSQL/Hasura 的表删除 outbox，并由 event trigger 在 pending 期间保留同名 relation。Admin/API 支持 adoption、结构刷新、显式列 grants、恢复状态和 revision/operation 幂等控制。恢复只覆盖 operation source/target 或可解释的非原子命令前缀，第三方 scoped permission 变化保持 recovery gate。真实 PostgreSQL 17 + Hasura v2.48 已验证新增列默认零授权、仅显式 select 扩展、删除已授权列后的受控 metadata 修复、owner 字段删除/generated/identity always 收缩、custom preservation、metadata consistency，以及 PostgreSQL 提交后 Hasura untrack 失败、untrack 已成功但 outbox 清理失败、pending 期间另一数据库连接重建同名 relation 被 SQLSTATE `55006` 阻断三类窗口。stable release workflow 已将该真实集成设为镜像发布前置门禁。PITCHETCH `football_session` 已完成 adoption，并仅将 `target_algorithm_version`、`current_analysis_run_id` 加入 authenticated select，revision 为 2；insert/update/anonymous 未扩大。四张派生表、内部表零 CRUD 和双 Project Session 仍由 PITCHETCH 后续验收，生产 release/OTA 尚未执行。
- RPC 已在本地建立数据库业务拒绝契约：仅业务函数调用阶段的 PostgreSQL `P0001` 在成功 rollback 后映射为 HTTP 400 `RPC_REJECTED`，客户端不接收原始数据库错误；连接、事务设置、未知 SQLSTATE 及 rollback 故障继续返回 500。该修复解除 PITCHETCH seal/time-only 等 RPC 验收矩阵的状态码阻塞，不涉及 migration、Hasura metadata 或 SDK 源码变更。
- Data Access 已在本地支持 PostgreSQL generated/identity 列：select、insert、update 使用独立列能力，owner preset、inspection、overview 与 migration v2 共用同一契约；v1 preview/rollback 兼容边界已固定，Hasura 502 增加脱敏定位日志。真实 PostgreSQL 17 + Hasura v2.48 已验证 Generated Always、Identity Always、Identity By Default 的策略写入和回读；PITCHETCH 已重新配置相关业务表。表列表状态现按项目当前 compatibility/explicit 模式检查唯一运行时角色集合，不再暴露物理 Hasura role；非默认环境在 actor 身份未实现前显示为暂不可用。尚待应用侧运行完整验收脚本。
- 项目成员与管理授权切片已完成本地实现：migration `022` 新增项目成员关系；平台 `admin` 收紧为登录身份；数据库当前 `super_admin`、workspace owner 和固定项目角色统一映射 capability；tenant/project/schema/backup 与项目模块路由完成资源级授权；Admin 增加成员管理和只读界面门禁。普通 PostgreSQL 与活动 PostGIS 本地库均已应用 022，PITCHETCH 用户已通过正式 API 在活动 PostGIS 库授予 `database_admin`，跨 Taro 项目及 owner-only 能力运行态验证为 403。生产 release/OTA 尚未执行。
- Apple Project Auth Druvia 侧开发切片已完成本地实现：migration `021`、平台 identity binding、原生登录、identity-bound refresh、两阶段 revoke、Apple server notification、Admin 配置与 lifecycle 管理、SDK helper、独立密钥加密和双 Registry release ceiling 已落地。mock Apple 与数据库集成定向回归通过；PITCHETCH 当前没有 Apple Developer Program 付费团队身份，真实 provider 配置、原生实现、真机和公网 notification 验收暂缓，因此不标记生产就绪。
- 本地数据库已支持并行普通 PostgreSQL 与 PostGIS：普通库继续使用默认 `postgres_data`，PostGIS 隔离到 `postgres_postgis_data`，API/Hasura 可通过显式目标切换进行应用适配验证；生产、release 和 OTA 仍保持单库部署
- 已增加 `docker-compose.postgis.yml` 可选 overlay：local/prod/release 可在不改变默认 PostgreSQL 镜像的前提下切换同主版本 PostGIS，并通过显式一次性任务为已有数据库启用扩展；数据库镜像、扩展升级与回退继续由运维人工管理，不进入普通 OTA
- MCP Server 已收口为实验性原型：包保持私有且不提供正式启动配置，当前不属于 Admin、SDK、Compose、release 或 OTA 运行链路；待真实 AI 使用场景明确管理型或项目型身份并补齐 API 契约测试后再重新启动实现
- Project Data Access Batch 1 已建立安全 metadata 基线：表 tracking 不再自动生成宽泛 CRUD permissions，Realtime 开关不再修改 select permission，Admin 默认改用数据接口/实时更新语义展示就绪状态
- 已引入版本化 data-scope role resolver 作为后续项目角色、环境作用域和 service principal 的内部扩展基础；现有项目尚未切换到 scoped role，需等待显式权限编辑和迁移批次
- Project Data Access Batch 2A 已落地默认生产 schema 的表级访问配置：认证用户 CRUD 支持关闭/全部记录/仅自己的记录，匿名侧仅支持读取；保存只批量替换当前项目受管 scoped roles，保留旧角色和自定义规则，HTTP/WebSocket actor 尚未切换。Hasura v2.48 不接受 permission command 的 `bulk_atomic` 时会精确回退到 `bulk`，并由迁移快照、差异恢复和验证闭环兜底
- Project Data Access Batch 2B 已落地默认生产 schema 的只读项目概览：
  - 项目设置新增数据访问汇总、筛选和表级配置导航
  - API 以一次数据库清单读取和一次默认数据源快照统一判定连接、认证、匿名、Realtime、旧规则和需检查状态
  - authenticated / anonymous 自定义规则独立分类，公开响应不暴露物理角色名
  - Batch 2B 交付时概览和显式 `scope=default` 导航不改变兼容运行模式；后续 HTTP 切换已由 Batch 3A 完成
- Project Data Access Batch 3A 已完成 HTTP actor 切换：
  - 迁移 `018` 持久化项目 `compatibility | explicit` 运行模式；已有项目保持兼容，新项目显式启用 scoped 模式
  - 项目 GraphQL 代理只接受同项目 `project_user` / `apikey`，拒绝平台 JWT 和客户端 Hasura 头注入
  - explicit 请求由服务端生成 scoped role 与项目用户 session variables，compatibility 继续使用旧 `user` role
  - SDK Database 不再回退平台 session；RPC/Functions 后续已由 Project Actor cutover 同步收紧
  - Admin Playground 改用内存中的 API Key 或 Project access token，并统一展示 Druvia GraphQL 代理地址
  - 已有项目迁移激活仍属于 Batch 4
- Project Data Access Batch 3B 已完成 Realtime actor 切换：
  - API 只为同项目 Project Session/API key 签发短期 Hasura token，固定 issuer/audience，并实施项目 actor 限流
  - compatibility actor 继续使用旧 `user` / `anonymous` permissions；explicit actor 使用项目 scoped roles
  - SDK 不向 Hasura 发送长期凭证，支持状态回调、令牌续期、指数退避、身份变化重连和显式停止
  - Admin 使用内存应用凭证执行真实 token exchange/WebSocket 探测，非默认环境在 environment identity 就绪前保持不可用
  - Compose、环境示例和 release workflow 已统一 API/Hasura 签名密钥，并增加源契约与真实渲染门禁
  - 已用真实 Hasura 覆盖有效、篡改、过期、兼容匿名和 explicit 跨项目拒绝；已建立 socket 的强制到期断开仍不作保证
- Project Data Access Batch 4 已完成已有项目迁移控制面：
  - 迁移 `019` 持久化不可变权限快照、计划、阶段、digest 和恢复目标
  - 仅精确历史规则可自动推断；自定义/重复/跨项目以及 Action/Remote Schema/inherited role 顶层绑定阻断，匿名写和认证 aggregate 收紧需要独立确认
  - apply、恢复和 rollback 使用项目级状态机，并通过 metadata、HTTP introspection 和 Realtime acknowledgment 做只读验证
  - 相关 DDL、权限、Realtime、raw SQL、clean restore 和删除路径接入 ordered advisory locks 与持久状态 gate
  - Admin 数据访问页提供预检、逐表保持关闭、阶段进度、失败恢复和回滚预检，不暴露 Hasura 实现细节
  - release workflow 已在镜像构建前加入 Batch 4 回归，tag 默认 manifest 要求 `018 -> 019`、备份和不可自动逆转；本地真实 PostgreSQL/Hasura apply/rollback/故障恢复已通过，真实发布和 OTA 演练按当前安排继续延期
- Project Actor RPC / Functions cutover 已完成：
  - API 以版本化 `ProjectActorContext` 统一 Platform User、Project User 和 API Key 的安全审计身份，API Key 使用稳定非秘密 ID/prefix
  - RPC 在单连接事务内写入可信 claims 并证明连接复用后无残留；API Key RPC 仍拒绝
  - Functions 在 service 同一函数记录上执行 invoke-mode 校验，内部 token、Worker caller 和日志使用严格 actor envelope，执行日志不再保存原始 payload
  - `druvia.graphql()` 已按 Project Data Access role/session variables 执行，Project User/API Key 权限由 Hasura 强制，Platform actor 被拒绝
  - API-to-Worker 请求增加强 secret 鉴权，Function 子 Worker 禁止继承容器环境，Compose 与 updater 已固化升级/回滚顺序
  - SDK RPC/Functions 不再回退 Platform Session；直接 Storage 身份与对象授权仍是后续独立切片

- API 已支持 `apikey` fallback 认证
- Realtime 权限开始与表管理权限解耦
- Functions invoke 已引入函数级 `invoke_auth_mode`
- Admin Functions 页面已补充 `invokeAuthMode` 的展示与编辑能力
- 项目终端用户 Auth Phase 1 已落地第一批核心能力：
  - `project-auth` API 路由
  - provider 通用核心与 `/:provider/login` 路由
  - 项目级 refresh token 基础设施
  - `platform_user / project_user / apikey` 身份分流
  - Functions `jwt_required` 接受同项目 `project_user`
  - RPC 接受同项目 `project_user`
  - SDK `client.projectAuth` 与独立 project session 存储
- 仓库已补齐 Codex 原生项目上下文体系：
  - 根与模块 `AGENTS.md`
  - `docs/agent/*`
  - `.agents/skills/*`
- 平台侧已补齐 Edge Function internal GraphQL 基础能力：
  - internal token
  - `/api/internal/functions/graphql`
  - 运行时 `druvia.graphql()` helper
- 平台侧已补齐终端用户图片上传 Phase 1 基础能力：
  - `/api/internal/functions/storage/upload`
  - `/api/internal/functions/storage/remove`
  - 运行时 `druvia.storage.upload()` / `druvia.storage.remove()`
  - storage 审计信息写入 `druvia_storage_objects.metadata`
  - taro-app 风格上传函数后续可去掉 `DRUVIA_TOKEN`
- 平台侧已补齐 trusted backend access Phase 1 第一批正式能力：
  - `trusted backend key` 数据模型与项目级管理 API
  - trusted project session issuer
  - trusted storage upload/remove ticket issuer
  - trusted storage upload/remove consume routes
  - SDK `projectAuth` / `storage` trusted helper
  - storage ticket 上传审计写入 `druvia_storage_objects.metadata`
- 平台日志 Phase 1 已落地第一批基础能力：
  - `packages/shared` 新增结构化日志契约与错误序列化 helper
  - Node 错误序列化已统一清理 message/stack 中的 Bearer/Basic、敏感键值与 URL userinfo；
    调用方仍不得把凭据直接写入结构化 context
  - API 首批高价值模块已接入结构化 stdout/stderr
  - Deno Worker 已输出执行级日志，并为函数内 `console.*` 注入统一结构化包装
  - MCP Server 已覆盖启动、鉴权失败、fatal 等关键日志事件
  - Admin 服务端 API wrapper 已覆盖上游 API 失败、无效响应、网络异常等最小结构化日志
- 平台日志 Phase 2 已补齐官方可选部署示例：
  - `docker-compose.local.yml` / `docker-compose.prod.yml` 新增 `with-logs` profile
  - 提供 `Loki + Promtail + Grafana` 最小可用配置
  - 新增 `docs/platform-logging-guide.md` 说明启动方式、标签约定与查询示例
- Admin Tables 已补齐 Hasura schema 刷新能力：
  - 新增 `刷新 Hasura Schema` 按钮
  - `addColumn` / `dropColumn` / `renameColumn` 后自动 reload metadata
  - 与原有 `同步 GraphQL 权限` 操作分离
- Docker Compose 在线升级初版已落地：
  - 新增 release-mode compose、worker/updater Dockerfile、`.env.release.example`
  - 新增 `apps/updater` 内部服务，支持 manifest 校验、镜像拉取、staged release、apply、restart、rollback
  - 新增 GitHub release workflow 和 manifest 生成脚本
  - API 新增 super_admin-only system update 代理路由
  - Admin 新增被动更新通知和系统设置页更新操作面板
  - release-mode compose 已新增 `with-local-nginx` profile，可用 GHCR/GitHub Release 发布物在本地通过 `http://localhost:8088` 同源演练 OTA
  - release/prod/local compose 已统一使用 `docker/storage_data` 作为本地 storage 默认持久化目录，生产 release 初始化不再依赖源码 `apps/` 目录
  - 新增独立 `docker/registry/` 部署包，支持在国内云主机/NAS 上自建 `registry:2` 作为生产可访问镜像源
  - GitHub release workflow 已改为同时推送 GHCR 与自建 Registry 镜像，并生成 `release-manifest.json` / `release-manifest.cn.json` 供客户端按环境选择 OTA 源
  - updater 自更新已改为一次性 finalizer 容器执行；apply 后进入 `finalizing`，finalizer 写回 completed/failed 状态并自动清理自身容器
  - Admin 系统更新面板已补齐阶段进度、更新详情弹窗与进行中反馈；顶部被动通知覆盖下载、应用、验证、收尾等后台阶段

## Current Next Steps

- 经明确配置确认后，在当前本地 Druvia 重新启用 PITCHETCH Device Wipe 并复用现有 Ed25519 signing key；随后执行 binding 注册、mandate 查询、receipt 回执、双用户/多设备、公钥轮换和恢复矩阵。首个生产部署继续验证物理隔离且不得放宽同一安全合同
- 冻结 taro-app/H5/小程序上线依赖和版本矩阵，盘点真实表权限、Auth provider、GraphQL、Realtime、Storage、RPC、Functions、SDK 和部署依赖
- 在真实应用中验证 Project Session 生命周期、数据/实时跨用户隔离、Storage 浏览器与小程序实际上传路径，以及 RPC/Functions token 选择；只修复联调发现的 Core 阻塞
- 为目标 stable 基线补齐根级 build/lint/核心测试门禁，并明确隔离当前并发集成和环境依赖失败；不以定向测试通过替代完整门禁结论
- 在生产同构预发布环境先完成 updater `0.2.0` bootstrap，再核对并演练 migration `018 -> 027`、数据库/Storage 备份、服务健康检查、项目成员授权、Data Access baseline/recovery、表删除 outbox、账户删除/设备擦除围栏、镜像回滚和必要的数据库人工恢复
- 验收通过后发布固定 digest 的 stable 基线并由生产人工 apply；此前不触发实际生产 OTA，后续也不按 commit 或 Phase 子任务反复升级
- 保持 beta/nightly 为 GitHub prerelease，并验证生产 `releases/latest/download` 始终指向通过兼容回归的 stable manifest
- taro-app 上线不等待足球应用、PostgreSQL 扩展、Swift SDK 或 Recipe；这些能力继续由真实应用证据决定优先级
- 足球运动数据应用后续验证原生客户端、批量写入、IMU Storage 和 Trusted Backend Worker；领域模型与算法保留在应用侧
- 暂不建设通用 Jobs、Queue、Resumable Upload 或 Worker Runtime
- 补齐公开仓库 README、LICENSE、敏感信息历史检查和版本轴说明
