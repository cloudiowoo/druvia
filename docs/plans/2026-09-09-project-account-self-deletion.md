# Project Account Self-Deletion 设计与实施计划

状态：Druvia 侧本地代码切片完成，应用联调、真实 Apple、恢复演练与发布验收待完成
Owner：Druvia Project Auth
日期：2026-09-09

> **执行约束：** 本文是同一功能唯一的设计与实施文档。实施在 Druvia 主工作区按任务顺序完成，
> 使用测试驱动开发；无需为每个子步骤设置人工检查点。涉及身份、数据库迁移、恢复和数据完整性，
> 最终必须经过 `critical_reviewer`，修复至无 Critical、High 或 Medium finding。

## 1. 目标

为 PITCHETCH 和其他 Druvia 项目提供 Project User 自助账户删除能力：当前 Project Session 用户
经 Provider 重新认证后，只能删除自身账户；请求被接受后立即阻断新请求、刷新和重新登录，后续由
持久状态机完成业务数据、Druvia Storage、Project User 和 Provider 授权清理。

账户删除完成后，同一 Apple 身份可以注册为新的 Project User。新账户不得与旧 Project User、旧业务
数据或旧删除 operation 建立关联；删除恢复围栏继续阻止备份恢复出的旧账户重新可见。

## 2. 现状与缺口

现有能力可以复用，但不能直接作为账户删除：

- migration `021` 已提供 Apple identity、加密 provider refresh token、`deletion_pending`、
  lifecycle event 和 identity 级 refresh token 撤销。
- `POST /projects/:projectId/auth/apple/revoke` 会先进入 `revoke_pending` 并撤销 refresh token；Apple
  暂时失败时保留加密 provider token，但只有管理端 retry，没有账户级后台状态机。
- Apple `account-deleted` notification 会进入 `application_action_pending`，当前需要 Trusted Backend
  手工删除业务数据并 ack。
- Project Access Token 是无状态 JWT。`authenticate` 只验证签名和过期时间；GraphQL、Realtime token、
  Storage、RPC 和 Functions 不统一回查 Project User/identity 状态。仅撤销 refresh token 不能立即
  阻断已签发 Access Token。
- Functions 内部 GraphQL/Storage 使用已签发的内部 token，不能仅依赖外部请求 middleware。
- 当前没有通用持久任务队列、Project User 设备登记或多设备本地擦除模型。
- Druvia 内建 backup 是 project schema 级 `pg_dump/pg_restore`；`public` 平台表不会被普通项目备份
  覆盖，但整库灾难恢复会同时回滚平台删除记录。

## 3. 非目标

- 不建设通用 Jobs、Queue、Webhook 或 service-principal 平台。
- 不向 PITCHETCH App 发放 Platform Token、Trusted Backend Key、Hasura admin secret 或数据库凭证。
- 不让 Druvia 猜测足球业务表的删除顺序、法定保留字段或外部数据源。
- 不在第一版支持任意 HTTP cleanup URL；这会引入 SSRF、签名轮换和外部可用性边界。
- 不宣称当前 Hasura 架构能即时终止已经建立的 WebSocket 或取消已经开始执行的请求。
- 不永久封禁已完成删除的 Apple subject。
- 第一版只支持具有 active Apple Project Auth identity 的 Project User；WeChat/OIDC 等 provider 后续按
  各自重新认证和撤销契约扩展，现有登录行为不受影响。
- 不把真实 Apple/PITCHETCH 联调、镜像发布或生产 OTA 与本地代码完成混为同一动作。

## 4. 方案决策

### 4.1 采用：PostgreSQL 持久状态机 + 项目数据库清理 Hook

账户删除 operation 和恢复围栏位于 `public` schema。PostgreSQL 是唯一任务事实源；执行器使用 lease、
`FOR UPDATE SKIP LOCKED`、`next_attempt_at` 和有界指数退避。Redis 只可用于唤醒或观测，不能作为唯一
状态源。

PITCHETCH 在自己的 schema 提供固定签名、幂等的数据库函数。Druvia 负责调用该函数、清理平台拥有的
身份和 Storage；PITCHETCH 负责业务数据及设备擦除任务。该边界不引入新的宽权限 Project Actor。

### 4.2 拒绝：扩展现有 Apple revoke 为账户删除

Apple revoke 只表达 Provider 授权状态，不能表达业务数据、Storage、设备、恢复围栏、24 小时 deadline
或跨进程重试。继续复用其 adapter 和加密材料，但不复用其顶层状态语义。

### 4.3 延后：通用签名 HTTPS Hook 或 Functions system actor

外部数据源出现后可以增加签名 HTTPS Hook。当前 Functions actor 只有 Platform User、Project User 和
API Key；为账户删除增加通用 system actor 会扩大 GraphQL/Storage 权限模型，当前不采用。

### 4.4 首版执行器部署在 API 进程

首版沿用现有可恢复 outbox 的部署模式，由每个 API 实例启动轻量调度循环，PostgreSQL lease 保证任务只被
一个实例执行。执行状态不依赖进程内存，API 重启或实例切换后可继续。

不在 migration `025` 首发中新增 Compose service。原因是旧 updater 已在启动时固定 managed services，
无法在同一次 OTA 中发现并启动新 service；强行新增会形成“镜像和 migration 已更新、删除执行器未启动”
的半完成状态。未来确有隔离吞吐需求时，先发布支持动态 service discovery 的 updater，再用后续 stable
版本把同一执行器模块拆为独立进程。

## 5. 安全语义

### 5.1 删除目标

- intent 的 `projectId` 来自路由，`projectUserId` 只来自已验证 Project Session 的 `sub`。
- create/confirm 请求体不接受 `userId`、identity ID、Apple subject、role 或 Hasura claims。
- confirm 必须重新验证 Apple authorization code、identity token、issuer、audience、nonce 和签名，并
  要求验证结果的 subject 与当前 Project User 的 active Apple identity 精确一致。
- nonce 必须由 Druvia intent 生成并绑定本次 deletion ID；不接受 App 自行生成且未绑定 intent 的 nonce。
- identity token 的 `iat` 必须落在服务端允许的短重认证窗口内；仅“签名有效且尚未过期”不算本次删除的
  新鲜认证。
- 重新认证凭证只存在于请求内存；authorization code、identity token 和 raw nonce 不落库、不进日志。

