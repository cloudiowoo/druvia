# API Key 认证支持设计

## 背景

SDK 的 `createFetchWrapper` 每个请求发送 `apikey` 头，但 API 的 `authenticate` 中间件只接受 `Authorization: Bearer <JWT>`。未登录用户（如小程序匿名访问）没有 JWT token，导致 GraphQL 代理等受保护路由返回 401。

需要让 API 支持 apikey 头作为备选认证方式，类似 Supabase 的 anon key 模式。

## 现状分析

### 认证流程

```
SDK 请求 → apikey: dru_xxx + Authorization: Bearer <JWT>
                          ↓
API authenticate 中间件 → 只检查 Bearer token → 无 token 则 401
```

### 已有基础设施

| 组件 | 状态 |
|------|------|
| `druvia_api_keys` 表 | ✅ project_id + key_hash + last_used_at |
| `validateApiKey(key)` | ✅ 返回 `{ valid, projectId }` |
| `POST /api-keys/validate` | ✅ 公开接口，MCP Server 使用 |
| SDK `apikey` 头 | ✅ 每个请求都发送 |
| `authenticate` 中间件 | ❌ 忽略 apikey 头 |
| `request.user` 类型 | ❌ 只有 JwtPayload，无匿名身份 |

### request.user 当前类型

```typescript
interface JwtPayload {
  userId: string;
  uid: number;
  tenantId?: string;
  role?: string;
  iat?: number;
  exp?: number;
}
```

## 设计方案

### 核心思路

`authenticate` 中间件增加 apikey fallback：无 Bearer token 时，检查 `apikey` 头，验证通过后设置匿名身份。

### 认证优先级

```
1. Authorization: Bearer <JWT> → 解析为已登录用户（现有逻辑）
   - 有 Bearer 但无效 → 直接 401（不 fallback 到 apikey，防止泄露的 token 被忽略）
2. 无 Bearer 时检查 apikey: dru_xxx → 验证后设置为匿名身份（新增）
3. 都没有 → 401
```

注意：SDK 同时发送 `apikey` 和 `Authorization` 两个头。当 Bearer token 存在时，始终以 JWT 为准，apikey 头被忽略。只有完全没有 Bearer 头时才 fallback 到 apikey。

### 匿名身份设计

扩展 `request.user` 类型，支持 apikey 认证的匿名身份：

```typescript
interface ApiKeyIdentity {
  projectId: string;
  role: 'anon';
  // 无 userId、uid — 标识为匿名
}

// 扩展后的类型
type RequestUser = JwtPayload | ApiKeyIdentity;

// 类型守卫
function isJwtUser(user: RequestUser): user is JwtPayload {
  return 'userId' in user;
}

function isApiKeyUser(user: RequestUser): user is ApiKeyIdentity {
  return user.role === 'anon' && 'projectId' in user;
}
```

### authenticate 中间件改动

```typescript
export async function authenticate(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  // 1. 优先 Bearer token
  const authHeader = request.headers.authorization;
  if (authHeader?.startsWith('Bearer ')) {
    const token = authHeader.slice(7);
    try {
      request.user = verifyToken(token);
      return;
    } catch {
      return reply.status(401).send({
        success: false,
        error: { code: 'UNAUTHORIZED', message: 'Invalid or expired token' },
      });
    }
  }

  // 2. Fallback: apikey 头
  const apiKey = request.headers.apikey as string | undefined;
  if (apiKey) {
    const result = await validateApiKey(apiKey);
    if (result.valid && result.projectId) {
      request.user = { projectId: result.projectId, role: 'anon' };
      return;
    }
    return reply.status(401).send({
      success: false,
      error: { code: 'UNAUTHORIZED', message: 'Invalid API key' },
    });
  }

  // 3. 都没有
  return reply.status(401).send({
    success: false,
    error: { code: 'UNAUTHORIZED', message: 'Missing authorization' },
  });
}
```

### 路由层适配

#### GraphQL 代理（openapi.routes.ts）

匿名用户通过 apikey 认证后，`request.user` 有 `projectId` 但无 `userId`。需要调整 project access 检查：

