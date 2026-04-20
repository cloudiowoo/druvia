# 单租户运营首页 Dashboard 健康总览重构实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 `/t/[tenantId]` 单租户首页重构为基于 tenant-scoped 真实数据的健康总览型 dashboard，优先回答“系统是否健康可用”，并提供项目级解释与下钻入口。

**Architecture:** 保留现有平台级 `/api/v1/dashboard/*` 接口不变，新增 tenant-scoped dashboard 聚合接口为 `/t/[tenantId]` 首页提供数据。该接口仍属于管理面路由，必须保持 `platform_user` JWT + 显式 tenant ownership 校验，不能让 `project_user` 或匿名 `apikey` 访问。前端将当前大页面拆成聚焦组件：综合健康、待处理事项、经营面指标、项目健康列表、能力覆盖、时间线；页面容器只负责加载数据与模式切换。单/多租户模式继续由 Admin 既有 `tenant-config` 推导，不在 API 中通过 `tenantId` 猜测。首页所有健康状态、能力覆盖率与服务状态都必须从真实 query / probe 得出；缺失探针只能返回 `unknown`，不能写死 `healthy`。遵循仓库约束：不自动提交，执行到验证完成后等待用户确认再使用 `/commit`。

**Tech Stack:** Node.js 22, Fastify 5, PostgreSQL 17, Next.js 16, React 19, TypeScript, Vitest

---

## 文件结构

### 后端

- Modify: `apps/api/src/lib/access.ts`
  - 新增 `checkTenantAccess()`，复用现有 owner 关系校验 tenant dashboard 读取权限
- Modify: `apps/api/src/modules/dashboard/dashboard.routes.ts`
  - 新增 tenant-scoped dashboard 路由
- Modify: `apps/api/src/modules/dashboard/dashboard.controller.ts`
  - 读取 `tenantId`、解析 query，并执行 platform-user-only + tenant ownership 校验
- Modify: `apps/api/src/modules/dashboard/dashboard.service.ts`
  - 新增 tenant overview / project rows / timeline 聚合逻辑、真实探针采集与健康评分 helper

### 前端

- Modify: `apps/admin/src/lib/api.ts`
  - 新增 tenant dashboard API client 方法与响应类型
- Modify: `apps/admin/src/app/t/[tenantId]/page.tsx`
  - 页面容器改为使用 tenant-scoped 数据；单租户模式渲染新 dashboard，多租户模式保留现状
- Create: `apps/admin/src/components/dashboard/health-score.ts`
  - 健康状态文案、颜色、分数阈值 helper
- Create: `apps/admin/src/components/dashboard/WorkspaceHealthSummary.tsx`
  - 综合健康卡与 3 个因子卡
- Create: `apps/admin/src/components/dashboard/WorkspaceActionItems.tsx`
  - 待处理事项卡片
- Create: `apps/admin/src/components/dashboard/WorkspaceMetricsRow.tsx`
  - 四张经营面指标卡
- Create: `apps/admin/src/components/dashboard/ProjectHealthList.tsx`
  - 项目健康列表
- Create: `apps/admin/src/components/dashboard/CapabilityCoverageCard.tsx`
  - 能力覆盖概览
- Create: `apps/admin/src/components/dashboard/ActivityTimelineCard.tsx`
  - 活动与异常时间线

### 测试

- Modify: `tests/integration/dashboard.test.ts`
  - 新增 tenant dashboard 集成测试
- Create: `tests/unit/dashboard-controller.test.ts`
  - 锁住 tenant dashboard 的平台用户访问边界
- Create: `tests/unit/dashboard-health.test.ts`
  - 锁住 `unknown` 探针归一化与能力覆盖率计算不能退化成常量
- Modify: `package.json`
  - 为 Admin UI 单测补 `@testing-library/react` / `@testing-library/jest-dom` / `jsdom`
- Modify: `vitest.config.ts`
  - 允许 `tests/**/*.test.tsx`，并给 Admin UI 测试接入 `jsdom`
- Modify: `tests/setup.ts`
  - 注入 `@testing-library/jest-dom/vitest`
- Create: `tests/unit/admin/jsdom-smoke.test.tsx`
  - 校验 Admin UI 单测基建已切到 `jsdom`
- Create: `tests/unit/admin/health-score.test.ts`
- Create: `tests/unit/admin/workspace-health-summary.test.tsx`
- Create: `tests/unit/admin/project-health-list.test.tsx`
- Create: `tests/unit/admin/tenant-dashboard-page.test.tsx`

---

### Task 1: 为 tenant-scoped dashboard API 建立失败测试与聚合接口

**Files:**
- Modify: `tests/integration/dashboard.test.ts`
- Create: `tests/unit/dashboard-controller.test.ts`
- Create: `tests/unit/dashboard-health.test.ts`
- Modify: `apps/api/src/lib/access.ts`
- Modify: `apps/api/src/modules/dashboard/dashboard.service.ts`
- Modify: `apps/api/src/modules/dashboard/dashboard.controller.ts`
- Modify: `apps/api/src/modules/dashboard/dashboard.routes.ts`

- [ ] **Step 1: 在集成测试里先写 tenant overview / project rows / timeline 的失败测试，再补 controller 权限失败测试**

