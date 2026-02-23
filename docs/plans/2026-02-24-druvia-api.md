# Druvia - API 设计

> 创建日期: 2026-02-24
> 父文档: 2026-02-24-druvia-design.md

## 一、认证 API

### 1.1 基础认证

```
POST   /api/auth/login              # 用户名/密码登录
POST   /api/auth/register           # 注册
POST   /api/auth/refresh            # 刷新 Token
POST   /api/auth/logout             # 登出
GET    /api/auth/me                 # 获取当前用户信息
```

### 1.2 第三方认证

```
# 第三方登录
POST   /api/auth/providers/:provider/login        # 第三方登录 (code 换 token)
POST   /api/auth/providers/:provider/refresh      # 刷新第三方 token
GET    /api/auth/providers/:provider/url          # 获取授权 URL (OAuth)

# 账号绑定
POST   /api/auth/providers/:provider/bind         # 绑定第三方账号
DELETE /api/auth/providers/:provider/unbind       # 解绑第三方账号
GET    /api/auth/providers                        # 获取已绑定的第三方账号
```

### 1.3 认证配置 (租户管理员)

```
GET    /api/tenants/:tenantId/auth/providers      # 获取已启用的认证方式
PUT    /api/tenants/:tenantId/auth/providers      # 配置认证方式
GET    /api/tenants/:tenantId/auth/providers/:provider  # 获取单个认证配置
PUT    /api/tenants/:tenantId/auth/providers/:provider  # 更新单个认证配置
DELETE /api/tenants/:tenantId/auth/providers/:provider  # 删除认证配置
```

---

## 二、租户管理 API

```
POST   /api/tenants                 # 创建租户
GET    /api/tenants                 # 租户列表
GET    /api/tenants/:id             # 租户详情
PUT    /api/tenants/:id             # 更新租户
DELETE /api/tenants/:id             # 删除租户
GET    /api/tenants/:id/stats       # 租户统计信息
```

---

## 三、项目管理 API

```
POST   /api/tenants/:tenantId/projects      # 创建项目
GET    /api/tenants/:tenantId/projects      # 项目列表
GET    /api/projects/:projectId             # 项目详情
PUT    /api/projects/:projectId             # 更新项目
DELETE /api/projects/:projectId             # 删除项目
GET    /api/projects/:projectId/stats       # 项目统计信息
```

---

## 四、Schema 管理 API

### 4.1 表管理

```
POST   /api/projects/:projectId/tables              # 创建表
GET    /api/projects/:projectId/tables              # 表列表
GET    /api/projects/:projectId/tables/:name        # 表结构
PUT    /api/projects/:projectId/tables/:name        # 修改表
DELETE /api/projects/:projectId/tables/:name        # 删除表
POST   /api/projects/:projectId/tables/:name/columns    # 添加列
PUT    /api/projects/:projectId/tables/:name/columns/:col  # 修改列
DELETE /api/projects/:projectId/tables/:name/columns/:col  # 删除列
```

### 4.2 函数管理

```
POST   /api/projects/:projectId/functions           # 创建函数
GET    /api/projects/:projectId/functions           # 函数列表
GET    /api/projects/:projectId/functions/:name     # 函数详情
PUT    /api/projects/:projectId/functions/:name     # 更新函数
DELETE /api/projects/:projectId/functions/:name     # 删除函数
POST   /api/projects/:projectId/functions/:name/test  # 测试函数
```

### 4.3 视图管理

```
POST   /api/projects/:projectId/views               # 创建视图
GET    /api/projects/:projectId/views               # 视图列表
GET    /api/projects/:projectId/views/:name         # 视图详情
PUT    /api/projects/:projectId/views/:name         # 更新视图
DELETE /api/projects/:projectId/views/:name         # 删除视图
POST   /api/projects/:projectId/views/:name/refresh # 刷新物化视图
```

---

## 五、数据操作 API (Hasura 代理)

```
POST   /api/projects/:projectId/graphql             # GraphQL 端点
GET    /api/projects/:projectId/rest/:table         # REST 查询
POST   /api/projects/:projectId/rest/:table         # REST 插入
PUT    /api/projects/:projectId/rest/:table/:id     # REST 更新
DELETE /api/projects/:projectId/rest/:table/:id     # REST 删除
POST   /api/projects/:projectId/rpc/:function       # RPC 调用
```

---

## 六、Storage API

### 6.1 文件操作

```
POST   /api/projects/:projectId/storage/upload      # 上传文件
GET    /api/projects/:projectId/storage/*path       # 获取文件/签名URL
DELETE /api/projects/:projectId/storage/*path       # 删除文件
GET    /api/projects/:projectId/storage             # 列出文件 (支持 prefix 参数)
```

### 6.2 存储配置 (管理员)

```
GET    /api/tenants/:tenantId/storage/config        # 获取存储配置
PUT    /api/tenants/:tenantId/storage/config        # 更新存储配置
GET    /api/tenants/:tenantId/storage/usage         # 获取存储使用量
```

### 6.3 请求/响应示例

**上传文件**

```bash
POST /api/projects/proj_123/storage/upload
Content-Type: multipart/form-data

file: (binary)
path: images/avatar.jpg
```

```json
{
  "success": true,
  "data": {
    "path": "images/avatar.jpg",
    "url": "https://bucket.r2.dev/tenant_acme/images/avatar.jpg",
    "size": 102400,
    "mimeType": "image/jpeg"
  }
}
```

**列出文件**

```bash
GET /api/projects/proj_123/storage?prefix=images/&limit=20
```