### 5.2 “立即阻断”的精确定义

删除接受事务提交后：

- 所有 Druvia Project refresh token 立即撤销。
- Apple identity 进入 `deletion_pending`，Apple login/refresh 不能重新激活或签发 Session。
- 所有携带旧 Project Access Token 的新项目数据、Session 签发和刷新请求在解析 JWT 后必须查询
  account fence，并返回 `ACCOUNT_DELETION_IN_PROGRESS`。删除状态查询及 confirm 的幂等重放是唯一例外，
  只授予该 operation 的只读状态能力。
- 同一检查必须覆盖公开 GraphQL、Realtime token exchange、Storage、RPC、Functions，以及 Functions
  内部 GraphQL/Storage 中恢复出的 Project User actor。
- PITCHETCH 收到 `202` 或查询到 `accepted/processing/completed` 后立即停止 Realtime、后台同步并清除
  当前设备的本地 Session。

当前 Hasura JWT 和 WebSocket 不支持按 Project User 主动撤销。已建立的订阅可能继续到网络断开、服务
关闭或 Hasura 自身终止连接；第一版不承诺对既有 socket 的毫秒级强制断开。删除状态机应优先清除业务
行以缩短可见窗口。需要严格终止时，后续单独建设可维护连接注册表的 Realtime Gateway。

### 5.3 接受后不可取消

- `pending_confirmation` intent 可以过期，不改变账户状态。
- confirm 事务一旦提交即不可取消或恢复旧账户。
- 所有后续错误只能进入 retry 或 `attention_required`，不能把 identity 恢复为 active。
- `completed` 后允许同一 Apple subject 创建全新的 Project User；旧 fence 只保护旧 Project User 和旧
  generation，不授予新账户任何旧数据访问权。

## 6. API 契约

### 6.1 创建 intent

```http
POST /api/v1/projects/:projectId/auth/account-deletions/intents
Authorization: Bearer <project-access-token>
Idempotency-Key: <uuid>
```

仅接受同项目 `project_user`。返回：

```json
{
  "success": true,
  "data": {
    "deletionId": "5edb1d3c-70d7-49d4-a86a-5d7aa71c4f2e",
    "statusToken": "<deletion-status-token>",
    "reauthNonce": "<server-bound-raw-nonce>",
    "status": "pending_confirmation",
    "intentExpiresAt": "2026-09-09T12:00:00.000Z"
  }
}
```

- 同一 `(projectId, projectUserId, Idempotency-Key)` 重试返回相同 deletion ID 和 status token。
- status token 和 `reauthNonce` 由专用 `ACCOUNT_DELETION_STATUS_SECRET` 以不同 domain label 对
  version/project/deletion ID 做 HMAC 派生，不落明文，可在响应丢失后确定性重建。数据库只保存 nonce
  hash；该 secret 必须稳定备份。常规轮换需先引入带 key version 的双读机制；紧急轮换可以使旧 status
  token 失效，但不能取消或暂停已接受 operation，平台管理员仍可查看和恢复执行状态。
- 同一用户只允许一个未过期 intent 或未终结 operation；新 idempotency key 命中活动 operation 时返回
  当前 operation，不创建第二条删除链路。
- App 在调用 Apple UI 前把 deletion ID/status token 写入 Keychain，并把 Druvia 返回 nonce 的 SHA-256
  传入 Apple AuthenticationServices；intent 创建响应丢失时以相同 key 重试。
- intent 默认 10 分钟过期；Apple identity token 的重新认证窗口默认 5 分钟并允许最多 60 秒时钟偏差，
  两者都以服务端时间判断。

### 6.2 确认删除

```http
POST /api/v1/projects/:projectId/auth/account-deletions/:deletionId/confirm
Authorization: Bearer <project-access-token>
X-Druvia-Deletion-Token: <status-token>
Content-Type: application/json
```

```json
{
  "authorizationCode": "<apple-code>",
  "identityToken": "<apple-identity-token>",
  "rawNonce": "<original-nonce>"
}
```

成功返回 `202 Accepted`：

```json
{
  "success": true,
  "data": {
    "deletionId": "5edb1d3c-70d7-49d4-a86a-5d7aa71c4f2e",
    "status": "accepted",
    "acceptedAt": "2026-09-09T12:00:00.000Z",
    "dataDeletionDeadlineAt": "2026-09-10T12:00:00.000Z"
  }
}
```

confirm 先以 CAS 获取短期 confirmation lease，再进行 Apple 网络验证；并发请求只能读取
`confirmation_in_progress`，不能第二次交换同一 code。Apple 验证完成后进入项目锁和 identity lock，并在
同一数据库事务中：

1. 重读 intent、Project User、identity 和当前 fence。
2. 验证 intent 仍属于当前 Session、raw nonce 匹配 intent 保存的 hash，且 Apple subject 与 identity
   一致；nonce 只允许成功消费一次。
3. 将 operation 改为 `accepted`，写入 24 小时 deadline。
4. 写入旧 Project User generation 的恢复 fence。
5. 将 identity 改为 `deletion_pending`，撤销该用户全部 Druvia refresh token。
6. 将新取得的 Apple refresh token加密复制到 operation 专用 revoke material。
7. 提交后唤醒执行器。

首次 confirm 必须同时具备可用且属于该 intent 的 Project Session 和 status token。路由先校验 deletion
token 并读取 operation：`pending_confirmation` 时再执行完整 Project Session 围栏与 Apple reauth；
operation 已进入 `accepted/processing/attention_required/completed` 后，status token 仅允许返回当前状态，
不再要求 Project Session 或重复消费 Apple code，也不授予任何项目数据能力。不同身份、不同 project 或
不匹配的 intent 返回 403/409。

Apple reauth 成功但 accepted 数据库事务失败时，新取得的 Apple refresh token 不得落入无主状态：请求
路径必须先尝试立即 revoke；revoke 暂时失败时，将其加密写入独立补偿记录供执行器重试，且仍不得接受
删除或改变 identity 状态。进程在 Apple 返回后、持久化前崩溃属于不可消除的跨系统窗口：lease 到期后
只允许使用新的 Apple credential 重试，并记录为显式残余风险。