```ts
// tests/integration/dashboard.test.ts

describe('Tenant dashboard', () => {
  it('returns tenant-scoped overview with health and action items', async () => {
    const overview = await dashboardService.getTenantOverview('default')

    expect(overview.workspace.tenantId).toBe('default')
    expect(overview.health.score).toBeGreaterThanOrEqual(0)
    expect(overview.health.score).toBeLessThanOrEqual(100)
    expect(['healthy', 'attention', 'risk']).toContain(overview.health.status)
    expect(Array.isArray(overview.actionItems)).toBe(true)
    expect(overview.metrics.totalProjects).toBeGreaterThanOrEqual(0)
    expect(overview.metrics.activeProjects).toBeGreaterThanOrEqual(0)
    expect(Array.isArray(overview.capabilities)).toBe(true)
  })

  it('returns tenant project health rows with capability statuses', async () => {
    const rows = await dashboardService.getTenantProjectHealth('default')

    expect(Array.isArray(rows)).toBe(true)
    rows.forEach((row) => {
      expect(row.projectId).toBeTruthy()
      expect(row.healthScore).toBeGreaterThanOrEqual(0)
      expect(row.capabilities).toMatchObject({
        database: expect.any(String),
        auth: expect.any(String),
        storage: expect.any(String),
        realtime: expect.any(String),
        functions: expect.any(String),
      })
    })
  })

  it('returns tenant timeline entries ordered by newest first', async () => {
    const timeline = await dashboardService.getTenantTimeline('default', 10)

    expect(Array.isArray(timeline)).toBe(true)
    for (let i = 1; i < timeline.length; i += 1) {
      expect(new Date(timeline[i - 1].createdAt).getTime()).toBeGreaterThanOrEqual(
        new Date(timeline[i].createdAt).getTime()
      )
    }
  })
})
```

```ts
// tests/unit/dashboard-controller.test.ts

describe('Tenant dashboard controller', () => {
  it('rejects apikey users for workspace dashboard routes', async () => {
    const reply = createReply()
    const request = {
      params: { tenantId: 'default' },
      user: { kind: 'apikey' as const, projectId: 'proj_123', role: 'anon' as const },
    }

    await dashboardController.getTenantOverview(request as never, reply as never)

    expect(reply.status).toHaveBeenCalledWith(401)
    expect(reply.payload).toEqual({
      success: false,
      error: { code: 'UNAUTHORIZED', message: 'Authentication required' },
    })
  })

  it('rejects platform users without tenant access', async () => {
    vi.mocked(access.checkTenantAccess).mockResolvedValue(false)

    const reply = createReply()
    const request = {
      params: { tenantId: 'default' },
      user: { kind: 'platform_user' as const, userId: 'usr_other', uid: 2, role: 'admin' as const },
    }

    await dashboardController.getTenantOverview(request as never, reply as never)

    expect(access.checkTenantAccess).toHaveBeenCalledWith('usr_other', 'default')
    expect(reply.status).toHaveBeenCalledWith(403)
  })
})
```

```ts
// tests/unit/dashboard-health.test.ts

describe('tenant dashboard health helpers', () => {
  it('normalizes unknown probes and surfaces partial-signal summary', () => {
    const health = buildTenantHealth({
      totalProjects: 2,
      activeProjects: 1,
      backupCoverage: 50,
      serviceStatus: {
        api: 'healthy',
        database: 'healthy',
        redis: 'unknown',
        hasura: 'healthy',
        worker: 'unknown',
      },
      actionItems: [],
      capabilities: [
        { key: 'database', label: 'Database', coveredProjects: 2, totalProjects: 2, status: 'healthy' },
        { key: 'auth', label: 'Auth', coveredProjects: 1, totalProjects: 2, status: 'attention' },
      ],
    })

    expect(health.score).toBeGreaterThanOrEqual(0)
    expect(health.score).toBeLessThanOrEqual(100)
    expect(health.summary).toContain('部分信号缺失')
  })

  it('computes capability coverage from real coveredProjects values', () => {
    expect(
      computeCapabilityCoverage([
        { key: 'database', label: 'Database', coveredProjects: 3, totalProjects: 3, status: 'healthy' },
        { key: 'auth', label: 'Auth', coveredProjects: 0, totalProjects: 3, status: 'risk' },
        { key: 'storage', label: 'Storage', coveredProjects: 1, totalProjects: 3, status: 'attention' },
        { key: 'realtime', label: 'Realtime', coveredProjects: 2, totalProjects: 3, status: 'attention' },
        { key: 'functions', label: 'Functions', coveredProjects: 3, totalProjects: 3, status: 'healthy' },
      ])
    ).toBe(60)
  })
})
```

- [ ] **Step 2: 运行集成测试，确认因缺少方法或类型而失败**

Run: `pnpm test tests/integration/dashboard.test.ts tests/unit/dashboard-controller.test.ts tests/unit/dashboard-health.test.ts`

Expected: FAIL，提示 `getTenantOverview` / `getTenantProjectHealth` / `getTenantTimeline` / `checkTenantAccess` / `buildTenantHealth` / `computeCapabilityCoverage` 不存在，或 controller 尚未收紧访问边界。

- [ ] **Step 3: 在 `dashboard.service.ts` 中新增 tenant-scoped 类型和最小聚合实现**

