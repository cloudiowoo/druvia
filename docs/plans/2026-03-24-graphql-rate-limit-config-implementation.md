# GraphQL 限流项目级可配置 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让管理员在项目设置页配置 GraphQL 限流参数（每项目内单用户主体限额 + 项目总限额），配置即时生效。

**Architecture:** 复用现有 `druvia_projects.settings` JSONB 列存储限流配置，GraphQL 代理在 preHandler 阶段查询 project 后读取 settings 动态应用限流。前端新增限流配置子页面，通过 PATCH API 顶层合并更新 settings，并在提交前保留完整 `rateLimits` 对象，避免覆盖其他子键。

**Tech Stack:** Fastify 5 + Redis 7 + PostgreSQL JSONB + Next.js + React

**Spec:** `docs/plans/2026-03-24-graphql-rate-limit-config-design.md`

---

## File Structure

| 文件 | 操作 | 职责 |
|------|------|------|
| `apps/api/src/middleware/ratelimit.ts` | 修改 | 新增 `checkProjectGraphqlRateLimit` 函数 |
| `apps/api/src/modules/openapi/openapi.routes.ts` | 修改 | project 查询前移到 preHandler，动态限流替换硬编码 |
| `apps/api/src/modules/project/project.service.ts` | 修改 | settings 更新改为 JSONB 合并（`\|\|` 操作符）|
| `apps/admin/src/lib/api.ts` | 修改 | `getProject`/`updateProject` 类型加 settings |
| `apps/admin/src/app/t/[tenantId]/p/[projectId]/settings/page.tsx` | 修改 | 新增限流配置导航项 |
| `apps/admin/src/app/t/[tenantId]/p/[projectId]/settings/rate-limits/page.tsx` | 新增 | 限流配置页面 |

---

### Task 1: 后端 — JSONB 合并更新

**Files:**
- Modify: `apps/api/src/modules/project/project.service.ts:113-116`

- [ ] **Step 1: 修改 settings 更新为 JSONB 合并**

在 `project.service.ts` 的 `updateProject` 函数中，将 settings 更新从整体覆盖改为 JSONB 顶层合并：

```typescript
// 改前 (line 113-116):
if (input.settings !== undefined) {
  updates.push(`settings = $${paramIndex++}`);
  values.push(input.settings);
}

// 改后:
if (input.settings !== undefined) {
  updates.push(`settings = COALESCE(settings, '{}'::jsonb) || $${paramIndex++}::jsonb`);
  values.push(JSON.stringify(input.settings));
}
```

- [ ] **Step 2: 验证构建**

Run: `cd /Users/cloudio/Developer/nodejs/Druvia && pnpm --filter @druvia/shared build && pnpm --filter @druvia/api build`
Expected: 构建成功，无错误

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/modules/project/project.service.ts
git commit -m "feat(project): settings 更新改为 JSONB 合并，避免覆盖其他配置键"
```

---

### Task 2: 后端 — 动态 GraphQL 限流函数

**Files:**
- Modify: `apps/api/src/middleware/ratelimit.ts`
- [ ] **Step 1: 在 ratelimit.ts 末尾新增类型和函数**

在文件末尾（line 140 之后）追加：

```typescript
// --- Project-level dynamic GraphQL rate limiting ---

export interface GraphqlRateLimitConfig {
  perUser: number;
  perProject: number;
}

const GRAPHQL_RATE_LIMIT_DEFAULTS: GraphqlRateLimitConfig = {
  perUser: 60,
  perProject: 0, // 0 = unlimited
};

/**
 * 动态 GraphQL 限流：从 project.settings 读取配置
 * - perUser: 每项目内单用户主体每分钟最大请求数
 * - perProject: 项目总计每分钟最大请求数（0=不限）
 */
function resolveGraphqlRateLimitActor(request: FastifyRequest): string {
  const user = request.user;

  if (user?.kind === 'platform_user') {
    return `platform:${user.userId}`;
  }

  if (user?.kind === 'project_user') {
    return `project:${user.sub}`;
  }

  return `anon-ip:${request.ip}`;
}

