// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const apiMock = vi.hoisted(() => ({
  getTableDataAccess: vi.fn(),
  updateTableDataAccess: vi.fn(),
  previewTableDataAccessReconcile: vi.fn(),
  applyTableDataAccessReconcile: vi.fn(),
  recoverTableDataAccessOperation: vi.fn(),
}))

vi.mock('@/lib/api', () => ({ api: apiMock }))
vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast: vi.fn() }) }))

import {
  TableDataAccessEditor,
  TableDataAccessPanel,
} from '../../../apps/admin/src/components/tables/TableDataAccessPanel.js'
import { cloneTableDataAccessPolicy } from '../../../apps/admin/src/lib/table-data-access.js'
import type {
  TableDataAccessPolicy,
  TableDataAccessState,
} from '../../../apps/admin/src/lib/table-data-access.js'

function state(overrides: Partial<TableDataAccessState> = {}): TableDataAccessState {
  return {
    projectId: 'proj_123',
    schemaName: 'dru_proj_123',
    tableName: 'orders',
    columns: ['id', 'owner_id', 'title'],
    managedState: 'managed',
    legacyRoles: [],
    baselineRevision: null,
    capabilities: {
      readable: ['id', 'owner_id', 'title'],
      insertable: ['id', 'owner_id', 'title'],
      updateable: ['id', 'owner_id', 'title'],
    },
    effective: {
      authenticated: { select: [], insert: [], update: [] },
      anonymous: { select: [] },
    },
    drift: null,
    activeOperation: null,
    policy: {
      authenticated: {
        select: 'none',
        insert: 'none',
        update: 'none',
        delete: 'none',
        ownerColumn: null,
      },
      anonymous: { select: false },
    },
    ...overrides,
  }
}

describe('TableDataAccessEditor', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('renders authenticated CRUD and anonymous read without anonymous writes', () => {
    const value = state()
    render(
      <TableDataAccessEditor
        state={value}
        policy={value.policy}
        saving={false}
        onPolicyChange={vi.fn()}
        onSave={vi.fn()}
      />
    )

    expect(screen.getByText('认证用户')).toBeInTheDocument()
    expect(screen.getByText('查询')).toBeInTheDocument()
    expect(screen.getByText('新增')).toBeInTheDocument()
    expect(screen.getByText('修改')).toBeInTheDocument()
    expect(screen.getByText('删除')).toBeInTheDocument()
    expect(screen.getByText('匿名读取')).toBeInTheDocument()
    expect(screen.queryByText('匿名写入')).not.toBeInTheDocument()
  })

  it('shows owner-field selection and allows a valid managed policy to save', () => {
    const value = state()
    const policy: TableDataAccessPolicy = {
      ...value.policy,
      authenticated: {
        ...value.policy.authenticated,
        select: 'owner',
        ownerColumn: 'owner_id',
      },
    }
    render(
      <TableDataAccessEditor
        state={value}
        policy={policy}
        saving={false}
        onPolicyChange={vi.fn()}
        onSave={vi.fn()}
      />
    )

    expect(screen.getByText('所有者字段')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '保存数据访问' })).toBeEnabled()
  })

  it('disables save for missing owner field or custom managed metadata', () => {
    const value = state()
    const invalidPolicy: TableDataAccessPolicy = {
      ...value.policy,
      authenticated: { ...value.policy.authenticated, select: 'owner' },
    }
    const { rerender } = render(
      <TableDataAccessEditor
        state={value}
        policy={invalidPolicy}
        saving={false}
        onPolicyChange={vi.fn()}
        onSave={vi.fn()}
      />
    )
    expect(screen.getByRole('button', { name: '保存数据访问' })).toBeDisabled()

    const customState = state({ managedState: 'custom' })
    rerender(
      <TableDataAccessEditor
        state={customState}
        policy={customState.policy}
        saving={false}
        onPolicyChange={vi.fn()}
        onSave={vi.fn()}
      />
    )
    expect(screen.getByText('检测到自定义访问规则')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '保存数据访问' })).toBeDisabled()
  })

  it('warns when authenticated writes can affect all records', () => {
    const value = state()
    const policy: TableDataAccessPolicy = {
      ...value.policy,
      authenticated: { ...value.policy.authenticated, update: 'all' },
    }
    render(
      <TableDataAccessEditor
        state={value}
        policy={policy}
        saving={false}
        onPolicyChange={vi.fn()}
        onSave={vi.fn()}
      />
    )

    expect(screen.getByText('存在不受记录范围限制的写入权限')).toBeInTheDocument()
  })

  it('shows anonymous column grants when anonymous read is enabled', () => {
    const value = state()
    const policy: TableDataAccessPolicy = {
      ...value.policy,
      authenticated: { ...value.policy.authenticated, insert: 'all' },
      anonymous: { select: true },
    }
    render(
      <TableDataAccessEditor
        state={value}
        policy={policy}
        grants={value.effective}
        saving={false}
        onPolicyChange={vi.fn()}
        onGrantsChange={vi.fn()}
        onSave={vi.fn()}
      />
    )

    expect(screen.getByText('匿名查询字段')).toBeInTheDocument()
    expect(screen.getAllByText('新增字段')).toHaveLength(1)
  })

  it.each([
    ['adoption_required', '现有规则需要接管'],
    ['refresh_required', '数据表结构已变化'],
    ['recovery_required', '访问规则需要恢复'],
  ] as const)('renders %s as a read-only action state', (managedState, message) => {
    const value = state({ managedState })
    render(
      <TableDataAccessEditor
        state={value}
        policy={value.policy}
        saving={false}
        onPolicyChange={vi.fn()}
        onSave={vi.fn()}
      />
    )
    expect(screen.getByText(message)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '保存数据访问' })).toBeDisabled()
  })
})