status/deletion ID 不存在、token 错误或 project 不匹配时使用统一错误形状和近似时序；intent、confirm、
status 都进入 Project Auth 限流，防止凭证猜测和 Apple 上游滥用。

### 6.3 查询状态

```http
GET /api/v1/projects/:projectId/auth/account-deletions/:deletionId
X-Druvia-Deletion-Token: <status-token>
```

该接口不依赖 Project Session，供 Access Token 失效、响应丢失和 App 重启后查询。响应不返回 User ID、
Apple subject、hook 错误正文或内部重试信息：

```json
{
  "success": true,
  "data": {
    "deletionId": "5edb1d3c-70d7-49d4-a86a-5d7aa71c4f2e",
    "status": "processing",
    "phase": "business_cleanup",
    "acceptedAt": "2026-09-09T12:00:00.000Z",
    "dataDeletionDeadlineAt": "2026-09-10T12:00:00.000Z",
    "localWipeRequired": true,
    "providerRevocationPending": false,
    "completedAt": null
  }
}
```

状态 token 只授权读取这一条删除 operation，不是 Project Session，不能用于其他 API。
合法 token 查询已知 operation 时始终返回 HTTP 200，包括 `expired`、`attention_required` 和
`completed`；错误表中的 503 只用于旧身份在恢复冲突期间尝试登录或访问项目数据的失败关闭响应。

### 6.4 项目管理配置

```http
GET /api/v1/projects/:projectId/auth/account-deletion
PUT /api/v1/projects/:projectId/auth/account-deletion
Authorization: Bearer <platform-session>
```

两条路由都使用现有项目成员授权的 `auth:manage` capability。PUT 首版只接受 `{ "enabled": true|false }`：

- 启用前必须完成 cleanup function 的签名、owner、隔离角色、ACL 和 search path 静态检查；不得为探测
  幂等性而对真实用户调用删除函数。幂等性由隔离集成测试和 PITCHETCH migration 验收证明。
- 存在未终结 operation 时不能禁用；已接受删除不能因配置变化停止重试。
- Admin 的 Project Auth 页面只展示“账户删除：已启用/未启用”和“业务清理：已就绪/未就绪”，不暴露
  schema、SQL、function name 或内部执行器配置。
- create intent 必须在 Apple provider 可用且 deletion config 已启用、preflight 当前有效时才返回成功，
  避免用户完成 Apple UI 后才发现平台无法执行删除。

### 6.5 错误码

| code | HTTP | 语义 |
| --- | ---: | --- |
| `ACCOUNT_DELETION_REAUTH_REQUIRED` | 401 | 重新获取 Apple credential |
| `ACCOUNT_DELETION_IDENTITY_MISMATCH` | 403 | Apple subject 与当前 Project User 不一致 |
| `ACCOUNT_DELETION_IN_PROGRESS` | 409 | 账户已接受删除，禁止项目数据访问或登录 |
| `ACCOUNT_DELETION_NOT_CONFIGURED` | 409 | 项目 cleanup Hook 未通过 preflight |
| `ACCOUNT_DELETION_STALE` | 409 | intent 已过期或状态不允许 confirm |
| `ACCOUNT_DELETION_STATUS_TOKEN_INVALID` | 401 | 删除状态凭证无效 |
| `ACCOUNT_DELETION_ATTENTION_REQUIRED` | 503 | 旧身份存在恢复冲突，禁止登录或数据访问 |

客户端不接收数据库、Apple 或 Hook 原始错误。

## 7. 数据模型

新增 migration `025_project_account_deletions`。

该 migration 同时为 `druvia_project_auth_identities` 增加 `generation INTEGER NOT NULL DEFAULT 1`。现有
identity 全部归为 generation 1；新注册只能取相同 subject fingerprint 的下一 generation，并始终创建
新的 Project User ID，不能复用或重新激活 fence 中的旧 ID。

### 7.1 配置

```sql
CREATE TABLE druvia_project_account_deletion_configs (
  project_id VARCHAR(64) PRIMARY KEY
    REFERENCES druvia_projects(project_id) ON DELETE CASCADE,
  enabled BOOLEAN NOT NULL DEFAULT false,
  cleanup_mode VARCHAR(24) NOT NULL DEFAULT 'database_function'
    CHECK (cleanup_mode = 'database_function'),
  cleanup_function TEXT NOT NULL DEFAULT 'druvia_delete_project_user_data',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (cleanup_function ~ '^[a-z_][a-z0-9_]{0,62}$')
);
```

启用前用 `to_regprocedure` 验证项目 schema 中存在精确签名：

```text
<schema>.druvia_delete_project_user_data(text, uuid) -> jsonb
```

首版不允许管理员填写 schema、任意 SQL 或 URL。schema 始终来自项目当前数据库记录；function 名只可
使用受限标识符并在 operation 创建时快照。

### 7.2 Operation

```sql
CREATE TABLE druvia_project_account_deletions (
  deletion_id UUID PRIMARY KEY,
  project_id VARCHAR(64) NOT NULL
    REFERENCES druvia_projects(project_id) ON DELETE CASCADE,
  project_schema TEXT NOT NULL,
  project_user_id TEXT NOT NULL,
  provider VARCHAR(32) NOT NULL,
  issuer TEXT NOT NULL,
  identity_id BIGINT,
  source VARCHAR(32) NOT NULL DEFAULT 'project_user',
  source_reference TEXT,
  generation INTEGER NOT NULL,
  idempotency_key UUID NOT NULL,
  reauth_nonce_hash CHAR(64),
  intent_expires_at TIMESTAMPTZ,
  confirmation_lease_token UUID,
  confirmation_lease_until TIMESTAMPTZ,
  cleanup_function TEXT NOT NULL,
  cleanup_contract_hash CHAR(64) NOT NULL,
  status VARCHAR(32) NOT NULL,
  phase VARCHAR(32) NOT NULL,
  accepted_at TIMESTAMPTZ,
  data_deletion_deadline_at TIMESTAMPTZ,
  next_attempt_at TIMESTAMPTZ,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  lease_token UUID,
  lease_until TIMESTAMPTZ,
  last_error_code VARCHAR(64),
  provider_revocation_status VARCHAR(24) NOT NULL DEFAULT 'not_required',
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (project_id, project_user_id, idempotency_key)
);
```

允许状态：

