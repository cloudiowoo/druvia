// @vitest-environment jsdom

import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { TableDataAccessEditor } from '../../../apps/admin/src/components/tables/TableDataAccessPanel.js'
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
})
