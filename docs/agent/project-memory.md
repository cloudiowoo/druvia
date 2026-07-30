# Druvia Project Memory

Codex 项目记忆，记录当前阶段新会话最值得优先恢复的事实。

## 产品与叙事

- 当前产品默认按“单租户 + 多项目”理解。
- Druvia 面向中文开发者，目标体验接近 Supabase，但底层以 Hasura 为核心。
- 真实需求牵引以 taro-app / Supabase 迁移兼容为主，而不是抽象平台能力先行。

## 当前优先级

- SDK 补齐与 Supabase 迁移兼容
- 权限模型细化，尤其是 API key、Functions、Realtime
- 项目终端用户 Auth Phase 1 已开始落地，优先解 taro-app 登录后受保护接口链路
- 平台日志 Phase 1 已开始落地，优先把 API / Deno Worker / MCP 收口到统一结构化 stdout 契约
- 商业化前置能力仍在规划，但不是当前一线开发焦点

## Platform Logging Phase 1

- 当前正式方向是：
  - 各服务输出结构化 JSON 到 stdout / stderr
  - 不把 Loki / Promtail / Grafana 绑定为最小部署前提
  - 用户可按自身部署规范对接任意日志采集后端
- 当前官方可选部署能力已补齐：
  - `docker-compose.local.yml` / `docker-compose.prod.yml` 均支持 `with-logs` profile
  - 推荐组合为 `Loki + Promtail + Grafana`
  - 采集目标覆盖官方 compose 中的 `api/admin/deno/hasura/postgres/redis/nginx`
- 共享日志契约当前最小字段为：
  - `ts`
  - `level`
  - `service`
  - `msg`
  - 常用上下文字段如 `module` / `requestId` / `projectId` / `functionName` / `executionId` / `durationMs`
- Node 侧当前已落地：
  - `packages/shared/src/logging/*` 提供共享契约与 error serializer
  - API 使用 Fastify request logger + `apps/api/src/lib/logger.ts`
  - MCP 目前先用本地 logger helper 对齐同一输出契约
  - Admin 当前已在 `apps/admin/src/lib/api.ts` 的服务端执行路径接入最小结构化日志
- Deno Worker 当前策略是：
  - 采用本地实现 `docker/deno-worker/logging.ts`
  - `main.ts` 记录 worker 启动、函数执行开始/成功/失败/超时
  - `executor.ts` 会把函数内 `console.*` 包装成带 `projectId/functionName/executionId` 的结构化日志
- Phase 1 当前只覆盖服务端运行日志：
  - 不采集浏览器前端日志
  - 不默认接入集中式日志后端
  - 不要求项目函数作者感知平台内部 token 或日志基础设施
- Phase 2 使用说明入口：
  - `docs/platform-logging-guide.md`

## Project User Auth Phase 1

- API 已新增项目级认证路由：
  - `POST /api/v1/projects/:projectId/auth/wechat/login`
  - `POST /api/v1/projects/:projectId/auth/wechat/silent-login`
  - `POST /api/v1/projects/:projectId/auth/:provider/login`
  - `POST /api/v1/projects/:projectId/auth/:provider/silent-login`
  - `POST /api/v1/projects/:projectId/auth/refresh`
  - `POST /api/v1/projects/:projectId/auth/logout`
- 请求身份已显式拆分为三类：
  - `platform_user`
  - `project_user`
  - `apikey`
- `PROJECT_AUTH_JWT_SECRET` 可独立于平台 `JWT_SECRET`。
- `authenticate()` 需要识别 project-user token，而不能只按平台 secret 验 Bearer token。
- 项目级 refresh token 基础设施依赖：
  - `migrations/016_project_user_auth_phase1.up.sql`
- taro-app 当前联调库仍需兼容旧字段：
  - `wx_open_id` 仍是有效查找键
  - `provider_id` / `last_login_at` 不能假设已存在
- `project-auth` 在 signup 分支不能假设 `<schema>.users.id` 是文本主键：
  - 若 `users.id` 为 `uuid`，服务端必须写入合法 UUID，不能写入 `user_xxx`
  - 若项目仍是文本型 `users.id`，才继续兼容字符串主键模式
