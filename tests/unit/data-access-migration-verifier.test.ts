import { describe, expect, it, vi } from 'vitest'
import { resolveDataScopeRole } from '../../apps/api/src/modules/data-access/data-scope-role.js'
import {
  DataAccessMigrationVerificationError,
  buildActiveRuntimeHttpContexts,
  buildMigrationRealtimeContexts,
  createInternalHasuraWebSocketUrl,
  verifyMigrationHttpVisibility,
  verifyMigrationMetadata,
  verifyMigrationRealtimeActors,
} from '../../apps/api/src/modules/data-access/data-access-migration-verifier.js'
import type {
  ProjectDataAccessMigrationPlan,
  ProjectDataAccessMigrationSnapshot,
} from '../../apps/api/src/modules/data-access/data-access-migration.types.js'

const projectId = 'proj_1'
const roles = {
  authenticated: resolveDataScopeRole({ projectId, actor: 'authenticated' }),
  anonymous: resolveDataScopeRole({ projectId, actor: 'anonymous' }),
}
const policy = {
  authenticated: {
    select: 'all' as const, insert: 'none' as const, update: 'none' as const,
    delete: 'none' as const, ownerColumn: null,
  },
  anonymous: { select: false },
}
const plan: ProjectDataAccessMigrationPlan = {
  version: 1, projectId, schemaName: 'dru_1',
  targetPolicies: [{ tableName: 'orders', source: 'legacy_default', inferredOperations: [{ actor: 'authenticated', operation: 'select' }], policy }],
  legacyDrops: [{ tableName: 'orders', role: 'user', operation: 'select' }],
  blockers: [], destructiveChanges: [],
}
const sourceSnapshot: ProjectDataAccessMigrationSnapshot = {
  projectId, schemaName: 'dru_1', runtimeMode: 'compatibility', sourceGraphqlNaming: null,
  tables: [{
    tableName: 'orders', columns: ['id'], realtimeEnabled: true,
    graphqlNaming: { customName: null, customRootFields: {} }, inventoryStatus: 'managed_table',
    permissions: [{ role: 'user', operation: 'select', permission: { columns: ['id'], filter: {} } }],
  }],
  unsupportedApiBindings: [], externalScopedRoleBindings: [],
}
const scopedSnapshot: ProjectDataAccessMigrationSnapshot = {
  ...sourceSnapshot,
  tables: [{
    ...sourceSnapshot.tables[0],
    permissions: [
      ...sourceSnapshot.tables[0].permissions,
      {
        role: roles.authenticated,
        operation: 'select',
        permission: { columns: ['id'], filter: {}, allow_aggregations: false },
      },
    ],
  }],
}