```ts
// apps/api/src/modules/dashboard/dashboard.service.ts

export interface TenantDashboardOverview {
  workspace: {
    tenantId: string
    label: string
  }
  health: {
    score: number
    status: 'healthy' | 'attention' | 'risk'
    summary: string
    factors: {
      availability: number
      stability: number
      risk: number
    }
  }
  actionItems: Array<{
    severity: 'high' | 'medium' | 'low'
    scope: 'workspace' | 'project'
    title: string
    description: string
    href: string
  }>
  metrics: {
    totalProjects: number
    activeProjects: number
    capabilityCoverage: number
    backupCoverage: number
    storageUsageBytes: number
    backupUsageBytes: number
  }
  capabilities: Array<{
    key: 'database' | 'auth' | 'storage' | 'realtime' | 'functions'
    label: string
    coveredProjects: number
    totalProjects: number
    status: 'healthy' | 'attention' | 'risk'
  }>
  serviceStatus: {
    api: 'healthy' | 'risk' | 'unknown'
    database: 'healthy' | 'risk' | 'unknown'
    redis: 'healthy' | 'risk' | 'unknown'
    hasura: 'healthy' | 'risk' | 'unknown'
    worker: 'healthy' | 'risk' | 'unknown'
  }
  updatedAt: string
}

export async function getTenantOverview(tenantId: string): Promise<TenantDashboardOverview> {
  const projects = await query<{
    project_id: string
    status: string
    schema_name: string | null
  }>(
    `SELECT project_id, status, schema_name
       FROM druvia_projects
      WHERE tenant_id = $1`,
    [tenantId]
  )

  const totalProjects = projects.length
  const activeProjects = projects.filter((project) => project.status === 'active').length

  const backupStats = await queryOne<{
    covered_projects: string
    backup_usage_bytes: string
  }>(
    `SELECT COUNT(DISTINCT project_id) FILTER (WHERE status = 'completed' AND created_at >= NOW() - INTERVAL '7 days') AS covered_projects,
            COALESCE(SUM(size_bytes), 0) AS backup_usage_bytes
       FROM druvia_backups
      WHERE tenant_id = $1`,
    [tenantId]
  )

  const fileUsage = await queryOne<{ storage_usage_bytes: string }>(
    `SELECT COALESCE(SUM(size_bytes), 0) AS storage_usage_bytes
       FROM druvia_files
      WHERE tenant_id = $1`,
    [tenantId]
  )

  const backupCoverage = totalProjects === 0
    ? 0
    : Math.round((Number(backupStats?.covered_projects || '0') / totalProjects) * 100)

  const serviceStatus = await collectTenantServiceStatus()
  const capabilities = await buildTenantCapabilities({
    tenantId,
    projects,
    serviceStatus,
  })
  const capabilityCoverage = computeCapabilityCoverage(capabilities)
  const actionItems = buildTenantActionItems({
    totalProjects,
    activeProjects,
    backupCoverage,
    serviceStatus,
    capabilities,
  })

  return {
    workspace: {
      tenantId,
      label: `${tenantId} workspace`,
    },
    health: buildTenantHealth({
      totalProjects,
      activeProjects,
      backupCoverage,
      serviceStatus,
      actionItems,
      capabilities,
    }),
    actionItems,
    metrics: {
      totalProjects,
      activeProjects,
      capabilityCoverage,
      backupCoverage,
      storageUsageBytes: Number(fileUsage?.storage_usage_bytes || '0'),
      backupUsageBytes: Number(backupStats?.backup_usage_bytes || '0'),
    },
    capabilities,
    serviceStatus,
    updatedAt: new Date().toISOString(),
  }
}
```

要求：

- `workspace.mode` 不从后端返回，前端继续使用现有 `tenant-config`
- `capabilityCoverage`、`capabilities[*].status`、`serviceStatus` 必须全部来自真实 query / probe
- 尚未补齐的探针统一返回 `unknown`，不能把缺失信号写死成 `healthy`
- `buildTenantHealth()` 需要对 `unknown` 探针做按可用信号归一化，并在 summary 中明确提示“部分信号缺失”
- `getTenantTimeline()` Phase 1 先聚合 `druvia_backups`、`druvia_function_logs`、项目状态变化，以及可归因到当前 tenant 的 admin activity；不要假设仓库里已有完整 project activity feed

- [ ] **Step 4: 补 controller / routes，把 tenant-scoped 接口暴露出来**

```ts
// apps/api/src/lib/access.ts

export async function checkTenantAccess(userId: string, tenantId: string): Promise<boolean> {
  const result = await queryOne<{ exists: boolean }>(
    `SELECT EXISTS(
      SELECT 1
      FROM druvia_tenants t
      WHERE t.tenant_id = $1
        AND t.owner_uid = (SELECT id FROM druvia_users WHERE user_id = $2)
    ) AS exists`,
    [tenantId, userId]
  )

  return result?.exists || false
}
```

```ts
// apps/api/src/modules/dashboard/dashboard.controller.ts

async function verifyTenantDashboardAccess(
  request: FastifyRequest<{ Params: { tenantId: string } }>,
  reply: FastifyReply
) {
  const user = request.user
  if (!user || !isPlatformUser(user)) {
    reply.status(401).send({
      success: false,
      error: { code: 'UNAUTHORIZED', message: 'Authentication required' },
    })
    return false
  }

  const hasAccess = await checkTenantAccess(user.userId, request.params.tenantId)
  if (!hasAccess) {
    reply.status(403).send({
      success: false,
      error: { code: 'FORBIDDEN', message: 'No access to this tenant' },
    })
    return false
  }

  return true
}

export async function getTenantOverview(
  request: FastifyRequest<{ Params: { tenantId: string } }>,
  reply: FastifyReply
) {
  if (!(await verifyTenantDashboardAccess(request, reply))) return

  const overview = await dashboardService.getTenantOverview(request.params.tenantId)
  return reply.send({ success: true, data: overview })
}

export async function getTenantProjects(
  request: FastifyRequest<{ Params: { tenantId: string } }>,
  reply: FastifyReply
) {
  if (!(await verifyTenantDashboardAccess(request, reply))) return

  const projects = await dashboardService.getTenantProjectHealth(request.params.tenantId)
  return reply.send({ success: true, data: projects })
}

export async function getTenantTimeline(
  request: FastifyRequest<{ Params: { tenantId: string }; Querystring: { limit?: string } }>,
  reply: FastifyReply
) {
  if (!(await verifyTenantDashboardAccess(request, reply))) return

  const limit = parseInt(request.query.limit || '20', 10)
  const timeline = await dashboardService.getTenantTimeline(request.params.tenantId, limit)
  return reply.send({ success: true, data: timeline })
}
```

