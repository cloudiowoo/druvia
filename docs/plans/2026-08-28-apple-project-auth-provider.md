# Apple Project Auth Provider 设计与实施方案

状态：设计审查已完成，代码尚未开始
Owner：Druvia Project Auth
日期：2026-08-28

## 1. 背景

PITCHETCH 的 M0 需要通过 iPhone `AuthenticationServices` 取得真实 Apple 凭证，再由 Druvia 换取标准 Project Session。当前通用 OIDC adapter 不能直接承担该流程：它只接受一个 authorization code，强制依赖固定 client secret 和 userinfo endpoint，也没有 Apple identity token、nonce、动态 client secret、token revoke 或 server notification 语义。

这项工作属于真实应用暴露的 Core 身份阻塞。它优先于足球业务 Schema，但不改变以下现有优先级和发布约束：

- taro-app/H5/小程序仍是当前 stable 生产基线，Apple 改动必须通过其 Project Auth 兼容回归。
- 足球业务表、PostGIS 领域 Schema、Swift SDK 和后台分析 Worker 不进入本功能范围。
- main 开发、镜像构建、stable release 和生产 OTA 仍是独立动作；本文完成不等于自动发布生产。

PITCHETCH 侧需求依据（位于 PITCHETCH 仓库，不复制本机绝对路径）：

- `docs/2026-08-26-pitchetch-development-plan.md`
- `docs/2026-08-26-apple-project-foundation.md`

Apple 契约依据：

