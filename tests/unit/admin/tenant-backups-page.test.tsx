// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ role: 'database_admin' }))
const apiMocks = vi.hoisted(() => ({
  listProjects: vi.fn(),
  getProjectAccess: vi.fn(),
  listBackups: vi.fn(),
  listAllBackups: vi.fn(),
  createBackup: vi.fn(),
  downloadBackup: vi.fn(),
  restoreBackup: vi.fn(),
  deleteBackup: vi.fn(),
}))

const capabilitiesByRole: Record<string, string[]> = {
  project_admin: ['project:read', 'backups:read', 'backups:create', 'backups:restore'],
  database_admin: ['project:read', 'backups:read', 'backups:create'],
  viewer: ['project:read', 'database:read'],
}

vi.mock('next/navigation', () => ({
  useParams: () => ({ tenantId: 'default' }),
}))

vi.mock('@/store', () => ({
  useAppStore: () => ({ currentTenant: { tenantId: 'default', alias: 'default', name: 'Default' } }),
}))

vi.mock('@/components/DashboardLayout', () => ({
  DashboardLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}))

vi.mock('@/lib/api', () => ({ api: apiMocks }))

import TenantBackupsPage from '../../../apps/admin/src/app/t/[tenantId]/backups/page'

describe('TenantBackupsPage authorization UI', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    state.role = 'database_admin'
    apiMocks.listProjects.mockResolvedValue({
      success: true,
      data: [{ projectId: 'proj_1', alias: 'project', name: 'Project' }],
    })
    apiMocks.getProjectAccess.mockImplementation(async () => ({
      success: true,
      data: {
        projectId: 'proj_1',
        role: state.role,
        capabilities: capabilitiesByRole[state.role],
        isWorkspaceOwner: false,
        isSuperAdmin: false,
      },
    }))
    apiMocks.listBackups.mockResolvedValue({
      success: true,
      data: [{
        backupId: 'backup_1', tenantId: 'default', projectId: 'proj_1',
        schemaName: 'dru_default_project', status: 'completed', sizeBytes: 100,
        createdAt: '2026-09-05T00:00:00.000Z',
      }],
    })
  })

  it('uses the tenant-scoped list and gives database admins create/download only', async () => {
    render(<TenantBackupsPage />)

    await screen.findByText('backup_1')
    expect(apiMocks.listBackups).toHaveBeenCalledWith('default')
    expect(apiMocks.listAllBackups).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: '下载' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '恢复' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '删除' })).not.toBeInTheDocument()

    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'proj_1' } })
    expect(await screen.findByRole('button', { name: '创建备份' })).toBeInTheDocument()
  })

  it('shows restore/delete only with backups:restore and hides all actions from viewers', async () => {
    state.role = 'project_admin'
    const view = render(<TenantBackupsPage />)
    await screen.findByText('backup_1')
    expect(screen.getByRole('button', { name: '恢复' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '删除' })).toBeInTheDocument()

    view.unmount()
    state.role = 'viewer'
    render(<TenantBackupsPage />)
    await screen.findByText('backup_1')
    await waitFor(() => expect(apiMocks.getProjectAccess).toHaveBeenCalled())
    expect(screen.queryByRole('button', { name: '下载' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '恢复' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '删除' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '创建备份' })).not.toBeInTheDocument()
  })
})