- `project-auth` 不能假设 UUID 主键一定带数据库默认值：
  - 对 UUID 主键用户表，当前由 API 在创建时显式生成 UUID
  - 建用户底层约束错误需包装为语义化 auth 错误，如 `USER_CREATE_FAILED`
- `project-auth` 的正式演进方向已确定为：
  - 通用 provider 核心
  - provider adapter 负责 `exchangeCode()`
  - 微信路由只是兼容别名，不应成为每个 provider 都复制一套 controller/service 的模板
- 当前通用核心已支持按 provider 复用同一套：
  - 项目配置读取
  - 用户查找/创建
  - session / refresh token 签发
- 但真正可用的 provider 仍取决于现有 adapter 实现状态；当前已落地的是 `wechat`，`oidc` 路径已可复用 generic core。
- Phase 1 里：
  - `Functions jwt_required` 已接受同项目 `project_user`
  - `RPC` 已接受同项目 `project_user`
  - GraphQL project-user 能力仍不在本阶段内
- `RPC` 签名解析已补齐 `RETURNS TABLE / OUT` 兼容：
  - 不能按 `proargnames` 全量补参数
  - 需要基于 `proallargtypes + proargmodes + proargnames` 只保留输入参数 `i / b / v`
  - 否则像 `batch_insert_score_events`、`calculate_all_season_aggregations` 这类函数会把输出列误当入参

## SDK Project Auth 近期事实

- SDK 已新增 `client.projectAuth`，与平台 `client.auth` 分离。
- SDK 当前阶段的通用能力状态、接入路线与兼容风险对比文档见：
  - `docs/plans/2026-03-31-sdk-capability-status-route-comparison.md`
- SDK `select('*')` 的 introspection 展开不能只保留裸 `SCALAR/ENUM`：
  - 对 `text[]`、`uuid[]` 这类数组字段，Hasura 会以 `LIST/NON_NULL->LIST` 包装返回
  - wildcard 展开必须接受“叶子类型为 `SCALAR/ENUM`”的字段，而不是仅接受最外层 kind
  - 否则像 `stats_player_combo_agg.player_ids` 这类数组列会在 `select('*')` 时被错误丢失
- 项目侧 session 存储键为：
  - `druvia.project_session:${projectId}`
- SDK 仍需兼容历史项目 session 存储键：
  - 读取时需要接受旧的 `druvia.project_session`
  - 新版读取后会迁移到 `druvia.project_session:${projectId}`
- `functions` / `rpc` / `database/graphql` 的 token 选择顺序现在是：
  1. project session token
  2. platform session token
- `storage` 仍保持平台 token 路径，不自动切到 project token。
- SDK `query builder` / `database.graphql()` 现在共用 GraphQL 响应解析：
  - 平台已返回 HTTP 响应但 payload 为空、缺失 `data`、或非预期结构时，返回 `BAD_RESPONSE`
  - 只有 `fetch` 本身抛错时才返回 `NETWORK_ERROR`
  - 对平台非标准 `{ error: { code, message } }` 响应会保留原始 `code/message`，不再因 `Object.keys(json.data)` 抛错而误报网络错误
  - `select('*')` 的 introspection 路径也已接入同一套解析与错误分类，不再单独走旧的裸 `response.json()`
- 新迁入应用应优先调用平台 project auth API，而不是继续依赖 Edge Function 自造 session。
- `projectAuth.logout()` 现在必须显式带当前 project session Bearer token。
- SDK 发版前的最小验证命令应优先用：
  - `pnpm --filter @druvia/sdk build`
  - `pnpm test:sdk`
