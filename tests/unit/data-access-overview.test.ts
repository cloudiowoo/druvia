import { describe, expect, it } from 'vitest'
import { buildProjectDataAccessOverview } from '../../apps/api/src/modules/data-access/data-access-overview.js'

const projectId = 'proj_123'
const schemaName = 'dru_proj_123'
const roles = {
  authenticated: 'druvia_v1_s_scope_user',
  anonymous: 'druvia_v1_s_scope_anon',
}
const columns = ['id', 'owner_id', 'title']
const columnInventory = {
  columns,
  insertableColumns: columns,
  updateableColumns: columns,
}

function table(
  name: string,
  permissions: Record<string, unknown> = {}
) {
  return {
    table: { schema: schemaName, name },
    ...permissions,
  }
}

describe('project data access overview aggregation', () => {
  it('classifies access states, review risks and summary counts', () => {
    const result = buildProjectDataAccessOverview({
      projectId,
      schemaName,
      runtimeMode: 'explicit',
      roles,
      inventory: [
        { tableName: 'untracked', ...columnInventory, realtimeEnabled: false },
        { tableName: 'outbox', ...columnInventory, realtimeEnabled: true },
        { tableName: 'orders', ...columnInventory, realtimeEnabled: false },
        { tableName: 'legacy_only', ...columnInventory, realtimeEnabled: false },
        { tableName: 'events', ...columnInventory, realtimeEnabled: true },
        { tableName: 'drafts', ...columnInventory, realtimeEnabled: false },
        { tableName: 'custom_rules', ...columnInventory, realtimeEnabled: false },
      ],
      tableMetadata: [
        table('orders', {
          select_permissions: [{
            role: roles.authenticated,
            permission: { columns, filter: {} },
          }],
        }),
        table('drafts'),
        table('events', {
          select_permissions: [
            { role: roles.authenticated, permission: { columns, filter: {} } },
            { role: roles.anonymous, permission: { columns, filter: {} } },
          ],
          insert_permissions: [{
            role: roles.authenticated,
            permission: { columns, check: {} },
          }],
        }),
        table('outbox', {
          insert_permissions: [{
            role: roles.authenticated,
            permission: { columns, check: {} },
          }],
        }),
        table('custom_rules', {
          select_permissions: [{
            role: roles.authenticated,
            permission: { columns: '*', filter: { tenant_id: { _eq: 'x' } } },
          }],
          insert_permissions: [{
            role: roles.anonymous,
            permission: { columns, check: {} },
          }],
        }),
        table('legacy_only', {
          select_permissions: [{
            role: 'user',
            permission: { columns: '*', filter: {} },
          }],
        }),
      ],
    })

    expect(result.runtimeMode).toBe('explicit')
    expect(result.tables.map((row) => row.tableName)).toEqual([
      'custom_rules',
      'drafts',
      'events',
      'legacy_only',
      'orders',
      'outbox',
      'untracked',
    ])
    expect(result.tables).toEqual([
      {
        tableName: 'custom_rules',
        managedState: 'custom',
        dataInterface: 'connected',
        authenticatedAccess: 'custom',
        anonymousAccess: 'custom',
        realtime: 'disabled',
        legacyAccess: { authenticated: false, anonymous: false },
        reviewRequired: true,
      },
      {
        tableName: 'drafts',
        managedState: 'managed',
        dataInterface: 'connected',
        authenticatedAccess: 'closed',
        anonymousAccess: 'closed',
        realtime: 'disabled',
        legacyAccess: { authenticated: false, anonymous: false },
        reviewRequired: false,
      },
      {
        tableName: 'events',
        managedState: 'adoption_required',
        dataInterface: 'connected',
        authenticatedAccess: 'read_write',
        anonymousAccess: 'read',
        realtime: 'configured',
        legacyAccess: { authenticated: false, anonymous: false },
        reviewRequired: true,
      },
      {
        tableName: 'legacy_only',
        managedState: 'managed',
        dataInterface: 'connected',
        authenticatedAccess: 'closed',
        anonymousAccess: 'closed',
        realtime: 'disabled',
        legacyAccess: { authenticated: true, anonymous: false },
        reviewRequired: true,
      },
      {
        tableName: 'orders',
        managedState: 'adoption_required',
        dataInterface: 'connected',
        authenticatedAccess: 'read_only',
        anonymousAccess: 'closed',
        realtime: 'disabled',
        legacyAccess: { authenticated: false, anonymous: false },
        reviewRequired: true,
      },
      {
        tableName: 'outbox',
        managedState: 'adoption_required',
        dataInterface: 'connected',
        authenticatedAccess: 'write_only',
        anonymousAccess: 'closed',
        realtime: 'access_required',
        legacyAccess: { authenticated: false, anonymous: false },
        reviewRequired: true,
      },
      {
        tableName: 'untracked',
        managedState: 'managed',
        dataInterface: 'not_connected',
        authenticatedAccess: 'closed',
        anonymousAccess: 'closed',
        realtime: 'disabled',
        legacyAccess: { authenticated: false, anonymous: false },
        reviewRequired: true,
      },
    ])
    expect(result.summary).toEqual({
      totalTables: 7,
      configuredTables: 3,
      anonymousConfiguredTables: 1,
      realtimeAccessRequiredTables: 1,
      legacyTables: 1,
      reviewRequiredTables: 6,
      pendingConfigurationTables: 4,
      actionRequiredTables: 4,
    })
    expect(JSON.stringify(result)).not.toContain(roles.authenticated)
    expect(JSON.stringify(result)).not.toContain(roles.anonymous)
    expect(JSON.stringify(result)).not.toContain('"user"')
  })

  it('maps legacy anonymous access without treating it as scoped configuration', () => {
    const result = buildProjectDataAccessOverview({
      projectId,
      schemaName,
      runtimeMode: 'compatibility',
      roles,
      inventory: [{ tableName: 'public_posts', ...columnInventory, realtimeEnabled: true }],
      tableMetadata: [table('public_posts', {
        select_permissions: [{
          role: 'anonymous',
          permission: { columns: '*', filter: {} },
        }],
      })],
    })

    expect(result.tables[0]).toMatchObject({
      anonymousAccess: 'closed',
      realtime: 'access_required',
      legacyAccess: { authenticated: false, anonymous: true },
      reviewRequired: true,
    })
    expect(result.summary.configuredTables).toBe(0)
  })

  it('counts supported permissions even when another operation requires review', () => {
    const result = buildProjectDataAccessOverview({
      projectId,
      schemaName,
      runtimeMode: 'compatibility',
      roles,
      inventory: [{ tableName: 'mixed_rules', ...columnInventory, realtimeEnabled: true }],
      tableMetadata: [table('mixed_rules', {
        select_permissions: [{
          role: roles.authenticated,
          permission: { columns, filter: {} },
        }],
        update_permissions: [{
          role: roles.authenticated,
          permission: { columns: '*', filter: {} },
        }],
      })],
    })

    expect(result.tables[0]).toMatchObject({
      authenticatedAccess: 'custom',
      realtime: 'configured',
      reviewRequired: true,
    })
    expect(result.summary.configuredTables).toBe(1)
  })

  it('reports generated-excluded write permissions as managed read-write access', () => {
    const writableColumns = ['id', 'owner_id', 'title']
    const readableColumns = [...writableColumns, 'observed_at']
    const result = buildProjectDataAccessOverview({
      projectId,
      schemaName,
      runtimeMode: 'explicit',
      roles,
      inventory: [{
        tableName: 'observations',
        columns: readableColumns,
        insertableColumns: writableColumns,
        updateableColumns: writableColumns,
        realtimeEnabled: false,
      }],
      tableMetadata: [table('observations', {
        select_permissions: [{
          role: roles.authenticated,
          permission: { columns: readableColumns, filter: {} },
        }],
        insert_permissions: [{
          role: roles.authenticated,
          permission: { columns: writableColumns, check: {} },
        }],
        update_permissions: [{
          role: roles.authenticated,
          permission: { columns: writableColumns, filter: {}, check: null },
        }],
      })],
    })

    expect(result.tables[0]).toMatchObject({
      authenticatedAccess: 'read_write',
      managedState: 'adoption_required',
      reviewRequired: true,
    })
  })

  it('counts supported anonymous read when anonymous writes require review', () => {
    const result = buildProjectDataAccessOverview({
      projectId,
      schemaName,
      runtimeMode: 'compatibility',
      roles,
      inventory: [{ tableName: 'mixed_anonymous', ...columnInventory, realtimeEnabled: true }],
      tableMetadata: [table('mixed_anonymous', {
        select_permissions: [{
          role: roles.anonymous,
          permission: { columns, filter: {} },
        }],
        insert_permissions: [{
          role: roles.anonymous,
          permission: { columns, check: {} },
        }],
      })],
    })

    expect(result.tables[0]).toMatchObject({
      anonymousAccess: 'custom',
      realtime: 'configured',
      reviewRequired: true,
    })
    expect(result.summary.configuredTables).toBe(1)
    expect(result.summary.anonymousConfiguredTables).toBe(1)
  })

  it('reports capability contraction as refresh-required instead of custom', () => {
    const baselineColumns = [...columns, 'retired_summary']
    const result = buildProjectDataAccessOverview({
      projectId,
      schemaName,
      runtimeMode: 'explicit',
      roles,
      inventory: [{ tableName: 'sessions', ...columnInventory, realtimeEnabled: false }],
      tableMetadata: [table('sessions', {
        select_permissions: [{
          role: roles.authenticated,
          permission: { columns: baselineColumns, filter: {}, allow_aggregations: false },
        }],
      })],
      managedPolicies: [{
        projectId,
        tableName: 'sessions',
        schemaName,
        policyVersion: 1,
        policy: {
          authenticated: {
            select: 'all', insert: 'none', update: 'none', delete: 'none', ownerColumn: null,
          },
          anonymous: { select: false },
        },
        columnGrants: {
          authenticated: { select: baselineColumns, insert: [], update: [] },
          anonymous: { select: [] },
        },
        capabilitiesSnapshot: {
          readableColumns: baselineColumns,
          insertableColumns: baselineColumns,
          updateableColumns: baselineColumns,
        },
        permissionsSnapshot: [{
          role: roles.authenticated,
          operation: 'select',
          permission: { columns: baselineColumns, filter: {}, allow_aggregations: false },
        }],
        metadataDigest: 'a'.repeat(64),
        revision: 1n,
        createdBy: 'usr_1',
        updatedBy: 'usr_1',
        createdAt: new Date(),
        updatedAt: new Date(),
      }],
    })

    expect(result.tables[0]).toMatchObject({
      managedState: 'refresh_required',
      authenticatedAccess: 'read_only',
      reviewRequired: true,
    })
  })

  it('marks a stalled metadata write as recovery-required in the overview', () => {
    const result = buildProjectDataAccessOverview({
      projectId,
      schemaName,
      runtimeMode: 'explicit',
      roles,
      inventory: [{ tableName: 'sessions', ...columnInventory, realtimeEnabled: false }],
      tableMetadata: [table('sessions')],
      activeOperation: {
        tableName: 'sessions',
        status: 'recovering',
        writeDeadlineAt: new Date(Date.now() - 5_001),
      } as never,
    })

    expect(result.tables[0]?.managedState).toBe('recovery_required')
    expect(result.summary.actionRequiredTables).toBe(1)
  })
})