```text
pending_confirmation -> expired
pending_confirmation -> accepted -> processing -> completed
                                      \-> attention_required -> processing
```

`project_schema`、`cleanup_function`、`cleanup_contract_hash`、Project User、provider/issuer 和 generation
在 operation 创建后不可变。hash 覆盖 `pg_get_functiondef`、owner、ACL 和安全属性；执行器执行前重算，
发生变化则进入 `attention_required`，避免执行期间修改函数导致删除范围漂移。
`accepted/processing/attention_required` 均是不可恢复的账户状态。数据库 partial unique index 保证同一
Project User 最多存在一个非终结 operation，`expired/completed` 为终态；`source + source_reference`
partial unique index 保证同一
Apple notification 只收敛到一条 operation。不可变字段和状态转换由 trigger 保护。项目删除 service
必须在存在非终结 operation 或待撤销 provider material 时失败关闭；项目完成退役后才允许级联删除已终结
operation。若未来需要恢复已退役项目，必须先从外部 deletion ledger 恢复 fence。

### 7.3 恢复 fence

```sql
CREATE TABLE druvia_project_account_deletion_fences (
  deletion_id UUID PRIMARY KEY
    REFERENCES druvia_project_account_deletions(deletion_id) ON DELETE CASCADE,
  project_id VARCHAR(64) NOT NULL,
  deleted_project_user_id TEXT NOT NULL,
  provider VARCHAR(32) NOT NULL,
  issuer TEXT NOT NULL,
  subject_fingerprint CHAR(64) NOT NULL,
  generation INTEGER NOT NULL,
  accepted_at TIMESTAMPTZ NOT NULL,
  completed_at TIMESTAMPTZ,
  UNIQUE (project_id, deleted_project_user_id, generation),
  UNIQUE (project_id, provider, issuer, subject_fingerprint, generation)
);
```

`subject_fingerprint` 使用专用 `ACCOUNT_DELETION_FENCE_SECRET` 对
`version/projectId/provider/issuer/subject` 做 HMAC-SHA256，不保存原 subject。该 secret 必须跨数据库
恢复保持稳定，并纳入独立密钥备份。存在未完成 fence 时禁止创建新 identity；全部完成后，新的 identity
generation 取同一 fingerprint 全部历史 fence 的最大值加一。旧 token 始终携带旧 Project User ID，因此
仍命中旧 fence，新 generation 不继承旧数据。

completed operation 与 fence 在项目生命周期内保留，用于状态查询、旧 token 阻断和 restore replay；只
保留删除证明所需的伪名标识、阶段与时间。过期且从未接受的 intent 和 reauth compensation 按短期保留
策略清理，不进入外部 deletion ledger。

### 7.4 Apple revoke material

独立表以自增 ID 保存 deletion ID、`purpose`、audience、encrypted refresh token、重试计数和下一重试
时间；同一 deletion 可有一条 accepted token 和多条 reauth compensation token。`purpose` 只允许
`accepted_deletion` / `reauth_compensation`，加密只使用 `SECRETS_ENCRYPTION_KEY`。业务数据和 identity
删除不级联清除该材料；Apple revoke 成功后立即删除。持续失败时只保留到运维定义的最大重试/人工处理
期限，并记录不含凭据的审计结果。claim 状态至少区分 `pending/in_flight/superseded`，并通过 lease/CAS
防止旧执行器实例在新 generation 授权后继续撤销。

### 7.5 项目恢复 gate 与执行器 heartbeat

新增一张 project-scoped runtime gate 表，保存 `project_id`、restore operation ID、状态、原因和时间。
backup restore 在修改 schema 前持久写入 gate，只有 fence replay 与 Hook 验证完成后才删除。API/进程
崩溃不得自动清除 gate；恢复流程必须显式继续或人工处理。

该 gate 对同项目 Project User、API Key 和 Trusted Backend 新请求均生效，覆盖 GraphQL、Realtime token、
Storage、RPC、Functions 和 Session 签发；不阻止具备 `backups:restore` 的平台管理员查看和恢复状态。

同一 migration 增加 account-deletion executor heartbeat 表，按 API 实例随机 ID 保存启动时间和最近心跳；
过期实例由定期清理删除。API 提供不含 operation 明细的内部 liveness 端点；至少一个新鲜 heartbeat 即
健康。API 主健康检查在调度循环尚未启动或 heartbeat 过期时失败，使现有 updater 的 apply/rollback health
checks 能发现执行器未运行，而无需认识新的 Compose service。
deadline backlog 通过独立 readiness/metrics 和结构化告警暴露，不让历史超时 operation 导致后续修复
版本自动回滚。

### 7.6 migration 回滚

- migration `025` 新增 `public` 平台表并为 identity 增加向后兼容的 generation 列，不修改项目业务
  schema 或 Hasura metadata。
- 任一 accepted、processing、attention-required、fence 或 provider revoke material 存在时，down
  migration 必须失败关闭。
- release manifest migration ceiling 提升到 `25`；API 执行器启动前必须完成 migration `025`。
- 生产使用后优先以前向 migration 修复，不能为镜像回滚删除恢复 fence。

## 8. PITCHETCH Cleanup Hook

PITCHETCH migration 创建：

```sql
CREATE FUNCTION dru_default_pitchetch.druvia_delete_project_user_data(
  p_project_user_id text,
  p_deletion_id uuid
) RETURNS jsonb
LANGUAGE plpgsql
AS $$
BEGIN
  -- 按 PITCHETCH 外键和保留策略删除业务数据；不得删除 users 或 Druvia public 表。
  RETURN jsonb_build_object('completed', true);
END;
$$;
```

最终实现必须满足：

- 同一 `(project_user_id, deletion_id)` 重复执行返回成功。
- 在单个数据库事务内完成；错误时整体 rollback。
- function 使用 `SECURITY DEFINER`，owner 必须是项目专属 `db_user`；owner 必须是非 superuser、
  非 `BYPASSRLS`、非 `CREATEROLE` 的隔离角色，只持有目标项目 schema 权限。
- function 固定 `search_path = pg_catalog, <project_schema>`，撤销 `PUBLIC EXECUTE` 且除 owner 外不得向
  其他角色授予 EXECUTE；启用配置时审计 owner、role attributes、完整 ACL、`prosecdef`、`proconfig`
  和精确参数/返回类型，任一不符即失败关闭。
