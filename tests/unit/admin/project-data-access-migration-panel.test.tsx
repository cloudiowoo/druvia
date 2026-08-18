// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { ProjectDataAccessMigration } from '../../../apps/admin/src/components/data-access/ProjectDataAccessMigration.js'
import type { ProjectDataAccessMigrationReport } from '../../../apps/admin/src/lib/project-data-access-migration.js'
import { api } from '@/lib/api'

vi.mock('@/lib/api', () => ({
  api: {
    getDataAccessMigration: vi.fn(),
    previewDataAccessMigration: vi.fn(), applyDataAccessMigration: vi.fn(), recoverDataAccessMigration: vi.fn(),
    previewDataAccessMigrationRollback: vi.fn(), rollbackDataAccessMigration: vi.fn(),
  },
}))
vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast: vi.fn() }) }))

const report: ProjectDataAccessMigrationReport = {
  migrationId: 'mig_1', projectId: 'proj_1', status: 'preview_ready', phase: 'preview',
  sourceDigest: 'a'.repeat(64), rollbackPreviewDigest: null, requiredRecoveryDigest: null,
  recoveryTarget: null, appliedAt: null, canApply: true, canRollback: false,
  summary: { totalTables: 1, migratedTables: 1, preservedScopedTables: 0, inferredOperationCount: 1, blockerCount: 0, destructiveChangeCount: 1 },
  blockers: [],
  destructiveChanges: [{ tableName: 'orders', actor: 'anonymous', operation: 'insert', reason: 'anonymous_write_removed' }],
  tables: [{
    tableName: 'orders', targetSource: 'legacy_default',
    inferredOperations: [{ actor: 'authenticated', operation: 'select' }],
    authenticated: 'read_only', anonymousRead: false, removesAnonymousWrite: true,
    removesAuthenticatedAggregations: false, blocked: false,
  }], error: null,
}