- 根目录 `pnpm test` 跑的是整仓 `unit + integration + e2e + sdk`，不是 SDK 独立发版门槛。
- SDK 当前发包约定：
  - `packages/sdk/package.json` 的 `files` 仅包含 `dist`
  - `prepack` 会先执行 `pnpm build`
  - prerelease 版本如 `0.1.0-beta.3` 不能直接裸跑 `npm publish`
  - npm 11 下必须显式指定 dist-tag；beta 通道当前最新版本应使用 `npm publish --tag beta`
  - 发布后可用 `npm dist-tag ls @druvia/sdk` 确认 tag 指向
  - 若要把 beta 版本切成默认 `latest`，必须显式执行 `npm dist-tag add @druvia/sdk@<version> latest`
  - 该动作属于例外操作，不应作为常规 beta 发版默认步骤
  - beta 持续期内，应用侧推荐显式消费 `beta` 通道，而不是依赖默认 `latest`
  - 迁移项目联调可使用 `@druvia/sdk@beta` 并通过显式 update 命令拉新版本
  - 主分支或待发布版本更适合锁定到具体 beta 号，避免未验证升级
  - 当前 taro-app 迁移仓库实际使用 `npm + package-lock.json`，不是 `pnpm`
  - 该仓库当前存在既有 RN/Taro peer 冲突；仅升级 SDK 时可临时使用 `npm install @druvia/sdk@beta --legacy-peer-deps`
  - 该做法只用于绕过历史 peer 校验，不代表根因已修复
- 仓库会忽略 SDK 发布副产物：
  - `*.tgz`
  - `.npmrc`
  - `package-lock.json`
- SDK 通过 npm 正式发布到 `@druvia/sdk` 之前，必须先具备 npm scope `@druvia` 的所有权或发布权限：
  - 若 scope 未创建或当前账号无权限，`npm publish` 会返回 `404 Scope not found`
  - 当前测试分发可先用 tarball，或改用临时个人 scope
- `trusted issue-session` 已落地：
  - 路由为 `POST /api/v1/projects/:projectId/auth/trusted/issue-session`
  - 只接受 `x-druvia-trusted-backend-key`
  - 需要 scope `project_session:issue`
  - 返回仍是标准 `ProjectSession`
- trusted-issued session 不引入第二套生命周期：
  - 继续复用现有 `/auth/refresh`
  - 继续复用现有 `/auth/logout`
  - 继续被同项目 `Functions jwt_required` / `RPC` 接受
- trusted-issued session 的 token claim 中：
  - `provider` 固定为 `trusted_backend`
  - 不沿用已有业务用户的 `wechat/oidc/...` provider

## GraphQL 限流配置近期事实

- GraphQL 代理限流现已支持项目级配置，管理入口为：
  - `/t/:tenantId/p/:projectId/settings/rate-limits`
- 配置存储在：
  - `project.settings.rateLimits.graphql`
- 当前字段语义为：
  - `perUser`: 每项目内单 actor 每分钟限额
  - `perProject`: 项目总计每分钟限额，`0` 表示不限
- 当前 actor 归并规则为：
  - `platform_user` -> `platform:${userId}`
  - `project_user` -> `project:${sub}`
  - `apikey` -> `anon-ip:${request.ip}`
- SDK `database/graphql` 现在优先带 `projectAuth` session Bearer token；项目终端用户已登录时，请求应落入 `project:${sub}` 桶，而不是继续归到匿名 IP。
- 因此当前匿名 `apikey` 流量仍按来源 IP 聚合，不是按 API key id 独立计数。
- 若 API 部署在 nginx / ingress 后，必须开启 `TRUST_PROXY`；否则匿名 `apikey` 的 `request.ip` 会退化为代理地址，导致 GraphQL 限流误合并。
- GraphQL 限流 Redis key 必须包含 `projectId`，否则会把跨项目流量错误合并。
- 项目设置保存虽已改为 `settings` 顶层 JSONB merge，但 `rateLimits` 内部仍不是深合并：
  - 前端保存 `rateLimits.graphql` 时必须保留同级其他子键
  - 不能只提交一个孤立的 `graphql` 子对象并假设后端会自动深合并

## Backup 运行近期事实

- Backup / Restore 的正式执行路径应优先使用直连数据库的 `pg_dump` / `pg_restore`，而不是把 API 服务绑定到宿主机 `docker exec`。
- `docker exec <postgres-container>` 当前只作为本地开发兜底：
  - 适用于 API 进程所在环境缺少 `pg_dump` / `pg_restore` 二进制但可访问本机 Docker CLI 的场景
- 生产 API 镜像必须包含 PostgreSQL client tools；否则备份/恢复会因命令缺失失败：
  - 旧实现会直接表现为 `spawn docker ENOENT`
  - 新实现若镜像也缺少 `pg_dump` / `pg_restore`，则会在直连命令缺失后再回退兜底

