# Druvia Trusted Backend Access 双层模型设计

## 背景

当前 Druvia 已经具备以下事实基础：

1. 项目级 `projectAuth` 已能正式签发 `project_user` session
2. `Functions jwt_required` 与 `RPC` 已能接受同项目 `project_user`
3. Edge Function 已有正式内部 storage 上传能力
4. `storage` 外部 API 仍未完整覆盖 `project_user` 直连场景
5. H5 / 外部应用存在“已有业务用户，需要正式接入 Druvia 能力”的真实诉求

这说明当前问题已经不再是“能不能先凑一个 token”，而是平台需要补齐一套面向受信业务后端的正式接入模型。

如果只做 `project session`，图片上传这类能力仍会卡在 storage 直连能力不足上。

如果只做 `storage ticket`，则 H5 / 外部应用仍无法自然接入 Functions、RPC、后续更多项目业务能力。

因此需要一个双层模型：

- 身份层：`project session trusted issuer`
- 能力层：`storage ticket`

## 核心结论

`storage ticket` 与 `project session` 不冲突，而且应该长期并存。

两者分工不同：

- `project session`
  - 负责回答“当前项目用户是谁”
  - 用于正式接入项目级业务能力
- `storage ticket`
  - 负责回答“当前是否允许在这个 bucket/path 范围内做一次受限上传/删除”
  - 用于精细受限、短时、能力型访问

换句话说：

- `project session` 是身份
- `storage ticket` 是能力

## 目标

### 总体目标

为 H5 / 外部应用提供正式、受控、可审计的接入路径，使其能以 Druvia 平台能力为主线，而不是继续自维护一套伪兼容会话体系。

### 本方案目标

1. 新增一类正式的 `trusted backend key`
2. 允许受信业务后端为“已存在的项目业务用户”签发标准 `project session`
3. 允许受信业务后端为“已存在的项目业务用户”签发 storage upload/remove ticket
4. 让 H5 能以 `project session` 接入 Functions / RPC / 后续更多能力
5. 让 H5 能以 `storage ticket` 正式完成图片上传/替换
6. 保持 taro-app 现有 Edge Function 上传链路继续可用

### 非目标

Phase 1 不包含：

- GraphQL `project_user` 全覆盖
- storage 全量管理接口全部接受 `project_user`
- 浏览器直接申请 trusted issuer
- 用户名直换 token
- 业务方自行伪造平台兼容 JWT

## 双层模型

## 1. 身份层：Project Session Trusted Issuer

受信业务后端在已完成自身登录态判定后，可向 Druvia 请求：

> 为当前 project 中的指定 `userId` 签发一份标准 `project session`

注意：

- issuer 只接受 `userId`
- 不接受裸 `username`
- `username -> userId` 映射由业务后端自行处理

issuer 返回的 session 必须与现有 `projectAuth` session 语义一致：

- `token`
- `refreshToken`
- `expiresIn`
- `expiresAt`
- `user`

这样 H5 / 外部应用可以正式依附：

- `functions`
- `rpc`
- 后续 project-user 覆盖到的其他模块

## 2. 能力层：Storage Ticket

受信业务后端还可为指定 `project user` 申请：

- upload ticket
- remove ticket

这些 ticket 只用于 storage 场景，不代表完整登录态。

ticket 的约束包括：

- `projectId`
- `projectUserId`
- `bucket`
- `pathPrefix` 或精确 `path`
- `contentTypes`
- `maxBytes`
- `expiresAt`

这样图片上传场景不必等待“storage 全面接受 project session”后才可正式落地。

## 为什么不冲突

二者的访问面天然不同：

### `project session` 负责

- 终端用户身份
- 会话刷新
- 登出
- 项目业务 API 鉴权主线

### `storage ticket` 负责

- 短时上传
- 短时删除
- 路径范围约束
- bucket 范围约束
- 文件类型 / 大小限制

因此长期上推荐：

- 常规业务请求：用 `project session`
- 上传头像 / 队伍图片等对象写入：优先用 `storage ticket`

即使未来 storage 已完整支持 `project_user` 直连，`storage ticket` 仍然有价值：

- BFF / SSR
- 不想把完整会话暴露给浏览器的上传场景
- 更细粒度的上传限制

## 统一基础：Trusted Backend Key

双层模型共享同一类受信服务端凭证：

> `trusted backend key`