export async function checkProjectGraphqlRateLimit(
  request: FastifyRequest,
  reply: FastifyReply,
  projectId: string,
  config?: Partial<GraphqlRateLimitConfig>
): Promise<void> {
  const { perUser, perProject } = { ...GRAPHQL_RATE_LIMIT_DEFAULTS, ...config };
  const windowSeconds = 60;

  try {
    // 1. Per-user check（项目内隔离）
    const actorId = resolveGraphqlRateLimitActor(request);
    const userKey = `ratelimit:graphql:${projectId}:${actorId}`;
    const userCurrent = await redis.incr(userKey);

    if (userCurrent === 1) {
      await redis.expire(userKey, windowSeconds);
    }

    const userTtl = await redis.ttl(userKey);
    reply.header('X-RateLimit-Limit', perUser);
    reply.header('X-RateLimit-Remaining', Math.max(0, perUser - userCurrent));
    reply.header('X-RateLimit-Reset', Math.ceil(Date.now() / 1000) + userTtl);

    if (userCurrent > perUser) {
      return reply.status(429).send({
        success: false,
        error: {
          code: 'GRAPHQL_USER_RATE_LIMIT_EXCEEDED',
          message: 'User rate limit exceeded for GraphQL API',
        },
      });
    }

    // 2. Per-project check (skip if perProject === 0)
    if (perProject > 0) {
      const projectKey = `ratelimit:graphql:project:${projectId}`;
      const projectCurrent = await redis.incr(projectKey);

      if (projectCurrent === 1) {
        await redis.expire(projectKey, windowSeconds);
      }

      if (projectCurrent > perProject) {
        return reply.status(429).send({
          success: false,
          error: {
            code: 'GRAPHQL_PROJECT_RATE_LIMIT_EXCEEDED',
            message: 'Project rate limit exceeded for GraphQL API',
          },
        });
      }
    }
  } catch (error) {
    // Fail open: if Redis fails, allow the request
    console.error('GraphQL rate limiter error:', error);
  }
}
```

- [ ] **Step 2: 验证构建**

Run: `pnpm --filter @druvia/api build`
Expected: 构建成功

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/middleware/ratelimit.ts
git commit -m "feat(ratelimit): 新增 checkProjectGraphqlRateLimit 动态限流函数"
```

---

### Task 3: 后端 — GraphQL 代理改用动态限流

**Files:**
- Modify: `apps/api/src/modules/openapi/openapi.routes.ts`

- [ ] **Step 1: 重构 GraphQL 代理路由**

改动要点：
1. 删除模块级 `graphqlRateLimiter` 常量（line 20-25）
2. import 新增 `checkProjectGraphqlRateLimit`（替换已不再使用的 `createRateLimiter`）
3. import `getProjectById` from project service
4. preHandler 中：权限检查后查询 project，挂到 `(request as any).project`，然后调用动态限流
5. handler 中：直接使用 `(request as any).project` 避免重复查询

```typescript
// line 5: 修改 import
import { checkProjectGraphqlRateLimit } from '../../middleware/ratelimit.js';
import { getProjectById } from '../project/project.service.js';

// 删除 line 20-25 的 graphqlRateLimiter 常量

// GraphQL route preHandler 改为:
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
    } else {
      // JWT 认证：原有逻辑
      const hasAccess = await checkProjectAccess(user.userId, projectId);
      if (!hasAccess) {
        return reply.status(403).send({ error: 'Access denied' });
      }
    }

    // 加载 project 并挂到 request 上（供 handler 和限流使用）
    const project = await getProjectById(projectId);
    if (!project || !project.schemaName) {
      return reply.status(404).send({ error: 'Project not found' });
    }
    (request as any).project = project;

    // 动态限流
    const rateLimitConfig = (project.settings as Record<string, any>)?.rateLimits?.graphql;
    await checkProjectGraphqlRateLimit(request, reply, projectId, rateLimitConfig);
    // checkProjectGraphqlRateLimit 内部 return reply.send() 只从该函数返回，
    // 不会中断本 preHandler，必须显式检查 reply.sent 防止 handler 继续执行
    if (reply.sent) return;
  },
],

// handler 改为直接使用 request.project:
async (request, reply) => {
  const { query, variables, operationName } = request.body;
  const project = (request as any).project;
  const schemaName = project.schemaName;

  // ... 后续 Hasura 代理逻辑不变（删除原来 line 71-80 的 project 查询）
}
```

