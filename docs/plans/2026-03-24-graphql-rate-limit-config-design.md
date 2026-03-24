# GraphQL 限流项目级可配置

## 背景 (Background)

当前 GraphQL 代理限流硬编码为 60 次/分钟/用户（`openapi.routes.ts`），无法按项目调整。前端应用（如 taro-app）在页面加载时多个组件同时发起 GraphQL 查询，容易触发 429 错误。

需要在项目设置页面提供限流配置入口，让管理员按项目需求调整 GraphQL API 的请求频率限制。

## 目标 (Objectives)

1. 管理员可在项目设置页配置 GraphQL 限流参数（每项目内单用户主体限额 + 项目总限额）
2. 配置即时生效，无缓存延迟
3. 复用现有 `druvia_projects.settings` JSONB 列，无需数据库迁移
4. 最小改动，不影响其他限流（Auth、Upload、OpenAPI）

## 方案设计 (Design)

### 方案选型

| 方案 | 描述 | 优劣 |
|------|------|------|
| **A: 请求时查 DB（采用）** | 复用 GraphQL handler 已有的 project 查询，从 settings 读取配置 | 零额外开销，即时生效 |
| B: Redis 缓存 | project settings 缓存到 Redis | 更复杂，有缓存延迟 |
| C: 内存加载 | 启动时加载，webhook 刷新 | 过度设计 |

采用方案 A：GraphQL 代理已有 project 查询（`openapi.routes.ts:71-80`），将其前移到 preHandler 阶段，限流器直接从 `request.project.settings` 读取配置。

### 数据模型

利用现有 `druvia_projects.settings` JSONB 列，无需新建迁移：

```jsonc
// druvia_projects.settings
{
  "rateLimits": {
    "graphql": {
      "perUser": 200,      // 每项目内单用户主体每分钟请求数，默认 60
      "perProject": 1000   // 项目总计每分钟请求数，默认不限（0）
    }
  }
}
```

字段说明：

| 字段 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `perUser` | number | 60 | 每项目内单用户主体每分钟最大请求数，最小 1，最大 10000 |
| `perProject` | number | 0 | 项目总计每分钟最大请求数，0 表示不限，最大 100000 |

时间窗口固定 1 分钟，不暴露给用户。

“用户主体”定义：

- 平台用户：`platform_user.userId`
- 项目终端用户：`project_user.sub`
- 匿名 `apikey`：当前实现按 `request.ip` 归并，而不是按 API Key id 单独计数

因此当前文档不应把 `perUser` 描述成“按 API Key 单独限流”；若未来需要按 API Key 粒度限流，需要先扩展认证上下文，显式暴露 key identity。

### 系统架构

```
┌─────────────────────────────────────────────────────────┐
│                   GraphQL Proxy Route                    │
│                                                          │
│  preHandler:                                             │
│    1. authenticate (JWT/apikey)                          │
│    2. checkProjectAccess                                 │
│    3. loadProject → request.project  ← 前移到此处        │
│    4. dynamicGraphqlRateLimit        ← 新增，从 settings │
│       ├─ perUser check (ratelimit:graphql:{projectId}:{actorId}) │
│       └─ perProject check (ratelimit:graphql:project:{projectId}) │
│                                                          │
│  handler:                                                │
│    使用 request.project.schemaName → 代理到 Hasura       │
└─────────────────────────────────────────────────────────┘
```

### 后端改动

#### 1. `apps/api/src/middleware/ratelimit.ts`

新增动态限流函数：

```typescript
export interface GraphqlRateLimitConfig {
  perUser: number;     // 每项目内单用户主体每分钟，默认 60
  perProject: number;  // 项目总计每分钟，0=不限
}

const GRAPHQL_DEFAULTS: GraphqlRateLimitConfig = {
  perUser: 60,
  perProject: 0,
};

export async function checkProjectGraphqlRateLimit(
  request: FastifyRequest,
  reply: FastifyReply,
  projectId: string,
  config: Partial<GraphqlRateLimitConfig>
): Promise<void> {
  const { perUser, perProject } = { ...GRAPHQL_DEFAULTS, ...config };
  const windowSeconds = 60;

  // 1. Per-user check
  const actorId = resolveGraphqlRateLimitActor(request);
  const userKey = `ratelimit:graphql:${projectId}:${actorId}`;
  // ... Redis incr/expire 逻辑，同现有 createRateLimiter
  // 超限返回 429 { code: 'GRAPHQL_USER_RATE_LIMIT_EXCEEDED' }

  // 2. Per-project check (跳过 if perProject === 0)
  if (perProject > 0) {
    const projectKey = `ratelimit:graphql:project:${projectId}`;
    // ... Redis incr/expire 逻辑
    // 超限返回 429 { code: 'GRAPHQL_PROJECT_RATE_LIMIT_EXCEEDED' }
  }
}
```

其中 `resolveGraphqlRateLimitActor(request)` 的建议语义：

- `platform_user` → `platform:${user.userId}`
- `project_user` → `project:${user.sub}`
- `apikey` → `anon-ip:${request.ip}`

#### 2. `apps/api/src/modules/openapi/openapi.routes.ts`