这是一种项目级、服务端专用的正式凭证，独立于匿名 `apikey`。

### 与匿名 `apikey` 的区别

匿名 `apikey`：

- 面向匿名项目访问
- 典型用于公开 GraphQL / 登录前函数
- 不应用于服务端可信发行

`trusted backend key`：

- 面向受信业务后端
- 典型用于 issuer 类能力
- 不应用于浏览器端

### 推荐能力范围

`trusted backend key` 建议带 scope，而不是默认无限能力。

Phase 1 至少支持：

- `project_session:issue`
- `storage_ticket:issue`

未来可扩展：

- `project_session:revoke`
- `project_user:lookup`
- `storage_object:admin`

## API 设计

## 1. Trusted Session Issuer

建议新增：

`POST /api/v1/projects/:projectId/auth/trusted/issue-session`

鉴权：

- 只接受 `trusted backend key`
- 不接受普通浏览器调用
- 不接受匿名 `apikey`

输入：

```json
{
  "userId": "uuid"
}
```

输出：

```json
{
  "success": true,
  "data": {
    "token": "access-token",
    "refreshToken": "refresh-token",
    "expiresIn": 604800,
    "expiresAt": "2026-04-04T12:00:00.000Z",
    "user": {
      "id": "uuid",
      "username": "kubo",
      "avatarUrl": null,
      "role": "authenticated"
    }
  }
}
```

要求：

- 复用现有 `issueProjectSession()` 语义
- 不重新发明第二套 session 结构
- 不再让业务方自行构造 token

## 2. Trusted Storage Upload Ticket

建议新增：

`POST /api/v1/projects/:projectId/storage/trusted/upload-ticket`

输入：

```json
{
  "userId": "uuid",
  "bucket": "team-assets",
  "pathPrefix": "user-avatars/",
  "contentTypes": ["image/jpeg", "image/png", "image/webp"],
  "maxBytes": 5242880,
  "expiresIn": 300
}
```

输出：

```json
{
  "success": true,
  "data": {
    "ticket": "stu_xxx",
    "expiresAt": "2026-03-28T12:00:00.000Z",
    "bucket": "team-assets",
    "pathPrefix": "user-avatars/",
    "contentTypes": ["image/jpeg", "image/png", "image/webp"],
    "maxBytes": 5242880
  }
}
```

## 3. Trusted Storage Remove Ticket

建议新增：

`POST /api/v1/projects/:projectId/storage/trusted/remove-ticket`

输入：

```json
{
  "userId": "uuid",
  "bucket": "team-assets",
  "path": "user-avatars/avatar-old.jpg",
  "expiresIn": 300,
  "ignoreMissing": true
}
```

### 删除为什么不应自动推断

平台 storage 层不知道：

- 哪张图是“旧头像”
- 是否要保留历史版本
- 数据库哪个字段代表当前引用对象

这些属于业务层职责。

因此：

- Druvia 提供受控删除能力
- 业务应用决定删哪张图

## 4. Ticket Consumption APIs

建议新增：

- `POST /api/v1/storage/upload-with-ticket`
- `POST /api/v1/storage/remove-with-ticket`

这些接口不接受平台 JWT，也不接受匿名 `apikey`。

它们只接受：

- `x-druvia-storage-ticket`

并从 ticket 恢复全部范围约束。

## 数据流

## H5 登录链路

```text
浏览器
  -> H5 /api/auth/login
  -> H5 服务端完成 username -> userId
  -> H5 服务端调用 Druvia trusted session issuer
  -> 获得正式 project session
  -> 写入 httpOnly cookie
  -> 后续请求 Functions / RPC / 其他 project_user 能力
```

## H5 上传链路

```text
浏览器
  -> H5 /api/storage/avatar-ticket
  -> H5 服务端调用 Druvia trusted storage upload-ticket
  -> 浏览器携带 ticket 直传 Druvia storage
  -> 上传成功后，业务侧更新 avatar_url
  -> 如需替换旧图，再申请 remove-ticket 删除旧对象
```

## taro-app 链路

```text
小程序
  -> 继续使用现有 projectAuth / Edge Function 上传链路
  -> 不要求立即迁移到 trusted session issuer
  -> 不要求立即迁移到 storage ticket
```

## 使用建议矩阵

