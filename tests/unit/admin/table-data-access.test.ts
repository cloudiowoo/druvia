import { describe, expect, it } from 'vitest'
import {
  getAccessModeLabel,
  getTableDataAccessValidationError,
  hasUnrestrictedWriteAccess,
  isDefaultTableDataScope,
  requiresOwnerColumn,
} from '../../../apps/admin/src/lib/table-data-access.js'
import type { TableDataAccessPolicy } from '../../../apps/admin/src/lib/table-data-access.js'

function policy(): TableDataAccessPolicy {
  return {
    authenticated: {
      select: 'none',
      insert: 'none',
      update: 'none',
      delete: 'none',
      ownerColumn: null,
    },
    anonymous: { select: false },
  }
}

describe('table data access presentation', () => {
  it('uses business-facing access mode labels', () => {
    expect(getAccessModeLabel('none')).toBe('关闭')
    expect(getAccessModeLabel('all')).toBe('全部记录')
    expect(getAccessModeLabel('owner')).toBe('仅自己的记录')
  })

  it('detects unrestricted authenticated writes', () => {
    const value = policy()
    value.authenticated.insert = 'all'
    expect(hasUnrestrictedWriteAccess(value)).toBe(true)

    value.authenticated.insert = 'owner'
    expect(hasUnrestrictedWriteAccess(value)).toBe(false)
  })

  it('requires an owner column when any operation uses owner mode', () => {
    const value = policy()
    value.authenticated.select = 'owner'

    expect(requiresOwnerColumn(value)).toBe(true)
    expect(getTableDataAccessValidationError(value, ['id', 'owner_id']))
      .toBe('请选择所有者字段')

    value.authenticated.ownerColumn = 'missing_id'
    expect(getTableDataAccessValidationError(value, ['id', 'owner_id']))
      .toBe('所有者字段不存在')

    value.authenticated.ownerColumn = 'owner_id'
    expect(getTableDataAccessValidationError(value, ['id', 'owner_id'])).toBeNull()
  })

  it('keeps anonymous access select-only in the public contract', () => {
    const value = policy()
    expect(Object.keys(value.anonymous)).toEqual(['select'])
  })

  it('enables editing only when the selected schema is the project default', () => {
    expect(isDefaultTableDataScope('dru_proj_123', 'dru_proj_123')).toBe(true)
    expect(isDefaultTableDataScope('dru_proj_123', 'dru_proj_123_dev')).toBe(false)
    expect(isDefaultTableDataScope(null, 'dru_proj_123')).toBe(false)
  })
})