注意：`createRateLimiter` 的 import 仍需保留给 `openapiRateLimiter`（line 14）使用。

- [ ] **Step 2: 验证构建**

Run: `pnpm --filter @druvia/api build`
Expected: 构建成功

- [ ] **Step 3: 手动测试**

启动开发环境后测试：
```bash
# 正常 GraphQL 请求应仍然正常工作
curl -X POST http://localhost:3001/api/v1/projects/proj_xxx/graphql \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{"query": "{ __typename }"}'
# Expected: 200 OK，响应包含 X-RateLimit-* headers
```

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/modules/openapi/openapi.routes.ts
git commit -m "feat(graphql): GraphQL 代理改用动态限流，从 project.settings 读取配置"
```

---

### Task 4: 前端 — API 层类型更新

**Files:**
- Modify: `apps/admin/src/lib/api.ts:216-233`

- [ ] **Step 1: 更新 getProject 返回类型**

在 `api.ts` line 216-224，`getProject` 方法的返回类型中新增 `settings`:

```typescript
async getProject(projectId: string) {
  return this.request<{
    projectId: string;
    tenantId: string;
    alias: string;
    name: string;
    schemaName: string;
    settings: Record<string, unknown>;
    status: string;
  }>('GET', `/api/v1/projects/${projectId}`);
}
```

- [ ] **Step 2: 更新 updateProject 参数类型**

在 `api.ts` line 227-233，`updateProject` 方法的参数中新增 `settings`:

```typescript
async updateProject(projectId: string, data: { name?: string; status?: string; settings?: Record<string, unknown> }) {
  return this.request<{
    projectId: string;
    name: string;
    settings: Record<string, unknown>;
    status: string;
  }>('PATCH', `/api/v1/projects/${projectId}`, data);
}
```

- [ ] **Step 3: 验证前端构建**

Run: `pnpm --filter @druvia/admin build`
Expected: 构建成功（现有调用点不受影响，新增字段都是可选的）

- [ ] **Step 4: Commit**

```bash
git add apps/admin/src/lib/api.ts
git commit -m "feat(admin): getProject/updateProject 类型增加 settings 字段"
```

---

### Task 5: 前端 — 限流配置页面

**Files:**
- Create: `apps/admin/src/app/t/[tenantId]/p/[projectId]/settings/rate-limits/page.tsx`

- [ ] **Step 1: 创建限流配置页面**

```tsx
'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { DashboardLayout } from '@/components/DashboardLayout';
import { useAppStore } from '@/store';
import { api } from '@/lib/api';

interface RateLimitFormData {
  perUser: string;
  perProject: string;
}