```ts
// apps/api/src/modules/dashboard/dashboard.routes.ts

app.get('/tenants/:tenantId/dashboard/overview', { preHandler: authenticate }, controller.getTenantOverview as never)
app.get('/tenants/:tenantId/dashboard/projects', { preHandler: authenticate }, controller.getTenantProjects as never)
app.get('/tenants/:tenantId/dashboard/timeline', { preHandler: authenticate }, controller.getTenantTimeline as never)
```

- [ ] **Step 5: 再跑集成测试，确认新接口聚合结构稳定**

Run: `pnpm test tests/integration/dashboard.test.ts tests/unit/dashboard-controller.test.ts tests/unit/dashboard-health.test.ts`

Expected: PASS，原有 dashboard 测试、新 tenant dashboard 聚合测试、权限边界测试与健康 helper 测试同时通过。

---

### Task 2: 先补前端测试基建，再写健康状态 helper 并锁住分数语义

**Files:**
- Modify: `package.json`
- Modify: `vitest.config.ts`
- Modify: `tests/setup.ts`
- Create: `tests/unit/admin/jsdom-smoke.test.tsx`
- Create: `apps/admin/src/components/dashboard/health-score.ts`
- Create: `tests/unit/admin/health-score.test.ts`

- [ ] **Step 0: 先补 Admin UI 单测基建，避免后续 `.test.tsx` 全部死在测试环境上**

```ts
// package.json

"devDependencies": {
  "@testing-library/jest-dom": "^6.x",
  "@testing-library/react": "^16.x",
  "jsdom": "^26.x"
}

// vitest.config.ts

test: {
  globals: true,
  environment: 'node',
  include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'],
  environmentMatchGlobs: [['tests/unit/admin/**/*.test.tsx', 'jsdom']],
  setupFiles: ['tests/setup.ts'],
}

// tests/setup.ts

import '@testing-library/jest-dom/vitest'

// tests/unit/admin/jsdom-smoke.test.tsx

import { describe, expect, it } from 'vitest'

describe('admin jsdom smoke', () => {
  it('provides browser globals for admin UI tests', () => {
    expect(document.createElement('div')).toBeInstanceOf(HTMLElement)
  })
})
```

- [ ] **Step 0.1: 运行一个空的 Admin UI 用例或现有 helper 测试，确认 `.test.tsx` 已能在 `jsdom` 下执行**

Run: `pnpm test tests/unit/admin/jsdom-smoke.test.tsx`

Expected: PASS，证明 `.test.tsx` 已在 `jsdom` 下运行，而不是继续落回 `node` 环境。

- [ ] **Step 1: 先写失败测试，锁住健康状态与能力标签语义**

```ts
// tests/unit/admin/health-score.test.ts

import { describe, expect, it } from 'vitest'
import {
  getHealthTone,
  getHealthLabel,
  getCapabilityLabel,
} from '../../../apps/admin/src/components/dashboard/health-score'

describe('health-score helpers', () => {
  it('maps score to status label and tone', () => {
    expect(getHealthLabel(92)).toBe('健康')
    expect(getHealthTone(92)).toBe('emerald')
    expect(getHealthLabel(72)).toBe('关注')
    expect(getHealthTone(72)).toBe('amber')
    expect(getHealthLabel(48)).toBe('风险')
    expect(getHealthTone(48)).toBe('red')
  })

  it('maps capability status to readable label', () => {
    expect(getCapabilityLabel('ready')).toBe('可用')
    expect(getCapabilityLabel('configured')).toBe('已配置')
    expect(getCapabilityLabel('missing')).toBe('未覆盖')
    expect(getCapabilityLabel('attention')).toBe('需关注')
  })
})
```

- [ ] **Step 2: 运行测试，确认 helper 缺失导致失败**

Run: `pnpm test tests/unit/admin/health-score.test.ts`

Expected: FAIL，提示模块不存在。

- [ ] **Step 3: 新建 helper，实现健康阈值与能力文案映射**

```ts
// apps/admin/src/components/dashboard/health-score.ts

export type HealthTone = 'emerald' | 'amber' | 'red'
export type CapabilityStatus = 'ready' | 'configured' | 'missing' | 'attention'

export function getHealthLabel(score: number) {
  if (score >= 85) return '健康'
  if (score >= 60) return '关注'
  return '风险'
}

export function getHealthTone(score: number): HealthTone {
  if (score >= 85) return 'emerald'
  if (score >= 60) return 'amber'
  return 'red'
}

export function getCapabilityLabel(status: CapabilityStatus) {
  switch (status) {
    case 'ready':
      return '可用'
    case 'configured':
      return '已配置'
    case 'missing':
      return '未覆盖'
    case 'attention':
      return '需关注'
  }
}
```

- [ ] **Step 4: 重跑测试，确认阈值与文案锁定成功**

Run: `pnpm test tests/unit/admin/health-score.test.ts`

