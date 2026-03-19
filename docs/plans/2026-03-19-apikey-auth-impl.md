# API Key 认证支持实施计划

基于 [设计文档](./2026-03-19-apikey-auth-design.md)

## 改动文件

| # | 文件 | 改动 |
|---|------|------|
| 1 | `apps/api/src/middleware/auth.ts` | 新增 `ApiKeyIdentity` 类型、类型守卫；`authenticate`/`optionalAuth` 增加 apikey fallback |
| 2 | `apps/api/src/modules/openapi/openapi.routes.ts` | GraphQL 代理 preHandler 适配匿名身份；Hasura 转发设置 anonymous role |
| 3 | `apps/api/src/modules/tenant/tenant.controller.ts` | `request.user!.uid` 加 `isJwtUser` 守卫 |
| 4 | `apps/api/src/modules/settings/settings.controller.ts` | `currentUser.role` 加 `isJwtUser` 守卫 |
| 5 | `apps/api/src/modules/user/user.controller.ts` | 多处 `currentUser.role`/`.userId` 加 `isJwtUser` 守卫 |
| 6 | `apps/api/src/modules/oauth/oauth.controller.ts` | `.userId` 访问加 `isJwtUser` 守卫 |

## Step 1: auth.ts — 类型扩展 + 中间件改造

### 1.1 新增类型和类型守卫

在 `JwtPayload` 接口后新增：

```typescript
export interface ApiKeyIdentity {
  projectId: string;
  role: 'anon';
}

export type RequestUser = JwtPayload | ApiKeyIdentity;

export function isJwtUser(user: RequestUser): user is JwtPayload {
  return 'userId' in user;
}
```

### 1.2 修改 FastifyRequest 声明

```diff
  declare module 'fastify' {
    interface FastifyRequest {
-     user?: JwtPayload;
+     user?: RequestUser;
    }
  }
```

### 1.3 修改 authenticate 函数

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

需要在文件顶部新增 import：

```typescript
import { validateApiKey } from '../modules/api-keys/api-keys.service.js';
```

### 1.4 optionalAuth 同步适配

`optionalAuth` 也增加 apikey 支持：

```typescript
export async function optionalAuth(
  request: FastifyRequest,
  _reply: FastifyReply
): Promise<void> {
  const authHeader = request.headers.authorization;
  if (authHeader?.startsWith('Bearer ')) {
    const token = authHeader.slice(7);
    try {
      request.user = verifyToken(token);
    } catch { /* 忽略 */ }
    return;
  }

  const apiKey = request.headers.apikey as string | undefined;
  if (apiKey) {
    const result = await validateApiKey(apiKey);
    if (result.valid && result.projectId) {
      request.user = { projectId: result.projectId, role: 'anon' };
    }
  }
}
```

## Step 2: openapi.routes.ts — GraphQL 代理适配

### 2.1 导入类型守卫

```typescript
import { authenticate, isJwtUser } from '../../middleware/auth.js';
import type { JwtPayload } from '../../middleware/auth.js';
```

### 2.2 修改 GraphQL 代理 preHandler

替换现有的 project access 检查逻辑：

```typescript
preHandler: [
  async (request: FastifyRequest, reply: FastifyReply) => {
    const { projectId } = request.params as { projectId: string };
    const user = request.user;

    if (!user) {
      return reply.status(401).send({ error: 'Unauthorized' });
    }

    // apikey 认证：验证 projectId 匹配
    if (!isJwtUser(user)) {
      if (user.projectId !== projectId) {
        return reply.status(403).send({ error: 'API key does not match project' });
      }
      return;
    }

    // JWT 认证：原有逻辑
    const hasAccess = await checkProjectAccess(user.userId, projectId);
    if (!hasAccess) {
      return reply.status(403).send({ error: 'Access denied' });
    }
  },
  graphqlRateLimiter,
],
```

### 2.3 Hasura 转发设置 anonymous role

在 GraphQL 代理的 fetch 调用中，匿名用户设置 Hasura role：