- 先建立需要保留的设备 wipe task，再删除设备注册和业务数据。
- 不删除 `<schema>.users`；Druvia 在 Hook 验证成功后删除。
- 不访问 Druvia `public` 控制表，不接收或返回平台 Token。
- 不返回被删除行、PII、轨迹、传感器或空间数据。
- Druvia 只调用 operation 中快照的 schema/function，使用固定 statement timeout 和精确函数签名，不拼接
  客户端 SQL；项目函数即使被替换，也不能借 Druvia API 数据库角色访问 `public` 或其他项目 schema。

后续若 PITCHETCH 增加数据库外资源，再通过独立设计增加签名 HTTPS Hook；第一版不让数据库函数执行
外部网络请求。

## 9. 持久执行与步骤

执行器从 PostgreSQL claim 到期任务，每次只持有有界 lease。每个外部或数据库步骤后以
`deletion_id + lease_token + expected phase` 条件更新；旧执行器实例的迟到结果不能覆盖新实例。

顺序：

1. `business_cleanup`：调用 PITCHETCH Hook；只接受约定的 `{ "completed": true }` 结果并记录脱敏 ledger。
   Druvia 不猜测任意业务表，因此业务行完整性由 PITCHETCH Hook 及其集成测试负责。
2. `storage_cleanup`：通过 Storage service 按 project/bucket/owner Project User 清理对象和物理文件；
   不直接绕过 bucket/object lock。
3. `project_user_cleanup`：在项目锁和 identity lock 下删除业务 users 行、identity 和 Druvia refresh
   token；既有 lifecycle 审计行将 identity/user 外键置空并只保留脱敏事件，不删除审计历史；保留 fence、
   operation 和未完成 Apple revoke material。
4. `provider_revoke`：尽力撤销 Apple refresh token。失败时独立退避，不回滚前三步。
5. `completed`：业务数据、Storage、Project User 和 active identity 已清除即完成；Apple 仍失败时返回
   `providerRevocationPending=true`。

所有 retryable 错误使用有界指数退避；不可解释的 schema drift、Hook 签名变化、旧账户重新出现或
deadline 超时进入 `attention_required` 并持续阻断旧账户。超过 24 小时前必须产生结构化告警。

本地与生产都由 API 内调度循环执行。每个 API 实例启动后立即写 heartbeat，再按固定周期 claim 到期任务；
多实例依赖数据库 lease 协调，不依赖单进程内存。`ACCOUNT_DELETION_EXECUTOR_ENABLED` 在 local/prod/release
默认开启；只有明确不承载流量的维护进程才可关闭，关闭后 API readiness 必须表明删除能力不可用。

## 10. 登录、Session 与 Actor 围栏

新增低层 `project-session-state` repository，避免 middleware 反向依赖完整 Project Auth service。

```ts
async function assertProjectSessionUsable(input: {
  projectId: string
  projectUserId: string
}): Promise<void>
```

该检查以 `public` account deletion operation/fence 为权威，不依赖项目 `users.status` 是否支持
`deleting`。另增加 project runtime gate 检查；它对 Project User/API Key/Trusted Backend 全项目生效。
两类检查应用到：

- Bearer Project Session 的 `authenticate` 和 `optionalAuth`。
- GraphQL、Realtime、Storage、RPC、Functions controller 的 Project User actor 建立前。
- Functions internal GraphQL/Storage 恢复 Project User actor 后。
- Trusted Backend `issue-session`，不能为正在删除的旧 User 签发新 Session。
- Apple login、Apple refresh 和普通 provider login/refresh。

Project User actor 通过检查后才可转为 Hasura role/session variables。任何调用方不得仅因为 JWT 签名
有效而绕过 fence。

Apple login 规则：

- 相同 subject 的任一 fence 未完成：返回 `ACCOUNT_DELETION_IN_PROGRESS`；即使旧 identity 已删除且
  operation 已进入 `provider_revoke`，也不得提前创建新 generation。
- operation completed 但旧 identity/users 行因备份恢复重新出现：保持失败关闭，唤醒 fence replay，
  返回 `ACCOUNT_DELETION_ATTENTION_REQUIRED`。
- completed 且旧 generation 已清理：允许创建新的 Project User/identity generation。若旧 Apple revoke
  material 尚未 claim，新授权在同一 project/subject lock 下将它标记为
  `superseded_by_new_authorization` 并安全删除旧 token；它不得在新授权后继续发起 revoke。
- 旧 revoke 已进入远端调用时，新登录返回可重试错误，直到 revoke 结果落库；避免后台撤销与新授权并发。
- Apple lifecycle notification 以 event ID 幂等，并比较 `occurred_at` 与 identity generation 的
  `created_at`。早于当前 generation 的迟到事件只收敛旧 operation，不得删除新 Project User。
- 未启用账户删除时，`account-deleted` 只写入待处理事件并将 identity 置为 `deletion_pending`；旧 lifecycle
  ack 不能直接删除用户，必须在配置就绪后收敛到同一 managed operation/fence。

## 11. 备份与恢复

### 11.1 Druvia project schema restore

当前 backup 只恢复项目 schema，因此 `public` fence 仍存在。`restoreBackupUnlocked` 在 pg_restore 前先
持久写入 project runtime gate；在 pg_restore 后、释放 Data Access exclusive lock 前必须：

1. 查询该项目全部 `accepted / processing / attention_required / completed` operation 及 fence。
2. 对恢复后的 Hook 重新执行完整安全预检；合法旧备份中的 Hook 摘要可以不同于删除 operation 创建时摘要。
3. 使用恢复后验证得到的摘要，对恢复出的旧 Project User generation 重放 PITCHETCH Hook。
4. 清理恢复出的旧 users 行和由 Druvia 管理的 Storage 引用。
5. 依据 Hook 的完成 ledger 验证没有恢复旧 generation；Druvia 不自行枚举任意业务表。
6. 失败时将 restore 标记为 recovery-required 并保留 runtime gate，不能向应用重新开放项目；API 重启
   后也不能自动清除。

### 11.2 整库灾难恢复

整库 restore 会回滚 `public` fence，不能仅靠同库表保证。生产声称支持该场景前必须：