```json
{
  "success": true,
  "data": {
    "files": [
      { "path": "images/avatar.jpg", "size": 102400, "createdAt": "2026-02-24T10:00:00Z" },
      { "path": "images/logo.png", "size": 51200, "createdAt": "2026-02-24T09:00:00Z" }
    ],
    "hasMore": false
  }
}
```

---

## 七、Backup API

```
POST   /api/projects/:projectId/backups             # 创建备份
GET    /api/projects/:projectId/backups             # 备份列表
GET    /api/projects/:projectId/backups/:id         # 备份详情
POST   /api/projects/:projectId/backups/:id/restore # 恢复备份
DELETE /api/projects/:projectId/backups/:id         # 删除备份
GET    /api/projects/:projectId/backups/:id/download  # 下载 SQL dump
```

### 7.1 请求/响应示例

**创建备份**

```bash
POST /api/projects/proj_123/backups
Content-Type: application/json

{
  "name": "Before migration",
  "excludeTables": ["_meta_*"]
}
```

```json
{
  "success": true,
  "data": {
    "backupId": "bak_abc123",
    "status": "pending",
    "createdAt": "2026-02-24T10:00:00Z"
  }
}
```

**恢复备份**

```bash
POST /api/projects/proj_123/backups/bak_abc123/restore
Content-Type: application/json

{
  "targetSchema": "tenant_acme_proj_shop_restored"
}
```

```json
{
  "success": true,
  "data": {
    "message": "Restore started",
    "targetSchema": "tenant_acme_proj_shop_restored"
  }
}
```

---

## 八、完整路由表

```typescript
// apps/api/src/routes.ts

export const routes = {
  // 认证
  auth: {
    login: 'POST /api/auth/login',
    register: 'POST /api/auth/register',
    refresh: 'POST /api/auth/refresh',
    logout: 'POST /api/auth/logout',
    me: 'GET /api/auth/me',
    providerLogin: 'POST /api/auth/providers/:provider/login',
    providerUrl: 'GET /api/auth/providers/:provider/url',
  },

  // 租户
  tenants: {
    create: 'POST /api/tenants',
    list: 'GET /api/tenants',
    get: 'GET /api/tenants/:id',
    update: 'PUT /api/tenants/:id',
    delete: 'DELETE /api/tenants/:id',
    authProviders: 'GET /api/tenants/:id/auth/providers',
    storageConfig: 'GET /api/tenants/:id/storage/config',
  },

  // 项目
  projects: {
    create: 'POST /api/tenants/:tenantId/projects',
    list: 'GET /api/tenants/:tenantId/projects',
    get: 'GET /api/projects/:projectId',
    update: 'PUT /api/projects/:projectId',
    delete: 'DELETE /api/projects/:projectId',
  },

  // Schema
  schema: {
    tables: '/api/projects/:projectId/tables/*',
    functions: '/api/projects/:projectId/functions/*',
    views: '/api/projects/:projectId/views/*',
  },

  // 数据操作
  data: {
    graphql: 'POST /api/projects/:projectId/graphql',
    rest: '/api/projects/:projectId/rest/:table/*',
    rpc: 'POST /api/projects/:projectId/rpc/:function',
  },

  // Storage
  storage: {
    upload: 'POST /api/projects/:projectId/storage/upload',
    get: 'GET /api/projects/:projectId/storage/*path',
    delete: 'DELETE /api/projects/:projectId/storage/*path',
    list: 'GET /api/projects/:projectId/storage',
  },

  // Backup
  backup: {
    create: 'POST /api/projects/:projectId/backups',
    list: 'GET /api/projects/:projectId/backups',
    get: 'GET /api/projects/:projectId/backups/:id',
    restore: 'POST /api/projects/:projectId/backups/:id/restore',
    delete: 'DELETE /api/projects/:projectId/backups/:id',
    download: 'GET /api/projects/:projectId/backups/:id/download',
  },
};
```

---

## 九、错误响应格式

```json
{
  "success": false,
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Invalid request parameters",
    "details": [
      { "field": "email", "message": "Invalid email format" }
    ]
  }
}
```

### 错误码列表

| 错误码 | HTTP 状态 | 描述 |
|--------|----------|------|
| `UNAUTHORIZED` | 401 | 未认证 |
| `FORBIDDEN` | 403 | 无权限 |
| `NOT_FOUND` | 404 | 资源不存在 |
| `VALIDATION_ERROR` | 400 | 参数验证失败 |
| `RATE_LIMITED` | 429 | 请求过于频繁 |
| `INTERNAL_ERROR` | 500 | 服务器内部错误 |
| `PROVIDER_ERROR` | 502 | 第三方服务错误 |

---

## 十、Realtime (Hasura Subscriptions)

### 10.1 GraphQL Subscription 示例

```graphql
# 订阅表数据变更
subscription OrderChanges($projectId: String!) {
  orders(where: {project_id: {_eq: $projectId}}) {
    id
    status
    updated_at
  }
}

# 订阅系统配置变更
subscription SystemConfigChanges {
  system_config(where: {key: {_eq: "maintenance"}}) {
    value
    updated_at
  }
}
```

### 10.2 客户端使用

```typescript
import { createClient } from 'graphql-ws';

const client = createClient({
  url: 'wss://api.druvia.com/v1/graphql',
  connectionParams: {
    headers: { Authorization: `Bearer ${token}` }
  }
});

// 订阅
const unsubscribe = client.subscribe(
  {
    query: `
      subscription OrderChanges {
        orders { id, status, updated_at }
      }
    `
  },
  {
    next: (data) => console.log('Data:', data),
    error: (err) => console.error('Error:', err),
    complete: () => console.log('Complete'),
  }
);

// 取消订阅
unsubscribe();
```
