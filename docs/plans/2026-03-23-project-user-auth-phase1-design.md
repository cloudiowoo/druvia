# 项目终端用户 Auth Phase 1 设计

## 背景

taro-app 当前的微信登录链路，已经暴露出 Druvia 认证模型的一个结构性缺口：

- 平台现有正式 JWT 只服务于平台用户 / 租户拥有者 / Admin
- 项目侧的 `wx-login-register`、`wx-silent-login` 一类登录前函数，历史上通过 Edge Function 自造 JWT / session 返回给前端
- 前端收到该 session 后，看起来“登录成功”，但进入 RPC 或其他受保护接口时，平台中间件并不把它识别为合法业务用户身份

这不是 token 字段小问题，而是当前平台只有“平台用户认证模型”，还没有“项目终端用户认证模型”。

## 当前代码现状

### 1. API 中间件只认平台 JWT

`apps/api/src/middleware/auth.ts` 当前 JWT payload 形状是：

- `userId`
- `uid`
- `tenantId?`
- `role?`

并且 `isJwtUser()` 只是判断是否存在 `userId`。这意味着当前 Bearer token 默认都被当作平台用户。

### 2. RPC 权限只适用于平台 owner/admin

`apps/api/src/modules/rpc/rpc.controller.ts` 通过 `checkProjectAccess(userId, projectId)` 校验访问权限；
`apps/api/src/lib/access.ts` 的 `checkProjectAccess()` 又是基于：

- `project -> tenant`
- `tenant.owner_uid`
- `public.druvia_users`

这套逻辑显然只适合“租户拥有者访问项目”，不适合“项目终端用户访问业务 RPC”。

### 3. 平台已有 refresh token 体系，但绑定的是平台用户

`apps/api/src/modules/user/user.service.ts` / `user.controller.ts` 已实现 refresh token 逻辑，但对象是 `public.druvia_users`，不是项目终端用户。

### 4. 项目用户并非完全不存在

Auth Admin 当前已把项目 schema 下的 `users` 表视为项目用户源：

- `apps/api/src/modules/auth-admin/auth-admin.service.ts`

它默认读取：

- `<schema>.users.id`
- `email`
- `username`
- `avatar_url`
- `provider`
- `provider_id`
- `status`
- `last_login_at`

这说明平台其实已经隐含存在“项目用户”的数据面，只是缺少正式的会话签发与统一鉴权。

### 5. taro-app 当前联调库仍以 `wx_open_id` 为主

截至 2026-03-24，本地联调库中 taro-app 项目 `dru_default_taroapp.users` 的实际结构与数据分布显示：

- `wx_open_id` 字段存在，且绝大多数用户已写入该字段
- `provider` 字段存在，但当前值实际是 `email`
- `provider_id` 字段不存在
- `last_login_at` 字段不存在

这意味着当前 taro-app 用户数据尚未迁移到 `provider = 'wechat' + provider_id = openid` 的目标形态。

## 问题定义

Phase 1 需要解决的是：

1. 由 Druvia API 正式签发项目终端用户 session，而不是由 Edge Function 自造
2. 平台请求身份模型从“JWT / apikey 二选一”扩展为：
   - platform user
   - project user
   - apikey anonymous
3. `Functions jwt_required` 与项目业务 `RPC` 能识别 project user
4. taro-app 能停止依赖 `wx-login-register` / `wx-silent-login` 自造 session

## Phase 1 范围

### 本次纳入

- 项目终端用户正式 auth API
- 微信小程序登录 / 静默登录 / refresh / logout
- 项目用户 JWT / refresh token 正式签发
- `middleware/auth.ts` 增加 project user 身份分支
- `Functions invoke` 的 `jwt_required` 接受 project user JWT
- `RPC` 增加 project user 鉴权分支
- `@druvia/sdk` 增补项目用户 auth 接口与类型适配

### 本次不纳入

- 项目用户 GraphQL 直通能力
- 通用多 provider 联邦账号体系
- 多 identity 绑定模型
- 项目用户细粒度 role/permission 系统
- 所有历史函数自动迁移
- 对“没有标准 `users` 表”的项目做通用映射支持

