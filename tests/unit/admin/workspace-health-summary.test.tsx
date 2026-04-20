// @vitest-environment jsdom
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