Expected: PASS。

---

### Task 3: 先做首页核心区组件——综合健康与待处理事项

**Files:**
- Create: `apps/admin/src/components/dashboard/WorkspaceHealthSummary.tsx`
- Create: `apps/admin/src/components/dashboard/WorkspaceActionItems.tsx`
- Create: `tests/unit/admin/workspace-health-summary.test.tsx`

- [ ] **Step 1: 写失败测试，锁住第一屏必须先给结论再给动作**

```tsx
// tests/unit/admin/workspace-health-summary.test.tsx

import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { WorkspaceHealthSummary } from '../../../apps/admin/src/components/dashboard/WorkspaceHealthSummary'
import { WorkspaceActionItems } from '../../../apps/admin/src/components/dashboard/WorkspaceActionItems'

describe('workspace dashboard hero', () => {
  it('renders health score, factor labels and summary', () => {
    render(
      <WorkspaceHealthSummary
        score={82}
        summary="核心服务可用，但 Functions 与备份覆盖不足。"
        factors={{ availability: 30, stability: 27, risk: 25 }}
      />
    )

    expect(screen.getByText('82 / 100')).toBeInTheDocument()
    expect(screen.getByText('核心服务可用，但 Functions 与备份覆盖不足。')).toBeInTheDocument()
    expect(screen.getByText('可用性')).toBeInTheDocument()
    expect(screen.getByText('稳定性')).toBeInTheDocument()
    expect(screen.getByText('配置风险')).toBeInTheDocument()
  })

  it('renders action items with links', () => {
    render(
      <WorkspaceActionItems
        items={[
          {
            severity: 'high',
            title: '最近 7 天没有成功备份',
            description: '当前工作区缺少恢复点。',
            href: '/t/default/backups',
          },
        ]}
      />
    )

    expect(screen.getByText('最近 7 天没有成功备份')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /查看/i })).toHaveAttribute('href', '/t/default/backups')
  })
})
```

- [ ] **Step 2: 运行测试，确认组件尚不存在而失败**

Run: `pnpm test tests/unit/admin/workspace-health-summary.test.tsx`

Expected: FAIL。

- [ ] **Step 3: 实现综合健康卡组件，突出结论与 3 个因子**

```tsx
// apps/admin/src/components/dashboard/WorkspaceHealthSummary.tsx

import { getHealthLabel, getHealthTone } from './health-score'

export function WorkspaceHealthSummary({
  score,
  summary,
  factors,
}: {
  score: number
  summary: string
  factors: {
    availability: number
    stability: number
    risk: number
  }
}) {
  const tone = getHealthTone(score)
  const toneClass = {
    emerald: 'bg-emerald-50 text-emerald-700 border-emerald-200',
    amber: 'bg-amber-50 text-amber-700 border-amber-200',
    red: 'bg-red-50 text-red-700 border-red-200',
  }[tone]

  return (
    <section className="grid gap-4 lg:grid-cols-[1.3fr_1fr]">
      <div className={`rounded-xl border p-6 ${toneClass}`}>
        <p className="text-sm font-medium">系统健康</p>
        <div className="mt-3 flex items-end gap-3">
          <p className="text-4xl font-bold">{score} / 100</p>
          <span className="mb-1 inline-flex rounded-full border px-2 py-0.5 text-xs">
            {getHealthLabel(score)}
          </span>
        </div>
        <p className="mt-3 text-sm">{summary}</p>
      </div>
      <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-1">
        <FactorCard label="可用性" value={factors.availability} />
        <FactorCard label="稳定性" value={factors.stability} />
        <FactorCard label="配置风险" value={factors.risk} />
      </div>
    </section>
  )
}

function FactorCard({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-xl border bg-white p-4">
      <p className="text-sm text-muted-foreground">{label}</p>
      <p className="mt-2 text-2xl font-semibold">{value}</p>
    </div>
  )
}
```

- [ ] **Step 4: 实现待处理事项组件，支持严重级别与空态**

```tsx
// apps/admin/src/components/dashboard/WorkspaceActionItems.tsx

import Link from 'next/link'

export function WorkspaceActionItems({
  items,
}: {
  items: Array<{
    severity: 'high' | 'medium' | 'low'
    title: string
    description: string
    href: string
  }>
}) {
  if (items.length === 0) {
    return (
      <section className="rounded-xl border bg-white p-6">
        <h2 className="text-base font-semibold">待处理事项</h2>
        <p className="mt-4 text-sm text-muted-foreground">当前没有需要立即处理的事项。</p>
      </section>
    )
  }

  return (
    <section className="rounded-xl border bg-white p-6">
      <h2 className="text-base font-semibold">待处理事项</h2>
      <div className="mt-4 space-y-3">
        {items.map((item) => (
          <div key={`${item.severity}-${item.title}`} className="rounded-lg border p-4">
            <div className="flex items-start justify-between gap-4">
              <div>
                <p className="text-sm font-medium">{item.title}</p>
                <p className="mt-1 text-sm text-muted-foreground">{item.description}</p>
              </div>
              <Link className="text-sm font-medium text-primary" href={item.href}>
                查看
              </Link>
            </div>
          </div>
        ))}
      </div>
    </section>
  )
}
```

- [ ] **Step 5: 重跑测试，确认首页第一屏组件通过**

Run: `pnpm test tests/unit/admin/workspace-health-summary.test.tsx`

Expected: PASS。

---

### Task 4: 先写项目健康列表失败测试，再实现能力标签与项目解释层

