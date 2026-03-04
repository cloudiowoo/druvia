# Storage Bucket 公开/非公开访问控制设计

**日期**: 2026-03-04
**状态**: 已批准

## 背景

当前存储系统的 `druvia_storage_buckets.public` 字段虽然存在，但在下载逻辑中未被使用。所有 bucket 行为一致：都可以生成签名 URL，签名 URL 可被任何人访问。

**问题**：用户创建"非公开" bucket 后，生成的签名链接仍可被匿名用户访问，公开/非公开区分无实际意义。

## 设计目标

实现真正的公开/非公开 bucket 访问控制：

| Bucket 类型 | 直接 URL | 签名 URL |
|------------|---------|---------|
| 公开 | ✅ 永久可访问 | ✅ 可选生成 |
| 非公开 | ❌ 403 Forbidden | ✅ 唯一访问方式 |

## API 设计

### 新增：公开下载端点

```
GET /api/v1/storage/public/:projectId/:bucketName/*
```

**处理逻辑**：
1. 解析 projectId、bucketName、filePath
2. 查询 bucket，验证 `public = true`
3. 若非公开 → 403 Forbidden
4. 查询 object 元数据获取 mime type
5. 从存储适配器下载并返回

**响应示例**：
- 成功：返回文件内容，带正确的 Content-Type
- 失败：`{ success: false, error: { code: "BUCKET_NOT_PUBLIC", message: "..." } }`

### 保持不变：签名下载端点

```
GET /api/v1/storage/download/:filePath?expires=...&signature=...
```

签名验证逻辑不变，公开/非公开 bucket 都可以生成签名 URL。

### 修改：获取下载 URL 响应

```typescript
// 公开 bucket
{
  url: "/api/v1/storage/public/proj_xxx/images/photo.png",
  expiresIn: null
}

// 非公开 bucket
{
  url: "/api/v1/storage/download/proj_xxx%2Fprivate%2Ffile.pdf?expires=...&signature=...",
  expiresIn: 3600
}
```

## 错误码

| 场景 | HTTP 状态码 | 错误码 |
|-----|------------|--------|
| 公开端点访问非公开 bucket | 403 | `BUCKET_NOT_PUBLIC` |
| 公开端点 bucket 不存在 | 404 | `BUCKET_NOT_FOUND` |
| 公开端点文件不存在 | 404 | `OBJECT_NOT_FOUND` |
| 签名过期 | 403 | `SIGNATURE_EXPIRED` |
| 签名无效 | 403 | `INVALID_SIGNATURE` |

## 代码改动

| 文件 | 改动内容 |
|-----|---------|
| `apps/api/src/modules/storage/storage.routes.ts` | 新增公开下载路由 |
| `apps/api/src/modules/storage/storage.controller.ts` | 新增 `downloadPublic` 函数 |
| `apps/api/src/modules/storage/storage.service.ts` | 新增 `getPublicUrl`，修改 URL 生成逻辑 |
| `apps/api/src/adapters/storage/local.adapter.ts` | 更新 `getPublicUrl` 实现 |
| `apps/api/src/adapters/storage/r2.adapter.ts` | 更新 `getPublicUrl` 实现 |

## 访问控制流程

```
用户请求下载
    │
    ├─→ /storage/public/...
    │       │
    │       ├─→ 检查 bucket.public = true?
    │       │       ├─ 是 → 返回文件
    │       │       └─ 否 → 403 BUCKET_NOT_PUBLIC
    │
    └─→ /storage/download/...?signature=...
            │
            └─→ 验证签名有效且未过期?
                    ├─ 是 → 返回文件
                    └─ 否 → 403 INVALID_SIGNATURE
```

## 未来扩展

- 前端 UI：复制链接时根据 bucket.public 显示不同提示
- CDN 集成：公开 URL 可配置 CDN 前缀
- 访问日志：记录公开文件访问统计
