# Druvia 终端用户图片上传设计

## 背景

当前 Druvia 已有项目级 Storage 能力，但“终端用户上传图片”在真实迁移场景里存在两类不同模型：

1. 终端用户通过应用前端直接调用 `storage.upload()`
2. 终端用户先调用 Edge Function，再由函数代表服务端写入 storage

以 taro-app 为代表的真实迁移案例表明，小程序端图片上传当前并不是前端直传 storage，而是：

- 前端读取本地临时文件
- 转 base64
- 调用 `upload-avatar` / `upload-team-logo`
- Edge Function 再以服务端身份写 storage

这条路径在 Supabase 中长期成立，因此 Druvia 不能只支持“终端用户直传 storage”，还必须正式支持“函数代理上传 storage”。

同时，当前临时兼容方案把平台级 token 放进项目函数 secrets，例如：

- `DRUVIA_TOKEN`
- 等价的后台管理 JWT

这能临时跑通，但不符合 Druvia 已确定的边界：

- 平台级 secret 不应暴露给项目函数
- internal token 不应出现在 Admin secrets UI
- 项目边界应由平台恢复，而不是由函数自己声明

## 目标

建立 Druvia 终端用户图片上传的正式能力模型，并明确分阶段实施路线。

### 总体目标

1. 正式支持两类终端用户图片上传模型
2. 保持项目边界和平台级 secret 的隔离
3. 兼容 taro-app 这类已存在的 Edge Function 上传模型
4. 为后续 Web / SDK 原生直传保留清晰演进路径

### Phase 1 目标

Phase 1 只解决“Edge Function 代理上传”正式化，优先覆盖 taro-app 的：

- `upload-avatar`
- `upload-team-logo`

成功标准：

1. 新函数无需配置 `DRUVIA_TOKEN`
2. 函数内部可通过内建 helper 上传图片到当前项目 storage
3. 上传永远绑定当前项目，不能跨项目写 bucket
4. 平台级写入权限只保留在 API 服务端
5. storage 元数据保留终端用户触发者审计信息

### 非目标

Phase 1 不包含：

- 终端用户直接 `druvia.storage.from(...).upload(...)`
- 完整函数内 storage SDK（`list/download/remove/createSignedUrl`）
- 匿名上传
- project-user 直连 storage 的完整权限体系重构
- 前端直传 / presigned upload

## 两类正式模型

### 模型 A：Edge Function 代理上传

适用场景：

- taro-app 小程序端
- 前端需先处理图片、压缩、裁剪、转码
- 现有上传流程已经围绕 Edge Function 构建

链路：

```text
终端用户
  -> functions.invoke('upload-avatar' / 'upload-team-logo')

Druvia API
  -> 校验 invoke 权限
  -> 签发短时 internal token
  -> 注入函数执行上下文

Edge Function
  -> 读取业务参数
  -> 调用内建 druvia.storage.upload()

Druvia API Internal Storage Route
  -> 校验 internal token
  -> 恢复 projectId / functionName / caller
  -> 服务端执行 storage 写入
```

优点：

- 最贴合 taro-app 当前真实迁移路径
- 前端改动最小
- 不需要项目函数持有平台级 token

缺点：

- 平台需新增 internal storage route 和 runtime helper
- 首期只解决函数代理上传，不解决直传能力

### 模型 B：终端用户直传 storage

适用场景：

- Web 应用
- SDK 原生上传模型
- 需要更接近 Supabase 的前端使用方式

链路：

```text
终端用户
  -> druvia.storage.from(bucket).upload(path, file)
  -> API 校验 project_user / platform_user
  -> storage 写入
```

优点：

- API 更直接
- 更符合 SDK 原生能力预期
- 更适合浏览器端和通用 BaaS 体验

缺点：

- 不能直接解决 taro-app 当前真实依赖的函数上传模型
- 需要先扩展 storage 权限体系接受 project-user

## 方案选型

| 方案 | 描述 | 结论 |
|------|------|------|
| A | Phase 1 先做函数代理上传，Phase 2 再补直传 | **采用** |
| B | Phase 1 先做终端用户直传 | 不采用 |
| C | 继续用 `DRUVIA_TOKEN` 作为长期方案 | 不采用 |

