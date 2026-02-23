---
name: hasura-guide
description: This skill should be used when the user asks about "Hasura", "GraphQL", "Subscriptions", "Actions", "Event Triggers", "Hasura permissions", or mentions "GraphQL API", "real-time subscriptions", "Hasura metadata".
---

# Hasura Configuration Guide

Druvia 平台 Hasura GraphQL 引擎配置指南。

## Hasura 在架构中的角色

```
Client → Druvia API (Fastify) → Hasura CE → PostgreSQL
                ↓
         管理层职责:
         - 租户/项目管理
         - Schema DDL 操作
         - 认证/限流
         - Storage/Backup
```

Hasura 负责：
- GraphQL/REST API 自动生成
- 实时订阅 (Subscriptions)
- 权限控制
- Actions (调用外部 HTTP)

## 权限配置

使用 Hasura 权限而非 PostgreSQL RLS：

```yaml
# hasura/metadata/databases/default/tables/tenant_acme_users.yaml
table:
  name: users
  schema: tenant_acme
select_permissions:
  - role: user
    permission:
      columns: [id, username, avatar_url, created_at]
      filter:
        _or:
          - id: { _eq: X-Hasura-User-Id }
          - is_public: { _eq: true }
insert_permissions:
  - role: user
    permission:
      columns: [username, avatar_url]
      check: {}
```

## Subscriptions (实时订阅)

### 配置

```yaml
# 启用表的订阅
table:
  name: orders
  schema: tenant_acme
select_permissions:
  - role: user
    permission:
      columns: '*'
      filter: { user_id: { _eq: X-Hasura-User-Id } }
      allow_subscriptions: true
```

### 客户端使用

```typescript
import { createClient } from 'graphql-ws';

const client = createClient({
  url: 'wss://api.druvia.com/v1/graphql',
  connectionParams: {
    headers: { Authorization: `Bearer ${token}` }
  }
});

// 订阅订单变更
client.subscribe(
  {
    query: `
      subscription OrderChanges {
        orders(order_by: {created_at: desc}, limit: 10) {
          id
          status
          updated_at
        }
      }
    `
  },
  {
    next: (data) => console.log('Order update:', data),
    error: console.error,
  }
);
```

## Actions (自定义业务逻辑)

### 定义 Action

```yaml
# hasura/metadata/actions.yaml
actions:
  - name: sendNotification
    definition:
      kind: synchronous
      handler: '{{DRUVIA_API_URL}}/api/actions/send-notification'
      request_transform:
        body:
          action: transform
          template: '{"userId": {{$body.input.userId}}, "message": {{$body.input.message}}}'
    permissions:
      - role: user
```

### 处理 Action

```typescript
// apps/api/src/modules/actions/notification.ts
app.post('/api/actions/send-notification', async (request, reply) => {
  const { userId, message } = request.body.input;

  // 发送通知逻辑
  await notificationService.send(userId, message);

  return reply.send({ success: true });
});
```

## Event Triggers

### 配置

```yaml
# hasura/metadata/databases/default/tables/tenant_acme_orders.yaml
event_triggers:
  - name: order_created
    definition:
      enable_manual: false
      insert:
        columns: '*'
    retry_conf:
      num_retries: 3
      interval_sec: 10
    webhook: '{{DRUVIA_API_URL}}/api/webhooks/order-created'
```

### 处理 Webhook

```typescript
app.post('/api/webhooks/order-created', async (request, reply) => {
  const { event, table } = request.body;
  const order = event.data.new;

  // 处理新订单
  await orderService.processNewOrder(order);

  return reply.send({ success: true });
});
```

## 常用命令

```bash
# 应用 metadata
hasura metadata apply --endpoint http://localhost:8080 --admin-secret $HASURA_ADMIN_SECRET

# 导出 metadata
hasura metadata export --endpoint http://localhost:8080 --admin-secret $HASURA_ADMIN_SECRET

# 重新加载 metadata
hasura metadata reload --endpoint http://localhost:8080 --admin-secret $HASURA_ADMIN_SECRET

# 追踪新表
hasura metadata apply --endpoint http://localhost:8080 --admin-secret $HASURA_ADMIN_SECRET
```

## JWT 配置

```yaml
# docker-compose.yml
hasura:
  environment:
    HASURA_GRAPHQL_JWT_SECRET: '{"type":"HS256","key":"${JWT_SECRET}"}'
```

JWT Payload 格式：

```json
{
  "sub": "usr_xxx",
  "iat": 1234567890,
  "exp": 1234567890,
  "https://hasura.io/jwt/claims": {
    "x-hasura-default-role": "user",
    "x-hasura-allowed-roles": ["user", "admin"],
    "x-hasura-user-id": "usr_xxx",
    "x-hasura-tenant-id": "ten_xxx"
  }
}
```
