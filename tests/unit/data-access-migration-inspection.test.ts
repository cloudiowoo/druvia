import { describe, expect, it } from 'vitest'
import { inspectMigrationTable } from '../../apps/api/src/modules/data-access/data-access-migration-inspection.js'
import type { MigrationTableSnapshot } from '../../apps/api/src/modules/data-access/data-access-migration.types.js'

const columns = ['id', 'owner_id', 'title']
const roles = {
  authenticated: 'druvia_v1_s_project_user',
  anonymous: 'druvia_v1_s_project_anon',
}

function table(
  permissions: MigrationTableSnapshot['permissions'],
  overrides: Partial<MigrationTableSnapshot> = {}
): MigrationTableSnapshot {
  return {
    tableName: 'orders',
    columns,
    realtimeEnabled: false,
    graphqlNaming: { customName: null, customRootFields: {} },
    inventoryStatus: 'managed_table',
    permissions,
    ...overrides,
  }
}

describe('data access legacy migration inspection', () => {
  it('recognizes exact historical CRUD shapes and normalized omissions', () => {
    const result = inspectMigrationTable(table([
      { role: 'user', operation: 'select', permission: { columns: '*', filter: {}, allow_aggregations: true } },
      { role: 'user', operation: 'insert', permission: { columns, check: {}, set: null, backend_only: false } },
      { role: 'user', operation: 'update', permission: { columns: '*', filter: {}, check: null } },
      { role: 'user', operation: 'delete', permission: { filter: {} } },
      { role: 'anonymous', operation: 'select', permission: { columns: '*', filter: {} } },
      { role: 'anonymous', operation: 'insert', permission: { columns: '*', check: {} } },
      { role: 'anonymous', operation: 'update', permission: { columns: '*', filter: {} } },
      { role: 'anonymous', operation: 'delete', permission: { filter: {} } },
    ]), roles)

    expect(result.blockers).toEqual([])
    expect(result.policy).toEqual({
      authenticated: {
        select: 'all', insert: 'all', update: 'all', delete: 'all', ownerColumn: null,
      },
      anonymous: { select: true },
    })
    expect(result.inferredOperations).toHaveLength(5)
    expect(result.destructiveChanges).toEqual(expect.arrayContaining([
      { tableName: 'orders', actor: 'authenticated', operation: 'select', reason: 'authenticated_aggregations_removed' },
      { tableName: 'orders', actor: 'anonymous', operation: 'insert', reason: 'anonymous_write_removed' },
      { tableName: 'orders', actor: 'anonymous', operation: 'update', reason: 'anonymous_write_removed' },
      { tableName: 'orders', actor: 'anonymous', operation: 'delete', reason: 'anonymous_write_removed' },
    ]))
    expect(result.legacyDrops).toHaveLength(8)
  })

  it('preserves recognized scoped permissions per operation and infers only gaps', () => {
    const ownerRule = { owner_id: { _eq: 'X-Hasura-User-Id' } }
    const result = inspectMigrationTable(table([
      { role: roles.authenticated, operation: 'select', permission: { columns, filter: ownerRule } },
      { role: roles.authenticated, operation: 'insert', permission: { columns: ['id', 'title'], check: ownerRule, set: { owner_id: 'X-Hasura-User-Id' } } },
      { role: roles.anonymous, operation: 'select', permission: { columns, filter: {} } },
      { role: 'user', operation: 'select', permission: { columns: '*', filter: {}, allow_aggregations: true } },
      { role: 'user', operation: 'delete', permission: { filter: {} } },
    ]), roles)

    expect(result.source).toBe('mixed')
    expect(result.policy.authenticated).toEqual({
      select: 'owner', insert: 'owner', update: 'none', delete: 'all', ownerColumn: 'owner_id',
    })
    expect(result.policy.anonymous.select).toBe(true)
    expect(result.inferredOperations).toEqual([{ actor: 'authenticated', operation: 'delete' }])
  })

  it('marks custom, duplicate, and tracked-only actor bindings as blockers', () => {
    const result = inspectMigrationTable(table([
      { role: 'user', operation: 'select', permission: { columns: ['id'], filter: {} } },
      { role: 'user', operation: 'select', permission: { columns: '*', filter: {} } },
      { role: roles.authenticated, operation: 'delete', permission: { filter: { id: { _eq: 'other' } } } },
    ], { inventoryStatus: 'tracked_only' }), roles)

    expect(result.blockers.map((item) => item.reason)).toEqual(expect.arrayContaining([
      'duplicate_rule',
      'custom_scoped_rule',
      'unsupported_tracked_object',
    ]))
  })

  it('blocks anonymous aggregation instead of silently removing it', () => {
    const result = inspectMigrationTable(table([
      {
        role: 'anonymous',
        operation: 'select',
        permission: { columns: '*', filter: {}, allow_aggregations: true },
      },
    ]), roles)

    expect(result.blockers).toContainEqual({
      tableName: 'orders',
      actor: 'anonymous',
      operation: 'select',
      reason: 'custom_legacy_rule',
    })
    expect(result.inferredOperations).toEqual([])
  })

  it('keeps inferred legacy permissions closed when the table is skipped', () => {
    const result = inspectMigrationTable(table([
      { role: 'user', operation: 'select', permission: { columns: '*', filter: {}, allow_aggregations: true } },
      { role: 'anonymous', operation: 'select', permission: { columns: '*', filter: {} } },
    ]), roles, { skipLegacyInference: true })

    expect(result.policy.authenticated.select).toBe('none')
    expect(result.policy.anonymous.select).toBe(false)
    expect(result.inferredOperations).toEqual([])
    expect(result.legacyDrops).toHaveLength(2)
  })
})