**Files:**
- Create: `apps/admin/src/components/dashboard/ProjectHealthList.tsx`
- Create: `tests/unit/admin/project-health-list.test.tsx`

- [ ] **Step 1: 写失败测试，锁住项目行必须展示健康分、能力状态和风险标签**

```tsx
// tests/unit/admin/project-health-list.test.tsx

import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { ProjectHealthList } from '../../../apps/admin/src/components/dashboard/ProjectHealthList'

describe('ProjectHealthList', () => {
  it('renders project health, capability labels and risk tags', () => {
    render(
      <ProjectHealthList
        tenantId="default"
        projects={[
          {
            projectId: 'proj_123',
            name: 'Taro 小程序',
            alias: 'taroapp',
            status: 'active',
            healthScore: 78,
            capabilities: {
              database: 'ready',
              auth: 'configured',
              storage: 'ready',
              realtime: 'ready',
              functions: 'missing',
            },
            latestSignalAt: '2026-04-20T06:00:00.000Z',
            latestBackupAt: '2026-04-19T06:00:00.000Z',
            riskTags: ['缺少备份', 'Functions 未覆盖'],
          },
        ]}
      />
    )

    expect(screen.getByText('Taro 小程序')).toBeInTheDocument()
    expect(screen.getByText('78')).toBeInTheDocument()
    expect(screen.getByText('可用')).toBeInTheDocument()
    expect(screen.getByText('已配置')).toBeInTheDocument()
    expect(screen.getByText('未覆盖')).toBeInTheDocument()
    expect(screen.getByText(/最近信号/i)).toBeInTheDocument()
    expect(screen.getByText(/最近备份/i)).toBeInTheDocument()
    expect(screen.getByText('缺少备份')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /进入项目/i })).toHaveAttribute('href', '/t/default/p/proj_123')
  })
})
```

- [ ] **Step 2: 运行测试，确认组件缺失而失败**

Run: `pnpm test tests/unit/admin/project-health-list.test.tsx`

Expected: FAIL。

- [ ] **Step 3: 实现项目健康列表组件，把项目入口升级为解释层**

```tsx
// apps/admin/src/components/dashboard/ProjectHealthList.tsx

import Link from 'next/link'
import { getCapabilityLabel, getHealthLabel } from './health-score'

type CapabilityStatus = 'ready' | 'configured' | 'missing' | 'attention'

export function ProjectHealthList({
  tenantId,
  projects,
}: {
  tenantId: string
  projects: Array<{
    projectId: string
    name: string
    alias: string
    status: string
    healthScore: number
    capabilities: {
      database: CapabilityStatus
      auth: CapabilityStatus
      storage: CapabilityStatus
      realtime: CapabilityStatus
      functions: CapabilityStatus
    }
    latestSignalAt: string | null
    latestBackupAt: string | null
    riskTags: string[]
  }>
}) {
  return (
    <section className="rounded-xl border bg-white">
      <div className="flex items-center justify-between border-b px-6 py-4">
        <div>
          <h2 className="text-base font-semibold">项目健康</h2>
          <p className="text-sm text-muted-foreground">从项目层解释首页健康结论</p>
        </div>
      </div>
      <div className="divide-y">
        {projects.map((project) => (
          <div key={project.projectId} className="grid gap-4 px-6 py-4 lg:grid-cols-[1.4fr_120px_1.6fr_1fr_auto] lg:items-center">
            <div>
              <p className="font-medium">{project.name}</p>
              <p className="text-sm text-muted-foreground">{project.alias}</p>
              <div className="mt-2 text-xs text-muted-foreground">
                <p>最近信号：{formatDateTime(project.latestSignalAt)}</p>
                <p>最近备份：{formatDateTime(project.latestBackupAt)}</p>
              </div>
            </div>
            <div>
              <p className="text-2xl font-semibold">{project.healthScore}</p>
              <p className="text-xs text-muted-foreground">{getHealthLabel(project.healthScore)}</p>
            </div>
            <div className="flex flex-wrap gap-2">
              {Object.values(project.capabilities).map((status, index) => (
                <span key={`${project.projectId}-${index}`} className="rounded-full border px-2 py-0.5 text-xs">
                  {getCapabilityLabel(status)}
                </span>
              ))}
            </div>
            <div className="flex flex-wrap gap-2">
              {project.riskTags.map((tag) => (
                <span key={tag} className="rounded-full bg-amber-50 px-2 py-0.5 text-xs text-amber-700">
                  {tag}
                </span>
              ))}
            </div>
            <Link href={`/t/${tenantId}/p/${project.projectId}`} className="text-sm font-medium text-primary">
              进入项目
            </Link>
          </div>
        ))}
      </div>
    </section>
  )
}

function formatDateTime(value: string | null) {
  if (!value) return '暂无'
  return new Date(value).toLocaleString('zh-CN')
}
```

- [ ] **Step 4: 重跑测试，确认项目解释层组件稳定**

Run: `pnpm test tests/unit/admin/project-health-list.test.tsx`

Expected: PASS。

---

### Task 5: 连接 API client 与 `/t/[tenantId]` 页面容器，替换旧首页布局并做浏览器验证

**Files:**
- Modify: `apps/admin/src/lib/api.ts`
- Modify: `apps/admin/src/app/t/[tenantId]/page.tsx`
- Create: `apps/admin/src/components/dashboard/WorkspaceMetricsRow.tsx`
- Create: `apps/admin/src/components/dashboard/CapabilityCoverageCard.tsx`
- Create: `apps/admin/src/components/dashboard/ActivityTimelineCard.tsx`
- Create: `tests/unit/admin/tenant-dashboard-page.test.tsx`

