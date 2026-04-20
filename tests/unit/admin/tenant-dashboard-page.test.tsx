// @vitest-environment jsdom

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
  DashboardLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}))

vi.mock('recharts', () => ({
  ResponsiveContainer: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  LineChart: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  Line: () => null,
  XAxis: () => null,
  YAxis: () => null,
  CartesianGrid: () => null,
  Tooltip: () => null,
  PieChart: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  Pie: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  Cell: () => null,
}))

vi.mock('@/lib/api', () => ({
  api: {
    listProjects: vi.fn(async () => ({ success: true, data: [] })),
    getDashboardStats: vi.fn(async () => ({
      success: true,
      data: {
        users: { total: 1 },
        backups: { total: 0 },
        storage: { used: 0, total: 0 },
      },
    })),
    getDashboardActivities: vi.fn(async () => ({ success: true, data: { activities: [] } })),
    getDashboardTrends: vi.fn(async () => ({ success: true, data: [] })),
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
        serviceStatus: {
          api: 'healthy',
          database: 'healthy',
          redis: 'healthy',
          hasura: 'healthy',
          worker: 'unknown',
        },
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

  it('shows an error state when tenant overview fails to load', async () => {
    vi.mocked((await import('@/lib/api')).api.getTenantDashboardOverview).mockResolvedValueOnce({
      success: false,
      error: { code: 'NETWORK_ERROR', message: '网络连接失败' },
    } as never)

    render(<TenantOverviewPage />)

    await waitFor(() => {
      expect(screen.getByText('首页加载失败')).toBeInTheDocument()
      expect(screen.getByText('网络连接失败')).toBeInTheDocument()
    })
  })

  it('shows a partial-load warning when projects or timeline fail', async () => {
    const apiModule = await import('@/lib/api')
    vi.mocked(apiModule.api.getTenantDashboardProjects).mockResolvedValueOnce({
      success: false,
      error: { code: 'BAD_RESPONSE', message: '项目健康加载失败' },
    } as never)
    vi.mocked(apiModule.api.getTenantDashboardTimeline).mockResolvedValueOnce({
      success: false,
      error: { code: 'BAD_RESPONSE', message: '时间线加载失败' },
    } as never)

    render(<TenantOverviewPage />)

    await waitFor(() => {
      expect(screen.getByText('部分数据加载失败')).toBeInTheDocument()
      expect(screen.getByText(/项目健康加载失败/)).toBeInTheDocument()
      expect(screen.getByText(/时间线加载失败/)).toBeInTheDocument()
    })
  })
})