describe('TableDataAccessPanel', () => {
  it('omits projection-only fields when cloning a v1 policy', () => {
    const cloned = cloneTableDataAccessPolicy({
      policyVersion: 1,
      authenticated: {
        select: 'owner', insert: 'none', update: 'none', delete: 'none',
        ownerColumn: 'user_id', selectConstraint: undefined,
      },
      anonymous: { select: false },
    })
    expect(Object.hasOwn(cloned.authenticated, 'selectConstraint')).toBe(false)
  })
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('offers recovery for an expired operation reported as recovery-required', async () => {
    const value = state({
      managedState: 'recovery_required',
      activeOperation: {
        operationId: 'operation_123',
        tableName: 'orders',
        kind: 'policy_update',
        status: 'applying',
        phase: 'apply_permissions',
        sourceDigest: 'a'.repeat(64),
        targetDigest: 'b'.repeat(64),
        writeDeadlineAt: '2026-09-07T00:00:00.000Z',
        startedAt: '2026-09-06T23:59:00.000Z',
        error: null,
      },
    })
    apiMock.getTableDataAccess.mockResolvedValueOnce({ success: true, data: value })

    render(<TableDataAccessPanel projectId="proj_123" tableName="orders" />)

    expect(await screen.findByRole('button', { name: '恢复访问规则' })).toBeEnabled()
    expect(screen.queryByText('正在应用访问规则')).not.toBeInTheDocument()
  })

  it('reuses the same operation ID after an unknown save result', async () => {
    const value = state({ baselineRevision: 1 })
    const committed = state({ baselineRevision: 2 })
    apiMock.getTableDataAccess
      .mockResolvedValueOnce({ success: true, data: value })
      .mockResolvedValue({ success: true, data: committed })
    apiMock.updateTableDataAccess
      .mockResolvedValueOnce({
        success: false,
        error: { code: 'NETWORK_ERROR', message: '网络连接失败' },
      })
      .mockResolvedValueOnce({ success: true, data: value })
    render(<TableDataAccessPanel projectId="proj_123" tableName="orders" />)
    const save = await screen.findByRole('button', { name: '保存数据访问' })

    fireEvent.click(save)
    await waitFor(() => expect(apiMock.updateTableDataAccess).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(save).toBeEnabled())
    fireEvent.click(save)
    await waitFor(() => expect(apiMock.updateTableDataAccess).toHaveBeenCalledTimes(2))

    const first = apiMock.updateTableDataAccess.mock.calls[0]?.[2]
    const second = apiMock.updateTableDataAccess.mock.calls[1]?.[2]
    expect(second).toEqual(first)
  })

  it('uses a new operation ID after a definitive upstream rejection', async () => {
    const value = state()
    apiMock.getTableDataAccess.mockResolvedValue({ success: true, data: value })
    apiMock.updateTableDataAccess
      .mockResolvedValueOnce({
        success: false,
        error: { code: 'DATA_ACCESS_UPSTREAM_ERROR', message: '请求被拒绝' },
      })
      .mockResolvedValueOnce({ success: true, data: value })
    render(<TableDataAccessPanel projectId="proj_123" tableName="orders" />)
    const save = await screen.findByRole('button', { name: '保存数据访问' })

    fireEvent.click(save)
    await waitFor(() => expect(apiMock.updateTableDataAccess).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(save).toBeEnabled())
    fireEvent.click(save)
    await waitFor(() => expect(apiMock.updateTableDataAccess).toHaveBeenCalledTimes(2))

    const first = apiMock.updateTableDataAccess.mock.calls[0]?.[2]
    const second = apiMock.updateTableDataAccess.mock.calls[1]?.[2]
    expect(second.operationId).not.toBe(first.operationId)
  })

  it('reloads the persisted state when recovery is still required', async () => {
    const value = state({
      managedState: 'recovery_required',
      activeOperation: {
        operationId: 'operation_123',
        tableName: 'orders',
        kind: 'policy_update',
        status: 'recovery_required',
        phase: 'verify_source',
        sourceDigest: 'a'.repeat(64),
        targetDigest: 'b'.repeat(64),
        writeDeadlineAt: '2026-09-07T00:00:00.000Z',
        startedAt: '2026-09-06T23:59:00.000Z',
        error: null,
      },
    })
    apiMock.getTableDataAccess.mockResolvedValue({ success: true, data: value })
    apiMock.recoverTableDataAccessOperation.mockResolvedValue({
      success: false,
      error: {
        code: 'DATA_ACCESS_RECONCILE_RECOVERY_REQUIRED',
        message: 'Unable to verify restored permissions',
      },
    })
    render(<TableDataAccessPanel projectId="proj_123" tableName="orders" />)

    fireEvent.click(await screen.findByRole('button', { name: '恢复访问规则' }))
    fireEvent.change(await screen.findByRole('textbox', { name: '项目别名确认' }), {
      target: { value: 'pitchetch' },
    })
    fireEvent.click(screen.getByRole('button', { name: '确认' }))

    await waitFor(() => expect(apiMock.recoverTableDataAccessOperation).toHaveBeenCalledOnce())
    await waitFor(() => expect(apiMock.getTableDataAccess).toHaveBeenCalledTimes(2))
    expect(screen.getByRole('dialog')).toBeInTheDocument()
  })

  it('confirms an explicit safe policy when reconciliation loses the owner column', async () => {
    const value = state({
      columns: ['id', 'title'],
      managedState: 'refresh_required',
      baselineRevision: 1,
      capabilities: {
        readable: ['id', 'title'], insertable: ['id', 'title'], updateable: ['id', 'title'],
      },
      policy: {
        authenticated: {
          select: 'owner', insert: 'owner', update: 'none', delete: 'none', ownerColumn: 'owner_id',
        },
        anonymous: { select: false },
      },
      drift: {
        addedReadable: [], addedInsertable: [], addedUpdateable: [],
        removedOrRestricted: ['owner_id'],
      },
    })
    const safePolicy: TableDataAccessPolicy = {
      policyVersion: 1,
      authenticated: {
        select: 'none', insert: 'none', update: 'none', delete: 'none', ownerColumn: null,
      },
      anonymous: { select: false },
    }
    const preview = {
      operation: {
        operationId: 'operation_reconcile', tableName: 'orders', kind: 'reconcile' as const,
        status: 'preview_ready' as const, phase: 'preview', sourceDigest: 'a'.repeat(64),
        targetDigest: 'b'.repeat(64), writeDeadlineAt: null, startedAt: null, error: null,
      },
      projectId: value.projectId,
      schemaName: value.schemaName,
      tableName: value.tableName,
      baselineRevision: 1,
      policy: safePolicy,
      columnGrants: value.effective,
      capabilities: value.capabilities,
      drift: value.drift,
    }
    apiMock.getTableDataAccess.mockResolvedValue({ success: true, data: value })
    apiMock.previewTableDataAccessReconcile.mockResolvedValue({ success: true, data: preview })
    apiMock.applyTableDataAccessReconcile.mockResolvedValue({
      success: true, data: state({ baselineRevision: 2 }),
    })
    render(<TableDataAccessPanel projectId="proj_123" tableName="orders" />)

    fireEvent.click(await screen.findByRole('button', { name: '刷新字段权限' }))
    expect(await screen.findByRole('combobox', { name: '刷新查询范围' })).toHaveTextContent('关闭')
    fireEvent.change(screen.getByRole('textbox', { name: '项目别名确认' }), {
      target: { value: 'pitchetch' },
    })
    fireEvent.click(screen.getByRole('button', { name: '确认' }))

    await waitFor(() => expect(apiMock.previewTableDataAccessReconcile).toHaveBeenCalledTimes(2))
    expect(apiMock.previewTableDataAccessReconcile).toHaveBeenLastCalledWith(
      'proj_123', 'orders', { policy: safePolicy, columnGrants: value.effective }
    )
    await waitFor(() => expect(apiMock.applyTableDataAccessReconcile).toHaveBeenCalledWith(
      'proj_123', 'orders', expect.objectContaining({ policy: safePolicy })
    ))
  })
})
