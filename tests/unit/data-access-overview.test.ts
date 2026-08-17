import { describe, expect, it } from 'vitest'
import { buildProjectDataAccessOverview } from '../../apps/api/src/modules/data-access/data-access-overview.js'

const projectId = 'proj_123'
const schemaName = 'dru_proj_123'
const roles = {
  authenticated: 'druvia_v1_s_scope_user',
  anonymous: 'druvia_v1_s_scope_anon',
}
const columns = ['id', 'owner_id', 'title']

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
        { tableName: 'untracked', columns, realtimeEnabled: false },
        { tableName: 'outbox', columns, realtimeEnabled: true },
        { tableName: 'orders', columns, realtimeEnabled: false },
        { tableName: 'legacy_only', columns, realtimeEnabled: false },
        { tableName: 'events', columns, realtimeEnabled: true },
        { tableName: 'drafts', columns, realtimeEnabled: false },
        { tableName: 'custom_rules', columns, realtimeEnabled: false },
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
        dataInterface: 'connected',
        authenticatedAccess: 'custom',
        anonymousAccess: 'custom',
        realtime: 'disabled',
        legacyAccess: { authenticated: false, anonymous: false },
        reviewRequired: true,
      },
      {
        tableName: 'drafts',
        dataInterface: 'connected',
        authenticatedAccess: 'closed',
        anonymousAccess: 'closed',
        realtime: 'disabled',
        legacyAccess: { authenticated: false, anonymous: false },
        reviewRequired: false,
      },
      {
        tableName: 'events',
        dataInterface: 'connected',
        authenticatedAccess: 'read_write',
        anonymousAccess: 'read',
        realtime: 'configured',
        legacyAccess: { authenticated: false, anonymous: false },
        reviewRequired: false,
      },
      {
        tableName: 'legacy_only',
        dataInterface: 'connected',
        authenticatedAccess: 'closed',
        anonymousAccess: 'closed',
        realtime: 'disabled',
        legacyAccess: { authenticated: true, anonymous: false },
        reviewRequired: true,
      },
      {
        tableName: 'orders',
        dataInterface: 'connected',
        authenticatedAccess: 'read_only',
        anonymousAccess: 'closed',
        realtime: 'disabled',
        legacyAccess: { authenticated: false, anonymous: false },
        reviewRequired: false,
      },
      {
        tableName: 'outbox',
        dataInterface: 'connected',
        authenticatedAccess: 'write_only',
        anonymousAccess: 'closed',
        realtime: 'access_required',
        legacyAccess: { authenticated: false, anonymous: false },
        reviewRequired: false,
      },
      {
        tableName: 'untracked',
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
      reviewRequiredTables: 3,
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
      inventory: [{ tableName: 'public_posts', columns, realtimeEnabled: true }],
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
      inventory: [{ tableName: 'mixed_rules', columns, realtimeEnabled: true }],
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

  it('counts supported anonymous read when anonymous writes require review', () => {
    const result = buildProjectDataAccessOverview({
      projectId,
      schemaName,
      runtimeMode: 'compatibility',
      roles,
      inventory: [{ tableName: 'mixed_anonymous', columns, realtimeEnabled: true }],
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
})
