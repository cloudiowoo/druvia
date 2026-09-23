# Project GraphQL Actor Context 设计与实施

状态：本地实现完成，PITCHETCH V23 联合验收待执行

Owner：Druvia Core

日期：2026-09-22

## 1. 背景

Project RPC 已经在同一 PostgreSQL client/transaction 中写入版本化 `druvia.actor` 和
`druvia.service_environment`。Project GraphQL 经 Hasura 执行时使用另一条 Hasura 数据库连接，不能观察到 API
连接的 GUC。PITCHETCH 的 admission trigger 因而无法区分真实 Project Session 与只包含
`x-hasura-user-id` 的一般 GraphQL 请求，必须失败关闭。

本切片提供通用的 Project GraphQL actor 合同，不包含 PITCHETCH 的套餐、slot、上传或足球业务规则。

## 2. 范围与非目标

范围：

- 受管 `POST /api/v1/projects/:projectId/graphql` 在 Hasura 请求中注入可由数据库读取的 actor 合同。
- Functions internal GraphQL 对经过内部签名验证的同项目 Project User/API Key 复用同一合同。
- 公开 Nginx GraphQL/WS 入口删除客户端伪造的合同 Header。
- Project Function Deno worker 与 Hasura 使用隔离 Docker 网络，Function 只能经 API 的受管内部路径访问应用数据。
- 遗留 host-API `docker-compose.yml` 与 `docker-compose.dev.yml` 不再运行 Deno；需要 Project Functions 的开发
  必须使用受隔离的 `docker-compose.local.yml`。
- 以真实 PostgreSQL 17、Hasura CE 2.48 覆盖 Project Session mutation、伪造 Header、Function actor 和直连
  Hasura 拒绝。

非目标：

- 不修改 Project Session token 格式、Hasura metadata、Data Access role/permission、Realtime token 或数据库
  migration。
- 不在 Project GraphQL 路径设置 RPC 专用 `druvia.actor` GUC；该 GUC 只能由 RPC 的同一数据库事务使用。
- 不把 Platform Session、Trusted Backend Key 或 Data Access verifier 伪装为 Project Session。
- 不实现 PITCHETCH 的 V23 schema、trigger、商业授权或客户端改造。

## 3. 设计决策

### 3.1 传递机制

API 认证成功后，以 Hasura 管理 secret 调用 Hasura，并设置服务端生成的 `x-hasura-*` session variables。Hasura
在业务 SQL 事务内暴露这些变量；项目代码以如下模式读取：

```sql
current_setting('hasura.user', true)::jsonb
```

项目 trigger、`SECURITY DEFINER` 和 RLS/权限辅助函数必须验证所有需要字段。缺少、类型非法、版本不支持或与
业务行不匹配时必须失败关闭。

### 3.2 Actor Contract v1

| Header | Project Session | 项目 API Key |
| --- | --- | --- |
| `x-hasura-druvia-actor-contract-version` | `1` | `1` |
| `x-hasura-druvia-actor-type` | `project_user` | `apikey` |
| `x-hasura-druvia-actor-source` | `project_session` | `project_api_key` |
| `x-hasura-druvia-project-id` | 已认证项目 ID | 已认证项目 ID |
| `x-hasura-druvia-project-user-id` | Project Session `sub` | 不发送 |
| `x-hasura-druvia-service-environment` | 已配置时服务端读取 | 已配置时服务端读取 |

最后一行属于既有 Project Runtime Context 合同；无配置项目不生成该 Header，保持兼容模式。PITCHETCH 需要
runtime context 时必须自行将缺失值视为拒绝条件。

现有 Data Access 变量 `x-hasura-user-id`、`x-hasura-project-id`、`x-hasura-actor-type` 和 derived role 保持
不变。actor contract 不扩大任意表、列或 mutation 权限。

### 3.3 信任边界

1. Project GraphQL proxy 先验证 Project Session/API Key、项目范围、runtime context 和限流，再使用
   `resolveScopedProjectActor()` 构造合同。调用方输入的同名 Header 不参与构造。
