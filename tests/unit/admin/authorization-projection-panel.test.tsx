// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AuthorizationProjectionPanel } from '../../../apps/admin/src/components/data-access/AuthorizationProjectionPanel.js'
import { api } from '@/lib/api'

vi.mock('@/lib/api', () => ({
  api: {
    getActiveAuthorizationProjection: vi.fn(),
    previewAuthorizationProjection: vi.fn(),
    applyAuthorizationProjection: vi.fn(),
    recoverAuthorizationProjection: vi.fn(),
  },
}))
vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast: vi.fn() }) }))

const operation = {
  operationId: 'dapo_1', projectId: 'proj_1', schemaName: 'dru_default_demo',
  status: 'recovery_required' as const,
  sourceDigest: 'a'.repeat(64), targetDigest: 'b'.repeat(64),
  dependencyDigest: 'c'.repeat(64), baselineRevisions: { orders: '1' },
  tables: [{
    table: 'orders', relationship: 'access_projection',
    ownerColumn: 'user_id', allowColumn: 'can_read',
  }],
}

describe('AuthorizationProjectionPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(api.getActiveAuthorizationProjection).mockResolvedValue({
      success: true,
      data: operation,
    })
  })

  it('requires the project alias before starting fail-closed recovery', async () => {
    vi.mocked(api.recoverAuthorizationProjection).mockResolvedValue({
      success: true,
      data: { ...operation, status: 'failed' },
    })
    render(<AuthorizationProjectionPanel
      projectId="proj_1"
      projectAlias="demo"
      dependencyInvalid={false}
      onChanged={vi.fn()}
    />)

    await waitFor(() => expect(screen.getByText('需要恢复')).toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: '恢复' }))
    const confirm = screen.getByRole('button', { name: '确认恢复' })
    expect(confirm).toBeDisabled()

    fireEvent.change(screen.getByLabelText('输入项目别名确认'), {
      target: { value: 'demo' },
    })
    expect(confirm).toBeEnabled()
    fireEvent.click(confirm)

    await waitFor(() => expect(api.recoverAuthorizationProjection).toHaveBeenCalledWith(
      'proj_1', 'dapo_1', { projectAlias: 'demo' }
    ))
  })

  it('offers fail-closed recovery for a completed batch with dependency drift', async () => {
    vi.mocked(api.getActiveAuthorizationProjection).mockResolvedValue({
      success: true,
      data: { ...operation, status: 'completed' },
    })
    render(<AuthorizationProjectionPanel
      projectId="proj_1"
      projectAlias="demo"
      dependencyInvalid
      onChanged={vi.fn()}
    />)

    await waitFor(() => expect(screen.getByText('授权依赖异常')).toBeInTheDocument())
    expect(screen.getByRole('button', { name: '安全关闭' })).toBeEnabled()
  })
})