export default function RateLimitsPage() {
  const params = useParams();
  const tenantId = params.tenantId as string;
  const projectId = params.projectId as string;
  const { currentTenant, currentProject } = useAppStore();

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saveSuccess, setSaveSuccess] = useState(false);
  const [error, setError] = useState('');
  const [formData, setFormData] = useState<RateLimitFormData>({
    perUser: '',
    perProject: '',
  });

  useEffect(() => {
    async function fetchProject() {
      const res = await api.getProject(projectId);
      if (res.success && res.data) {
        const graphql = (res.data.settings as any)?.rateLimits?.graphql;
        setFormData({
          perUser: graphql?.perUser?.toString() ?? '',
          perProject: graphql?.perProject?.toString() ?? '',
        });
      }
      setLoading(false);
    }
    fetchProject();
  }, [projectId]);

  const validate = (): string | null => {
    if (formData.perUser !== '') {
      const v = Number(formData.perUser);
      if (!Number.isInteger(v) || v < 1 || v > 10000) {
        return '每项目内单用户限额必须是 1-10000 的整数';
      }
    }
    if (formData.perProject !== '') {
      const v = Number(formData.perProject);
      if (!Number.isInteger(v) || v < 0 || v > 100000) {
        return '项目总限额必须是 0-100000 的整数';
      }
    }
    return null;
  };

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    const validationError = validate();
    if (validationError) {
      setError(validationError);
      return;
    }

    setSaving(true);
    setError('');
    setSaveSuccess(false);

    try {
      const graphqlConfig: Record<string, number> = {};
      if (formData.perUser !== '') {
        graphqlConfig.perUser = Number(formData.perUser);
      }
      if (formData.perProject !== '') {
        graphqlConfig.perProject = Number(formData.perProject);
      }

      const projectRes = await api.getProject(projectId);
      if (!projectRes.success || !projectRes.data) {
        throw new Error('加载项目配置失败');
      }

      const currentSettings = (projectRes.data.settings as Record<string, any>) || {};
      const currentRateLimits = (currentSettings.rateLimits as Record<string, any>) || {};

      const res = await api.updateProject(projectId, {
        settings: {
          rateLimits: {
            ...currentRateLimits,
            graphql: graphqlConfig,
          },
        },
      });

      if (res.success) {
        setSaveSuccess(true);
        setTimeout(() => setSaveSuccess(false), 3000);
      }
    } catch {
      setError('保存失败，请重试');
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <DashboardLayout isProjectLevel={true}>
        <div className="p-8 text-center text-gray-500">加载中...</div>
      </DashboardLayout>
    );
  }

  return (
    <DashboardLayout isProjectLevel={true}>
      <div className="mb-6">
        <div className="flex items-center gap-2 text-sm text-muted-foreground mb-2">
          <Link href={`/t/${tenantId}`} className="hover:text-foreground">
            {currentTenant?.name}
          </Link>
          <span>/</span>
          <Link href={`/t/${tenantId}/p/${projectId}`} className="hover:text-foreground">
            {currentProject?.name}
          </Link>
          <span>/</span>
          <Link href={`/t/${tenantId}/p/${projectId}/settings`} className="hover:text-foreground">
            设置
          </Link>
          <span>/</span>
          <span>限流配置</span>
        </div>
        <h1 className="text-2xl font-bold">限流配置</h1>
        <p className="text-sm text-muted-foreground mt-1">
          配置 GraphQL API 的请求频率限制
        </p>
      </div>

      <div className="card max-w-2xl">
        <div className="card-header">
          <h2 className="font-semibold">GraphQL 限流</h2>
        </div>
        <form onSubmit={handleSave} className="card-body space-y-6">
          <div>
            <label className="label">每项目内单用户每分钟请求数</label>
            <input
              type="number"
              className="input w-full max-w-xs"
              placeholder="60（默认）"
              min={1}
              max={10000}
              value={formData.perUser}
              onChange={(e) => setFormData({ ...formData, perUser: e.target.value })}
            />
            <p className="text-xs text-gray-500 mt-1">
              单个平台用户、项目终端用户或匿名来源 IP 的最大请求频率。留空使用默认值 60
            </p>
          </div>

          <div>
            <label className="label">项目总计每分钟请求数</label>
            <input
              type="number"
              className="input w-full max-w-xs"
              placeholder="不限制（默认）"
              min={0}
              max={100000}
              value={formData.perProject}
              onChange={(e) => setFormData({ ...formData, perProject: e.target.value })}
            />
            <p className="text-xs text-gray-500 mt-1">
              项目所有用户的总请求频率。0 或留空表示不限制
            </p>
          </div>

          {error && (
            <p className="text-sm text-red-600">{error}</p>
          )}

          <div className="flex items-center gap-3">
            <button type="submit" disabled={saving} className="btn btn-primary">
              {saving ? '保存中...' : '保存'}
            </button>
            {saveSuccess && (
              <span className="text-green-600 text-sm">保存成功</span>
            )}
          </div>
        </form>
      </div>
    </DashboardLayout>
  );
}
```

- [ ] **Step 2: 验证前端构建**

Run: `pnpm --filter @druvia/admin build`
Expected: 构建成功

- [ ] **Step 3: Commit**

```bash
git add apps/admin/src/app/t/\[tenantId\]/p/\[projectId\]/settings/rate-limits/page.tsx
git commit -m "feat(admin): 新增 GraphQL 限流配置页面"
```

---

> **重要约束**
>
> 当前后端 `settings = settings || input` 仅做顶层合并，不会深合并 `rateLimits`。
> 因此本页面保存前必须先读取当前项目 settings，保留 `rateLimits` 下其他子键后再写回。

### Task 6: 前端 — 设置主页新增导航项

**Files:**
- Modify: `apps/admin/src/app/t/[tenantId]/p/[projectId]/settings/page.tsx`

- [ ] **Step 1: 新增 Gauge 图标 import**

在 `page.tsx` line 19，修改 lucide-react import：

```typescript
// 改前:
import { GitBranch, Key, ChevronRight } from 'lucide-react';