```typescript
preHandler: [
  async (request: FastifyRequest, reply: FastifyReply) => {
    const { projectId } = request.params as { projectId: string };
    const user = request.user;

    if (!user) {
      return reply.status(401).send({ error: 'Unauthorized' });
    }

    // apikey 认证：验证 key 对应的 projectId 与请求的 projectId 一致
    if (user.role === 'anon' && 'projectId' in user) {
      if (user.projectId !== projectId) {
        return reply.status(403).send({ error: 'API key does not match project' });
      }
      return; // 通过
    }

    // JWT 认证：原有逻辑
    const userId = (user as JwtPayload).userId;
    if (!userId) {
      return reply.status(401).send({ error: 'Unauthorized' });
    }
    const hasAccess = await checkProjectAccess(userId, projectId);
    if (!hasAccess) {
      return reply.status(403).send({ error: 'Access denied' });
    }
  },
  graphqlRateLimiter,
],
```

#### Hasura 请求头

匿名用户的 GraphQL 请求转发到 Hasura 时，应使用 `anonymous` role（而非 admin）：

```typescript
const hasuraHeaders: Record<string, string> = {
  'Content-Type': 'application/json',
  'x-hasura-admin-secret': HASURA_ADMIN_SECRET,
  'x-hasura-default-schema': schemaName,
};

// 匿名用户设置 anonymous role
if (request.user?.role === 'anon') {
  hasuraHeaders['x-hasura-role'] = 'anonymous';
}
```

#### 其他受保护路由

大部分管理类路由（项目管理、表管理、存储管理等）仍然需要 JWT 认证。这些路由的 `verifyProjectAccess` 内部检查 `request.user?.userId`，apikey 匿名用户没有 `userId`，自然会被拒绝。无需改动。

### 受影响路由分析

| 路由 | apikey 可访问 | 说明 |
|------|:---:|------|
| `POST /projects/:id/graphql` | ✅ | 核心需求，匿名查询 |
| `GET /projects/:id/openapi` | ❌ | 管理功能，需 JWT |
| `POST /projects/:id/rpc/:fn` | ⚠️ | 可选，Phase 2 考虑 |
| Storage 公开下载 | ✅ | 已是公开路由 |
| Storage 上传/管理 | ❌ | 需 JWT |
| 表/数据管理 | ❌ | 需 JWT |
| 用户/租户管理 | ❌ | 需 JWT |

### 安全考虑

1. **apikey 不等于 admin** — apikey 认证的用户角色是 `anon`，受 Hasura 权限规则限制
2. **projectId 绑定** — apikey 只能访问其绑定的项目，跨项目请求被拒绝
3. **速率限制** — 现有 `graphqlRateLimiter`（60/min）对匿名用户同样生效
4. **审计** — `validateApiKey` 已更新 `last_used_at`，可追踪使用情况
5. **回滚** — 如需紧急回滚，revert `auth.ts` 的 apikey fallback 分支即可恢复原有行为

### 前置条件

- Hasura 需配置 `anonymous` role 的权限规则，否则匿名用户的 GraphQL 查询会被 Hasura 拒绝
- 项目需在 Admin UI 中创建至少一个 API Key

## 改动文件

| 文件 | 改动 |
|------|------|
| `apps/api/src/middleware/auth.ts` | authenticate/optionalAuth 增加 apikey fallback；新增 `ApiKeyIdentity` 类型和类型守卫 |
| `apps/api/src/modules/openapi/openapi.routes.ts` | GraphQL 代理 preHandler 适配匿名身份；Hasura 转发设置 anonymous role |
| `apps/api/src/modules/tenant/tenant.controller.ts` | 类型守卫适配（`request.user!.uid`） |
| `apps/api/src/modules/settings/settings.controller.ts` | 类型守卫适配（`currentUser.role`） |
| `apps/api/src/modules/user/user.controller.ts` | 类型守卫适配（多处 `.role`/`.userId`） |
| `apps/api/src/modules/oauth/oauth.controller.ts` | 类型守卫适配（`.userId`） |

## 不改动的部分

- SDK — 已正确发送 `apikey` 头
- 数据库 — `druvia_api_keys` 表结构不变
- `validateApiKey` — 已有完整实现
- 其他路由 — 自然兼容（无 userId 则被 verifyProjectAccess 拒绝）