## Docker Compose 在线升级方向

- 生产环境在线升级目标参考 Sub2API 的界面体验，但不能照搬“容器内替换单二进制”机制。
- Druvia 的正式方向是 Compose-native OTA：
  - 新增独立 `updater` 服务持有 Docker socket 和部署目录挂载
  - API 只做 `platform_user + super_admin` 鉴权代理
  - Admin 只展示通知、状态和操作按钮
- API、Admin、Deno Worker 不应挂载 Docker socket。
- 生产在线升级应使用 release-mode compose 和版本化镜像：
  - `api/admin/worker/updater` 均由 release manifest 指向镜像 digest
  - 不依赖 `latest`
  - 不依赖生产机器本地 `build:`
- Deno Worker 的生产升级对象应是版本化 worker 镜像，不是宿主机挂载的 `docker/deno-worker` 源码目录。
- 升级前数据库保护应由 updater 直连 PostgreSQL 执行完整 `pg_dump`，并保存到 update state volume。
- 不可逆数据库迁移失败时，只承诺自动回滚镜像和 compose 状态；数据库恢复需要使用升级前 dump 人工执行。
- 截至 2026-07-28，Compose OTA 初版代码已落地：
  - `packages/shared/src/update.ts` 提供 release manifest / update status 共享契约
  - `apps/updater` 提供内部 updater Fastify 服务、状态文件、manifest 校验、镜像拉取、staged env/compose、apply、restart、rollback
  - `docker/docker-compose.release.yml`、`.env.release.example`、`Dockerfile.worker`、`Dockerfile.updater` 已新增
  - API 已新增 `/api/v1/system/update/*` 和 `/api/v1/system/restart`，只允许 `platform_user + super_admin`
  - Admin 已新增全局更新通知和系统设置页更新面板
  - GitHub release workflow 与 `scripts/release/generate-manifest.mjs` 已新增
- 外部 API 返回仍遵循 Druvia 标准 `{ success, data/error }` envelope；只有 updater 内部 `/internal/*` 使用裸状态 / 裸错误响应。
- `DRUVIA_MANAGED_SERVICES` 默认仍是 `api,admin,deno,hasura`；内置 `nginx` 只在明确 opt-in 时加入，`certbot` 不进入常规 managed services。
- 本地演练 GitHub/GHCR 发布物 OTA 时，使用 `docker-compose.release.yml --profile with-local-nginx`，入口为 `http://localhost:${LOCAL_HTTP_PORT:-8088}`；该 profile 复用 `docker/nginx/conf.d.local`，不使用生产域名、HTTPS 证书或 certbot。若要从 Admin UI 执行 apply，`.env.release` 也要设置 `DRUVIA_COMPOSE_PROFILES=with-local-nginx` 和 `DRUVIA_MANAGED_SERVICES=api,admin,deno,hasura,local-nginx`，让 updater 后续 compose 命令继续管理本地反代。
- 生产内置 nginx 仍使用 `--profile with-nginx`；不要把本地 `with-local-nginx` 当成生产入口。
- `DRUVIA_DEPLOY_DIR` 必须是宿主机上 `docker/` 部署目录的绝对路径，并以同一个绝对路径挂入 updater；不要回退到只把宿主目录挂为容器内 `/deploy`，否则 updater 通过 Docker socket 执行 compose 时会把 bind mount 源解析成宿主不存在的 `/deploy/...`。
- 完整实施文档见：
  - `docs/plans/2026-07-28-compose-ota-update-implementation.md`
  - `docs/superpowers/plans/2026-07-28-druvia-compose-ota-update.md`

## Functions / API Key 近期事实

- API 已支持 `apikey` fallback 认证。
- GraphQL 代理已适配匿名 `apikey` 链路。
- Functions invoke 权限不再是“同项目匿名 apikey 可调用任意函数”。
- 当前采用函数级 `invoke_auth_mode`：
  - `jwt_required`
  - `anon_allowed`
- 默认值必须是 `jwt_required`。
- Edge Function 平台侧已开始补正式内部数据通道：
  - API 提供 internal GraphQL proxy
  - 运行时内建 `druvia.graphql()`
  - 平台级 Hasura secret 不应再作为项目函数的正式 secrets 方案

