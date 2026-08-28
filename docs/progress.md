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

- 冻结 taro-app/H5/小程序上线依赖和版本矩阵，盘点真实表权限、Auth provider、GraphQL、Realtime、Storage、RPC、Functions、SDK 和部署依赖
- 在真实应用中验证 Project Session 生命周期、数据/实时跨用户隔离、Storage 浏览器与小程序实际上传路径，以及 RPC/Functions token 选择；只修复联调发现的 Core 阻塞
- 为目标 stable 基线补齐根级 build/lint/核心测试门禁，并明确隔离当前并发集成和环境依赖失败；不以定向测试通过替代完整门禁结论
- 在生产同构预发布环境核对并演练 migration `018 -> 021`、数据库/Storage 备份、服务健康检查、镜像回滚和必要的数据库人工恢复
- 验收通过后发布固定 digest 的 stable 基线并由生产人工 apply；此前不触发实际生产 OTA，后续也不按 commit 或 Phase 子任务反复升级
- beta/nightly 与 GitHub `releases/latest/download` 完成隔离前，不让非 stable Release 覆盖生产 manifest 入口
- taro-app 上线不等待足球应用、PostgreSQL 扩展、Swift SDK 或 Recipe；这些能力继续由真实应用证据决定优先级
- 足球运动数据应用后续验证原生客户端、批量写入、IMU Storage 和 Trusted Backend Worker；领域模型与算法保留在应用侧
- 暂不建设通用 Jobs、Queue、Resumable Upload 或 Worker Runtime
- 补齐公开仓库 README、LICENSE、敏感信息历史检查和版本轴说明
