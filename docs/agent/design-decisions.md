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
- Deno Worker 日志必须携带可信执行上下文：
  - `projectId`
  - `functionName`
  - `executionId`
- 平台 Phase 1 只覆盖服务端运行日志，不包含浏览器日志采集。

## Hasura 同步策略

- `track-all` 与 `reload metadata` 是两类不同操作，不能混用概念：
  - `track-all` 负责表、关系、权限等 metadata 对象同步
  - `reload metadata` 负责刷新 Hasura schema / cache 视图
- Druvia 管理端对列级 DDL 的正式策略是：
  - Admin Tables 页面内的 `add/drop/rename column` 自动触发 `reload metadata`
  - 外部 SQL / migration 导致的 schema 漂移，由用户显式触发 `刷新 Hasura Schema`

## 项目删除策略

- 项目删除是“全量清理”操作，不是单纯删除 `druvia_projects` 行。
- 平台管理接口删除项目时，必须同时满足：
  - 调用者是 `platform_user`
  - 调用者通过 `checkProjectAccess()` 校验
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

## 文档策略

- `AGENTS.md` 用于入口与索引。
- `docs/agent/project-memory.md` 用于近期高价值事实。
- `docs/plans/*` 用于完整背景与实施过程。
- `.claude/*` 保留用于兼容，不作为 Codex 唯一事实来源。