## Functions 匿名调用规则

- 只有明确属于登录前流程的函数，才应考虑 `anon_allowed`。
- 当前应优先视为匿名开放候选的函数：
  - `wx-silent-login`
  - `wx-login-register`
  - `wx-auth`
  - `wx-auth-fixed`
- 上传类、用户态、后台函数默认不应开放匿名调用，例如：
  - `upload-avatar`
  - `upload-team-logo`

## Edge Function 内部调用规则

- 新函数应优先使用运行时内建 `druvia.graphql()`，而不是项目 secrets 中的 Hasura admin 类凭证。
- internal token 属于执行期内部凭证，不属于 Admin secrets UI 中的项目配置项。
- `DRUVIA_GRAPHQL_URL`、`HASURA_ADMIN_SECRET`、等价的 `DRUVIA_SERVICE_ROLE_KEY` 不应继续作为正式推荐的函数数据访问模型。
- 终端用户图片上传的 Phase 1 正式模型已确定为：
  - API internal storage proxy
  - 运行时内建 `druvia.storage.upload()` / `druvia.storage.remove()`
  - 平台级 storage 写权限只保留在 API 服务端
- `API_BASE_URL` 仅用于对外 public URL / signed URL 生成，不应用作 Deno worker 内部回调地址。
- Worker 内部 `druvia.storage.*` / `druvia.graphql()` 回调应优先走内网地址：
  - API 侧显式传入 `INTERNAL_API_BASE_URL`
  - Worker 侧回退 `DRUVIA_API_URL`
- 当 API 与 Deno worker 都运行在 Docker Compose 网络中时：
  - `DENO_WORKER_URL` 必须显式指向 `http://deno:7133`
  - 不能依赖 `http://localhost:7133`，因为那会回到 API 容器自身
- `DRUVIA_TOKEN` 不再是项目函数写 storage 的正式方案，只可视为历史临时兼容思路。
- `druvia.storage.upload()` 当前是窄能力：
  - 当前支持 `upload()` 与受控 `remove()`
  - helper 对函数作者不暴露 `projectId` / `caller`
  - helper 原始返回 `{ path, publicUrl, object }`
  - `publicUrl` 仅在目标 bucket 为 public 时非 `null`
- `remove({ bucket, path, ignoreMissing? })` 已可用于头像/队徽替换场景里的旧对象清理。
- internal storage route 会把以下审计字段写入 `druvia_storage_objects.metadata`：
  - `created_by_type`
  - `created_by_platform_user_id`
  - `created_by_project_user_id`
  - `source_function`
- 同路径重传时，storage metadata 中的上述审计字段也必须刷新，不能沿用旧调用者信息。

## Trusted Backend Access 近期事实

- 新增了项目级 `trusted backend key` 模型，与匿名 `apikey` 分离：
  - 管理路由为 `/api/v1/projects/:projectId/trusted-backend-keys`
  - key prefix 为 `drutb_`
  - 当前 scope：
    - `project_session:issue`
    - `storage_ticket:issue`
- `trusted backend key` 的正式用途是服务端受控签发，不用于浏览器直连或匿名公开访问。
- H5 类外部应用当前推荐双层模型：
  - 身份统一优先走 trusted session issuer
  - 上传图片优先走 trusted storage ticket
- storage trusted ticket Phase 1 已落地：
  - issuer routes:
    - `POST /api/v1/projects/:projectId/storage/trusted/upload-ticket`
    - `POST /api/v1/projects/:projectId/storage/trusted/remove-ticket`
  - consume routes:
    - `POST /api/v1/storage/upload-with-ticket`
    - `POST /api/v1/storage/remove-with-ticket`
  - consume route 只信任 ticket 内的 `projectId / projectUserId / bucket / pathPrefix|path`
- trusted storage ticket 当前约束：
  - issuer 鉴权只接受 `x-druvia-trusted-backend-key`
  - consume 鉴权只接受 `x-druvia-storage-ticket`
  - 上传 ticket 约束 `pathPrefix / contentTypes / maxBytes / exp`
  - 删除 ticket 约束精确 `path`
  - ticket 签名 secret 必须使用专用 `STORAGE_TRUSTED_TICKET_SECRET`
  - 不能回退复用 platform/project JWT secret