2. Functions internal GraphQL 只接受 API 内部签名 token 中的已验证 Project Actor；Platform actor 在到达
   Hasura 前拒绝。
3. `deno` 只加入 `druvia-functions-network`，`hasura` 只加入 `druvia-network`，`api` 是唯一双网服务。
   因此项目 Function 不能解析或直连容器内 `hasura`，仍可通过 `http://api:3001` 使用内部受管 GraphQL。
4. `/v1/graphql` 与 `/v1/graphql/ws` 的 local、prod 和 UAT Nginx 配置清除全部
   `x-hasura-druvia-actor-*` Header，防止通过公开 Hasura 入口伪造数据库上下文。
5. functions-capable local、prod/release Compose 都不发布 Hasura host port，浏览器和外部调用只能经过 Nginx。
   local 的浏览器 GraphQL/Realtime 需启用 `with-nginx`；Hasura 诊断使用 `docker exec druvia-hasura`。这同时阻断
   Docker Desktop Function 经 host gateway 绕过网络隔离。Project Session JWT 直连 Hasura 必须被拒绝：若 Project
   Auth 与 Hasura 使用不同 signing key，返回 `invalid-jwt`；若 key 相同，仍因缺少 Hasura JWT claims 返回
   `jwt-invalid-claims`。测试必须检查 GraphQL error code，而不是只检查 HTTP status，因 Hasura 对这类请求返回
   HTTP `200` 加 error envelope。
6. Data Access verifier 不得创建 `project_session` 合同。它只使用自身固定的 verifier identity；Platform Session
   和 Trusted Backend Key 同样不能取得此 source。

## 4. 实施任务

- [x] 在 `project-actor.ts` 定义 Actor Contract v1 Header 常量和受限 session-variable builder。
- [x] Project GraphQL proxy 在每次认证后从 scoped Project Actor 生成合同，并在调用 Hasura 前覆盖客户端输入。
- [x] Functions internal GraphQL 使用已验证的内部 actor token 生成同一合同。
- [x] local/prod/UAT Nginx HTTP 与 WebSocket GraphQL 路由清除全部合同 Header。
- [x] functions-capable local/prod/release Compose 取消 Hasura host port，避免 Nginx/容器网络清理边界被绕过。
- [x] local/prod/release Compose 将 Deno worker 限制到 Functions 网络，API 是连接该网络与 Hasura 核心网络的唯一服务。
- [x] 遗留 host-API Compose 移除 Deno runtime，并将 Hasura host port 收紧为 loopback；这些模式不支持 Project
  Functions，避免 host gateway 绕过容器网络隔离。
- [x] 单元测试覆盖 Project User/API Key、缺失 Project User ID 及伪造 Header 覆盖。
- [x] 真实 PostgreSQL 17 + Hasura CE 2.48 集成测试覆盖 trigger、Functions 和直连 Hasura 拒绝。
- [x] release 的 `data-access-integration` job 使用与 API 一致的 JWT verifier，并在构建镜像前执行上述真实集成测试。
- [x] 同步根/API 规则、架构决策和项目进度。

## 5. 验收标准

1. 有效 Project Session 经受管 Project GraphQL 可以写入本人行，项目 trigger 能同时读到 version、type、source、
   Project User、Project ID 和已配置的 service environment。
2. API Key 只能获得 `apikey/project_api_key`，永远没有 Project User ID。
3. 客户端提供的 actor 或 runtime environment Header 不会覆盖服务端值。
4. Platform actor、跨项目 actor、无效 Project Session、直连 Hasura 与项目 Function 的容器内直连均不能获得
   `project_session` 上下文。
   遗留 host-API Compose 不启动项目 Function，不能作为该合同的例外运行模式。
5. Project RPC 继续使用 `druvia.actor`，GraphQL 继续使用 `hasura.user`，两者语义版本和字段含义一致。
6. 无 runtime context 的 compatibility 项目不因本功能失败；有配置但损坏的 runtime context 仍按既有规则失败关闭。