采用 A 的原因：

1. taro-app 当前真实上传路径就是 Edge Function 代理上传
2. 这条链路的迁移兼容价值最高
3. 可以复用现有 internal token / runtime helper 设计方向
4. 不必为了直传能力提前重做整套 storage 权限模型

## Phase 1 架构

```text
终端用户
  -> druvia.functions.invoke()

Druvia API
  -> 校验函数 invoke 权限
  -> 签发 internal token
  -> 把 caller 上下文 + token 注入 Deno Worker

Edge Function
  -> 调用 druvia.storage.upload(...)

Internal Storage Route
  -> 只接受 internal token
  -> 从 signed internal token 恢复 projectId / functionName / caller identity
  -> 执行上传并返回 object metadata + publicUrl

Storage Backend
  -> Local / R2 等现有实现
```

### 设计原则

1. 平台级写入权限永远只留在 API 服务端
2. internal token 属于执行期内部凭证，不出现在项目 secrets UI
3. 函数不自行传 `projectId`，项目边界由平台恢复
4. 上传既要记录“哪个函数执行”，也要记录“哪个终端用户触发”

## Helper 设计

Phase 1 不直接提供完整 `druvia.storage.from(bucket)...`，而是先提供窄能力：

```ts
const result = await druvia.storage.upload({
  bucket: 'team-assets',
  path: `user-avatars/avatar-${userId}-${Date.now()}.jpg`,
  data: binaryData,
  contentType: 'image/jpeg'
})

await druvia.storage.remove({
  bucket: 'team-assets',
  path: 'user-avatars/old-avatar.jpg',
  ignoreMissing: true
})
```

返回：

```ts
{
  path: 'user-avatars/avatar-xxx.jpg',
  publicUrl: 'https://.../api/v1/storage/public/<projectId>/<bucket>/<path>' | null,
  object: {
    objectId: 'obj_xxx',
    bucketId: 'bkt_xxx',
    name: 'user-avatars/avatar-xxx.jpg',
    size: 12345,
    mimeType: 'image/jpeg'
  }
}
```

约束：

- `publicUrl` 只在目标 bucket 为公开 bucket 时返回
- 若 bucket 非公开，则 `publicUrl = null`
- `remove()` 仅补受控对象删除，不扩展为完整 storage 管理 API
- Phase 1 不负责在 helper 内自动补 signed URL
- 若未来需要私有 bucket 图片上传后立即访问，应在 Phase 2 单独设计 signed URL / 直传配套能力

采用窄 helper 的原因：

- taro-app 当前主要需要上传，头像/队徽替换流程还需要受控删除旧对象
- API 面更小，权限边界更清晰
- 有利于更快落地 Phase 1

## Internal API 设计

### 路由

- `POST /api/internal/functions/storage/upload`

### 认证

- 仅接受 internal token
- 不接受前端 JWT
- 不接受前端 `apikey`

### 请求体

```json
{
  "bucket": "team-assets",
  "path": "user-avatars/avatar-xxx.jpg",
  "contentType": "image/jpeg",
  "dataBase64": "..."
}
```

### 约束

1. `projectId` 不从 body 读取，只从 internal token 恢复
2. bucket 必须属于当前项目
3. path 必须做安全校验：
   - 禁止 `..`
   - 禁止空路径
   - 限制最大长度
4. 必须显式配置足够的 `bodyLimit`，因为 base64 JSON 比原始二进制更大
5. `bodyLimit` 只负责允许请求进入路由，不替代 bucket 的 `file_size_limit`
6. 保持现有 file size / mime type 校验

### 调用者身份约束

- internal route 的 caller identity 不应信任函数代码传入的 body 字段
- caller 必须由 API 在函数执行时绑定到 signed internal token
- `druvia.storage.upload()` 对函数作者暴露的 API 不应允许自定义 caller
- helper 请求 internal route 时不应再透传 caller body 字段

## 权限语义

### 第一层：函数执行权限

是否允许调用上传函数，仍由 `functions.invoke` 权限决定。

上传类函数在正式模型下应保持：

- `upload-avatar` -> `jwt_required`
- `upload-team-logo` -> `jwt_required`

也就是只有已登录用户才能触发上传函数。