- [ ] **Step 1: 写页面级失败测试，锁住新首页模块顺序与单租户条件分支**

```tsx
// tests/unit/admin/tenant-dashboard-page.test.tsx

import { render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/tenant-config', () => ({
  isMultiTenantEnabled: () => false,
}))

vi.mock('next/navigation', () => ({
  useParams: () => ({ tenantId: 'default' }),
}))

vi.mock('@/lib/auth', () => ({
  useAuth: () => ({ user: { email: 'admin@druvia.local', username: 'Admin' } }),
}))

vi.mock('@/store', () => ({
  useAppStore: () => ({ currentTenant: null }),
}))

vi.mock('@/components/DashboardLayout', () => ({
  DashboardLayout: ({ children }: any) => <div>{children}</div>,
}))

vi.mock('@/lib/api', () => ({
  api: {
    getTenantDashboardOverview: vi.fn(async () => ({
      success: true,
      data: {
        workspace: { tenantId: 'default', label: 'default workspace' },
        health: {
          score: 82,
          status: 'attention',
          summary: '核心服务可用，但 Functions 与备份覆盖不足。',
          factors: { availability: 30, stability: 27, risk: 25 },
        },
        actionItems: [],
        metrics: {
          totalProjects: 1,
          activeProjects: 1,
          capabilityCoverage: 60,
          backupCoverage: 0,
          storageUsageBytes: 0,
          backupUsageBytes: 0,
        },
        capabilities: [],
        serviceStatus: { api: 'healthy', database: 'healthy', redis: 'healthy', hasura: 'healthy', worker: 'unknown' },
        updatedAt: '2026-04-20T06:00:00.000Z',
      },
    })),
    getTenantDashboardProjects: vi.fn(async () => ({ success: true, data: [] })),
    getTenantDashboardTimeline: vi.fn(async () => ({ success: true, data: [] })),
  },
}))

import TenantOverviewPage from '../../../apps/admin/src/app/t/[tenantId]/page'

describe('TenantOverviewPage', () => {
  it('renders health-first dashboard modules in single-tenant mode', async () => {
    render(<TenantOverviewPage />)

    await waitFor(() => {
      expect(screen.getByText('系统健康')).toBeInTheDocument()
      expect(screen.getByText('待处理事项')).toBeInTheDocument()
      expect(screen.getByText('项目健康')).toBeInTheDocument()
    })
  })
})
```

- [ ] **Step 2: 运行页面测试，确认旧页面结构不满足断言而失败**

Run: `pnpm test tests/unit/admin/tenant-dashboard-page.test.tsx`

Expected: FAIL。

- [ ] **Step 3: 在 `api.ts` 中增加 tenant dashboard 调用方法**

```ts
// apps/admin/src/lib/api.ts

async getTenantDashboardOverview(tenantId: string) {
  return this.request<{
    workspace: { tenantId: string; label: string }
    health: {
      score: number
      status: 'healthy' | 'attention' | 'risk'
      summary: string
      factors: { availability: number; stability: number; risk: number }
    }
    actionItems: Array<{
      severity: 'high' | 'medium' | 'low'
      scope: 'workspace' | 'project'
      title: string
      description: string
      href: string
    }>
    metrics: {
      totalProjects: number
      activeProjects: number
      capabilityCoverage: number
      backupCoverage: number
      storageUsageBytes: number
      backupUsageBytes: number
    }
    capabilities: Array<{
      key: 'database' | 'auth' | 'storage' | 'realtime' | 'functions'
      label: string
      coveredProjects: number
      totalProjects: number
      status: 'healthy' | 'attention' | 'risk'
    }>
    serviceStatus: {
      api: 'healthy' | 'risk' | 'unknown'
      database: 'healthy' | 'risk' | 'unknown'
      redis: 'healthy' | 'risk' | 'unknown'
      hasura: 'healthy' | 'risk' | 'unknown'
      worker: 'healthy' | 'risk' | 'unknown'
    }
    updatedAt: string
  }>('GET', `/api/v1/tenants/${tenantId}/dashboard/overview`)
}

async getTenantDashboardProjects(tenantId: string) {
  return this.request<Array<{
    projectId: string
    name: string
    alias: string
    status: string
    healthScore: number
    healthStatus: 'healthy' | 'attention' | 'risk'
    capabilities: {
      database: 'ready' | 'configured' | 'missing' | 'attention'
      auth: 'ready' | 'configured' | 'missing' | 'attention'
      storage: 'ready' | 'configured' | 'missing' | 'attention'
      realtime: 'ready' | 'configured' | 'missing' | 'attention'
      functions: 'ready' | 'configured' | 'missing' | 'attention'
    }
    latestSignalAt: string | null
    latestBackupAt: string | null
    riskTags: string[]
  }>>('GET', `/api/v1/tenants/${tenantId}/dashboard/projects`)
}

async getTenantDashboardTimeline(tenantId: string, limit = 20) {
  return this.request<Array<{
    id: string
    kind: 'activity' | 'incident'
    title: string
    description: string | null
    createdAt: string
    href: string | null
  }>>('GET', `/api/v1/tenants/${tenantId}/dashboard/timeline?limit=${limit}`)
}
```

- [ ] **Step 4: 重写 `/t/[tenantId]/page.tsx` 的单租户分支，按新顺序组合组件**