// 改后:
import { GitBranch, Key, Gauge, ChevronRight } from 'lucide-react';
```

- [ ] **Step 2: 在"更多设置"区域新增限流配置链接**

在 `page.tsx` 的 API 密钥 Link 之后（line 244 `</Link>` 之后），新增：

```tsx
<Link
  href={`/t/${tenantId}/p/${projectId}/settings/rate-limits`}
  className="flex items-center justify-between px-6 py-4 hover:bg-gray-50"
>
  <div className="flex items-center gap-3">
    <Gauge className="h-5 w-5 text-gray-400" />
    <div>
      <div className="font-medium">限流配置</div>
      <div className="text-sm text-gray-500">配置 GraphQL API 的请求频率限制</div>
    </div>
  </div>
  <ChevronRight className="h-5 w-5 text-gray-400" />
</Link>
```

注意：原来 API 密钥链接没有 `border-b`（因为它是最后一项）。现在它不再是最后一项，需要给 API 密钥链接加上 `border-b`（与环境管理链接一致）：

```typescript
// API 密钥 Link（line 233）:
// 改前:
className="flex items-center justify-between px-6 py-4 hover:bg-gray-50"
// 改后:
className="flex items-center justify-between px-6 py-4 hover:bg-gray-50 border-b"
```

- [ ] **Step 3: 验证前端构建**

Run: `pnpm --filter @druvia/admin build`
Expected: 构建成功

- [ ] **Step 4: Commit**

```bash
git add apps/admin/src/app/t/\[tenantId\]/p/\[projectId\]/settings/page.tsx
git commit -m "feat(admin): 项目设置页新增限流配置导航项"
```

---

### Task 7: 端到端验证

- [ ] **Step 1: 启动开发环境**

Run: `cd /Users/cloudio/Developer/nodejs/Druvia && pnpm dev`

- [ ] **Step 2: 验证设置页面导航**

浏览器访问 `http://localhost:3000/t/default/p/proj_caTbQ9RJhaZUr2on/settings`，确认"更多设置"中出现"限流配置"导航项。

- [ ] **Step 3: 验证限流配置页面**

点击"限流配置"，确认页面正确加载，表单字段显示默认 placeholder。

- [ ] **Step 4: 保存配置并验证生效**

1. 设置 perUser=200，perProject=1000，点击保存
2. 刷新页面确认配置已保存
3. 通过 GraphQL 请求确认 `X-RateLimit-Limit` header 变为 200

- [ ] **Step 5: 验证 429 行为**

设置 perUser=2，快速发 3 次 GraphQL 请求，第 3 次应返回 429 且 error code 为 `GRAPHQL_USER_RATE_LIMIT_EXCEEDED`。

- [ ] **Step 6: 验证跨项目隔离**

同一用户在项目 A 打满 `perUser` 后，请求项目 B 的 GraphQL 代理，不应继承项目 A 的计数。

- [ ] **Step 7: 验证 `rateLimits` 子键保留**

如果项目 settings 中已有非 GraphQL 的 `rateLimits` 子键，保存 GraphQL 页面后这些子键仍应保留。
