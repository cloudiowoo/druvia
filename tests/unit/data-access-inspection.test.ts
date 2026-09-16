import { describe, expect, it } from 'vitest'
import { inspectTableDataAccessMetadata } from '../../apps/api/src/modules/data-access/data-access-inspection.js'

const columns = ['id', 'owner_id', 'title']
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
const roles = {
  authenticated: 'druvia_v1_s_scope_user',
  anonymous: 'druvia_v1_s_scope_anon',
}

describe('data access metadata inspection', () => {
  it('parses supported actor permissions independently', () => {
    const result = inspectTableDataAccessMetadata({
      table: { schema: 'dru_test', name: 'orders' },
      select_permissions: [
        {
          role: roles.authenticated,
          permission: { columns, filter: {} },
        },
        {
          role: roles.anonymous,
          permission: { columns, filter: {} },
        },
      ],
      insert_permissions: [{
        role: roles.authenticated,
        permission: {
          columns: ['id', 'title'],
          check: { owner_id: { _eq: 'X-Hasura-User-Id' } },
          set: { owner_id: 'X-Hasura-User-Id' },
        },
      }],
    }, roles, capabilities)

    expect(result.authenticatedState).toBe('managed')
    expect(result.anonymousState).toBe('managed')
    expect(result.policy).toEqual({
      policyVersion: 1,
      authenticated: {
        select: 'all',
        insert: 'owner',
        update: 'none',
        delete: 'none',
        ownerColumn: 'owner_id',
      },
      anonymous: { select: true },
    })
  })

  it('keeps Hasura wildcard columns outside managed provenance', () => {
    const result = inspectTableDataAccessMetadata({
      table: { schema: 'dru_test', name: 'orders' },
      select_permissions: [
        {
          role: roles.authenticated,
          permission: {
            columns: '*',
            filter: { owner_id: { _eq: 'X-Hasura-User-Id' } },
          },
        },
        {
          role: roles.anonymous,
          permission: { columns: '*', filter: {} },
        },
      ],
    }, roles, capabilities)

    expect(result.authenticatedState).toBe('custom')
    expect(result.anonymousState).toBe('custom')
    expect(result.containsWildcard).toBe(true)
  })

  it('recognizes generated-excluded write permissions as managed', () => {
    const result = inspectTableDataAccessMetadata({
      table: { schema: 'dru_test', name: 'observations' },
      select_permissions: [{
        role: roles.authenticated,
        permission: { columns: generatedColumnCapabilities.readableColumns, filter: {} },
      }],
      insert_permissions: [{
        role: roles.authenticated,
        permission: { columns: generatedColumnCapabilities.insertableColumns, check: {} },
      }],
      update_permissions: [{
        role: roles.authenticated,
        permission: {
          columns: generatedColumnCapabilities.updateableColumns,
          filter: {},
          check: null,
        },
      }],
    }, roles, generatedColumnCapabilities)

    expect(result.authenticatedState).toBe('managed')
    expect(result.policy.authenticated).toMatchObject({
      select: 'all',
      insert: 'all',
      update: 'all',
    })
  })

  it('marks anonymous writes custom without changing authenticated state', () => {
    const result = inspectTableDataAccessMetadata({
      table: { schema: 'dru_test', name: 'orders' },
      select_permissions: [{
        role: roles.authenticated,
        permission: { columns, filter: {} },
      }],
      insert_permissions: [{
        role: roles.anonymous,
        permission: { columns, check: {} },
      }],
    }, roles, capabilities)

    expect(result.authenticatedState).toBe('managed')
    expect(result.anonymousState).toBe('custom')
    expect(result.policy.authenticated.select).toBe('all')
    expect(result.policy.anonymous.select).toBe(false)
  })

  it('marks conflicting owner rules custom and preserves replacement inventory', () => {
    const result = inspectTableDataAccessMetadata({
      table: { schema: 'dru_test', name: 'orders' },
      select_permissions: [
        {
          role: roles.authenticated,
          permission: {
            columns,
            filter: { owner_id: { _eq: 'X-Hasura-User-Id' } },
          },
        },
        {
          role: 'user',
          permission: { columns: '*', filter: {} },
        },
      ],
      delete_permissions: [{
        role: roles.authenticated,
        permission: { filter: { id: { _eq: 'X-Hasura-User-Id' } } },
      }],
    }, roles, capabilities)

    expect(result.authenticatedState).toBe('custom')
    expect(result.anonymousState).toBe('managed')
    expect(result.legacyRoles).toEqual(['user'])
    expect(result.existingManaged).toEqual([
      { operation: 'select', role: roles.authenticated },
      { operation: 'delete', role: roles.authenticated },
    ])
  })

  it('rejects wildcard owner writes and additional presets as custom', () => {
    const ownerFilter = { owner_id: { _eq: 'X-Hasura-User-Id' } }
    const result = inspectTableDataAccessMetadata({
      table: { schema: 'dru_test', name: 'orders' },
      insert_permissions: [{
        role: roles.authenticated,
        permission: {
          columns: '*',
          check: ownerFilter,
          set: { owner_id: 'X-Hasura-User-Id' },
        },
      }],
      update_permissions: [{
        role: roles.authenticated,
        permission: {
          columns: ['id', 'title'],
          filter: ownerFilter,
          check: ownerFilter,
          set: { title: 'forced' },
        },
      }],
    }, roles, capabilities)

    expect(result.authenticatedState).toBe('custom')
  })

  it('rejects explicit permission columns outside the current operation capability', () => {
    const result = inspectTableDataAccessMetadata({
      table: { schema: 'dru_test', name: 'orders' },
      insert_permissions: [{
        role: roles.authenticated,
        permission: { columns: ['id', 'generated_value'], check: {} },
      }],
    }, roles, capabilities)

    expect(result.authenticatedState).toBe('custom')
  })

  it('recognizes the exact v2 authorization projection filter as managed', () => {
    const result = inspectTableDataAccessMetadata({
      table: { schema: 'dru_test', name: 'orders' },
      select_permissions: [{
        role: roles.authenticated,
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
      }],
    }, roles, capabilities)

    expect(result.authenticatedState).toBe('managed')
    expect(result.policy).toMatchObject({
      policyVersion: 2,
      authenticated: {
        select: 'owner',
        ownerColumn: 'owner_id',
        selectConstraint: {
          type: 'authorization_projection',
          relationshipPath: ['session_access_projection'],
          actorColumn: 'user_id',
          allowColumn: 'can_read_basic',
        },
      },
    })
  })

  it('keeps non-canonical projection filters custom', () => {
    const result = inspectTableDataAccessMetadata({
      table: { schema: 'dru_test', name: 'orders' },
      select_permissions: [{
        role: roles.authenticated,
        permission: {
          columns,
          filter: {
            _or: [
              { owner_id: { _eq: 'X-Hasura-User-Id' } },
              { session_access_projection: { can_read_basic: { _eq: true } } },
            ],
          },
        },
      }],
    }, roles, capabilities)

    expect(result.authenticatedState).toBe('custom')
  })
})