### 第二层：函数内部 storage 权限

一旦函数已被合法触发，`druvia.storage.upload()` 获得的是“当前项目内受控上传能力”。

它不是：

- 全平台写入能力
- 任意 API 调用能力
- 用户可配置 secret

它只允许：

- 在当前项目内写当前项目的 bucket
- 写入动作受 internal route 限制

## 审计与元数据

当前 storage 元数据只有 `created_by`，且更偏平台用户语义，不能完整表达“终端用户通过函数触发上传”的场景。

Phase 1 建议 storage 元数据至少记录：

- `source_function`
- `created_by_type`
  - `platform_user`
  - `project_user`
  - `apikey`
- `created_by_platform_user_id`
- `created_by_project_user_id`

对 taro-app 来说，应优先记录：

- `created_by_type = project_user`
- `created_by_project_user_id = <project user id>`
- `source_function = upload-avatar / upload-team-logo`

这样平台既能审计函数执行来源，也能审计终端用户触发来源。

### 元数据落点取舍

当前 `druvia_storage_objects` 已有 `metadata JSONB`。Phase 1 推荐优先把新增审计信息写入 `metadata`，而不是立即扩展多列结构，原因是：

- Phase 1 的核心目标是先打通正式上传路径
- 审计字段当前主要用于可靠留痕，而不是复杂筛选
- 这样可以减少 migration 成本和表结构膨胀

只有在后续明确需要按这些字段做后台筛选、统计或索引时，再考虑把其中一部分提升为独立列。

## 错误模型

Phase 1 保持相对透明，不额外过度包装：

- `UNAUTHORIZED`
- `FORBIDDEN`
- `BUCKET_NOT_FOUND`
- `INVALID_OBJECT_PATH`
- `FILE_TOO_LARGE`
- `INVALID_MIME_TYPE`
- `UPLOAD_FAILED`

函数侧 helper 可直接抛这些错误，优先便于联调定位。

## taro-app 迁移影响

### 前端

前端协议可基本保持不变：

- 仍然转 base64
- 仍然调用 `functions.invoke('upload-avatar')`
- 仍然消费 `{ path, url }`

### 函数

`upload-avatar` / `upload-team-logo` 的正式迁移目标是：

- 删除 `DRUVIA_TOKEN`
- 删除对公开 storage API 的手写 `fetch`
- 改为调用 `druvia.storage.upload(...)`
- 若业务继续使用“新文件名替换旧图片”，可配合 `druvia.storage.remove(...)` 清理旧对象

迁移约定：

- helper 原始返回采用 `{ path, publicUrl, object }`
- taro-app 函数对前端保持兼容返回 `{ path, url }`
- 即：
  - `url = publicUrl`
  - 仅当上传目标 bucket 为公开 bucket 时，这条兼容返回才成立

因此 Phase 1 默认假设 taro-app 的上传目标 bucket 仍是公开 bucket。

### 配置

正式模型下不再要求项目方在 Functions secrets 中配置：

- `DRUVIA_TOKEN`

## Phase 2 展望

当 taro-app 这类函数代理上传路径稳定后，再补“终端用户直传 storage”：

- `project_user` 访问 storage 上传接口
- SDK 提供 `druvia.storage.from(bucket).upload(...)`
- 视场景决定是否补 presigned upload

Phase 2 应作为独立设计，不与本 Phase 1 混在一起实施。

## 涉及模块

| 模块 | 方向 |
|------|------|
| `apps/api/src/modules/functions` | invoke 时注入 storage 所需 caller 上下文 |
| `apps/api/src/modules/storage` | internal upload route + metadata/audit 扩展 |
| `docker/deno-worker` | 新增 `druvia.storage.upload()` helper |
| `packages/sdk` | Phase 1 不直接改对外 SDK API |
| `apps/admin` | Phase 1 不新增终端用户图片上传管理页 |

## 结论

Druvia 终端用户图片上传需要正式支持两类模型：

1. Edge Function 代理上传
2. 终端用户直传 storage

Phase 1 应优先落地模型 1，因为它最贴近 taro-app 当前真实迁移路径，且可以在不暴露平台级 token 的前提下，把现有上传链路变成平台正式能力。
