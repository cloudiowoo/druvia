// @vitest-environment jsdom

import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { ProjectDataAccessOverviewPanel } from '../../../apps/admin/src/components/data-access/ProjectDataAccessOverview.js'
import type { ProjectDataAccessOverview } from '../../../apps/admin/src/lib/project-data-access-overview.js'

function overview(
  overrides: Partial<ProjectDataAccessOverview> = {}
): ProjectDataAccessOverview {
  return {
    projectId: 'proj_123',
    schemaName: 'dru_proj_123',
    runtimeMode: 'compatibility',
    summary: {
      totalTables: 2,
      configuredTables: 1,
      anonymousConfiguredTables: 0,
      realtimeAccessRequiredTables: 1,
      legacyTables: 0,
      reviewRequiredTables: 1,
    },
    tables: [
      {
        tableName: 'orders',
        dataInterface: 'connected',
        authenticatedAccess: 'read_only',
        anonymousAccess: 'closed',
        realtime: 'disabled',
        legacyAccess: { authenticated: false, anonymous: false },
        reviewRequired: false,
      },
      {
        tableName: 'audit_log',
        dataInterface: 'not_connected',
        authenticatedAccess: 'custom',
        anonymousAccess: 'closed',
        realtime: 'access_required',
        legacyAccess: { authenticated: true, anonymous: false },
        reviewRequired: true,
      },
    ],
    ...overrides,
  }
}

describe('ProjectDataAccessOverviewPanel', () => {
  it('renders summary, product statuses and encoded configuration links', () => {
    const value = overview()
    render(
      <ProjectDataAccessOverviewPanel
        tenantId="tenant/a"
        projectId="project b"
        overview={value}
        loading={false}
        error={null}
        onRetry={vi.fn()}
      />
    )

    expect(screen.queryByText('当前处于兼容模式，新数据访问配置尚未用于应用请求'))
      .not.toBeInTheDocument()
    expect(screen.getByText('数据表总数')).toBeInTheDocument()
    expect(screen.getByText('已配置')).toBeInTheDocument()
    expect(screen.getAllByText('匿名已配置').length).toBeGreaterThan(0)
    expect(screen.getAllByText('Realtime 待授权').length).toBeGreaterThan(0)
    expect(screen.getAllByText('需检查').length).toBeGreaterThan(0)
    for (const heading of ['数据表', '数据接口', '认证用户', '匿名读取', '实时更新', '旧规则', '配置']) {
      expect(screen.getByRole('columnheader', { name: heading })).toBeInTheDocument()
    }
    expect(screen.getByRole('link', { name: '配置 orders' })).toHaveAttribute(
      'href',
      '/t/tenant%2Fa/p/project%20b/tables/orders?tab=access&scope=default'
    )
    expect(document.body.textContent).not.toMatch(/Hasura|metadata|druvia_v1/)
  })

  it('filters review rows and shows a filtered-empty state', () => {
    const value = overview()
    const { rerender } = render(
      <ProjectDataAccessOverviewPanel
        tenantId="tenant"
        projectId="project"
        overview={value}
        loading={false}
        error={null}
        onRetry={vi.fn()}
      />
    )

    fireEvent.click(screen.getByRole('tab', { name: '需检查' }))
    expect(screen.getByText('audit_log')).toBeInTheDocument()
    expect(screen.queryByText('orders')).not.toBeInTheDocument()

    rerender(
      <ProjectDataAccessOverviewPanel
        tenantId="tenant"
        projectId="project"
        overview={overview({
          summary: { ...value.summary, reviewRequiredTables: 0 },
          tables: [value.tables[0]],
        })}
        loading={false}
        error={null}
        onRetry={vi.fn()}
      />
    )
    expect(screen.getByText('当前筛选条件下没有数据表')).toBeInTheDocument()
  })

  it('renders empty, loading and retryable failure states', () => {
    const retry = vi.fn()
    const { rerender } = render(
      <ProjectDataAccessOverviewPanel
        tenantId="tenant"
        projectId="project"
        overview={null}
        loading={true}
        error={null}
        onRetry={retry}
      />
    )
    expect(screen.getByText('正在加载数据访问状态')).toBeInTheDocument()

    rerender(
      <ProjectDataAccessOverviewPanel
        tenantId="tenant"
        projectId="project"
        overview={null}
        loading={false}
        error="加载失败"
        onRetry={retry}
      />
    )
    fireEvent.click(screen.getByRole('button', { name: '重试' }))
    expect(retry).toHaveBeenCalledTimes(1)

    rerender(
      <ProjectDataAccessOverviewPanel
        tenantId="tenant"
        projectId="project"
        overview={overview({
          summary: {
            totalTables: 0,
            configuredTables: 0,
            anonymousConfiguredTables: 0,
            realtimeAccessRequiredTables: 0,
            legacyTables: 0,
            reviewRequiredTables: 0,
          },
          tables: [],
        })}
        loading={false}
        error={null}
        onRetry={retry}
      />
    )
    expect(screen.getByText('项目中还没有可配置的数据表')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: '前往数据表' })).toHaveAttribute(
      'href',
      '/t/tenant/p/project/tables'
    )
  })
})