## 6. PITCHETCH 集成合同

PITCHETCH V23 的统一 actor resolver 应在 Project GraphQL trigger 路径读取 `hasura.user` JSON，并至少验证：

- contract version 等于字符串 `1`；
- actor type 为 `project_user`；
- actor source 为 `project_session`；
- project ID 等于其安装项目；
- project user ID 是当前业务操作的允许 actor；
- service environment 存在且为 PITCHETCH 允许的值（Global 当前为 `sandbox`）。

PITCHETCH 不应读取 `current_user`、`session_user`、任意客户端 Header 或 API 进程连接的 `druvia.actor` 来判断
商业权限。其 V23 migration 和双 Project Session mutation/RPC 结果构成下一阶段联合验收；本切片完成不代表
PITCHETCH 商业流程已生产就绪。

## 7. 发布与兼容性

没有 migration、Hasura metadata 或 release manifest ceiling 变化。发布时需要按现有部署流程更新 API、Nginx 和
Compose；functions-capable local/prod/release 均不允许通过宿主 `HASURA_PORT` 做诊断，改用
`docker exec druvia-hasura`。Functions internal GraphQL 随 API 一同更新，网络隔离变更还需 recreate API 和 Deno
worker。生产发布仍必须遵循 stable release、数据库 migration preflight、镜像 digest 和人工 OTA apply 规则。本地开发
需重启 API 和 Deno worker，并以 `--profile with-nginx` 启动或重启 Nginx。

## 8. 验证证据

- 初始集成测试用 HTTP `401` 断言直连 Hasura，实际响应为 HTTP `200` 与 GraphQL JWT error。已定位为 Hasura
  的 GraphQL transport 语义，而非 JWT 接受或 Header 伪造成功，并将回归断言改为 `invalid-jwt` 或
  `jwt-invalid-claims` 的真实拒绝码。
- `pnpm vitest run tests/unit/openapi-graphql-route.test.ts tests/unit/functions-internal-graphql.test.ts tests/unit/release-compose-files.test.ts tests/unit/project-actor.test.ts tests/unit/realtime-compose-config.test.ts tests/unit/release-pipeline.test.ts tests/unit/worker-compose-config.test.ts`：104 项通过。
- `docker compose --env-file .env -f docker-compose.local.yml -f docker-compose.local.dual-db.yml up -d --force-recreate api deno` 后，
  `docker inspect` 确认 API 同时位于 `druvia-network` 和 `druvia-functions-network`，Deno 仅位于后者，Hasura
  仅位于前者；Deno 容器内实测 API health 可达、`http://hasura:8080/healthz` 不可达。
- 取消 local Hasura host port 后，以 `--profile with-nginx` recreate Hasura/API/Deno/Nginx；Deno 容器内实测
  `http://hasura:8080/healthz` 与 `http://host.docker.internal:8180/healthz` 都不可达，同时 API health 和
  Nginx `http://localhost:80/health` 正常。
- `docker compose ... -f docker-compose.yml config` 与 `docker-compose.dev.yml config`：均无 `deno` service，Hasura
  仅映射到 `127.0.0.1`。
- `DB_HOST=127.0.0.1 DB_PORT=5632 HASURA_ENDPOINT=http://127.0.0.1:8180 DRUVIA_RUN_PROJECT_ACTOR_INTEGRATION=1 ... pnpm vitest run tests/integration/project-actor-rpc-functions.test.ts`：6 项通过，使用活动本地 PostGIS、真实 Hasura 和临时独立 project/schema；其中 Functions internal GraphQL 的 Project Session mutation 必须通过同一 trigger 的完整 `hasura.user` actor contract。清理后无测试项目、schema 或 metadata 残留。
- `pnpm --filter @druvia/api build`：通过；完整定向回归将在最终验证阶段记录。
- `pnpm vitest run tests/unit/release-pipeline.test.ts`：27 项通过，确认 release 在真实 PostgreSQL/Hasura 服务中启用 Project Session JWT verifier 并执行 actor contract 集成测试。