- 将 accepted/completed deletion ledger 以不可变、追加方式复制到 PostgreSQL 备份之外的运维介质。
- ledger 只保存 deletion ID、项目 ID、旧 Project User ID、generation、subject HMAC 和时间，不保存
  Apple subject 或 token。
- 整库恢复后、启动 API/Admin/Hasura 前先导入 ledger 并重放 fence。
- 更新 `docs/agent/playbooks.md`，把 fence export/import/reconcile 设为强制恢复步骤。

没有完成外部 ledger 时，只能声明 Druvia 内建 project schema restore 受保护，不能宣称整库灾难恢复
已闭环。

## 12. 设备本地擦除

migration `025` 的 `localWipeRequired` 仍是发起设备的粗粒度即时提示。跨 Session、App 重装或原
Project Session 已失效后的可靠投递由后续 migration `026` Device Wipe extension 承担，完整契约见
`docs/plans/2026-09-10-project-device-wipe-mandates.md`。

职责边界为：

- PITCHETCH 在业务 schema 维护原始设备关系和删除 obligation，并在业务删除事务提交前创建 mandate。
- Druvia 从有效 Project Session 派生注册 owner，签发独立 binding 查询凭证，保存不可变 Ed25519 签名
  envelope 与幂等回执；不保存原始设备 identity，也不允许客户端枚举或指定其他用户。
- PITCHETCH 客户端验证签名、擦除 Keychain/SQLite/文件缓存/离线队列并提交 receipt；APNs 只能作为
  唤醒优化，不能替代 sessionless pull。
- 项目应用的 device/binding/mandate/receipt 表保持普通 Hasura 客户端零 CRUD，通过三条受检 Hook 与
  Druvia 对接。

PITCHETCH migration、双用户/多设备、本机重装、公钥轮换和真实 Watch/iPhone 验收仍属于应用侧证据，
不得因 Druvia 平台切片完成而标记为端到端生产就绪。

## 13. 文件边界

### 新增

- `migrations/025_project_account_deletions.up.sql`
- `migrations/025_project_account_deletions.down.sql`
- `apps/api/src/modules/project-auth/account-deletion.types.ts`
- `apps/api/src/modules/project-auth/account-deletion.repository.ts`
- `apps/api/src/modules/project-auth/account-deletion.service.ts`
- `apps/api/src/modules/project-auth/account-deletion-executor.ts`
- `apps/api/src/modules/project-auth/account-deletion-hook.ts`
- `apps/api/src/modules/project-auth/project-session-state.ts`
- `apps/admin/src/components/auth/AccountDeletionConfigPanel.tsx`
- `tests/unit/project-account-deletion-schema.test.ts`
- `tests/unit/project-account-deletion-service.test.ts`
- `tests/unit/project-account-deletion-executor.test.ts`
- `tests/unit/project-account-deletion-hook.test.ts`
- `tests/unit/project-session-state.test.ts`
- `tests/integration/project-account-deletion.test.ts`

### 修改

- `apps/api/src/modules/project-auth/project-auth.routes.ts`
- `apps/api/src/modules/project-auth/project-auth.controller.ts`
- `apps/api/src/modules/project-auth/project-auth.service.ts`
- `apps/api/src/modules/project-auth/project-identity.repository.ts`
- `apps/api/src/modules/project-auth/apple-lifecycle.service.ts`
- `apps/api/src/modules/project/project.service.ts`
- `apps/api/src/modules/auth-admin/auth-admin.service.ts`
- `apps/api/src/middleware/auth.ts`
- `apps/api/src/modules/storage/storage.service.ts`
- `apps/api/src/modules/functions/internal-graphql.routes.ts`
- `apps/api/src/modules/functions/internal-storage.routes.ts`
- `apps/api/src/modules/backup/backup.service.ts`
- `apps/api/src/cli/migrate.ts`
- `apps/api/src/index.ts`
- `apps/api/src/config/index.ts`
- `apps/api/package.json`
- `apps/admin/src/app/t/[tenantId]/p/[projectId]/auth/page.tsx`
- `apps/admin/src/lib/api.ts`
- `docker/docker-compose.local.yml`
- `docker/docker-compose.prod.yml`
- `docker/docker-compose.release.yml`
- `docker/.env.example`
- `docker/.env.prod.example`
- `docker/.env.release.example`
- `.github/workflows/release.yml`
- `tests/unit/project-auth.controller.test.ts`
- `tests/unit/apple-project-auth.service.test.ts`
- `tests/unit/apple-auth-lifecycle.test.ts`
- `tests/unit/project-service.test.ts`
- `tests/unit/api-app.test.ts`
- `tests/unit/backup-service.test.ts`
- `tests/unit/release-pipeline.test.ts`
- `docs/agent/design-decisions.md`
- `docs/agent/playbooks.md`
- `docs/progress.md`
- `AGENTS.md`
- `apps/api/AGENTS.md`

PITCHETCH 仓库独立新增业务 migration、设备 wipe task 和真实应用验收，不由 Druvia 修改其代码。

## 14. 实施任务

### Task 1：冻结 migration、状态和安全类型

- [x] 先写 migration SQL 契约测试，覆盖表、约束、partial unique、不可变 trigger、down guard 和
  migration ceiling `25`。
- [x] 实现 migration `025`、CLI 映射和 release manifest 范围。
- [x] 定义 operation/status/phase、公开 DTO 和错误码；禁止公开内部错误、subject fingerprint 和 token。
- [x] 为 `ACCOUNT_DELETION_STATUS_SECRET` 和 `ACCOUNT_DELETION_FENCE_SECRET` 增加生产强校验、example
  配置和日志 redact；不得与 JWT、Hasura、Deno Worker 或 Storage ticket secret 复用。
- [x] 运行：

```bash
pnpm vitest run tests/unit/project-account-deletion-schema.test.ts tests/unit/release-pipeline.test.ts
pnpm --filter @druvia/api build
```

### Task 2：实现 intent、status token 和 Apple confirm

- [ ] 补齐 controller/service 失败矩阵：跨项目、Platform User/API Key、客户端 user ID、错误 status
  token、过期 intent、服务端 nonce mismatch、过旧 `iat`、Apple subject mismatch、重复 idempotency key
  和重复 confirm。当前已覆盖 controller 身份边界、token/nonce 基础契约与 confirm replay；完整 service
  失败矩阵留待真实数据库集成补齐。
