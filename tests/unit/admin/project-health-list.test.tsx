// @vitest-environment jsdom

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
    expect(screen.getAllByText('可用').length).toBeGreaterThan(0)
    expect(screen.getByText('已配置')).toBeInTheDocument()
    expect(screen.getByText('未覆盖')).toBeInTheDocument()
    expect(screen.getByText(/最近信号/i)).toBeInTheDocument()
    expect(screen.getByText(/最近备份/i)).toBeInTheDocument()
    expect(screen.getByText('缺少备份')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /进入项目/i })).toHaveAttribute('href', '/t/default/p/proj_123')
  })
})
