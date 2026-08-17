import { describe, expect, it } from 'vitest'
import {
  materializeTableDataAccessPolicy,
  validateTableDataAccessInput,
} from '../../apps/api/src/modules/data-access/data-access-policy.js'
import type { TableDataAccessInput } from '../../apps/api/src/modules/data-access/data-access.types.js'

const roles = {
  authenticated: 'druvia_v1_s_scope_user',
  anonymous: 'druvia_v1_s_scope_anon',
}

const columns = ['id', 'owner_id', 'title', 'created_at']

function policy(overrides: Partial<TableDataAccessInput> = {}): TableDataAccessInput {
  return {
    authenticated: {
      select: 'none',
      insert: 'none',
      update: 'none',
      delete: 'none',
      ownerColumn: null,
      ...overrides.authenticated,
    },
    anonymous: {
      select: false,
      ...overrides.anonymous,
    },
  }
}

describe('table data access policy materializer', () => {
  it('materializes owner-scoped authenticated CRUD permissions', () => {
    const result = materializeTableDataAccessPolicy(
      policy({
        authenticated: {
          select: 'owner',
          insert: 'owner',
          update: 'owner',
          delete: 'owner',
          ownerColumn: 'owner_id',
        },
      }),
      { roles, columns }
    )

    const ownerFilter = { owner_id: { _eq: 'X-Hasura-User-Id' } }
    expect(result).toEqual([
      {
        role: roles.authenticated,
        operation: 'select',
        permission: { columns, filter: ownerFilter, allow_aggregations: false },
      },
      {
        role: roles.authenticated,
        operation: 'insert',
        permission: {
          columns: ['id', 'title', 'created_at'],
          check: ownerFilter,
          set: { owner_id: 'X-Hasura-User-Id' },
        },
      },
      {
        role: roles.authenticated,
        operation: 'update',
        permission: {
          columns: ['id', 'title', 'created_at'],
          filter: ownerFilter,
          check: ownerFilter,
        },
      },
      {
        role: roles.authenticated,
        operation: 'delete',
        permission: { filter: ownerFilter },
      },
    ])
  })

  it('materializes explicit all-row access with empty row rules', () => {
    const result = materializeTableDataAccessPolicy(
      policy({
        authenticated: {
          select: 'all',
          insert: 'all',
          update: 'all',
          delete: 'all',
          ownerColumn: null,
        },
      }),
      { roles, columns }
    )

    expect(result.map((item) => item.operation)).toEqual([
      'select',
      'insert',
      'update',
      'delete',
    ])
    expect(result.find((item) => item.operation === 'select')?.permission).toEqual({
      columns,
      filter: {},
      allow_aggregations: false,
    })
    expect(result.find((item) => item.operation === 'insert')?.permission).toEqual({
      columns,
      check: {},
    })
  })

  it('materializes anonymous read only and never anonymous writes', () => {
    const result = materializeTableDataAccessPolicy(
      policy({ anonymous: { select: true } }),
      { roles, columns }
    )

    expect(result).toEqual([{
      role: roles.anonymous,
      operation: 'select',
      permission: { columns, filter: {}, allow_aggregations: false },
    }])
  })

  it('emits no permissions for a closed policy', () => {
    expect(materializeTableDataAccessPolicy(policy(), { roles, columns })).toEqual([])
  })

  it('rejects owner mode without a valid owner column', () => {
    expect(() => validateTableDataAccessInput(
      policy({ authenticated: { select: 'owner', ownerColumn: null } }),
      columns
    )).toThrow('Owner column is required')

    expect(() => validateTableDataAccessInput(
      policy({ authenticated: { select: 'owner', ownerColumn: 'missing_id' } }),
      columns
    )).toThrow('Owner column does not exist')
  })

  it('rejects unsupported access modes at runtime', () => {
    expect(() => validateTableDataAccessInput(
      policy({ authenticated: { select: 'custom' as never } }),
      columns
    )).toThrow('Unsupported access mode')
  })
})