describe('ProjectDataAccessMigration', () => {
  it('renders a compatibility upgrade command without implementation vocabulary', () => {
    render(<ProjectDataAccessMigration
      tenantId="tenant" projectId="proj_1" projectAlias="demo" runtimeMode="compatibility"
      migration={null} loading={false} error={null} onRefresh={vi.fn()} onChanged={vi.fn()}
    />)
    expect(screen.getByRole('button', { name: '生成迁移预检' })).toBeInTheDocument()
    expect(document.body.textContent).not.toMatch(/Hasura|metadata|druvia_v1/)
  })

  it('requires independent review, risk, and alias confirmations before apply', () => {
    render(<ProjectDataAccessMigration
      tenantId="tenant" projectId="proj_1" projectAlias="demo" runtimeMode="compatibility"
      migration={report} loading={false} error={null} onRefresh={vi.fn()} onChanged={vi.fn()}
    />)
    fireEvent.click(screen.getByRole('button', { name: '查看迁移预检' }))
    const apply = screen.getByRole('button', { name: '开始升级' })
    expect(apply).toBeDisabled()
    fireEvent.click(screen.getByLabelText('我已检查自动迁移的访问规则'))
    fireEvent.click(screen.getByLabelText('我已了解将移除高风险旧能力'))
    fireEvent.change(screen.getByLabelText('输入项目别名确认'), { target: { value: 'demo' } })
    expect(apply).toBeEnabled()
    expect(screen.getByText('orders')).toBeInTheDocument()
  })

  it('shows persisted progress and the correct recovery target', () => {
    const { rerender } = render(<ProjectDataAccessMigration
      tenantId="tenant" projectId="proj_1" projectAlias="demo" runtimeMode="compatibility"
      migration={{ ...report, status: 'applying', phase: 'verify_scoped_http', canApply: false }}
      loading={false} error={null} onRefresh={vi.fn()} onChanged={vi.fn()}
    />)
    expect(screen.getByText('验证访问')).toBeInTheDocument()

    rerender(<ProjectDataAccessMigration
      tenantId="tenant" projectId="proj_1" projectAlias="demo" runtimeMode="compatibility"
      migration={{ ...report, status: 'failed', phase: 'restore_permissions', canApply: false, recoveryTarget: 'pre_migration', requiredRecoveryDigest: 'c'.repeat(64) }}
      loading={false} error={null} onRefresh={vi.fn()} onChanged={vi.fn()}
    />)
    expect(screen.getByRole('button', { name: '恢复迁移前状态' })).toBeInTheDocument()
  })

  it('starts progress immediately and reconciles a disconnected apply request', async () => {
    const applying = { ...report, status: 'applying' as const, phase: 'verify_scoped_http' as const, canApply: false }
    vi.mocked(api.applyDataAccessMigration).mockResolvedValueOnce({
      success: false,
      error: { code: 'NETWORK_ERROR', message: '网络连接失败' },
    })
    vi.mocked(api.getDataAccessMigration).mockResolvedValueOnce({ success: true, data: applying })
    const onChanged = vi.fn()
    render(<ProjectDataAccessMigration
      tenantId="tenant" projectId="proj_1" projectAlias="demo" runtimeMode="compatibility"
      migration={report} loading={false} error={null} onRefresh={vi.fn()} onChanged={onChanged}
    />)
    fireEvent.click(screen.getByRole('button', { name: '查看迁移预检' }))
    fireEvent.click(screen.getByLabelText('我已检查自动迁移的访问规则'))
    fireEvent.click(screen.getByLabelText('我已了解将移除高风险旧能力'))
    fireEvent.change(screen.getByLabelText('输入项目别名确认'), { target: { value: 'demo' } })
    fireEvent.click(screen.getByRole('button', { name: '开始升级' }))

    expect(onChanged).toHaveBeenCalledWith(expect.objectContaining({
      status: 'applying', phase: 'snapshot_check', canApply: false,
    }))
    await waitFor(() => expect(api.getDataAccessMigration).toHaveBeenCalledWith('proj_1'))
    expect(onChanged).toHaveBeenLastCalledWith(applying)
  })

  it.each(['failed', 'rolled_back', 'recovered'] as const)(
    'allows a new preview after the terminal %s state',
    (status) => {
      render(<ProjectDataAccessMigration
        tenantId="tenant" projectId="proj_1" projectAlias="demo" runtimeMode="compatibility"
        migration={{ ...report, status, canApply: false, error: status === 'failed'
          ? { code: 'DATA_ACCESS_MIGRATION_APPLY_FAILED', message: '已恢复迁移前状态' }
          : null }}
        loading={false} error={null} onRefresh={vi.fn()} onChanged={vi.fn()}
      />)

      expect(screen.getByRole('button', { name: '重新生成迁移预检' })).toBeInTheDocument()
    }
  )

  it('clears prior confirmations when a different preview becomes current', async () => {
    const props = {
      tenantId: 'tenant', projectId: 'proj_1', projectAlias: 'demo', runtimeMode: 'compatibility' as const,
      loading: false, error: null, onRefresh: vi.fn(), onChanged: vi.fn(),
    }
    const { rerender } = render(<ProjectDataAccessMigration {...props} migration={report} />)
    fireEvent.click(screen.getByRole('button', { name: '查看迁移预检' }))
    fireEvent.click(screen.getByLabelText('我已检查自动迁移的访问规则'))
    fireEvent.click(screen.getByLabelText('我已了解将移除高风险旧能力'))
    fireEvent.change(screen.getByLabelText('输入项目别名确认'), { target: { value: 'demo' } })
    expect(screen.getByRole('button', { name: '开始升级' })).toBeEnabled()

    rerender(<ProjectDataAccessMigration {...props} migration={{ ...report, migrationId: 'mig_2' }} />)

    await waitFor(() => expect(screen.getByRole('button', { name: '开始升级' })).toBeDisabled())
    expect(screen.getByLabelText('我已检查自动迁移的访问规则')).not.toBeChecked()
    expect(screen.getByLabelText('我已了解将移除高风险旧能力')).not.toBeChecked()
    expect(screen.getByLabelText('输入项目别名确认')).toHaveValue('')
  })
})