- trusted storage ticket 上传会把以下审计字段写入 `druvia_storage_objects.metadata`：
  - `created_by_type = trusted_backend_project_user`
  - `created_by_project_user_id`
  - `issued_by`
  - `issued_via = trusted_storage_ticket`
- SDK 已补 trusted helper：
  - `client.projectAuth.issueTrustedSession(...)`
  - `client.storage.issueUploadTicket(...)`
  - `client.storage.issueRemoveTicket(...)`
  - `client.storage.uploadWithTicket(...)`
  - `client.storage.removeWithTicket(...)`

## 管理端与迁移注意事项

- 项目删除的正式语义不是只删 `druvia_projects` 记录：
  - Admin Settings 删除项目前，API 必须校验 `platform_user + checkProjectAccess()`
  - 删除过程中必须同时清理项目 schema、项目数据库用户、Storage 对象目录、旧 `druvia_files` 物理路径、`druvia_backups` 对应备份文件
  - `dropProjectDbUser()` 若失败，不能继续删除项目记录
  - 物理文件 cleanup 不能早于 schema / db user 这类关键删除步骤
  - 本地 `LocalAdapter.delete()` 需要回收空父目录，否则项目目录会残留在磁盘上
- Admin 端 Functions 页面已经增加 `invokeAuthMode` 的展示与编辑能力。
- 创建函数时不暴露该字段，默认保持 `JWT Required`。
- Admin 端 Tables 页面现在要区分两类 Hasura 操作：
  - `同步 GraphQL 权限` = track tables / relationships / permissions
  - `刷新 Hasura Schema` = 触发 Hasura metadata reload，处理字段缓存未刷新问题
- 在 Admin Tables 页面内执行：
  - `addColumn`
  - `dropColumn`
  - `renameColumn`
  这三类列级 DDL 后，API 会自动执行一次 Hasura metadata reload。
- 如果变更来自：
  - 外部 SQL
  - 手工 migration
  - 数据库页直接执行的 schema 变更
  则不能假设 Hasura cache 已自动刷新；此时应显式点击 `刷新 Hasura Schema`。
- 对 taro-app / Supabase init chain 或外部导入得到的项目 schema：
  - 不要假设 schema 内已经存在 Druvia 的 `_meta_tables`
  - Realtime 订阅页对应 API 现在会在读取/配置订阅前自动 bootstrap `_meta_tables`，并补齐 `realtime_enabled` 列
  - 因此导入后的 schema 即使缺少这张元表，也应能先列出业务表，再继续配置 realtime
- Admin 端项目级 Auth 页面
  - `/t/:tenantId/p/:projectId/auth`
  - 当前就是微信小程序 `project-auth` 的配置入口
  - UI 中的 `Client ID` / `Client Secret` 应按 `微信 AppID` / `微信 AppSecret` 理解
  - 当前微信登录类型固定按 `miniprogram` 处理，不应再依赖旧的 Edge Function secrets 约定
- Admin 端数据库页要区分两条 SQL 链路：
  - DDL 模式仍会禁止 `CREATE FUNCTION` / `SECURITY DEFINER`
  - `/sql/import` 已支持导入带 `$$` 或 `$tag$` body 的 PL/pgSQL function SQL
- 在 Admin 中保存 `invokeAuthMode` 之前，数据库必须已执行：
  - `migrations/015_function_invoke_auth_mode.up.sql`
- 如果保存时报：
  - `column "invoke_auth_mode" of relation "druvia_functions" does not exist`
  说明迁移未执行，不是前端字段绑定问题。

## 文档优先级

当文档与代码不一致时，优先级应为：

1. 当前代码
2. 最近实施文档
3. 本目录下的 `design-decisions.md`
4. `.claude/memory/design-decisions.md`

## 建议回填时机

以下情况发生后，应优先更新本文件：

- 权限模型变化
- taro-app / Supabase 兼容结论变化
- 某个高频故障定位到明确前置条件
- 新会话最容易重复踩坑的事项出现
