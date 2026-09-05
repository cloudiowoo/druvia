// @vitest-environment jsdom

import { render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ capabilities: [] as string[] }))
const apiMocks = vi.hoisted(() => ({
  getProjectDbInfo: vi.fn(),
  createProjectDbUser: vi.fn(),
  resetProjectDbPassword: vi.fn(),
  deleteProjectDbUser: vi.fn(),
}))

vi.mock('next/navigation', () => ({
  useParams: () => ({ tenantId: 'default', projectId: 'proj_1' }),
}))

vi.mock('next/dynamic', () => ({
  default: () => function DynamicStub() { return <div>API tool</div> },
}))

vi.mock('@/store', () => ({
  useAppStore: () => ({
    currentTenant: { tenantId: 'default', name: 'Default' },
    currentProject: { projectId: 'proj_1', name: 'Project', schemaName: 'dru_default_project' },
    currentEnv: null,
  }),
}))

vi.mock('@/hooks/use-project-access', () => ({
  useProjectAccess: () => ({
    can: (capability: string) => state.capabilities.includes(capability),
  }),
}))

vi.mock('@/components/DashboardLayout', () => ({
  DashboardLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}))

vi.mock('@/lib/api', () => ({ api: apiMocks }))
vi.mock('@/lib/public-env', () => ({ getPublicApiBaseUrl: () => 'http://localhost:3001' }))

import ProjectApiPage from '../../../apps/admin/src/app/t/[tenantId]/p/[projectId]/api/page'

describe('ProjectApiPage authorization UI', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    state.capabilities = ['database:read']
    apiMocks.getProjectDbInfo.mockResolvedValue({
      success: true,
      data: { hasCredentials: false },
    })
  })

  it('keeps API documentation available without requesting database credentials', async () => {
    render(<ProjectApiPage />)

    expect(screen.getByRole('tab', { name: '文档' })).toBeInTheDocument()
    expect(screen.queryByText('数据库直连')).not.toBeInTheDocument()
    await waitFor(() => expect(apiMocks.getProjectDbInfo).not.toHaveBeenCalled())
  })

  it('loads and renders database connection controls only with database:credentials', async () => {
    state.capabilities = ['database:read', 'database:credentials']
    render(<ProjectApiPage />)

    await waitFor(() => expect(apiMocks.getProjectDbInfo).toHaveBeenCalledWith('proj_1'))
    expect(screen.getByText('数据库直连')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '创建数据库用户' })).toBeInTheDocument()
  })
})