- [x] 实现 domain-separated HMAC status token/reauth nonce 的签发、验证及常量时间比较。
- [x] 实现 create intent、confirm 和 status route；confirm 复用 Apple adapter，但不得调用普通 login 或
  签发 Project Session。
- [x] 实现 `auth:manage` 配置读取/启用接口和 Admin 简化状态面板；禁用与 preflight 失败必须保持安全。
- [x] 更新 CORS `allowedHeaders`，显式允许 `Idempotency-Key` 和 `X-Druvia-Deletion-Token`；验证 nginx
  不剥离这两个请求头。
- [x] 以项目锁再 identity lock 的顺序提交 accepted 事务；事务失败不能部分撤销 Session 或创建 fence。
- [x] 实现 Apple reauth 成功但 accepted 事务失败时的 refresh token 立即 revoke 与持久补偿路径；数据库
  整体不可用时仍只能记录告警，需在真实故障注入验收中确认运维处置。
- [x] 运行现有定向单元测试；原计划中的 controller 文件名已调整为
  `tests/unit/project-account-deletion.controller.test.ts`：

```bash
pnpm vitest run tests/unit/project-account-deletion-service.test.ts tests/unit/project-auth.controller.test.ts
```

### Task 3：实现 Project Session 即时围栏

- [ ] 以真实 Project Session 证明删除接受前旧 Access Token 可通过，而接受后同一 token 在 GraphQL、Realtime token、
  Storage、RPC 和 Functions 全部失败；status/confirm replay 只能读取该 operation。
- [x] 实现 `project-session-state.ts`，在 Project User JWT 解析后查询 authoritative fence。
- [x] 将检查接入外部认证 middleware、Trusted Backend session issue 和 Functions internal
  GraphQL/Storage；API Key 与 Platform Session 行为保持不变。
- [x] 增加 deleted Project User 通过登录、refresh 或 trusted issue 重新取得 Session 的负向单元回归；
  多 Provider 真实集成仍属于 Task 8。
- [x] 运行现有定向单元测试。

```bash
pnpm vitest run tests/unit/api-app.test.ts tests/unit/project-auth.controller.test.ts \
  tests/unit/project-auth.trusted-issuer.test.ts tests/unit/realtime-service.test.ts
```

### Task 4：实现 PITCHETCH Hook 与持久执行器

- [x] 实现并测试 Hook 静态 preflight、错误 rollback、statement timeout、非法函数签名和越权 owner/
  ACL/search path；不得对真实用户执行“探针删除”。重复执行由 PITCHETCH 隔离集成验收负责。
- [x] 实现固定数据库函数调用，schema 来自 operation 的不可变快照，函数名来自已验证项目配置。
- [x] 实现 PostgreSQL claim/lease/renew/CAS、阶段转换、指数退避、deadline 和结构化告警。
- [x] 实现 business cleanup、Storage cleanup、Project User/identity cleanup；任何失败均保留不可恢复 fence。
- [x] 在 API 启动/关闭生命周期接入执行器循环、heartbeat 和 graceful lease release；多 API 实例并发只允许
  一个实例处理同一 operation。
- [x] local/prod/release Compose 只向 API 注入执行器配置，不新增 service；API health 验证 heartbeat，
  deadline backlog 进入独立指标/告警。现有 updater 无需新增 managed service 或第五个镜像。
- [x] 运行现有定向单元测试与 API build。

```bash
pnpm vitest run tests/unit/project-account-deletion-executor.test.ts \
  tests/unit/storage-service.test.ts tests/unit/release-compose-files.test.ts
pnpm --filter @druvia/api build
```

### Task 5：分离 Apple revoke 与 lifecycle notification

- [x] 增加 Apple revoke 重试、重复执行和新 generation 的单元回归；真实 API 崩溃恢复留待 Task 8。
- [x] 将 accepted operation 所需最小 refresh token 加密复制到独立 revoke material；身份/业务清理不得
  删除它。
- [x] Apple revoke 成功后删除材料；暂时失败独立重试并允许顶层 account deletion 完成。
- [x] 将 Apple `account-deleted` notification 收敛到同一删除 operation，source 标记为
  `apple_notification`；保留现有 Trusted Backend lifecycle API 的兼容读取，但不能再形成第二套删除
  事实源。
- [x] 验证 completed 后相同 Apple subject 创建全新 Project User；覆盖 pending revoke 被新授权
  supersede、in-flight revoke 阻塞新登录和迟到 notification 不影响新 generation。

### Task 6：实现恢复围栏

- [x] 增加项目 schema 恢复 gate/fence replay 单元回归，证明项目在 replay 前不可开放。
- [x] 在 `restoreBackupUnlocked` 修改 schema 前持久写入 runtime gate，并在 exclusive lock 内执行 fence
  replay 和 Hook 验证；API 崩溃后 gate 必须保留。
- [x] 将 runtime gate 接入 Project User、API Key、Trusted Backend 的 GraphQL、Realtime、Storage、RPC、
  Functions 和 Session 请求；真实跨入口恢复演练留待 Task 8。
- [x] 为 Hook replay 失败定义持久 `recovery_required` gate；Storage 元数据位于平台 schema，不随项目 schema
  restore 回滚，旧 identity/Project User 由平台表和 fence 保持阻断。
- [x] 在 playbook 增加 project schema restore 强制检查，以及整库恢复的外部 ledger export/import 门禁。
- [x] 在进度和发布边界中明确：外部 ledger 未实现前只完成 schema restore 保护。

### Task 7：PITCHETCH 业务与设备契约

- [ ] PITCHETCH 提供并审查 `druvia_delete_project_user_data(text, uuid)` migration。
- [ ] PITCHETCH 增加幂等 ledger 和 `account_deletion_device_wipes`，证明 Hook 不删除未 ack wipe task。
- [ ] 使用两名 Project User 验证只删除当前用户，另一用户数据不变。
- [ ] 验证发起设备、第二设备、离线后重连和 App 重启的本地擦除流程。
- [ ] 该任务的代码和测试证据保存在 PITCHETCH 仓库；Druvia 文档只记录版本化契约和验收结果。

### Task 8：真实集成、发布和文档

