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
- 匿名 `apikey` 能力必须是显式允许，不要扩散成默认放开。
- 新建或同步 Hasura permissions 时，禁止默认生成无行过滤的写权限；任何匿名写入都必须有明确业务理由和测试。
- 修改认证请求头时，要联动检查 SDK、MCP Server、Admin server routes 和 nginx 代理是否使用同一契约。
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
- migration CLI 只能在迁移 SQL 同时存在最外层 `BEGIN` 与 `COMMIT` 时剥离包装；孤立事务边界必须保留并由 PostgreSQL 报错。

## 参考入口

- `docs/agent/design-decisions.md`
- `docs/plans/2026-08-14-project-update-direction-analysis.md`
- `docs/plans/2026-03-19-apikey-auth-design.md`
- `docs/plans/2026-03-23-function-invoke-auth-ui-design.md`