describe('data access migration verifier', () => {
  it('builds execution probes without fabricating authenticated request identities', () => {
    const httpContexts = buildActiveRuntimeHttpContexts(projectId, 'explicit')
    const realtimeContexts = buildMigrationRealtimeContexts(projectId, 'explicit')

    expect(httpContexts.map((item) => item.actor)).toEqual(['authenticated', 'anonymous'])
    expect(httpContexts.every((item) => item.context.kind === 'project_actor')).toBe(true)
    expect(JSON.stringify(httpContexts)).not.toContain('apiKeyId')
    expect(realtimeContexts).toHaveLength(2)
    expect(realtimeContexts[0]).toMatchObject({
      actorType: 'project_user',
      subject: `migration_probe:authenticated:${projectId}`,
    })
    expect(realtimeContexts[1]).toMatchObject({
      actorType: 'apikey',
      subject: `migration_probe:anonymous:${projectId}`,
    })
    expect(JSON.stringify(realtimeContexts)).not.toContain('apiKeyId')
    expect(JSON.stringify(realtimeContexts)).not.toContain('apiKeyPrefix')
  })

  it('verifies exact scoped metadata before cutover and legacy absence after cutover', () => {
    const prepared: ProjectDataAccessMigrationSnapshot = {
      ...sourceSnapshot,
      tables: [{
        ...sourceSnapshot.tables[0],
        permissions: [
          ...sourceSnapshot.tables[0].permissions,
          { role: roles.authenticated, operation: 'select', permission: { columns: ['id'], filter: {}, allow_aggregations: false } },
        ],
      }],
    }
    expect(() => verifyMigrationMetadata({ currentSnapshot: prepared, sourceSnapshot, plan, roles, stage: 'prepared' })).not.toThrow()

    const removed = {
      ...prepared,
      tables: [{ ...prepared.tables[0], permissions: prepared.tables[0].permissions.filter((item) => item.role !== 'user') }],
    }
    expect(() => verifyMigrationMetadata({ currentSnapshot: removed, sourceSnapshot, plan, roles, stage: 'legacy_removed' })).not.toThrow()
    expect(() => verifyMigrationMetadata({ currentSnapshot: prepared, sourceSnapshot, plan, roles, stage: 'legacy_removed' }))
      .toThrow(DataAccessMigrationVerificationError)
  })

  it('rejects extra legacy or scoped permissions that were not in the migration plan', () => {
    const prepared: ProjectDataAccessMigrationSnapshot = {
      ...sourceSnapshot,
      tables: [{
        ...sourceSnapshot.tables[0],
        permissions: [
          ...sourceSnapshot.tables[0].permissions,
          { role: roles.authenticated, operation: 'select', permission: { columns: ['id'], filter: {}, allow_aggregations: false } },
          { role: 'anonymous', operation: 'insert', permission: { columns: ['id'], check: {} } },
        ],
      }],
    }
    expect(() => verifyMigrationMetadata({ currentSnapshot: prepared, sourceSnapshot, plan, roles, stage: 'prepared' }))
      .toThrow('does not match the migration plan')

    const scopedDrift: ProjectDataAccessMigrationSnapshot = {
      ...sourceSnapshot,
      tables: [{
        ...sourceSnapshot.tables[0],
        permissions: [
          { role: roles.authenticated, operation: 'select', permission: { columns: ['id'], filter: {}, allow_aggregations: false } },
          { role: roles.anonymous, operation: 'insert', permission: { columns: ['id'], check: {} } },
        ],
      }],
    }
    expect(() => verifyMigrationMetadata({ currentSnapshot: scopedDrift, sourceSnapshot, plan, roles, stage: 'legacy_removed' }))
      .toThrow('does not match the migration plan')
  })

  it('rejects unsupported actor bindings introduced after preview', () => {
    const prepared: ProjectDataAccessMigrationSnapshot = {
      ...scopedSnapshot,
      unsupportedApiBindings: [{
        kind: 'action', objectName: 'publishOrder', role: roles.authenticated,
      }],
    }

    expect(() => verifyMigrationMetadata({
      currentSnapshot: prepared, sourceSnapshot, plan, roles, stage: 'prepared',
    })).toThrow('Unsupported API actor binding')
  })

  it('accepts Hasura omitting the false aggregation default while keeping permission checks strict', () => {
    const prepared: ProjectDataAccessMigrationSnapshot = {
      ...sourceSnapshot,
      tables: [{
        ...sourceSnapshot.tables[0],
        permissions: [
          ...sourceSnapshot.tables[0].permissions,
          { role: roles.authenticated, operation: 'select', permission: { columns: ['id'], filter: {} } },
        ],
      }],
    }
    expect(() => verifyMigrationMetadata({ currentSnapshot: prepared, sourceSnapshot, plan, roles, stage: 'prepared' }))
      .not.toThrow()
  })

  it('uses internal admin-secret HTTP introspection with server-derived actor headers', async () => {
    const fetchImpl = vi.fn(async (_url, init) => ({
      ok: true,
      status: 200,
      json: async () => ({ data: { __schema: {
        queryType: { fields: [{ name: 'dru_1_orders' }] }, mutationType: { fields: [] }, subscriptionType: { fields: [{ name: 'dru_1_orders' }] },
      } } }),
    } as Response))

    await verifyMigrationHttpVisibility({
      endpoint: 'http://hasura:8080', adminSecret: 'server-secret', schemaName: 'dru_1',
      plan, snapshot: scopedSnapshot, actor: 'authenticated',
      context: { kind: 'project_actor', role: roles.authenticated, sessionVariables: { 'x-hasura-user-id': 'probe-user' } },
      fetchImpl,
    })

    expect(fetchImpl).toHaveBeenCalledWith('http://hasura:8080/v1/graphql', expect.objectContaining({
      method: 'POST',
      headers: expect.objectContaining({
        'x-hasura-admin-secret': 'server-secret', 'x-hasura-role': roles.authenticated,
        'x-hasura-default-schema': 'dru_1', 'x-hasura-user-id': 'probe-user',
      }),
    }))
    expect(String(fetchImpl.mock.calls[0][1]?.body)).toContain('__schema')
  })

  it('rejects unexpected closed and aggregate roots', async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true, status: 200,
      json: async () => ({ data: { __schema: {
        queryType: { fields: [{ name: 'dru_1_orders' }, { name: 'dru_1_orders_aggregate' }] },
        mutationType: { fields: [{ name: 'insert_dru_1_orders' }] }, subscriptionType: { fields: [{ name: 'dru_1_orders' }] },
      } } }),
    } as Response))
    await expect(verifyMigrationHttpVisibility({
      endpoint: 'http://hasura:8080', adminSecret: 'secret', schemaName: 'dru_1', plan,
      snapshot: scopedSnapshot, actor: 'authenticated',
      context: { kind: 'project_actor', role: roles.authenticated, sessionVariables: {} }, fetchImpl,
    })).rejects.toThrow('Unexpected GraphQL root')
  })

  it('accepts aggregate roots granted by the current compatibility permission', async () => {
    const compatibilitySnapshot: ProjectDataAccessMigrationSnapshot = {
      ...sourceSnapshot,
      tables: [{
        ...sourceSnapshot.tables[0],
        permissions: [{
          role: 'user', operation: 'select',
          permission: { columns: ['id'], filter: {}, allow_aggregations: true },
        }],
      }],
    }
    const fetchImpl = vi.fn(async () => ({
      ok: true, status: 200,
      json: async () => ({ data: { __schema: {
        queryType: { fields: [{ name: 'dru_1_orders' }, { name: 'dru_1_orders_aggregate' }] },
        mutationType: { fields: [] }, subscriptionType: { fields: [{ name: 'dru_1_orders' }] },
      } } }),
    } as Response))

    await expect(verifyMigrationHttpVisibility({
      endpoint: 'http://hasura:8080', adminSecret: 'secret', schemaName: 'dru_1', plan,
      snapshot: compatibilitySnapshot, actor: 'authenticated',
      context: { kind: 'project_actor', role: 'user', sessionVariables: {} }, fetchImpl,
    })).resolves.toBeUndefined()
  })

  it('uses internal websocket URLs and disposes every actor connection', async () => {
    const dispose = vi.fn(async () => undefined)
    const openConnection = vi.fn(async () => ({ dispose }))
    await verifyMigrationRealtimeActors({
      endpoint: 'https://hasura.internal/base', projectId, runtimeMode: 'explicit',
      issueToken: ({ context }) => ({ token: `token:${context.role}` }), openConnection,
    })

    expect(createInternalHasuraWebSocketUrl('https://hasura.internal/base')).toBe('wss://hasura.internal/v1/graphql')
    expect(openConnection).toHaveBeenCalledTimes(2)
    expect(openConnection.mock.calls.every(([url]) => url === 'wss://hasura.internal/v1/graphql')).toBe(true)
    expect(dispose).toHaveBeenCalledTimes(2)
  })

  it('disposes an acknowledged connection even when a later actor fails', async () => {
    const dispose = vi.fn(async () => undefined)
    const openConnection = vi.fn()
      .mockResolvedValueOnce({ dispose })
      .mockRejectedValueOnce(new Error('ack timeout'))
    await expect(verifyMigrationRealtimeActors({
      endpoint: 'http://hasura:8080', projectId, runtimeMode: 'explicit',
      issueToken: () => ({ token: 'token' }), openConnection,
    })).rejects.toThrow('ack timeout')
    expect(dispose).toHaveBeenCalledOnce()
  })
})