## 设计目标

### 1. 单一标准签发

所有项目终端用户 access token / refresh token 必须由 Druvia API 正式签发。

### 2. 双层身份模型

平台用户与项目终端用户必须分层，不能继续复用同一套业务语义。

### 3. 最小侵入复用现有项目用户数据面

Phase 1 优先复用当前项目 schema 的 `users` 表，而不是立即引入一套全新的项目用户主表。

### 4. 优先解 taro-app 当前阻塞

先解决“登录成功但业务接口仍失败”的链路问题，再考虑 project-user GraphQL 和更完整的授权模型。

## 方案比较

### 方案 A：继续允许 Edge Function 自造 session

做法：

- 继续让 `wx-login-register` / `wx-silent-login` 在函数里拼 JWT
- API 中间件逐步兼容更多字段

问题：

- session 签发标准分裂
- refresh / logout / revoke 无法统一
- 很容易继续把 project user 与 platform user 语义混淆

结论：

- 不推荐

### 方案 B：复用 `public.druvia_users` 承载项目终端用户

做法：

- 所有项目用户也进 `public.druvia_users`
- 继续使用现有平台 token / refresh token 体系

问题：

- 平台用户与项目用户语义严重混杂
- 多项目下用户边界不清晰
- 现有 `checkProjectAccess()`、tenant owner 逻辑会持续产生歧义

结论：

- 不推荐

### 方案 C：新增 project-user 会话层，复用项目 `users` 表

做法：

- 项目业务用户仍落在 `<project schema>.users`
- API 新增项目级 auth 路由
- 新增 project-user JWT claim 与 refresh token 表
- 中间件按身份类型分流

优点：

- 对现有项目数据面侵入最小
- 能快速解 taro-app 迁移阻塞
- 不污染平台 owner/admin 体系

代价：

- 中间件、Functions、RPC、SDK 都需要加新分支
- 后续若要支持多 identity / GraphQL project-user 权限，还需要 Phase 2+

结论：

- 推荐作为 Phase 1

## 推荐方案

采用方案 C：

- 复用 `<project schema>.users` 作为项目终端用户资料表
- 由 API 正式提供项目级 auth 接口
- 使用独立的 project-user claim 语义
- refresh token 进入平台公共基础设施表
- Functions / RPC 先支持 project user
- GraphQL project user 留到后续阶段

## 数据模型

### 1. 复用项目 schema 的 `users` 表

Phase 1 将当前 Auth Admin 已隐含依赖的字段，分成“目标字段”和“兼容字段”两层处理。

目标字段：

- `id`
- `email`
- `username`
- `avatar_url`
- `provider`
- `provider_id`
- `status`
- `last_login_at`
- `created_at`
- `updated_at`

兼容字段：

- `wx_open_id`

这意味着：

- Phase 1 面向的项目，仍以 `<schema>.users` 作为业务用户主表
- 微信小程序登录的目标标准仍是：
  - `provider = 'wechat'`
  - `provider_id = <openid>`
- 但 Phase 1 不能假设所有项目都已具备该结构，必须兼容当前 taro-app 的 `wx_open_id` 存量数据

说明：

- 后续若要支持“一用户多身份绑定”，再引入独立 identity 表
- Phase 1 不为“自定义用户主表映射”做抽象
- Phase 1 不要求在首批实施时完成所有项目用户表结构统一迁移

### 2. 新增项目用户 refresh token 表

建议新增公共基础设施表：

`public.druvia_project_refresh_tokens`

建议字段：

- `id SERIAL PRIMARY KEY`
- `project_id VARCHAR(64) NOT NULL`
- `user_id TEXT NOT NULL`
- `token_hash TEXT NOT NULL`
- `provider VARCHAR(32) NOT NULL`
- `expires_at TIMESTAMPTZ NOT NULL`
- `revoked BOOLEAN DEFAULT false`
- `created_at TIMESTAMPTZ DEFAULT NOW()`

索引建议：

