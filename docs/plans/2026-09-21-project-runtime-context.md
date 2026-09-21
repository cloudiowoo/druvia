# 项目受管运行时上下文设计与实施

状态：本地代码与活动 PostGIS migration 已完成，联合 Hasura/PITCHETCH 验收待执行

Owner：Druvia Core

日期：2026-09-21

## 1. 背景

PITCHETCH 的商业授权 RPC 和 Hasura 授权投影需要一个由平台确定、调用方无法伪造的项目运行环境。现有
Project RPC 仅注入 actor GUC，GraphQL/Realtimes 仅注入 actor session variables，项目配置也没有可审计的
受管运行时上下文。

该能力属于 Druvia Core。PITCHETCH 只消费通用上下文，不得将套餐、槽位、降级或商业判断写入平台。

## 2. 决策

1. 平台使用通用名称 `serviceEnvironment`，合法值仅为 `local`、`sandbox`、`testflight`、`production`。
2. PostgreSQL RPC 使用事务本地 `druvia.service_environment`；Hasura 使用
   `x-hasura-druvia-service-environment`。Core 不引入 `pitchetch.*` GUC 或 Header。
3. 运行时上下文存入独立 `druvia_project_runtime_contexts` 表。无记录等于未启用，保持旧项目行为；不能复用
   无类型、可合并的 `druvia_projects.settings`。
4. 配置读写是管理控制面能力。读要求项目读取权限；写/禁用仅允许 workspace owner 或 super admin，且更新与
   活动日志在同一事务中完成。
5. 所有应用数据路径使用同一个已验证上下文：Project RPC、项目 GraphQL 代理、Functions internal GraphQL、
   Realtime token，以及 Data Access HTTP/Realtime 验证探针。
6. nginx 的公开 `/v1/graphql` 与 `/v1/graphql/ws` 必须剥离该 Header。Realtime 只从 Druvia 签发的 JWT
   claim 获取该值；HTTP 代理只从数据库配置生成该 Header。
7. 配置记录存在但不合法、读取失败或所需注入不完整时返回脱敏
   `PROJECT_RUNTIME_CONTEXT_UNAVAILABLE`，且不执行 RPC、Hasura 请求或 token 签发。无记录不是错误，因为
   它表示未启用的兼容项目；RPC 仍以事务本地空值屏蔽连接或角色级环境默认值，避免泄漏到旧项目。

## 3. 非目标与限制

- 不修改 PITCHETCH schema、V23 migration 或商业规则。PITCHETCH 应读取 `druvia.*` 通用契约，并自行对
  缺少/非法值失败关闭。
- 不复用 `druvia_project_environments`。该表表达 schema 副本环境，当前没有完成 environment actor identity；
  service environment 表示项目业务运行阶段。
- 不承诺已建立 Realtime WebSocket 在配置切换时立即获得新值。新 token 必须携带新环境；现有连接的 JWT
  重新校验行为需要在 Hasura CE 2.48 联合验收中实测并单独决定强制断开方案。
- API 当前使用 `postgres` 数据库账号。PITCHETCH 不得以 `current_user`、`session_user` 或 superuser 判断
  商业权限；未来拆分 API runtime database role 是独立加固事项。

## 4. 数据与 API 合同

```ts
type ServiceEnvironment = 'local' | 'sandbox' | 'testflight' | 'production'

type ProjectRuntimeContext =
  | { enabled: false }
  | {
      enabled: true
      serviceEnvironment: ServiceEnvironment
      revision: number
      updatedAt: string
    }
```

管理 API：

- `GET /api/v1/projects/:projectId/runtime-context`
- `PUT /api/v1/projects/:projectId/runtime-context`，body 为 `{ serviceEnvironment }`
- `DELETE /api/v1/projects/:projectId/runtime-context`

配置更新必须记录 actor、项目、旧值、新值、revision 和 request ID，但日志不得包含 project credentials、JWT
或请求 Header。

## 5. 实施任务

- [x] 新增 migration `028` 与共享类型，建立配置存储、约束和活动日志 action；migration `029` 为已应用早期 `028` 但缺少 fence 表的数据库补齐表结构并回填既有配置。
- [x] 实现 runtime context repository/service、受限管理 API 与 Admin 设置界面。
- [x] 在 RPC 事务内、GraphQL 代理和 Functions internal GraphQL 中统一注入上下文。
- [x] 在 Realtime JWT、Data Access HTTP/Realtime verifier 中统一携带上下文。
- [x] 在 local/prod/release/uat nginx GraphQL 与 WebSocket 路径清理客户端同名 Header。
- [ ] 补齐真实 PostgreSQL/Hasura 两项目联合验收；单元、路由、API/Admin build 与活动 PostGIS migration 已完成。
- [x] 同步 migration floor/ceiling、架构决策、进度和发布说明。

## 6. 验收标准

1. 两个项目交替进行 RPC、GraphQL 和 Realtime token 请求时，各自只观察到已配置的环境，连接池无残留。
2. GraphQL API 请求、Functions internal GraphQL、Data Access probe 与 Realtime JWT 使用同一项目值。
3. 客户端在 API、HTTP GraphQL 或 WebSocket 请求中伪造同名 Header 不会影响服务端值。
4. 无配置项目保持原行为；有损坏配置的项目失败关闭且不调用业务 SQL/Hasura。
5. 无权平台用户、Project Session、API Key、Trusted Backend Key 都不能修改该配置。
6. 更新/禁用操作具备事务性审计记录；PITCHETCH 可将其 Global 项目配置为 `sandbox` 后完成其 V23 联调。

## 7. 发布顺序

1. 先应用 Druvia migration `029`，发布 API/Admin/nginx；既有项目仍无运行时上下文。
2. 通过受控管理 API 将 PITCHETCH Global 配置为 `sandbox`。
3. 由 PITCHETCH 应用 V23，并以受控 Project Session 联调 RPC、GraphQL、Realtime。
4. 发布包的 migration ceiling 升至 `29`；本地、release、GHCR、自建 Registry 和 OTA 依旧遵循既有
   migration/backup/人工 apply 规则。

## 8. 实施证据

- `DB_HOST=127.0.0.1 DB_PORT=5632 pnpm migrate up`：活动 PostGIS 先从 `027` 升级至 `028`，再由 `029_project_runtime_context_fences` 补齐缺失 fence 表；随后 `status` 确认当前版本 `29`。
- `pnpm vitest run` 定向回归：145 项通过，覆盖 runtime context repository、mutation audit、controller/routes、RPC、GraphQL proxy、Functions internal GraphQL、Realtime、Data Access verifier、Nginx 和 Admin panel；独立审查补充了 RPC 空 GUC 遮蔽、管理/调用读取失败的 503 错误映射和 migration 026 测试职责分离回归。
- `pnpm vitest run tests/unit/release-pipeline.test.ts tests/unit/project-runtime-context-schema.test.ts`：29 项通过，完整 release target 为 `28`，bootstrap 仍仅接受 `< 28` 的历史 migration。
- `pnpm --filter @druvia/shared build`、`pnpm --filter @druvia/api build`、`pnpm --filter @druvia/admin build`：通过；Admin 路由包含 `/settings/runtime-context`。
- `tests/integration/project-actor-rpc-functions.test.ts` 已扩展两项目交替 RPC 与事务残留 GUC 断言；未设置 `DRUVIA_RUN_PROJECT_ACTOR_INTEGRATION=1` 和 Hasura 管理密钥时安全跳过。真实 GraphQL/Realtime 与 PITCHETCH V23 联合验收仍未执行。