```tsx
// apps/admin/src/app/t/[tenantId]/page.tsx

const [overview, setOverview] = useState<TenantDashboardOverview | null>(null)
const [projectRows, setProjectRows] = useState<TenantDashboardProjectRow[]>([])
const [timeline, setTimeline] = useState<TenantDashboardTimelineEntry[]>([])

useEffect(() => {
  async function fetchLegacyTenantOverview() {
    const [projectsRes, statsRes, activitiesRes, trendsRes] = await Promise.all([
      api.listProjects(tenantId),
      api.getDashboardStats(),
      api.getDashboardActivities(5, 0),
      api.getDashboardTrends(7),
    ])

    // 这里继续复用当前页面已有的 legacy state：projects / stats / activities / trends
    if (projectsRes.success && projectsRes.data) setProjects(projectsRes.data)
    if (statsRes.success && statsRes.data) {
      setStats({
        projects: projectsRes.data?.length || 0,
        users: statsRes.data.users?.total || 0,
        backups: statsRes.data.backups?.total || 0,
        storage: statsRes.data.storage || { used: 0, total: 0 },
      })
    }
    if (activitiesRes.success && activitiesRes.data) setActivities(activitiesRes.data.activities || [])
    if (trendsRes.success && trendsRes.data) setTrends(trendsRes.data)
    setLoading(false)
  }

  async function fetchTenantDashboard() {
    const [overviewRes, projectsRes, timelineRes] = await Promise.all([
      api.getTenantDashboardOverview(tenantId),
      api.getTenantDashboardProjects(tenantId),
      api.getTenantDashboardTimeline(tenantId, 10),
    ])

    if (overviewRes.success && overviewRes.data) setOverview(overviewRes.data)
    if (projectsRes.success && projectsRes.data) setProjectRows(projectsRes.data)
    if (timelineRes.success && timelineRes.data) setTimeline(timelineRes.data)
    setLoading(false)
  }

  if (multiTenant) {
    fetchLegacyTenantOverview()
    return
  }

  fetchTenantDashboard()
}, [tenantId, multiTenant])
```

```tsx
return (
  <DashboardLayout>
    <div className="space-y-6">
      <header className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold">运营概览</h1>
          <p className="text-sm text-muted-foreground">{overview?.workspace.label ?? `${tenantId} workspace`} · 单租户模式</p>
        </div>
      </header>

      <WorkspaceHealthSummary
        score={overview?.health.score ?? 0}
        summary={overview?.health.summary ?? '正在计算健康状态。'}
        factors={overview?.health.factors ?? { availability: 0, stability: 0, risk: 0 }}
      />

      <WorkspaceActionItems items={overview?.actionItems ?? []} />
      <WorkspaceMetricsRow metrics={overview?.metrics} />

      <div className="grid gap-6 xl:grid-cols-[1.5fr_1fr]">
        <ProjectHealthList tenantId={tenantId} projects={projectRows} />
        <CapabilityCoverageCard capabilities={overview?.capabilities ?? []} />
      </div>

      <ActivityTimelineCard items={timeline} />
    </div>
  </DashboardLayout>
)
```

- [ ] **Step 5: 运行前端单测、集成测试与构建验证，再用浏览器手工验收**

Run: `pnpm test tests/unit/admin/jsdom-smoke.test.tsx tests/unit/admin/health-score.test.ts tests/unit/admin/workspace-health-summary.test.tsx tests/unit/admin/project-health-list.test.tsx tests/unit/admin/tenant-dashboard-page.test.tsx tests/unit/dashboard-controller.test.ts tests/unit/dashboard-health.test.ts tests/integration/dashboard.test.ts`

Expected: PASS。

Run: `pnpm --filter @druvia/api build && pnpm --filter @druvia/admin build`

Expected: PASS；如出现现有无关失败，需在执行记录中明确区分。

手工验证：

```text
1. 启动开发环境：pnpm dev
2. 登录 http://localhost:3000/login
3. 使用 admin@druvia.local / 88888888 登录
4. 打开 /t/default
5. 确认首屏顺序为：系统健康 → 待处理事项 → 经营面指标 → 项目健康 → 能力覆盖 / 时间线
6. 点击待处理事项与项目跳转，确认链接正确
7. 将 `NEXT_PUBLIC_MULTI_TENANT_ENABLED=true` 后重启 Admin 进程，再确认原租户概览分支仍可使用
```

---

## 自检清单

- [ ] 设计文档中的每个首页模块都有对应任务
- [ ] 没有把 tenant-scoped 数据继续复用成 platform-scoped 旧接口
- [ ] 首页所有“健康”状态都有可解释的数据来源
- [ ] tenant dashboard 路由拒绝 `project_user` 与匿名 `apikey`
- [ ] 没有通过 `tenantId === 'default'` 推断部署模式
- [ ] 没有把缺失探针或缺失配置写死成 `healthy`
- [ ] 未加入超出本次范围的项目页重构或商业化指标
- [ ] 所有命令、文件路径、类型名都与当前代码库一致

---

## 交付完成标准

- [ ] 新增 tenant-scoped dashboard API 并通过集成测试
- [ ] tenant dashboard 路由保持管理面权限边界，不向 `project_user` / `apikey` 开放
- [ ] `/t/default` 单租户首页切换为健康总览型结构
- [ ] 首页核心模块顺序与设计文档一致
- [ ] 项目列表具备健康解释能力，不再只是导航列表
- [ ] 首页健康与能力状态未使用写死数据冒充真实信号
- [ ] 浏览器手工验收完成，且结果有记录
- [ ] 未自动提交，等待用户确认后再决定是否使用 `/commit`
