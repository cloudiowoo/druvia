import { describe, expect, it } from 'vitest'
import { inspectTableDataAccessMetadata } from '../../apps/api/src/modules/data-access/data-access-inspection.js'

const columns = ['id', 'owner_id', 'title']
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
    }, roles, columns)

    expect(result.authenticatedState).toBe('managed')
    expect(result.anonymousState).toBe('managed')
    expect(result.policy).toEqual({
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

  it('accepts Hasura wildcard columns for managed select permissions', () => {
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
    }, roles, columns)

    expect(result.authenticatedState).toBe('managed')
    expect(result.anonymousState).toBe('managed')
    expect(result.policy.authenticated).toMatchObject({ select: 'owner', ownerColumn: 'owner_id' })
    expect(result.policy.anonymous.select).toBe(true)
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
    }, roles, columns)

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
    }, roles, columns)

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
    }, roles, columns)

    expect(result.authenticatedState).toBe('custom')
  })
})