| 场景 | 推荐能力 |
|------|----------|
| H5 用户登录 | `project session trusted issuer` |
| H5 常规业务请求 | `project session` |
| H5 图片上传 | `storage upload ticket` |
| H5 删除旧图 | `storage remove ticket` |
| taro-app 现有图片上传 | 继续 Edge Function 内部上传 |
| taro-app 后续优化 | 视情况再迁到 ticket 模型 |

## 对现有模块的影响

## 1. Project Auth

`project-auth.service.ts` 已有：

- `issueProjectSession()`
- `refreshProjectSession()`
- `logoutProjectUser()`
- `getProjectUserById()` 的核心查询能力

因此 trusted session issuer 应复用现有 project auth 核心，而不是重做第二套 session 签发逻辑。

## 2. Storage

storage 侧新增的是：

- ticket 发行
- ticket 消费
- 审计 metadata

而不是立刻把整个 storage 模块重做成“全部接受 project_user”。

## 3. SDK

SDK 需补两类 helper：

### 身份层 helper

例如：

```ts
await druvia.projectAuth.issueTrustedSession({
  userId,
  trustedBackendKey,
})
```

### 能力层 helper

例如：

```ts
await druvia.storage.issueUploadTicket({
  userId,
  bucket: 'team-assets',
  pathPrefix: 'user-avatars/',
  trustedBackendKey,
})

await druvia.storage.uploadWithTicket(ticket, file, {
  path: 'user-avatars/avatar-123.jpg',
})
```

## 4. Admin

Admin 需要新增或扩展：

- `trusted backend key` 管理
- key scope 配置

不建议把它塞进匿名 `API Keys` 的同一语义里而不做区分。

## 安全要求

### 必须满足

1. `trusted backend key` 仅服务端保存
2. key 必须项目级隔离
3. key 最好带 scope
4. `project session issuer` 不接受 `username`
5. `storage ticket` 必须短时有效
6. `storage ticket` 必须限制 bucket/path/type/size
7. 所有签发与使用都要可审计

### 审计字段建议

至少记录：

- `projectId`
- `trustedKeyId` 或 `trustedKeyPrefix`
- `issuerScope`
- `projectUserId`
- `bucket`
- `objectPath`
- `issuedAt`
- `usedAt`
- `sourceIp`
- `userAgent`

### Phase 1 审计落地建议

Phase 1 先不强制落独立审计表，先用平台现有结构化日志完成“可审计”要求。

也就是：

- trusted session issuer 签发时输出结构化审计日志
- storage ticket 签发与消费时输出结构化审计日志
- 字段至少覆盖上面的建议字段

这样可以先满足联调与追溯需求，同时避免本期把范围扩大到完整审计子系统。

后续若需要：

- Admin 审计列表
- 更稳定的历史查询
- 风险控制与撤销追踪

再单独追加数据库审计表与管理界面。

## Phase 划分

## Phase 1：Trusted Backend Foundation

- `trusted backend key`
- key scopes
- Admin 管理入口

## Phase 2：Project Session Trusted Issuer

- `auth/trusted/issue-session`
- SDK trusted session helper
- trusted-issued session 的 refresh / logout 闭环校验与修正
- H5 以正式 project session 接入业务能力

## Phase 3：Storage Ticket

- `storage/trusted/upload-ticket`
- `storage/trusted/remove-ticket`
- `upload-with-ticket`
- `remove-with-ticket`
- SDK storage ticket helper

## Phase 4：后续增强

可选后续项：

- storage 直接接受 `project_user`
- GraphQL `project_user` 正式支持
- trusted backend key 细粒度 revoke / rotation / audit view

## 验收标准

1. 受信后端能为已有业务用户签发标准 `project session`
2. 该 session 可被现有同项目 `jwt_required` Functions 与 RPC 正式接受
3. 受信后端能为已有业务用户签发 storage upload/remove ticket
4. ticket 只能在授权 bucket/path 范围内使用
5. 上传 metadata 能追溯到项目业务用户与 trusted issuer
6. taro-app 现有函数上传链路不受影响

## 结论

对于 H5 / 外部应用，最合理的正式模型不是二选一，而是双层并存：

1. 用 `project session trusted issuer` 解决正式身份问题
2. 用 `storage ticket` 解决图片上传这类受限能力问题

这样既能让外部应用逐步完整依附 Druvia，又不会为了上传场景把全部能力都硬塞进单一 token。