- [ ] 在隔离 PostgreSQL 17/PostGIS + Hasura v2.48 环境执行真实账户删除集成测试。
- [ ] 覆盖响应丢失、Access Token 过期、API/执行器重启、lease 抢占、Apple unavailable、Hook 暂时失败、
  Storage 删除失败和 deadline 告警。
- [ ] 验证旧 Access Token 不能新建 GraphQL、Realtime、Storage、RPC、Functions 请求；记录已建立
  WebSocket 的明确限制，不把客户端断开当服务端安全证明。
- [x] 将现有稳定定向回归加入 release 镜像 push 前门禁，并将 GHCR、自建 Registry、本地 release 和生产 OTA
  四条路径的 migration `025` 前置。
- [x] 更新根/API `AGENTS.md`、设计决策、playbook 和 progress。
- [ ] 执行完整单元测试、API/Admin build、改动范围 lint、migration up/down、真实恢复演练和
  `git diff --check`。
- [x] 使用 `critical_reviewer` 复核身份、恢复、Hook、备份和发布边界，修复至无重要 finding。

## 15. Druvia 验收标准

1. 删除目标只能来自当前 Project Session；客户端无法指定或推导删除其他用户。
2. Apple reauth 的 issuer、audience、nonce、code、token 和 subject 任一不匹配时不接受删除。
3. 相同 idempotency key 和重复 confirm 不产生第二条 operation，也不重复扩大删除范围。
4. 接受事务提交后，旧 refresh token 失效，旧 Access Token 的所有新项目数据请求均被 fence 拒绝。
5. API/执行器重启、并发执行器、响应丢失和迟到结果不会恢复账户或覆盖新 phase。
6. PITCHETCH Hook 和 Storage cleanup 可重复执行，失败后保留 operation、fence 和重试上下文。
7. 业务数据、平台 Storage、Project User 和 active identity 在 accepted 后 24 小时内清除；超时产生告警。
8. Apple revoke 失败不阻塞第 7 条，并只保留完成撤销所需的加密最小材料。
9. Druvia project schema 恢复旧备份后，fence replay 在应用开放前再次清理旧 generation。
10. completed 后相同 Apple subject 可建立全新 Project User，但不能读取或继承旧数据。
11. PITCHETCH 已登记设备具有持久 pending wipe 状态；发起设备和其他设备均有验收证据。
12. App、SDK、日志和 API 响应均不包含平台凭证、Trusted Backend Key、Apple refresh token、原始
    subject、authorization code 或 identity token。status token 只允许出现在 create intent 成功响应、
    App 安全存储和 deletion 专用请求头，不得进入其他响应、URL、日志或遥测。
13. 真实 custom Hasura permission、Data Access baseline 和其他 Project User 不因删除 operation 被修改。
14. migration `025`、release manifest、API 内执行器配置和 OTA 前置一致；本地完成不等于生产发布完成。

## 16. 风险与发布边界

- **现有 Realtime 长连接：** 无法按用户即时断开，是第一版明确残余风险；数据清理优先级和客户端主动
  断开只能缩短窗口，不能替代 Gateway。
- **每请求数据库校验：** Project Session 增加一次 authoritative fence 查询。为保证立即失效，第一版
  不使用可能产生陈旧 active 结果的正向缓存；上线前必须压测 GraphQL/Storage 高频路径。
- **业务 Hook 权限：** Druvia 数据库连接权限较高，必须固定 schema、函数名、参数类型和 timeout；不得
  提供任意 SQL 配置。
- **整库恢复：** 外部 ledger 未部署前不能宣称完整灾难恢复围栏。
- **24 小时 SLA：** 依赖至少一个健康 API 执行器、PostgreSQL、Storage 和 Hook；必须有 backlog/deadline
  指标与告警，不能只写入文档。
- **Apple 调试：** 真实 Apple reauth/revoke 仍依赖有效付费开发者账号、Bundle ID、Team/Key 和 `.p8`；
  缺少真实账号时只能完成本地 mock 与契约测试，不能标记 Provider 端到端验收完成。
- **生产发布：** migration 与内置执行器的 API 必须同一 stable release 发布；现有 updater 仍只需重建
  已管理的 API service。旧镜像不能在 migration `025` 已产生 fence 后执行 down，生产仍由人工 OTA apply。

## 17. 当前状态

- 2026-09-10：完成三轮高风险复核。前两轮发现的 project lock/CAS、restore replay、disabled
  notification fence、Hook TOCTOU、backlog health、未完成 fence generation、旧 lifecycle ack 绕过、
  历史 Hook hash restore 和非 owner EXECUTE 问题均已修复；最终独立 `critical_reviewer` 未发现
  Critical/High/Medium finding。Druvia 非集成回归 166 个文件、1263 项测试通过，API/Admin build、改动
  范围 lint、Compose 渲染、`git diff --check`、双本地数据库 migration `025`、运行态 executor health 和
  真实 PostGIS ACL 探针通过；真实 Apple、生产规模 Storage 与实际 `pg_restore` 故障注入仍属于 Task 8。
- 2026-09-10：已完成设计审查；认证新鲜度、幂等 confirm、Hook 隔离角色、恢复 gate、跨 generation
  Apple 竞态和现有 updater 首发兼容均已纳入方案。实施后高风险 review 暴露的项目锁、restore replay、
  disabled notification fence、Hook TOCTOU 和 backlog health 问题已修复，最终复核结果以本节后续记录为准。
- 2026-09-10：Druvia 侧本地代码切片已实现 migration `025`、intent/confirm/status、管理开关、即时
  session/runtime fence、API 内持久执行器、独立 Apple revoke、notification 收敛和 project schema restore
  gate。普通 PostgreSQL 与活动 PostGIS 已应用 `025`，临时 PostGIS 已验证完整 up/down-to-024；外部应用
  Hook、设备 wipe、真实 Apple、故障注入、完整恢复、release/OTA 与生产验收仍未完成。
- 2026-09-09：确认账户删除完成后允许同一 Apple 身份创建全新 Project User；删除处理中禁止登录，
  恢复 fence 永久保护旧 generation。
- 2026-09-10：确认首版采用 PostgreSQL 持久状态机、PITCHETCH 数据库 Hook、Druvia 平台清理和 API 内
  执行器；不新增 Compose service，不扩展 Trusted Backend Key，不建设通用 Jobs 平台。