- `(project_id, user_id)`
- `(token_hash)`
- `(expires_at) WHERE revoked = false`

说明：

- `user_id` 采用 `TEXT`，避免强绑项目 `users.id` 的具体类型
- Phase 1 不强制跨 schema FK

### 3. 复用现有项目级 auth 配置

继续复用：

- `druvia_project_auth_providers`
- `druvia_project_auth_config`

用途：

- 读取微信 provider 配置
- 读取 access token / refresh token TTL
- 读取 `allow_signup`

## Session 与 JWT 模型

### Access Token Claim

项目终端用户 JWT 建议包含：

- `sub`: 项目用户 id
- `projectId`
- `authType: 'project_user'`
- `role: 'authenticated'`
- `provider: 'wechat'`
- `iat`
- `exp`

说明：

- 不再复用 `userId` / `uid` / `tenantId`
- 这套 claim 与平台用户 JWT 语义明确分离

### Refresh Token 语义

- API 签发 refresh token
- 只在 `druvia_project_refresh_tokens` 中存 hash
- refresh 时执行 token rotation
- logout 时按 `projectId + userId` 撤销未失效 refresh token

### Session 返回结构

建议仍保持与 SDK 当前可承接的结构接近：

```json
{
  "success": true,
  "data": {
    "token": "<access-token>",
    "refreshToken": "<refresh-token>",
    "user": {
      "id": "usr_xxx",
      "email": "user@example.com",
      "username": "昵称",
      "avatarUrl": "https://...",
      "role": "authenticated"
    }
  }
}
```

补充建议：

- 可额外返回 `expiresIn`
- 可额外返回 `expiresAt`

## API 设计

### Phase 1 路由

- `POST /api/v1/projects/:projectId/auth/wechat/silent-login`
- `POST /api/v1/projects/:projectId/auth/wechat/login`
- `POST /api/v1/projects/:projectId/auth/refresh`
- `POST /api/v1/projects/:projectId/auth/logout`

本轮不新增：

- `GET /api/v1/projects/:projectId/auth/me`

原因：

- Phase 1 的主目标是统一签发与统一鉴权
- taro-app 当前主阻塞不在“项目用户 profile 拉取”
- 项目用户 profile 的服务端读接口可留到后续阶段，与项目用户资料更新能力一并设计

### 1. `POST /auth/wechat/silent-login`

用途：

- 只尝试登录，不自动创建用户

请求体建议：

```json
{
  "code": "<wx-code>"
}
```

行为：

- 用 project provider 配置调用 WeChat adapter
- 依据 `provider = 'wechat'` 与 `provider_id = openid` 查找 `<schema>.users`
- 找到则签发 session
- 未找到返回业务错误，例如 `USER_NOT_FOUND`

### 2. `POST /auth/wechat/login`

用途：

- 登录或注册

请求体建议：

```json
{
  "code": "<wx-code>",
  "userInfo": {
    "nickName": "昵称",
    "avatarUrl": "https://..."
  }
}
```

行为：

- 先换取微信身份
- 查找现有用户
- 若不存在且 `allow_signup = true`，在 `<schema>.users` 创建用户
- 更新 `last_login_at`
- 签发 access token / refresh token

说明：

- 该接口在语义上对应 taro-app 现有 `wx-login-register`
- 官方 API 不继续暴露“函数名式”的 auth 路径

### 3. `POST /auth/refresh`

请求体：

```json
{
  "refresh_token": "<refresh-token>"
}
```

行为：

- 校验并消费 refresh token
- 重新签发 access token 与 refresh token
- 返回同一 session 结构

### 4. `POST /auth/logout`

行为：

- 基于 project user JWT 撤销当前用户全部未失效 refresh token

## API 服务内部流程

### 登录流程

1. 校验项目存在
2. 读取项目 auth provider 配置
3. 调用 `WeChatAdapter.exchangeCode()`
4. 读取项目 schema
5. 在 `<schema>.users` 中查找或创建用户
6. 签发 project-user access token
7. 生成并落库 refresh token
8. 返回 session

### 用户查找 / 创建策略

查找键：