- 删除模块级 `graphqlRateLimiter` 常量
- 在 preHandler 中：权限检查后查询 project 并挂到 `request.project`
- 调用 `checkProjectGraphqlRateLimit(request, reply, projectId, project.settings?.rateLimits?.graphql)`
- handler 中直接使用 `request.project.schemaName`，不再重复查询

```typescript
// preHandler 新增步骤
const project = await getProjectById(projectId);
if (!project || !project.schemaName) {
  return reply.status(404).send({ error: 'Project not found' });
}
(request as any).project = project;

// 动态限流
await checkProjectGraphqlRateLimit(
  request, reply, projectId,
  (project.settings as any)?.rateLimits?.graphql
);
```

#### 3. `apps/api/src/modules/project/project.service.ts`

settings 更新改为 JSONB 顶层合并（PostgreSQL `||` 操作符），避免覆盖其他顶层配置键：

> **注意**：`||` 是顶层 key 合并，非深合并。传入 `{"rateLimits": {...}}` 会整体替换 `rateLimits` 键，不会与已有的 `rateLimits` 深合并。因此前端每次保存都必须基于当前 `project.settings.rateLimits` 做读-改-写，保留其他子键（例如未来的 `rateLimits.rpc` / `rateLimits.storage`），不能只提交 `graphql` 单个子对象。

```typescript
// 改前
updates.push(`settings = $${paramIndex++}`);
values.push(input.settings);

// 改后
updates.push(`settings = COALESCE(settings, '{}'::jsonb) || $${paramIndex++}::jsonb`);
values.push(JSON.stringify(input.settings));
```

### 前端改动

#### 1. 新增限流配置页面

**路径**: `apps/admin/src/app/t/[tenantId]/p/[projectId]/settings/rate-limits/page.tsx`

UI 结构：
- 面包屑导航
- 卡片标题："GraphQL 限流配置"
- 两个数字输入字段：
  - **每项目内单用户每分钟请求数**（perUser）— placeholder 60，说明"单个平台用户、项目终端用户或匿名来源 IP 的最大请求频率"
  - **项目总计每分钟请求数**（perProject）— placeholder "不限制"，说明"项目所有用户的总请求频率，0 或空表示不限"
- 保存按钮 + 成功提示
- 输入验证：perUser 范围 [1, 10000]，perProject 范围 [0, 100000]，整数

#### 2. 设置主页新增导航项

在 `settings/page.tsx` 的"更多设置"区域，API 密钥下方新增：

```tsx
<Link href={`/t/${tenantId}/p/${projectId}/settings/rate-limits`}>
  <Gauge className="h-5 w-5 text-gray-400" />
  <div>
    <div className="font-medium">限流配置</div>
    <div className="text-sm text-gray-500">配置 GraphQL API 的请求频率限制</div>
  </div>
</Link>
```

#### 3. API 调用方式

- 读取：`GET /api/v1/projects/:projectId` → `data.settings.rateLimits.graphql`
- 保存：`PATCH /api/v1/projects/:projectId`
- 前端必须先读取当前 `settings.rateLimits`，再提交完整的 `rateLimits` 对象：

```jsonc
{
  "settings": {
    "rateLimits": {
      // 保留已有其他子键
      "graphql": { "perUser": 200, "perProject": 1000 }
    }
  }
}
```

- 后端 JSONB 顶层合并只保证不覆盖 `settings` 其他顶层键，不负责深合并 `rateLimits` 内部子键

## 涉及文件

| 文件 | 改动类型 | 说明 |
|------|----------|------|
| `apps/api/src/middleware/ratelimit.ts` | 修改 | 新增 `checkProjectGraphqlRateLimit` |
| `apps/api/src/modules/openapi/openapi.routes.ts` | 修改 | project 查询前移，动态限流 |
| `apps/api/src/modules/project/project.service.ts` | 修改 | settings JSONB 合并 |
| `apps/admin/src/lib/api.ts` | 修改 | `getProject`/`updateProject` 类型加 settings |
| `apps/admin/.../settings/page.tsx` | 修改 | 新增限流配置导航项 |
| `apps/admin/.../settings/rate-limits/page.tsx` | 新增 | 限流配置页面 |

## 测试验证 (Testing)

### 后端测试

1. **动态限流测试**：设置 perUser=5，连续发 6 次同项目 GraphQL 请求，第 6 次应返回 429
2. **项目总限额测试**：设置 perProject=10，多用户合计超过 10 次应触发项目级 429
3. **跨项目隔离测试**：同一用户在项目 A 打满限流后，项目 B 不应共享计数
4. **默认值测试**：settings 为空时使用默认 60 次/分钟
5. **JSONB 合并测试**：更新 rateLimits 不影响 settings 中其他顶层键
6. **前端读改写测试**：更新 `graphql` 不应覆盖 `rateLimits` 下其他子键

### 前端测试

1. 限流配置页面正确加载当前配置
2. 保存后配置生效（再次请求 API 确认）
3. 输入验证（非整数、超范围值被拒绝）

## 参考资料 (References)

- 现有限流中间件：`apps/api/src/middleware/ratelimit.ts`
- 项目数据模型：`packages/shared/src/types/tenant.ts`
- 项目服务：`apps/api/src/modules/project/project.service.ts`