- [Authenticating users with Sign in with Apple](https://developer.apple.com/documentation/signinwithapple/authenticating-users-with-sign-in-with-apple)
- [Verifying a user](https://developer.apple.com/documentation/signinwithapple/verifying-a-user)
- [Token validation](https://developer.apple.com/documentation/signinwithapplerestapi/generate-and-validate-tokens)
- [Token revocation](https://developer.apple.com/documentation/signinwithapplerestapi/revoke-tokens)
- [Processing changes for Sign in with Apple accounts](https://developer.apple.com/documentation/signinwithapple/processing-changes-for-sign-in-with-apple-accounts)
- [Fetch Apple's public key](https://developer.apple.com/documentation/signinwithapplerestapi/fetch-apple%27s-public-key-for-verifying-token-signature)
- [TN3194: Handling account deletions and revoking tokens for Sign in with Apple](https://developer.apple.com/documentation/technotes/tn3194-handling-account-deletions-and-revoking-tokens-for-sign-in-with-apple)

## 2. 目标与非目标

### 2.1 目标

1. 为 Project Auth 增加一等 `apple` provider，不伪装成通用 OIDC。
2. 服务端验证 Apple authorization code、identity token、issuer、audience、有效期、签名和 nonce。
3. 以平台级 identity binding 把 Apple identity 稳定映射到 Druvia Project User。
4. 返回现有标准 Project Session，不改变 GraphQL、Realtime、Storage、RPC 和 Functions 的 Project User actor 语义。
5. 保存加密 Apple refresh token，为 revoke、账号授权状态处理和后续 App 转移保留能力。
6. 提供项目级 Apple 配置、Admin 配置体验、稳定错误码和日志脱敏。
7. 以真实非生产 PITCHETCH Project 证明登录、重复登录、refresh、logout 和 GraphQL actor 传播。
8. 在生产就绪门禁前补齐 Apple revoke 和签名 server notification。

### 2.2 非目标

- 不创建 PITCHETCH 足球业务 Schema 或 Hasura metadata。
- 不在本批次提取正式 Swift SDK；PITCHETCH 先维护应用内最小 Swift HTTP/Auth 边界。
- 不迁移已有 WeChat/OIDC identity 到新表。
- 不按 email 自动合并账号，不实现通用多 provider account linking UI。
- 不引入全局 JWT denylist；logout 后现有 Project access token 仍存活到自身过期。
- 不把 Apple credential state 检查替代 Druvia Project Session refresh。
- 不支持 Apple Web/Android flow；首批只支持原生 Apple 平台 `AuthenticationServices`。
- 不在普通 Druvia OTA 中配置 Apple Developer Team、私钥或项目凭证。

## 3. 方案比较与决策

### 3.1 方案 A：直接复用项目 `users(provider, provider_id)`

优点是代码改动较少。缺点是 Druvia 无法保证所有已有项目 Schema 都存在目标列和唯一约束；taro-app 还保留 `wx_open_id` 兼容数据，批量增加唯一索引可能被重复值阻断。该模型也只能表达一个主 provider，难以支持账号绑定和 Apple App 转移。

结论：拒绝作为 Apple 权威身份模型。项目 `users.provider` 可以继续作为显示字段；Apple subject 不写入业务 `provider_id`，更不能由它承担 identity 唯一性。

### 3.2 方案 B：平台级 Project identity binding

在 `public` schema 新增项目身份绑定和 provider token 表，以 `(project_id, provider, issuer, subject)` 建立数据库级唯一映射。业务用户仍位于项目 Schema，Project Session `sub` 仍是业务用户 ID。

优点：

- 不重写现有项目数据，也不要求所有业务 Schema 立即统一。
- 并发首次登录可以由唯一约束和事务 advisory lock 收敛。
- 支持一个 Project User 后续绑定多个 provider。
- 能独立保存 Apple 授权状态和加密 refresh token。

代价：平台表与动态项目 Schema 之间不能建立直接外键，删除用户、删除项目和一致性检查必须由 service 显式维护。

结论：采用。

### 3.3 方案 C：外部 Apple/OIDC 身份代理

该方案可以减少 Druvia 内 Apple 协议代码，但会增加外部处理方、隐私披露、故障面、账号映射和部署依赖，也不能证明 Druvia 自托管身份闭环。

结论：当前不采用。

## 4. 身份与信任边界

### 4.1 三种 ID 不得混用

```text
Apple subject
  Apple 在开发者团队范围内的外部身份标识
  只用于 provider identity 映射

Druvia Project User ID
  项目业务 Schema 中 users.id
  Project Session JWT sub 的唯一含义

Platform User ID
  Druvia 管理后台用户
  不具备项目应用数据身份
```

标准链路：

```text
iPhone AuthenticationServices
  -> authorizationCode + identityToken + rawNonce + first-login name
  -> Druvia Apple adapter 验签并向 Apple exchange code
  -> (projectId, apple, issuer, Apple subject) identity binding
  -> Project schema users.id
  -> Druvia Project access token + refresh token
  -> GraphQL Project User actor
```

Project Session JWT 保持：

```json
{
  "sub": "<druvia-project-user-id>",
  "projectId": "<project-id>",
  "authType": "project_user",
  "role": "authenticated",
  "provider": "apple"
}
```

Apple subject、identity token、authorization code、Apple refresh token 和 `.p8` 私钥不得进入 Project Session、Hasura session variables、客户端日志或业务 GraphQL。

### 4.2 Apple 会话与 Druvia 会话分层

- Apple authorization code 只用于首次或重新授权时的服务端身份验证，单次使用。
- Apple refresh token 只保存在 Druvia 服务端，用于 revoke、状态验证和未来迁移；不返回 PITCHETCH。
- 正常应用刷新以 Druvia Project refresh token 为主；仅当对应 Apple refresh token 距上次成功验证已满 24 小时时，才同步向 Apple 做一次状态验证。不得高于 Apple 建议的每日一次频率。
- Druvia logout 撤销 Project refresh token；不会自动撤销 Apple 授权。
- Apple revoke 是独立动作；开始后先把 identity 标记为 `revoke_pending` 并撤销 Druvia refresh token，远端完成后再标记为 `revoked`。
- 已签发 Project access token 在 TTL 内仍可能有效，客户端登出必须立即删除 Keychain 中的 access/refresh token。

## 5. 数据模型

新增 migration `021_project_auth_identities`。

### 5.1 `druvia_project_auth_identities`

```sql
CREATE TABLE druvia_project_auth_identities (
  id BIGSERIAL PRIMARY KEY,
  project_id VARCHAR(64) NOT NULL
    REFERENCES druvia_projects(project_id) ON DELETE CASCADE,
  project_user_id TEXT NOT NULL,
  provider VARCHAR(32) NOT NULL,
  issuer TEXT NOT NULL,
  subject TEXT NOT NULL,
  audience TEXT,
  status VARCHAR(16) NOT NULL DEFAULT 'active',
  email_forwarding_status VARCHAR(16) NOT NULL DEFAULT 'unknown',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_authenticated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  revoked_at TIMESTAMPTZ,
  CONSTRAINT druvia_project_auth_identities_status_check
    CHECK (status IN ('active', 'revoke_pending', 'revoked', 'deletion_pending')),
  CONSTRAINT druvia_project_auth_identities_email_forwarding_check
    CHECK (email_forwarding_status IN ('unknown', 'enabled', 'disabled')),
  CONSTRAINT druvia_project_auth_identities_unique_subject
    UNIQUE (project_id, provider, issuer, subject)
);

CREATE INDEX idx_project_auth_identities_project_user
  ON druvia_project_auth_identities(project_id, project_user_id);
```

规则：

- `project_user_id` 不建立跨 Schema 外键，由 Project Auth 和 Auth Admin service 在同一事务中维护。
- `audience` 记录最近一次成功认证的 audience，只用于审计，不参与身份唯一键。
- identity 指向不存在或已禁用业务用户时，不得静默创建新用户或重新绑定；返回安全的一致性错误并要求管理员处理。
- 不按 email 查找或自动绑定已有用户。
- Apple 重新授权同一 subject 时复用原 Project User；只有原状态为 `revoked` 时可恢复为 `active`，`revoke_pending` 必须先完成远端撤销，`deletion_pending` 必须先完成应用数据删除交接。
- Apple email relay notification 只更新 `email_forwarding_status`，不自动覆盖项目业务用户的 email。
- `revoke_pending`、`revoked` 和 `deletion_pending` 都不得签发或刷新 Project Session；只有重新完成有效 Apple 授权且不存在未完成远端撤销时，`revoked` 才可恢复为 `active`。

### 5.2 `druvia_project_auth_provider_tokens`

```sql
CREATE TABLE druvia_project_auth_provider_tokens (
  id BIGSERIAL PRIMARY KEY,
  identity_id BIGINT NOT NULL
    REFERENCES druvia_project_auth_identities(id) ON DELETE CASCADE,
  audience TEXT NOT NULL,
  refresh_token_encrypted TEXT NOT NULL,
  last_validated_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT druvia_project_auth_provider_tokens_identity_audience_key
    UNIQUE (identity_id, audience)
);
```

规则：

- 每个 identity/audience 最多保存一个 Apple refresh token；只持久化 refresh token，不持久化短期 access token 或 identity token。
- authorization code 再次交换出同一 identity/audience 的 refresh token 时，以新 token 原子替换旧 token；Apple 明确允许持续使用同一有效 refresh token，Druvia 不主动用 refresh grant 轮换它。
- authorization code exchange 成功落库时把 `last_validated_at` 初始化为当前时间；后续只有成功的 refresh grant 验证才能推进该时间。
- 密文必须使用服务端 `SECRETS_ENCRYPTION_KEY`；生产环境不得回退到默认值或客户端提供的密钥。
- Apple provider 要求该 key 至少 32 UTF-8 bytes、不得使用 example/placeholder，且不得与 `JWT_SECRET`、`PROJECT_AUTH_JWT_SECRET` 或 `HASURA_JWT_SECRET` 相同。
- 加密 helper 从 `auth-admin.service.ts` 抽到共享 API 内部模块，保持现有 `iv:authTag:ciphertext` 格式兼容，不能使已有 provider secret 无法解密。
- 为兼容尚未配置独立密钥的旧 WeChat/OIDC 部署，legacy provider secret 暂时保留当前 JWT-secret 解密回退；Apple 私钥和 Apple provider token 调用加密 helper 时必须设置 `requireDedicatedKey=true`。没有独立密钥时 API 仍可服务旧 provider，但 Apple 配置不能启用、登录/revoke 必须返回配置错误。
- 表不进入 Hasura metadata，不提供项目 GraphQL 权限和管理端明文读取接口。

### 5.3 Project refresh token identity binding

`021` 同时对现有 `druvia_project_refresh_tokens` 做 additive 扩展：

```sql
ALTER TABLE druvia_project_refresh_tokens
  ADD COLUMN identity_id BIGINT
    REFERENCES druvia_project_auth_identities(id) ON DELETE CASCADE,
  ADD COLUMN provider_audience TEXT;

CREATE INDEX idx_project_refresh_tokens_identity
  ON druvia_project_refresh_tokens(identity_id)
  WHERE revoked = false AND identity_id IS NOT NULL;

ALTER TABLE druvia_project_refresh_tokens
  ADD CONSTRAINT druvia_project_refresh_tokens_apple_identity_check
  CHECK (
    provider <> 'apple'
    OR (identity_id IS NOT NULL AND provider_audience IS NOT NULL)
  );
```

规则：

- 现有 WeChat/OIDC/trusted 行保持 `identity_id`、`provider_audience` 为 `NULL`，原刷新行为不变。
- Apple 登录签发的每个 Druvia refresh token 必须绑定权威 `identity_id` 和本次已验证 audience，不能只依赖可伪造或语义不足的 provider 字符串。
- Apple refresh 先按 token hash 只读定位 identity，再取得同一 identity advisory lock；随后必须在同一数据库事务和连接上重新检查 token 未撤销、identity 为 `active`、业务用户可用，消费旧 token并创建绑定同一 identity/audience 的新 token。
- Apple revoke、notification、refresh、重复登录和用户删除共享同一 identity lock；任何路径都不得在另一条池连接上绕过状态检查或签发新 refresh token。

### 5.4 `druvia_project_auth_events`

server notification 的幂等与应用数据删除交接需要持久状态，不能只靠日志：

```sql
CREATE TABLE druvia_project_auth_events (
  id BIGSERIAL PRIMARY KEY,
  project_id VARCHAR(64) NOT NULL
    REFERENCES druvia_projects(project_id) ON DELETE CASCADE,
  identity_id BIGINT
    REFERENCES druvia_project_auth_identities(id) ON DELETE SET NULL,
  project_user_id TEXT,
  provider VARCHAR(32) NOT NULL,
  issuer TEXT NOT NULL,
  event_id TEXT NOT NULL,
  event_type VARCHAR(32) NOT NULL,
  status VARCHAR(24) NOT NULL DEFAULT 'handled',
  occurred_at TIMESTAMPTZ NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  acknowledged_at TIMESTAMPTZ,
  CONSTRAINT druvia_project_auth_events_status_check
    CHECK (status IN ('handled', 'application_action_pending', 'acknowledged')),
  CONSTRAINT druvia_project_auth_events_unique_event
    UNIQUE (provider, issuer, event_id)
);
```

- 只保存 Apple 已验签 JWS 的 `jti`、事件类型、时间和内部关联，不保存原始 JWS、Apple subject、email 或 token。
- `account-deleted` 写入 `application_action_pending`；PITCHETCH 必须通过同项目 trusted backend capability 读取事件、删除领域数据，再确认处理。确认事务才删除 Project User/identity，并清空事件中的 `project_user_id` 后标记 `acknowledged`。
- PITCHETCH 删除遗漏导致业务外键阻断时，确认事务失败且事件保持 pending；Druvia 不使用 cascade 猜测足球业务删除规则。
- `consent-revoked`、`email-enabled`、`email-disabled` 可在 Druvia 内幂等处理并记为 `handled`。

### 5.5 migration 与回滚

- `021` 新增平台表，并为现有 Project refresh 表增加 nullable 列、索引及只约束新 Apple 行的 check；不扫描或重写业务 Schema，也不改变已有 token 行。
- migrate bootstrap 对 `021` 使用 composite data check，同时确认 identity/token/event 三张表、Project refresh 的两个新增列和 Apple check constraint；不能只看到 identity 表就把部分结构误标为已应用。
- down migration 发现任一 identity/token/event 行时必须拒绝；空环境也必须先删除 Project refresh check/index/columns，再按外键反向顺序删除 event/token/identity 表。生产回滚优先回滚应用镜像并保留新结构。
- 项目删除在 service 层发现 Apple provider token、非终态 identity 或 pending lifecycle event 时必须返回 `PROVIDER_DECOMMISSION_REQUIRED`；该检查必须位于现有 exclusive-global/project lock 内，并发生在 drop DB role、untrack、drop Schema、清理 Storage 等任何破坏动作之前。只有完成远端批量 revoke 和应用事件确认后才允许删除。数据库 cascade 只负责已完成前置流程后的最终清理，不能代替 Apple revoke。
- Auth Admin 删除项目用户时，如果仍有 Apple provider token、`active/revoke_pending/deletion_pending` identity 或 pending lifecycle event，必须返回对应 lifecycle 错误，不得丢弃唯一可用于远端 revoke/应用删除交接的状态。完成独立 revoke 或 lifecycle ack 后，用户删除才可在同一数据库事务中依次撤销 Druvia refresh、删除 provider token/identity、删除业务用户。

## 6. Provider 配置

现有 `druvia_project_auth_providers` 继续保存项目级配置，不增加重复配置表。

Apple 配置映射：

```json
{
  "provider": "apple",
  "clientId": "com.example.pitchetch",
  "clientSecret": "-----BEGIN PRIVATE KEY-----\n...",
  "config": {
    "teamId": "<APPLE_TEAM_ID>",
    "keyId": "<APPLE_KEY_ID>",
    "allowedAudiences": ["com.example.pitchetch"],
    "flow": "native"
  }
}
```

约束：

- `clientSecret` 在 Apple 语义下表示 `.p8` private key，API 响应永不返回该值。
- `clientId` 必须包含在 `allowedAudiences` 中；首批 PITCHETCH 只配置一个原生 Bundle ID。
- `allowedAudiences` 接受 1 至 8 个非空唯一值；首批 native code exchange 按已验证 token 的 `aud` 选择对应 audience，不接受客户端另传 audience。
- `teamId`、`keyId`、client ID 和 audience 使用严格长度/字符校验。
- `teamId` 和 `keyId` 各为 10 个 ASCII 字母或数字；client ID/audience 为 1 至 255 个 ASCII 字母、数字、点或连字符，不能以点开头/结尾或包含连续点。
- `.p8` 请求值最大 16 KiB；解密后的私钥只存在于当前请求内存，不进入缓存、响应或日志。
- `.p8` 必须可解析为 Apple client-secret JWT 所需的 EC 私钥；保存前验证，不能通过一次登录才发现格式错误。
- Apple issuer、JWKS、token 和 revoke endpoint 固定在代码中，不允许管理员配置任意 URL。
- 首批 native flow 不发送 `redirect_uri`；未来 Web flow 必须另行设计 client/redirect allowlist，不能复用任意字符串配置。
- provider 只有在 client ID、Team ID、Key ID、私钥和 audience 全部有效时才显示“已配置”并允许启用。
- Apple 登录签发的 Project access token TTL 取项目配置与 3600 秒的较小值；其他 provider 保持现有 TTL。这样 notification/revoke 后无法立即 denylist 的旧 Apple access token 最多继续存活一小时。
- 禁用 provider 只阻止新登录，必须保留加密私钥和 provider token，使已有 session 状态验证、用户 revoke 和项目 decommission 仍可完成；禁用不能伪装成远端撤销。
- 任一 Apple provider token、pending identity 或 lifecycle event 存在时，禁止清空私钥、删除 provider 配置或删除项目。Key ID/私钥轮换必须先验证新私钥可生成有效 client secret，再原子替换配置。

Admin 配置弹窗只展示 Bundle ID、Team ID、Key ID、允许 audience、只写私钥和启用开关。固定 issuer/endpoints、JWT 生成方式、Hasura 等实现细节不暴露给用户。

## 7. 客户端与 API 契约

### 7.1 PITCHETCH nonce 约定

1. iPhone 生成至少 32 bytes 的密码学随机 `rawNonce`。
2. iPhone 计算小写十六进制 `SHA-256(rawNonce)`，把摘要赋给 `ASAuthorizationAppleIDRequest.nonce`。
3. 登录请求把原始 `rawNonce` 发送 Druvia；不得持久化到普通日志或 UserDefaults。
4. Druvia 重新计算摘要，并要求 Apple identity token 的 `nonce` claim 与摘要常量时间相等。

字段名固定为 `rawNonce`，避免调用方把摘要和原值混淆。

### 7.2 Apple 登录

```http
POST /api/v1/projects/:projectId/auth/apple/login
Content-Type: application/json
```

```json
{
  "authorizationCode": "<base64url-or-utf8-code>",
  "identityToken": "<apple-id-token>",
  "rawNonce": "<original-random-nonce>",
  "profile": {
    "givenName": "Optional first-login value",
    "familyName": "Optional first-login value"
  }
}
```

约束：

- 三个凭证字段必填：`authorizationCode` 为 1 至 4096 UTF-8 bytes，`identityToken` 为 1 至 16384 UTF-8 bytes，`rawNonce` 为 43 至 256 个 base64url 字符；空白、非法字符和超长输入在访问 Apple 前拒绝。
- `givenName` / `familyName` 各自 trim 后最多 100 个 Unicode code points，移除控制字符；两个字段均为空时忽略 profile。
- email 只取自已验证 identity token，且 `email_verified` 只接受布尔 `true` 或 Apple 兼容字符串 `"true"`；不得使用 JavaScript truthiness 接受 `"false"`。空 email 或未验证 email 按缺失处理，客户端 profile 不能提交或覆盖 email。
- 姓名只在新建 Project User 时使用，移除控制字符、限制长度并按现有 username 字段能力落库；后续缺失姓名不覆盖已有资料。
- 不接受客户端传入 issuer、audience、subject、Apple user ID、redirect URI 或 Apple client secret。
- Apple 不提供 `silent-login`；后续静默恢复必须走 Druvia `/auth/refresh`。

成功响应保持现有结构：

```json
{
  "success": true,
  "data": {
    "token": "<project-access-token>",
    "refreshToken": "<project-refresh-token>",
    "expiresIn": 3600,
    "expiresAt": "2026-08-28T12:00:00.000Z",
    "user": {
      "id": "<druvia-project-user-id>",
      "email": "<verified-or-null>",
      "username": "<sanitized-name-or-fallback>",
      "avatarUrl": null,
      "role": "authenticated"
    }
  }
}
```

### 7.3 服务端验证顺序

网络请求前：

1. 读取并校验项目、auth config 和启用的 Apple provider。
2. 校验请求形状和大小。
3. 从未验证 token 中只提取 `aud` 作为配置选择提示；必须精确命中服务端 allowlist，不能信任其他 claim。
4. 使用 Apple remote JWKS 验证客户端 identity token 的 `RS256` 签名、`kid`、issuer、allowlisted audience、`exp`、不超过 60 秒的 clock skew 和 nonce；拒绝对称算法、`none`、未来签发时间和不匹配 key type。

Apple exchange：

5. 使用 Team ID、Key ID、匹配 audience 和 `.p8` 动态生成 ES256 client-secret JWT：header `kid=<keyId>`，claims 固定 `iss=<teamId>`、`sub=<matched audience>`、`aud=https://appleid.apple.com`、`iat=now-60s`、`exp=now+5m`。
6. 调用固定 `https://appleid.apple.com/auth/token`，提交 `authorization_code` grant；native flow 不附加 redirect URI。token/JWKS 网络请求使用 5 秒超时；authorization code exchange 超时后不得自动重放同一个 code。
7. 验证 token endpoint 返回的 identity token 签名、issuer、audience、过期时间和同一 `SHA-256(rawNonce)` nonce。
8. 要求两个已验证 identity token 的 `sub`、issuer、audience 和 nonce 一致；不一致时拒绝。
9. 只把 Apple 官方枚举错误映射为内部 typed error，不把上游正文返回客户端。

数据库事务：

10. 按 `projectId + provider + issuer + subject` 获取 transaction advisory lock。
11. 查找 identity；存在时读取其 Project User，不存在时按 `allowSignup` 创建 Project User 和 identity。
12. 保存或轮换加密 Apple refresh token。
13. 创建带 `identity_id` 和 `provider_audience` 的 Druvia Project refresh token并签发标准 Project Session。
14. 提交事务；失败时回滚用户、identity、provider token 和 Project refresh token的本地写入。

Apple code 被消费后本地事务失败时不能安全重用 code。Druvia 必须对刚取得的 Apple refresh token执行一次 best-effort revoke，且不得把补偿请求成功作为原登录成功：

- 若这是已有 identity，无论补偿结果如何，都在独立恢复事务中把 identity 置为 `revoke_pending` 并撤销其 Druvia refresh token；运维或用户重试远端 revoke 后才能恢复确定状态。
- 若首次登录的 identity/Project User 已随事务回滚，本地不存在可签发会话的账号；补偿失败必须产生不含凭证/subject 的 critical 审计事件，后续重新授权取得的新 refresh token作为恢复入口。
- 进程在 Apple 成功响应与本地提交之间崩溃属于无法用数据库事务消除的外部副作用窗口；实现必须通过上述补偿、审计和重复授权恢复明确管理，不能声称 exactly-once。

客户端统一收到 `PROVIDER_REAUTH_REQUIRED` 并重新发起 Apple 授权，不得自动重放原 code。

### 7.4 Druvia refresh 与 logout

沿用：

```http
POST /api/v1/projects/:projectId/auth/refresh
POST /api/v1/projects/:projectId/auth/logout
```

- Project refresh token 继续单次消费并轮换。
- 首批 Apple slice 不改变现有返回结构、session storage key 或 actor claims。
- Apple token 通过 `identity_id` 定位权威 identity；`revoke_pending`、`revoked`、`deletion_pending` 或 audience 不匹配时，必须在签发新 token 前拒绝。
- 对应 provider token 的 `last_validated_at` 未满 24 小时时不访问 Apple；达到 24 小时时，在消费 Druvia refresh token前使用 `refresh_token` grant 同步验证一次。成功后验证返回 id token 的 issuer/audience/subject 并更新 `last_validated_at`；Apple `invalid_grant` 把 identity 置为 `revoked`、删除失效 provider token并撤销全部 Druvia refresh token；暂时网络失败返回 `PROVIDER_UNAVAILABLE` 且不得消费调用方的 Druvia refresh token。
- logout 撤销该 Project User 的全部 Druvia refresh token；不会远端 revoke Apple。
- PITCHETCH 在 logout 成功或确认本地退出时删除 Keychain session，即使网络失败也不能继续展示已登录状态。

### 7.5 Apple revoke

```http
POST /api/v1/projects/:projectId/auth/apple/revoke
Authorization: Bearer <project-access-token>
```

- 只接受同项目 `project_user` 且 access token 的 provider 为 Apple；服务端仍须按 `(projectId, projectUserId)` 查找实际 Apple identity，不能只信任 JWT provider claim。
- 按 identity 读取全部 audience token，逐个解密并使用匹配 audience 的动态 client secret 调用固定 revoke endpoint。
- 首个本地事务取得 identity lock，确认 token 存在后把 identity 改为 `revoke_pending` 并撤销其全部 Druvia refresh token；随后才执行远端请求。该状态阻止并发 refresh/login 在撤销期间签发新会话。
- 只有全部已保存 audience token 都得到 Apple 成功/已失效响应后，第二个本地事务才把 identity 标记为 `revoked`并删除 provider token。
- 任一 audience 出现暂时失败时保留全部 token 和 `revoke_pending` 状态；Apple 对已失效 token 返回成功，因此重复请求可以安全重试整组 token，不需要在部分成功时提前删除行。
- 不删除 Project User 或业务数据；应用账号删除由 PITCHETCH 领域流程负责。
- Apple 暂时不可用时不伪造 revoke 成功；返回可重试错误并保留 token。
- 缺失 refresh token 时返回需要重新授权的稳定错误，不能把本地标记当成远端撤销证明。

用户 access token 过期后不能再调用 revoke route，因此平台项目管理员必须有恢复入口：

```http
POST /api/v1/projects/:projectId/auth/apple/identities/:identityId/retry-revoke
Authorization: Bearer <platform-session>
```

- 复用同一 identity lock、远端 revoke 和终态事务，不建立第二套撤销语义。
- 只允许有该项目管理权限的 Platform User；Project Session、trusted backend key 和 API key 均拒绝。
- Admin 的 provider decommission 逐页调用同一内部 primitive，并显示剩余 active/pending 数量；发生暂时错误时可恢复续跑，不能在一个长 HTTP 事务中假定全部用户一次成功。
- identity/provider 配置页面只展示内部 ID、状态、时间和不可逆 subject 摘要，不展示 subject、refresh token 或 email。

### 7.6 Apple server notification

```http
POST /api/v1/projects/:projectId/auth/apple/notifications
Content-Type: application/json
```

```json
{
  "payload": "<apple-signed-jws>"
}
```

- 该路由不接受 Druvia JWT/API key，唯一信任来源是经过 Apple JWKS 验证的签名 payload。
- 固定项目路由用于读取该项目 allowlist；payload audience 必须与项目 Apple 配置匹配。
- 请求体只接受单个 1 至 65536 UTF-8 bytes 的 `payload` 字符串，并按 project/source IP 施加独立限流；限流不替代签名验证。
- JWS 必须验证签名、issuer、audience、时间和唯一 `jti`；只允许 Apple 当前文档与 JWKS key type 对应的非对称算法，不能盲目信任 header `alg`、接受 `none` 或对称算法。
- `consent-revoked` 将 identity 标记为 `revoked`、删除 provider token并撤销 Druvia refresh token。
- `account-deleted` 将 identity 标记为 `deletion_pending`、删除已失效 provider token、撤销 Druvia refresh token，并创建 `application_action_pending` lifecycle event；在 PITCHETCH 确认领域数据删除前不得宣称处理完成。
- email relay enable/disable 事件只记录最小审计状态，不自动覆盖业务用户 email。
- 重复 notification 以已验签 `jti` 唯一键幂等；未知 subject 记录最小 handled event并返回成功，但不泄露是否存在用户。
- server notification 不删除业务用户和领域数据。

项目 lifecycle event 队列可由具备项目访问权的平台管理员处理，也可交接给同项目 trusted backend key；后者必须显式持有独立 `project_auth_lifecycle:manage` scope。Project Session、API key 和客户端 SDK 都不能读取或确认该队列。PITCHETCH 可从服务端 Function/后台任务消费，私钥和 trusted key 仍只留在服务端。

### 7.7 Application lifecycle event API

```http
GET /api/v1/projects/:projectId/auth/lifecycle-events?status=application_action_pending&limit=100&cursor=<opaque>
X-Druvia-Trusted-Backend-Key: <server-only-key>

POST /api/v1/projects/:projectId/auth/lifecycle-events/:eventId/ack
X-Druvia-Trusted-Backend-Key: <server-only-key>
```

- 两个路由接受具备项目访问权的平台管理员，或同项目且显式持有 `project_auth_lifecycle:manage` 的 trusted backend key；分页上限 100，cursor 不暴露数据库查询或跨项目信息。
- list 只返回 Druvia event ID、type、occurredAt 和 Project User ID，不返回 Apple `jti`、subject、email 或原始 payload。
- ack 表示 PITCHETCH 已删除该用户的全部领域数据。Druvia 在同一事务中重查 pending event/identity，尝试删除 Project User，成功后删除 identity、清空事件 Project User ID 并标记 `acknowledged`。
- ack 幂等；第一次处理已提交后的重复调用返回成功。若业务外键或数据库错误阻止用户删除，整个事务回滚并保留 pending。

### 7.8 内部 adapter 契约

现有 `AuthAdapter.exchangeCode()`、WeChat/OIDC adapter 和平台 OAuth service 保持不变。Apple 采用增量式专用接口，避免为一个 provider 重写或扩大共享平台 OAuth 回归面。

```ts
type AppleNativeCredential = {
  authorizationCode: string;
  identityToken: string;
  rawNonce: string;
  profile?: {
    givenName?: string;
    familyName?: string;
  };
};

type AppleVerifiedUser = {
  provider: 'apple';
  providerId: string;
  email?: string;
  nickname?: string;
};

type AppleAuthenticationResult = {
  user: AppleVerifiedUser;
  providerSession: {
    audience: string;
    refreshToken: string;
  };
};

interface AppleAuthAdapter {
  readonly provider: 'apple';
  authenticateNative(
    credential: AppleNativeCredential
  ): Promise<AppleAuthenticationResult>;
  revoke(input: {
    audience: string;
    refreshToken: string;
  }): Promise<void>;
  validateRefreshToken(input: {
    audience: string;
    refreshToken: string;
    expectedSubject: string;
  }): Promise<void>;
}
```

- `createAuthAdapter()` 继续只服务现有 code-based adapters；新增 `createAppleAuthAdapter()` 返回专用接口。
- `project-auth.service` 在 provider 为 `apple` 时调用专用 factory，其他 provider 继续走原 `exchangeCode()` 路径。
- Apple 客户端请求不能进入平台 OAuth `/oauth/*` 路径。
- `providerSession` 是 API 内部敏感材料，只能立即交给 identity repository 加密落库，不能进入响应、通用 `AuthUser.raw` 或 logger。
- typed Apple adapter error 只携带安全 reason enum、retryable 和上游 HTTP status；不得携带上游 body、code、token 或私钥。
- Apple adapter 内部 revoke 不扩展成所有 provider 必须实现的能力。

## 8. 错误、重试与日志

### 8.1 对外错误码

| code | HTTP | 重试语义 | 场景 |
| --- | ---: | --- | --- |
| `INVALID_INPUT` | 400 | 修正请求 | 缺字段、超长或非法 profile |
| `PROVIDER_NOT_CONFIGURED` | 503 | 管理员处理 | Apple provider 未启用或配置不完整 |
| `PROVIDER_CREDENTIAL_INVALID` | 401 | 重新授权 | 签名、issuer、audience、nonce、code、subject consistency 失败 |
| `PROVIDER_FLOW_UNSUPPORTED` | 400 | 不重试 | Apple silent-login 或非 native flow |
| `PROVIDER_RATE_LIMITED` | 429 | 退避重试 | Apple 上游限流 |
| `PROVIDER_UNAVAILABLE` | 503 | 有限退避 | 网络、JWKS 或 Apple 5xx |
| `IDENTITY_CONFLICT` | 409 | 管理员处理 | identity 指向缺失/冲突业务用户 |
| `PROVIDER_REAUTH_REQUIRED` | 409 | 重新 Apple 授权 | code 已消费后本地失败或 revoke 缺 token |
| `PROVIDER_REVOKE_PENDING` | 409 | 完成撤销后重试 | identity 正在撤销，禁止签发新会话 |
| `PROVIDER_DECOMMISSION_REQUIRED` | 409 | 管理员处理 | 删除 provider/project 前仍有 Apple token 或 lifecycle event |

Apple `invalid_grant`、错误 token、nonce、issuer 和 audience 对客户端统一为 `PROVIDER_CREDENTIAL_INVALID`；内部日志可记录安全 reason enum，但不记录凭证或 Apple 原始响应正文。

### 8.2 日志脱敏

全局 redact 增加：

- `req.body.authorizationCode` / `req.body.authorization_code` / provider 登录请求中的 `req.body.code`
- `req.body.identityToken` / `req.body.identity_token` / `req.body.id_token`
- `req.body.rawNonce` / `req.body.nonce`
- provider 配置请求中的 `req.body.clientSecret` / `req.body.client_secret` / `req.body.privateKey`
- Apple adapter 内部结构中的 `providerRefreshToken` / `refresh_token`

不得添加全局裸 `code` redact 路径，否则会吞掉结构化错误码和运维诊断字段。模块代码也不得把完整 request body 或 adapter token response 传给 logger。

默认请求 serializer 继续只记录 method、URL、request ID 和来源信息。Apple 模块结构化日志只允许：

- project ID
- provider=`apple`
- operation 名称
- 安全 reason enum
- Apple HTTP status
- identity/project user 的不可逆审计摘要，不能记录原 subject

## 9. 代码边界

### 9.1 PITCHETCH Project User 前置契约

平台级 identity binding 不替代现有 Project User 数据源。Apple 登录前，PITCHETCH 项目默认 Schema 必须已有 `<schema>.users`；该表属于项目认证基础数据，不是足球比赛、轨迹或传感器业务 Schema。

M0 推荐最小列：

```sql
CREATE TABLE <pitchetch_schema>.users (
  id UUID PRIMARY KEY,
  email TEXT,
  username TEXT,
  avatar_url TEXT,
  provider TEXT,
  provider_id TEXT,
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'disabled')),
  last_login_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

该 DDL 由 PITCHETCH 项目 migration 持有，不进入 Druvia Core migration。Druvia 在启用 Apple provider 前执行 Project Auth preflight：

- `users` 表必须存在，`id` 必须是当前支持的 UUID 或文本类型。
- `status`、`provider`、`provider_id`、profile/时间列仍按现有 capability 机制兼容，但 Apple preflight 要求业务 `provider_id` 不存在或允许 `NULL`；Auth Admin 页面若要完整管理用户，应满足上述推荐列。
- 推荐 `email` nullable，因为 managed Apple Account 可能不提供 email。
- legacy 项目的 email 若为 `NOT NULL` 且 Apple token 无 email，使用基于新 Druvia Project User ID 的 `<id>@users.invalid` 合成值，不得把 Apple subject 拼入 email；API response 对该合成值返回 `null`。
- Apple 创建用户时可以写 `provider='apple'`，但 `provider_id` 保持 `NULL`；不得把 Apple subject、其可逆编码或 hash 当成业务字段替代品。Apple 权威唯一性只位于平台 identity table。
- 不为该表增加 `(provider, provider_id)` 全局唯一约束；若既有 Schema 强制 `provider_id NOT NULL`，启用 Apple 前必须由应用 migration 放宽该列，不能用 subject 绕过 preflight。
- GraphQL actor 探针只添加最小只读 permission，不由 Apple provider 自动生成宽泛 Hasura CRUD。

### 9.2 Druvia 新增文件

| 文件 | 职责 |
| --- | --- |
| `apps/api/src/adapters/auth/apple.adapter.ts` | Apple native credential 验证、code exchange、revoke |
| `apps/api/src/adapters/auth/apple-client-secret.ts` | ES256 Apple client-secret JWT 生成 |
| `apps/api/src/adapters/auth/apple-token-verifier.ts` | remote JWKS、identity token claims 验证 |
| `apps/api/src/lib/secret-encryption.ts` | 兼容现有格式的服务端 secret 加解密 |
| `apps/api/src/modules/project-auth/project-identity.repository.ts` | identity/provider token 的事务读写与 advisory lock |
| `apps/api/src/modules/project-auth/apple-notification.service.ts` | server notification 验签和幂等状态处理 |
| `apps/api/src/modules/project-auth/project-auth-lifecycle.service.ts` | account-deleted 事件的 trusted backend 读取、确认和业务用户清理编排 |
| `migrations/021_project_auth_identities.up.sql` | identity/provider token 数据模型 |
| `migrations/021_project_auth_identities.down.sql` | 有数据时拒绝的保护性 down migration |
| `tests/unit/apple-auth-adapter.test.ts` | Apple adapter 和 claims 测试 |
| `tests/unit/project-auth-identity.test.ts` | identity 映射、事务和并发测试 |
| `tests/unit/apple-auth-notification.test.ts` | notification 签名、幂等和撤销测试 |
| `tests/unit/project-auth-lifecycle.test.ts` | account-deleted pending/ack、scope 和数据删除失败恢复测试 |
| `tests/unit/ratelimit-apple-auth.test.ts` | Apple login/revoke/notification 独立限流 |
| `tests/unit/admin/apple-auth-provider.test.tsx` | Admin Apple 配置交互 |
| `apps/admin/src/components/auth/AppleProviderConfigForm.tsx` | Apple 专用配置表单 |

### 9.3 修改文件

| 文件 | 改动 |
| --- | --- |
| `apps/api/package.json` / `pnpm-lock.yaml` | 将 `jose` 作为 API 直接依赖，不依赖传递安装 |
| `apps/api/src/adapters/auth/interface.ts` | 增量增加 Apple credential/result/typed error，不改变现有 `AuthAdapter` |
| `apps/api/src/adapters/auth/index.ts` | 导出独立 `createAppleAuthAdapter()`，保留现有 factory 行为 |
| `apps/api/src/modules/project-auth/project-auth.service.ts` | Apple 编排、identity-bound refresh、每日 Apple token 验证和事务 client 接入 |
| `apps/api/src/modules/project-auth/project-auth.controller.ts` | Apple 请求 schema、用户 revoke、管理员 retry-revoke、notification controller |
| `apps/api/src/modules/project-auth/project-auth.routes.ts` | Apple revoke/recovery/notification/lifecycle 路由；登录继续命中 provider route |
| `apps/api/src/modules/trusted-backend-keys/trusted-backend-keys.service.ts` | 增加仅服务端使用的 `project_auth_lifecycle:manage` scope |
| `apps/api/src/modules/auth-admin/auth-admin.service.ts` | Apple provider、配置校验、用户删除 identity cleanup |
| `apps/api/src/modules/auth-admin/auth-admin.controller.ts` | provider-specific 配置验证和安全响应 |
| `apps/api/src/modules/project/project.service.ts` | 在任何项目删除副作用前执行 Apple decommission gate |
| `apps/api/src/middleware/ratelimit.ts` | Apple login/revoke/notification 的 project/IP 限流 |
| `apps/api/src/cli/migrate.ts` | migration 021 bootstrap 检查 |
| `apps/api/src/index.ts` | Apple 凭证 redact 路径 |
| `apps/admin/src/lib/api.ts` | Apple 配置类型 |
| `apps/admin/src/app/t/[tenantId]/p/[projectId]/auth/page.tsx` | Apple provider form 分派与配置状态 |
| `packages/sdk/src/modules/project-auth.ts` | 无破坏地增加 `appleLogin()` typed helper |
| `tests/unit/project-auth.service.test.ts` | WeChat/OIDC 回归及 Apple service 编排 |
| `tests/unit/project-auth.controller.test.ts` | Apple 登录/revoke 输入和响应 |
| `tests/sdk/project-auth.test.ts` | Apple helper 请求与 session 持久化 |
| `tests/integration/auth-admin.test.ts` | 配置加密、只写和 identity cleanup |
| `tests/unit/migration-runner-lock.test.ts` | migration 021 bootstrap 契约 |
| `.github/workflows/release.yml` | stable manifest 默认 migration ceiling 从 `20` 提升到 `21`，两套 Registry 保持一致 |
| `tests/unit/release-workflow.test.ts` | GHCR/自建 Registry manifest migration 范围回归 |
| `docker/docker-compose.yml` | API 传入独立 secret encryption key |
| `docker/docker-compose.local.yml` | 本地 Apple provider secret/token 加密配置 |
| `docker/docker-compose.prod.yml` | 生产强制独立 secret encryption key |
| `docker/docker-compose.release.yml` | release/OTA API 使用同一持久配置的 encryption key |
| `docker/.env.example` / `docker/.env.prod.example` | 增加非秘密配置说明和生成要求 |
| `apps/api/AGENTS.md` | Apple identity/secret/session 的局部约束 |
| `packages/sdk/AGENTS.md` | Apple helper 不得暴露服务端秘密或替代 Project refresh |
| `docs/agent/design-decisions.md` | 平台级 provider identity binding 长期决策 |
| `docs/progress.md` | 仅在 M0 或生产门禁完成后更新状态 |

## 10. 实施批次

每个批次内部按测试驱动执行；下列复选框在实施过程中直接更新，不另建 implementation 文档。

### Batch 0：批准设计与冻结 Druvia 契约

- [x] Druvia 审查本文至无重要 findings。
- [x] 确认执行顺序：Druvia 先完成全部服务端/Admin/SDK/migration 和 mock 回归，PITCHETCH 后续开发原生登录，最后进入真实非生产验收。
- [x] Druvia 冻结 native nonce、登录、refresh、revoke、notification 和 lifecycle event 的草案契约；PITCHETCH 的最终确认留到 Batch 7，不阻塞 Druvia 实施。

验收：设计无未决身份、安全、数据迁移或回滚问题。未取得 Apple 配置、未开放公网 notification、未完成 PITCHETCH/真机功能，都不阻止 Druvia Batch 1-6；它们只阻止 Batch 7 真实验收和生产就绪结论。

### Batch 1：migration、加密和 identity repository

- [x] 先写 migration schema 测试，覆盖 identity/event 唯一键、状态约束、Project refresh identity binding、cascade 和保护性 down。
- [x] 新增 migration `021` 并更新 migrate bootstrap。
- [x] 先写旧 provider secret 密文兼容测试，再抽取 `secret-encryption.ts`。
- [x] local/prod/release Compose 显式传入 `SECRETS_ENCRYPTION_KEY`；缺失时旧 provider 保持兼容，但 Apple provider 启用和运行预检必须失败，不能回退 JWT secret。
- [x] 先写 repository 事务测试，再实现 identity advisory lock、find/create/reactivate/revoke、lifecycle event 和 token upsert。
- [x] 修改 Auth Admin 用户删除：active Apple token 存在时先返回 `PROVIDER_REVOKE_REQUIRED`；完成 revoke 后再在同一连接事务中清理 Project refresh、identity/token 和业务用户。
- [x] 在 `deleteProjectUnlocked()` 的第一个副作用前加入 decommission gate，并测试被阻断时不会 drop DB role、untrack/drop Schema 或清理 Storage。
- [x] 验证 migration 不改变任何项目业务 Schema、Hasura metadata 或现有 provider 数据。

定向验证：

```bash
pnpm vitest run \
  tests/unit/project-auth-identity.test.ts \
  tests/unit/migration-runner-lock.test.ts \
  tests/integration/auth-admin.test.ts
```

### Batch 2：Apple cryptographic adapter

- [x] 将 `jose` 加为 API 直接依赖。
- [x] 以本地生成的测试 EC/RSA key 和本地 mock JWKS 写失败测试，不让单元测试访问 Apple 网络。
- [x] 实现 client-secret JWT 生成，固定 5 分钟 TTL、Key ID、Team ID、audience 和 ES256 claims。
- [x] 实现 remote JWKS verifier，固定 Apple issuer/JWKS、`RS256` 和 5 秒网络超时，并支持 `kid` rotation/cache。
- [x] 实现 native identity token 的 audience、exp/iat、nonce、subject 和 verified-email 验证。
- [x] 实现 authorization code exchange，并验证返回 id token 与客户端 token identity 一致。
- [x] 实现 refresh token grant 验证，最多每日一次，并验证返回 id token 的 issuer/audience/subject。
- [x] 实现 Apple revoke；只接受服务端解密 token。
- [x] 把 Apple 错误转换成 typed internal errors，不外泄上游正文。

定向验证：

```bash
pnpm vitest run tests/unit/apple-auth-adapter.test.ts
```

### Batch 3：Project Auth 登录与 session 集成

- [x] 先写 controller 请求边界测试，覆盖缺字段、超长字段、profile 清洗和 silent-login 拒绝。
- [x] 先写 service 测试，覆盖首次用户、重复 subject、不同 code 相同 subject、并发首次登录、禁用用户、关闭 signup 和 identity orphan。
- [x] 增加 code 已消费后本地事务失败的补偿 revoke、已有 identity `revoke_pending` 和首次登录 critical audit 测试。
- [x] 增加 Project Auth preflight 和 nullable/non-null email 测试，证明缺 users 表时安全失败、无 Apple email 时不把 subject 写入业务 email。
- [x] 增量增加 Apple adapter interface/factory；不修改 WeChat/OIDC `exchangeCode()` 和平台 OAuth 调用路径。
- [x] 在 Apple 网络验证之后、数据库写入之前建立明确事务边界。
- [x] 在同一事务中完成用户/identity/provider token/Project refresh token 写入。
- [x] 改造 Apple Project refresh：绑定 identity/audience，在同一 identity lock 和事务中完成状态检查、旧 token 消费和新 token签发；现有 provider 路径保持不变。
- [x] 保持 Project Session response、JWT claims 和 SDK storage key 不变。
- [x] 增加 Apple `appleLogin()` SDK helper；不创建 Swift SDK。
- [x] 扩充全局和模块日志脱敏测试。
- [x] 为 Apple login/revoke/notification 增加独立 project/IP 限流；登录限流不得以同一 NAT IP 合并成唯一身份防线。

定向验证：

```bash
pnpm vitest run \
  tests/unit/apple-auth-adapter.test.ts \
  tests/unit/project-auth-identity.test.ts \
  tests/unit/project-auth.service.test.ts \
  tests/unit/project-auth.controller.test.ts \
  tests/sdk/project-auth.test.ts \
  tests/unit/api-app.test.ts
```

### Batch 4：Auth Admin 配置

- [x] 先写 API 测试，证明不完整配置不能启用、私钥不可读、已有私钥留空更新时保持不变。
- [x] 把 `apple` 加入真实 supported provider，并按 provider 计算 `hasCredentials`。
- [x] 实现 Team ID、Key ID、Bundle ID、allowlist 和 `.p8` 服务端验证。
- [x] 新增 Apple 专用配置表单，固定 endpoint 和 JWT 细节不出现在 UI。
- [x] 验证错误状态、保存中状态、已配置编辑和启用/禁用流程。
- [x] 增加 identity 状态/不可逆摘要、管理员 retry-revoke 和可恢复 decommission 进度；有 token/pending event 时禁止清空凭证或删除 provider/project。
- [x] 检查配置响应、浏览器日志和 Next.js server 日志均不含私钥。

定向验证：

```bash
pnpm vitest run \
  tests/integration/auth-admin.test.ts \
  tests/unit/admin/apple-auth-provider.test.tsx
pnpm --filter @druvia/admin build
```

### Batch 5：Druvia revoke、notification 与 lifecycle 实施

- [x] 先写 authenticated revoke 的成功、缺 token、Apple 暂时失败、重复 revoke、跨项目拒绝，以及 access token 过期后管理员 retry-revoke 测试。
- [x] 实现 revoke route：先原子进入 `revoke_pending` 并撤销本地 refresh，再远端 revoke，全部成功后原子完成；覆盖与 refresh/login 的并发测试。
- [x] 先写 Apple notification 的签名、算法 allowlist、audience、`jti` 重复、未知 subject、consent-revoked 和 account-deleted 测试。
- [x] 使用本地生成的 Apple 等价测试密钥/JWS 实现固定项目 notification route 和幂等状态处理；自动化测试不得访问真实 Apple endpoint。
- [x] 实现 trusted backend lifecycle event list/ack；证明 Project Session/API key 无权访问，PITCHETCH 领域删除失败时事件保持 pending。
- [x] 禁止带 token/pending event 的 Apple provider/project 被直接删除；完成可恢复的批量 revoke/decommission 演练。
- [x] 记录 App 转移时 subject/relay address 迁移仍需独立运维 playbook，不把普通登录自动当作转移处理。

验收：Druvia 的 revoke、notification、account-deleted 持久状态和 lifecycle API 在 mock Apple 协议下全部通过。此时功能代码完整，但还不是 Apple 真实环境或生产验收结论。

### Batch 6：Druvia 完整回归、文档与开发完成门禁

- [x] 运行 WeChat/OIDC provider、Project refresh/logout、trusted issuer 回归。
- [x] 运行 taro-app 依赖的 Project Auth、GraphQL、Realtime、Storage、RPC 和 Functions 核心回归。
- [x] 运行 API/Admin/SDK build 和根级测试门禁，记录并区分既有环境失败。
- [x] 更新最近 `AGENTS.md`、长期 design decision 和本文完成状态；`docs/progress.md` 只在形成对应人类可读里程碑时更新。
- [x] 检查 migration `021` 已进入 release 镜像和升级顺序，API 启动前必须先 migrate。
- [x] 更新并测试 `.github/workflows/release.yml` 的 GHCR/自建 Registry migration `from/to` 默认值，不能继续生成 ceiling=`20` 的 stable manifest。
- [x] 检查 local/prod/release 渲染结果都把同一个宿主 `SECRETS_ENCRYPTION_KEY` 注入 API，且该值不进入镜像、manifest、日志或 Git。
- [x] 以自动化和 Compose/manifest 渲染验证 GHCR、自建 Registry、本地 release 与生产 OTA 将使用同一 stable digest，且 Apple 私钥不进入镜像、manifest 或 Compose example；实际镜像构建、stable release 和 OTA 不属于 Batch 6 开发完成动作。
- [x] 形成供 PITCHETCH 使用的 endpoint、字段、nonce、session 生命周期、错误码、重试和 lifecycle event 契约，不要求应用侧在本批次同步实施。

完整验证命令：

```bash
pnpm vitest run
pnpm build
pnpm lint
```

如果根级门禁存在与本功能无关的既有失败，必须记录具体命令和失败，不得以定向测试替代完整结论。

Druvia 开发完成出口：Batch 1-6 的代码、migration、Admin、SDK、mock Apple 协议测试和共享回归全部完成。该出口不要求真实 `.p8`、真实 Apple 账号、真机、公网 notification URL 或 PITCHETCH Apple 登录代码，也不得据此标记生产就绪。

### Batch 7：PITCHETCH 开发与真实非生产验收

当前状态：暂缓。PITCHETCH 项目组目前没有可用于真实联调的 Apple Developer Program 付费团队身份，无法取得受控的 Team ID、Key ID 和 `.p8`，因此不配置真实 Apple provider、不开展真机登录或 server notification 验收。该外部前置条件不影响 Druvia Batch 1-6 的本地开发完成结论，但在取得合规的付费团队身份前，Batch 7 保持未开始，Apple provider 不得标记为生产就绪。

- [ ] PITCHETCH 确认 native nonce、请求/响应、错误和 session 生命周期契约。
- [ ] 准备非生产 Apple Developer Team、Key ID、Bundle ID 和 `.p8`；文档和证据只记录标识，不记录秘密。
- [ ] 准备非生产 Druvia Project ID、API origin 和 `allowSignup` 策略；PITCHETCH 以项目 migration 建立最小 `users` 表并确认 GraphQL actor permission。
- [ ] PITCHETCH 通过 `AuthenticationServices` 发送约定 credential，并只把 Druvia Project Session 存入 iPhone Keychain。
- [ ] 在非生产项目配置 Apple provider，不把 `.p8`、trusted key 或平台凭证交给客户端。
- [ ] 验证有效登录和同一 Apple identity 使用不同 code 重复登录映射同一 Project User ID。
- [ ] 验证伪造签名、错误 issuer、错误 audience、错误/缺失 nonce、过期 token 和重放 code 被拒绝且不创建用户。
- [ ] 验证 Druvia refresh 轮换、并发旧 refresh 仅一次成功、logout 后 refresh 失效。
- [ ] 验证 Apple refresh token 未满 24 小时不访问上游，满 24 小时成功校验、`invalid_grant` 失效和暂时网络失败不消费 Druvia token。
- [ ] 用 Apple 登录返回的 Project access token 调用最小 GraphQL 查询，证明 actor user ID 等于 Druvia Project User ID，而不是 Apple subject。
- [ ] 验证平台 session、跨项目 Project Session 和匿名 API key不能冒充该用户。
- [ ] 配置稳定公网 TLS notification URL，以真实事件或 Apple 支持的验证方式证明 consent-revoked/account-deleted 链路。
- [ ] 冻结并验证双向账号删除编排：应用主动删除时先处理领域数据再调用 revoke；Apple `account-deleted` 时由 Druvia 阻断会话并持久化事件，PITCHETCH 服务端删除领域数据后 ack。
- [ ] 检查 API/Admin/PITCHETCH 日志、错误和数据库审计不含原始 Apple/Druvia token。

真实验收出口：Batch 1-7 全部通过，且备份、migration、配置、回滚和 decommission 演练完成后，才可把一等 Apple provider 标记为生产就绪。

## 11. 测试矩阵

| 层级 | 必测内容 |
| --- | --- |
| Token verifier | signature、kid rotation、issuer、audience、exp、nonce、malformed JWT |
| Apple exchange | single-use code、invalid_grant、invalid_client、5xx、timeout、token identity mismatch |
| Identity repository | 首次创建、重复映射、并发映射、reactivate、orphan、project cascade |
| Provider token | 加密落库、无明文查询、替换、每日验证、revoke 后删除、旧密文兼容 |
| Project Session | identity/audience binding、refresh rotation/revoke race、logout、disabled user、allowSignup=false |
| Admin API/UI | 配置完整性、私钥只写、留空保持、启用门禁、retry-revoke、decommission gate、无秘密响应 |
| Notification | signed event、algorithm allowlist、wrong audience、duplicate jti、unknown subject、consent revoked、account deleted lifecycle ack |
| Actor | Apple-created Project User 经 HTTP GraphQL 产生正确 Hasura user ID |
| Compatibility | WeChat `wx_open_id` fallback、OIDC code flow、taro-app SDK/session storage |
| Operations | composite bootstrap、backup、API-before-migration failure、project-delete no-side-effect gate、image rollback、保留身份表 |

单元测试不访问真实 Apple endpoint。真实 Apple 证据只在非生产 Project 集成门禁产生，并记录环境标识、时间、结果和安全摘要，不记录任何 token、私钥或用户敏感资料。

## 12. 发布、兼容和数据影响

### 12.1 已有数据

- migration 只新增 `public` 表并为 Project refresh token 表增加 nullable identity/audience 列；不修改现有 `users`、`wx_open_id`、`provider_id` 或 Hasura metadata，已有 refresh 行保持原值与行为。
- WeChat/OIDC 不自动回填 identity table，继续使用现有查找路径。
- Apple 新用户仍写入项目 `users` 表；若目标表有 `provider`，可写入 `apple` 作为显示，`provider_id` 保持 `NULL`。Apple subject 只存平台 identity table，不进入 Hasura 业务数据。
- 同 email 不自动合并，避免把 Apple relay email 或历史账号错误合并。

### 12.2 兼容窗口

- 旧 API 可以在 migration `021` 执行后继续运行。
- 新 API 在访问 Apple route 时要求 `021` 已存在；健康检查/启动门禁应明确报告缺 migration。
- 现有 Project Session response、JWT actor 和 SDK session key不变。
- SDK 新方法是 additive，不删除或重命名 WeChat/OIDC 方法。

### 12.3 回滚

- 应用回滚：回到旧 API/Admin 镜像，保留 `021` 表和数据。
- provider 回滚：禁用 Apple provider只阻止新登录，并保留私钥/token用于状态验证和 revoke；若要彻底移除配置，必须先完成 decommission。
- 数据库 down：仅空表环境允许；有 identity 数据时拒绝。
- 不允许通过删除 identity 表解决代码回滚，否则同一 Apple 用户后续可能被映射为新的 Project User。

### 12.4 密钥、备份与环境隔离

- 数据库备份只包含 Apple `.p8` 和 provider refresh token 的密文，不包含解密 key；恢复环境必须从独立 secrets storage 恢复同一个 `SECRETS_ENCRYPTION_KEY`。
- OTA、镜像启动脚本和 migration 不得自动生成、覆盖或轮换该 key；release 应继续使用宿主环境中持久保存的值。
- key 丢失时不得静默重置，否则已有 provider secret/token 将永久不可解密；系统应阻止 Apple 登录/revoke并报告运维错误。
- 生产数据库恢复到非生产环境时，默认禁用 Apple provider并清除/替换 provider 配置和 token；不得让非生产节点持有生产 Apple 私钥或继续处理生产 notification。
- 非生产 PITCHETCH Project 使用独立 Apple 配置和独立 encryption key，测试证据不得依赖生产账号或生产 subject。

## 13. 验收交付物

### PITCHETCH M0 交付

- Batch 1-6 的 Druvia 开发完成证据，以及 Batch 7 的 PITCHETCH 真实非生产验收证据。
- Apple native 登录 endpoint、请求/响应和错误码契约。
- 非生产 API origin、Project ID、Bundle ID 和允许 audience；不含秘密。
- 有效登录、重复登录、负向 token、refresh、logout 证据。
- Project Session GraphQL actor 传播证据。
- Swift 集成所需的 session 生命周期和重试说明。

### 生产就绪附加交付

- Batch 5 mock revoke/notification 自动化证据和 Batch 7 真实 Apple server notification 证据。
- migration `021` 备份、应用和镜像回滚演练。
- Apple provider 配置、`.p8` 替换和恢复运维说明；平台 `SECRETS_ENCRYPTION_KEY` 轮换仍属于独立 secrets-management 工作，不在本文中伪装为已完成能力。
- 日志和数据库敏感信息审计结果。
- taro-app/H5/小程序兼容回归结果。

## 14. 当前状态

| 项目 | 状态 |
| --- | --- |
| 方向选择 | 已确认：一等 Apple provider |
| 权威 identity 模型 | 已确认：平台级 binding，Apple 先接入 |
| 现有 WeChat/OIDC 数据迁移 | 不纳入本批次 |
| PITCHETCH 业务 Schema | 不纳入本批次 |
| 设计审查 | 已完成：2026-08-28，无重要 findings |
| 实施顺序 | 已确认：Druvia 完整开发在前，PITCHETCH 开发及真实验收在后 |
| migration/code/tests | Druvia Batch 1-6 已完成本地开发与 mock 协议验证；migration `021` 已在本地应用 |
| 非生产 Apple 配置 | 暂缓：PITCHETCH 当前没有 Apple Developer Program 付费团队身份 |
| PITCHETCH M0 真实验收 | 暂缓，等待合规 Apple 账号前置条件 |
| 生产就绪 | 未达到 |

### 14.1 2026-08-28 实施证据

- Apple/Auth 定向测试、Auth Admin 数据库集成、release pipeline 与 trusted backend lifecycle 回归共 `18 files / 160 tests` 通过；根级 build `6/6 packages` 通过。
- Apple provider 创建、更新、登录、refresh、revoke、notification、删除与项目删除统一使用项目级 advisory lock；禁用 provider 返回后不会遗留并发新登录窗口。
- lifecycle event list/ack 同时支持平台管理员和显式持有 `project_auth_lifecycle:manage` 的同项目 trusted backend key；该高风险 scope 不在默认授权中，Project Session/API key 均被拒绝。
- local/prod/release Compose 均通过 `docker compose config --quiet`；local 仅有既有 `STORAGE_TRUSTED_TICKET_SECRET` 空值 warning。
- 本地 `pnpm migrate up` 应用 `021_project_auth_identities`，`pnpm migrate status` 显示 current version `21`。
- 根级 `pnpm test -- --reporter=dot --silent=passed-only`：`1380 passed / 28 failed / 12 skipped`。失败集中于 Redis 不可达、Hasura secret/Realtime URL 环境不匹配、Deno Worker 不可达、并行集成 advisory lock/DDL 污染及既有 Storage/DDL 断言；Apple 定向测试未失败。
- 根级 `pnpm lint` 被 14 个既有 Admin lint error 阻断；本切片变更文件定向 lint 为 `0 error / 1 warning`，warning 是认证页既有 `<img>`。该结果不影响 Batch 1-6 代码完成判断，但在 stable release 前仍须处理根级门禁基线。
- `.github/workflows/release.yml` 已将 GHCR/自建 Registry manifest 默认 migration ceiling 从 `20` 提升为 `21`，并在镜像构建前加入无真实 Apple 网络依赖的 Apple Project Auth 测试集。
- 未执行真实镜像发布、stable release 或 OTA；PITCHETCH 当前没有 Apple Developer Program 付费团队身份，未配置真实 `.p8`、Apple provider、真机和公网 notification。以上全部留在暂缓的 Batch 7。