- 优先：`provider = 'wechat'` 且 `provider_id = <openid>`
- 兼容：若项目表仍未迁到该结构，则允许回退到 `wx_open_id = <openid>`

创建时：

- 若目标字段存在：
  - `provider = 'wechat'`
  - `provider_id = <openid>`
- 若兼容字段存在：
  - `wx_open_id = <openid>`
- `username` / `avatar_url` 从 `userInfo` 或 provider 原始资料回填
- `status = 'active'`
- 若 `last_login_at` 存在，则写入 `NOW()`

### 数据收敛策略

Phase 1 的策略不是“先强推全量数据改造，再上线 auth”，而是：

1. API 先兼容旧数据形态
2. 新登录路径优先写入目标字段
3. 若项目表仍保留 `wx_open_id`，则同步写入兼容字段
4. 后续再通过单独迁移或回填任务，把存量用户逐步收敛到 `provider/provider_id`

换句话说：

- `wx_open_id` 在 Phase 1 是兼容字段，不是当天就删除的字段
- `provider/provider_id` 才是平台希望收敛到的长期标准

## 中间件身份模型调整

### 当前问题

现有 `RequestUser` 只有：

- `JwtPayload`
- `ApiKeyIdentity`

并且 `JwtPayload` 默认代表平台用户。

### Phase 1 目标

改为显式判别联合类型：

- `PlatformJwtUser`
- `ProjectJwtUser`
- `ApiKeyIdentity`

建议形状：

```ts
type RequestUser =
  | {
      kind: 'platform_user'
      userId: string
      uid: number
      tenantId?: string
      role?: string
    }
  | {
      kind: 'project_user'
      sub: string
      projectId: string
      provider: string
      role: 'authenticated'
      authType: 'project_user'
    }
  | {
      kind: 'apikey'
      projectId: string
      role: 'anon'
    }
```

建议配套工具函数：

- `isPlatformUser()`
- `isProjectUser()`
- `isApiKeyUser()`

不要继续用 `isJwtUser()` 表达“只要是 JWT 就等于平台用户”。

## Functions 调整

### CRUD 管理

Functions 的创建、编辑、删除、列表仍然只接受 platform user。

原因：

- 这些属于管理面能力
- 不属于项目终端用户权限范围

### Invoke

`verifyInvokeAccess()` 需要支持三类调用者：

1. platform user
2. project user
3. apikey anonymous

规则：

- `anon_allowed`
  - 允许同项目 apikey anonymous
  - 也允许 platform user / project user
- `jwt_required`
  - 允许 platform user
  - 允许同项目 project user
  - 拒绝 anonymous apikey

说明：

- `caller` 上下文不能继续只用“`jwt` / `apikey`”二值表达
- 应显式告诉函数调用者是 platform user 还是 project user

## RPC 调整

### 目标

项目业务 RPC 在 Phase 1 增加 project user 认证支持。

### 规则

- platform user：保持现状
- project user：仅允许访问 `projectId` 与 JWT 中一致的项目

### 风险边界

当前 `rpc.service.ts` 只是直接执行 PG function，并不会把用户上下文注入数据库层。

因此：

- Phase 1 的 RPC project-user 支持，只能解决“认证通过 / 认证失败”问题
- 不能自动提供“细粒度按当前用户授权”的数据库级能力

这意味着：

- 已有业务 RPC 若面向项目终端用户开放，仍需自行保证安全
- 更完整的 per-user RPC 授权应作为后续阶段设计，例如：
  - 调用前白名单
  - 约定必须传 `user_id`
  - 连接级 GUC 注入
  - 独立 RPC 权限配置

结论：

- Phase 1 可先加 project-user 认证分支
- 但必须明确这是“先打通登录后受保护接口”，不是完整授权模型终点

## GraphQL 处理策略

Phase 1 不纳入 project-user GraphQL。

原因：

- 现有 GraphQL 代理本质上仍是 API 代持 Hasura admin secret
- 若要支持 project user，需要同时设计：
  - Hasura role 映射
  - user context header 注入
  - 项目业务表权限规则