```typescript
const hasuraHeaders: Record<string, string> = {
  'Content-Type': 'application/json',
  'x-hasura-admin-secret': HASURA_ADMIN_SECRET,
  'x-hasura-default-schema': schemaName,
};

if (!isJwtUser(request.user!)) {
  hasuraHeaders['x-hasura-role'] = 'anonymous';
}

const response = await fetch(`${HASURA_URL}/v1/graphql`, {
  method: 'POST',
  headers: hasuraHeaders,
  body: JSON.stringify({ query, variables, operationName }),
});
```

## Step 3: 类型兼容性修复

将 `request.user` 类型从 `JwtPayload` 改为 `JwtPayload | ApiKeyIdentity` 后，以下位置直接访问 `.uid`/`.role`/`.userId` 会编译报错，需要加类型守卫。

这些路由都是管理操作，apikey 匿名用户不会走到这些代码（会在 `verifyProjectAccess` 中因无 `userId` 被拒绝），但 TypeScript 编译器不知道这一点。

### 安全的用法（无需改动）

以下模式已经兼容 union 类型，无需修改：

- `request.user?.userId` — 可选链，`ApiKeyIdentity` 无 `userId` 返回 `undefined`
- `request.user?.uid` — 同上
- `(request as any).user?.userId` — `as any` 绕过类型检查
- `if (!request.user) return 401` + 后续访问 — 需要加守卫

### 3.1 tenant.controller.ts (Line 22)

```diff
+ import { isJwtUser } from '../../middleware/auth.js';
  // ...
- ownerUid: request.user!.uid,
+ ownerUid: isJwtUser(request.user!) ? request.user!.uid : 0,
```

实际上此路由需要 JWT 认证，匿名用户不会到达此处。但编译器需要满足。更好的方式：

```typescript
const user = request.user;
if (!user || !isJwtUser(user)) {
  return reply.status(401).send({ success: false, error: { code: 'UNAUTHORIZED', message: 'Authentication required' } });
}
// 此后 user 类型收窄为 JwtPayload
```

### 3.2 settings.controller.ts (Line 18-19)

```typescript
const currentUser = request.user;
if (!currentUser || !isJwtUser(currentUser) || currentUser.role !== 'super_admin') {
  return reply.status(403).send({ ... });
}
```

### 3.3 user.controller.ts (多处)

Lines 99-106, 122-129, 145-169, 186, 230, 265, 315, 353, 379 — 模式相同：

```typescript
if (!request.user) { return 401; }
// 之后访问 request.user.userId / request.user.role
```

改为：

```typescript
const user = request.user;
if (!user || !isJwtUser(user)) { return 401; }
// 此后 user 类型收窄为 JwtPayload
```

### 3.4 oauth.controller.ts (Lines 82-100, 116-123, 132-139)

同样模式，`if (!request.user)` 后访问 `.userId`：

```typescript
if (!request.user || !isJwtUser(request.user)) { return 401; }
```

## Step 4: OpenAPI 路由 — 仅 GraphQL 代理

`GET /projects/:id/openapi`（OpenAPI 文档生成）不支持 apikey，保持原有 JWT 认证。该路由的 preHandler 已用 `(request as any).user?.userId`，无需改动。

## Step 5: 编译验证

```bash
npx tsc --noEmit --project apps/api/tsconfig.json
```

注意：`request.user?.userId` 可选链在 union 类型上不会报错（`ApiKeyIdentity` 无 `userId` 时返回 `undefined`）。只有非可选链的直接访问（如 `request.user!.uid`、`request.user.role`）才会报错，这些已在 Step 3 中处理。

## 验证清单

- [ ] `tsc --noEmit` 编译通过
- [ ] 带 JWT 的请求正常工作（现有功能不受影响）
- [ ] 只带 apikey 的请求可以访问 GraphQL 代理
- [ ] apikey 跨项目请求返回 403
- [ ] 无效 apikey 返回 401
- [ ] 有 Bearer 但无效时返回 401（不 fallback 到 apikey）
- [ ] 匿名用户的 Hasura 请求带 `x-hasura-role: anonymous`
- [ ] 管理类路由（表管理、存储等）仍然拒绝 apikey 匿名用户
- [ ] `GET /projects/:id/openapi` 仍需 JWT，apikey 不可访问
