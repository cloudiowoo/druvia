---
name: api-guide
description: This skill should be used when the user asks about "API response format", "rate limiting", "Fastify routes", "API endpoints", "REST API", "error handling", or mentions "API development", "request validation", "middleware".
---

# API Development Guide

Druvia 平台 API 开发模式指南。

## API Response Format

### Success Response

```typescript
return reply.send({
  success: true,
  data: result,
});

// 带分页
return reply.send({
  success: true,
  data: items,
  pagination: {
    page: 1,
    pageSize: 20,
    total: 100,
    hasMore: true,
  },
});
```

### Error Response

```typescript
return reply.status(404).send({
  success: false,
  error: {
    code: 'NOT_FOUND',
    message: 'Resource not found',
  },
});

// 带详情
return reply.status(400).send({
  success: false,
  error: {
    code: 'VALIDATION_ERROR',
    message: 'Invalid request parameters',
    details: [
      { field: 'email', message: 'Invalid email format' },
    ],
  },
});
```

## Error Codes

| Code | HTTP Status | Description |
|------|-------------|-------------|
| `UNAUTHORIZED` | 401 | 未认证 |
| `FORBIDDEN` | 403 | 无权限 |
| `NOT_FOUND` | 404 | 资源不存在 |
| `VALIDATION_ERROR` | 400 | 参数验证失败 |
| `RATE_LIMITED` | 429 | 请求过于频繁 |
| `INTERNAL_ERROR` | 500 | 服务器内部错误 |

## Route Definition

```typescript
// apps/api/src/modules/tenant/tenant.routes.ts
import type { FastifyInstance } from 'fastify';
import * as controller from './tenant.controller';

export async function tenantRoutes(app: FastifyInstance) {
  app.post('/api/tenants', controller.createTenant);
  app.get('/api/tenants', controller.listTenants);
  app.get('/api/tenants/:tenantId', controller.getTenant);
  app.put('/api/tenants/:tenantId', controller.updateTenant);
  app.delete('/api/tenants/:tenantId', controller.deleteTenant);
}
```

## Controller Pattern

```typescript
// apps/api/src/modules/tenant/tenant.controller.ts
import type { FastifyRequest, FastifyReply } from 'fastify';
import { tenantService } from './tenant.service';

export async function getTenant(
  request: FastifyRequest<{ Params: { tenantId: string } }>,
  reply: FastifyReply
) {
  const tenant = await tenantService.findById(request.params.tenantId);

  if (!tenant) {
    return reply.status(404).send({
      success: false,
      error: { code: 'NOT_FOUND', message: 'Tenant not found' },
    });
  }

  return reply.send({ success: true, data: tenant });
}
```

## Request Validation (Zod)

```typescript
import { z } from 'zod';

const createTenantSchema = z.object({
  alias: z.string().min(3).max(64).regex(/^[a-z0-9_]+$/),
  name: z.string().min(1).max(255),
  plan: z.enum(['free', 'pro', 'enterprise']).optional(),
});

export async function createTenant(request: FastifyRequest, reply: FastifyReply) {
  const result = createTenantSchema.safeParse(request.body);

  if (!result.success) {
    return reply.status(400).send({
      success: false,
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Invalid request parameters',
        details: result.error.errors,
      },
    });
  }

  const tenant = await tenantService.create(result.data);
  return reply.status(201).send({ success: true, data: tenant });
}
```

## Rate Limiting

```typescript
// 使用 Redis 实现令牌桶限流
import { RateLimiter } from '../lib/rate-limiter';

const limiter = new RateLimiter({
  redis: redisClient,
  keyPrefix: 'ratelimit:',
  limits: {
    authenticated: { requests: 100, window: 60 },
    anonymous: { requests: 20, window: 60 },
  },
});
```

## Quick Testing

```bash
# 健康检查
curl http://localhost:3001/health

# 创建租户
curl -X POST http://localhost:3001/api/tenants \
  -H "Content-Type: application/json" \
  -d '{"alias": "acme", "name": "ACME Corp"}'

# 获取租户列表
curl http://localhost:3001/api/tenants
```