这部分复杂度明显高于 Functions / RPC，且不是 taro-app 当前主阻塞的最小路径。

## SDK 影响

### 当前问题

`packages/sdk/src/modules/auth.ts` 当前面向的是平台 `/auth/*` 路由，语义偏平台用户。

同时 `packages/sdk/src/types.ts` 的 `UserInfo.id` 当前是 `number`，与项目业务用户常见的 `uuid/string` 不匹配。

### Phase 1 建议

新增项目级 auth 模块或 project-scoped auth 能力，避免继续把平台 auth 与项目 auth 混在一起。

建议方向：

- `client.projectAuth.wechatLogin()`
- `client.projectAuth.wechatSilentLogin()`
- `client.projectAuth.refreshSession()`
- `client.projectAuth.logout()`
- `client.projectAuth.getSession()`
- `client.projectAuth.getUser()`

同时修正类型：

- `UserInfo.id` 改为 `string | number`
  或
- 为 project auth 单独定义 `ProjectUserInfo`

对 taro-app 的建议：

- 旧的 `druvia.auth.*` 不应继续承载微信项目用户登录
- taro-app 应切到新的 project auth 接口
- `projectAuth` 应使用独立 session key，例如 `druvia.project_session`
- 不能复用当前平台 `auth` 的 `druvia.session`，否则会把 platform user 与 project user 会话污染到同一存储槽
- SDK 的 project-scoped 请求注入策略也应同步分层：
  - `functions` / `rpc` 优先使用 project auth session
  - 平台 `auth` 继续只服务平台用户接口
  - `database/graphql` 不在 Phase 1 自动切到 project user token

`projectAuth.getUser()` 的 Phase 1 语义建议明确为：

- 优先作为本地 session 视图能力
- 直接从 `druvia.project_session` 解析当前用户
- 不要求在本轮新增服务端 `auth/me` 路由

后续若需要“服务端实时用户资料读取”，再单独引入项目级 `me/profile` 接口。

## taro-app 迁移建议

### 当前函数的处理

`wx-login-register` / `wx-silent-login` 不再承担 session 签发职责。

它们的后续处理有两种选择：

1. 直接废弃  
   前端改为调用项目 auth API

2. 过渡代理  
   函数内部改为调用项目 auth API，再原样转发结果

推荐：

- 正式路径使用 API
- 若需要降低前端改动成本，可短期保留过渡代理

### 迁移顺序

1. API 新增 project auth 正式能力
2. 中间件支持 project user 身份识别
3. Functions `jwt_required` 接受 project user
4. RPC 增加 project user 鉴权分支
5. taro-app 改调用项目 auth API
6. 删除函数中的 `createJWT()` / mock session 逻辑
7. 清理旧 secrets / 兼容代码

## 风险与限制

### 1. 对项目 `users` 表有结构假设

Phase 1 默认项目业务用户主表就是 `<schema>.users`，且字段结构接近当前 Auth Admin 假设。

### 2. RPC 只是认证打通，不是完整授权完成

project-user RPC 在 Phase 1 主要解决“能被平台认出来”，不是自动完成 per-user 权限治理。

### 3. SDK 需要同步调整

否则 taro-app 虽然有新 API，客户端侧仍会被旧 `auth` 模块语义卡住。

### 4. GraphQL 仍是后续阶段

如果 taro-app 后续要求“项目用户 JWT 直接走 GraphQL”，需要单独设计。

## 成功标准

- 项目终端用户 access token / refresh token 由 Druvia API 正式签发
- taro-app 不再依赖 `wx-login-register` / `wx-silent-login` 自造 session
- `Functions jwt_required` 能接受同项目 project user JWT
- `RPC` 登录后请求不再因为“只认平台 owner JWT”而失败
- 平台用户与项目终端用户语义在中间件层正式分开

## 后续阶段

### Phase 2 候选

- project-user GraphQL
- project-user 细粒度 RPC 授权
- 多 provider / 多 identity 绑定
- 项目用户角色与权限模型
- 对非标准 `users` 表的映射支持
