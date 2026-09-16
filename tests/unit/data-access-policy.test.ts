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
const capabilities = {
  readableColumns: columns,
  insertableColumns: columns,
  updateableColumns: columns,
}
const generatedColumnCapabilities = {
  readableColumns: ['id', 'owner_id', 'title', 'observed_at'],
  insertableColumns: ['id', 'owner_id', 'title'],
  updateableColumns: ['id', 'owner_id', 'title'],
}

function policy(overrides: Partial<TableDataAccessInput> = {}): TableDataAccessInput {
  return {
    policyVersion: overrides.policyVersion ?? 1,
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

const projectionConstraint = {
  type: 'authorization_projection' as const,
  relationshipPath: ['session_access_projection'],
  actorColumn: 'user_id',
  allowColumn: 'can_read_basic',
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
      { roles, capabilities }
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
      { roles, capabilities }
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
      { roles, capabilities }
    )

    expect(result).toEqual([{
      role: roles.anonymous,
      operation: 'select',
      permission: { columns, filter: {}, allow_aggregations: false },
    }])
  })

  it('keeps generated columns readable while excluding them from writes', () => {
    const result = materializeTableDataAccessPolicy(
      policy({
        authenticated: {
          select: 'all',
          insert: 'all',
          update: 'all',
          delete: 'none',
          ownerColumn: null,
        },
        anonymous: { select: true },
      }),
      { roles, capabilities: generatedColumnCapabilities }
    )

    expect(result.find((item) => item.operation === 'select')?.permission.columns)
      .toEqual(generatedColumnCapabilities.readableColumns)
    expect(result.find((item) => item.operation === 'insert')?.permission.columns)
      .toEqual(generatedColumnCapabilities.insertableColumns)
    expect(result.find((item) => item.operation === 'update')?.permission.columns)
      .toEqual(generatedColumnCapabilities.updateableColumns)
    expect(result.find((item) => item.role === roles.anonymous)?.permission.columns)
      .toEqual(generatedColumnCapabilities.readableColumns)
  })

  it('rejects owner insert when the owner column cannot be preset', () => {
    expect(() => materializeTableDataAccessPolicy(
      policy({
        authenticated: {
          select: 'owner',
          insert: 'owner',
          update: 'none',
          delete: 'none',
          ownerColumn: 'observed_at',
        },
      }),
      { roles, capabilities: generatedColumnCapabilities }
    )).toThrow('Owner column is not insertable')
  })

  it('emits no permissions for a closed policy', () => {
    expect(materializeTableDataAccessPolicy(policy(), { roles, capabilities })).toEqual([])
  })

  it('rejects owner mode without a valid owner column', () => {
    expect(() => validateTableDataAccessInput(
      policy({ authenticated: { select: 'owner', ownerColumn: null } }),
      capabilities
    )).toThrow('Owner column is required')

    expect(() => validateTableDataAccessInput(
      policy({ authenticated: { select: 'owner', ownerColumn: 'missing_id' } }),
      capabilities
    )).toThrow('Owner column does not exist')
  })

  it('rejects unsupported access modes at runtime', () => {
    expect(() => validateTableDataAccessInput(
      policy({ authenticated: { select: 'custom' as never } }),
      capabilities
    )).toThrow('Unsupported access mode')
  })

  it('materializes a v2 owner projection select as a fixed conjunction', () => {
    const result = materializeTableDataAccessPolicy(policy({
      policyVersion: 2,
      authenticated: {
        select: 'owner',
        insert: 'none',
        update: 'none',
        delete: 'none',
        ownerColumn: 'owner_id',
        selectConstraint: projectionConstraint,
      },
    }), { roles, capabilities })

    expect(result).toEqual([{
      role: roles.authenticated,
      operation: 'select',
      permission: {
        columns,
        filter: {
          _and: [
            { owner_id: { _eq: 'X-Hasura-User-Id' } },
            {
              session_access_projection: {
                user_id: { _eq: 'X-Hasura-User-Id' },
                can_read_basic: { _eq: true },
              },
            },
          ],
        },
        allow_aggregations: false,
      },
    }])
  })

  it('rejects projection constraints outside the v2 owner-select contract', () => {
    expect(() => validateTableDataAccessInput(policy({
      authenticated: {
        select: 'owner', insert: 'none', update: 'none', delete: 'none',
        ownerColumn: 'owner_id', selectConstraint: projectionConstraint,
      },
    }), capabilities)).toThrow(/policy version 2/i)

    expect(() => validateTableDataAccessInput(policy({
      policyVersion: 2,
      authenticated: {
        select: 'all', insert: 'none', update: 'none', delete: 'none',
        ownerColumn: null, selectConstraint: projectionConstraint,
      },
    }), capabilities)).toThrow(/owner select/i)
  })
})
