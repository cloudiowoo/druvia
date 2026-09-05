import { describe, expect, it } from 'vitest'
import {
  buildProjectMigrationPlan,
  buildProjectMigrationSnapshot,
  canonicalizeMigrationValue,
  digestProjectMigrationSnapshot,
  digestMigrationValue,
  toPublicMigrationReport,
} from '../../apps/api/src/modules/data-access/data-access-migration-plan.js'

const projectId = 'project-a'
const roles = {
  authenticated: 'druvia_v1_s_a_user',
  anonymous: 'druvia_v1_s_a_anon',
}
const inventoryColumns = (columns: string[]) => ({
  columns,
  insertableColumns: columns,
  updateableColumns: columns,
})

function source() {
  return {
    name: 'default',
    customization: {},
    tables: [{
      table: { schema: 'dru_a', name: 'orders' },
      configuration: { custom_name: 'Order', custom_root_fields: { select: 'ordersList' } },
      select_permissions: [{ role: 'user', permission: { filter: {}, columns: '*' } }],
    }],
    functions: [{ function: { schema: 'dru_a', name: 'search' }, permissions: [{ role: 'user' }] }],
  }
}

describe('data access migration snapshot and plan', () => {
  it('canonicalizes objects and declared set arrays without reordering unknown arrays', () => {
    expect(canonicalizeMigrationValue({ b: 1, a: { z: 2, y: 1 } })).toEqual({ a: { y: 1, z: 2 }, b: 1 })
    expect(canonicalizeMigrationValue({ values: ['b', 'a'] })).toEqual({ values: ['b', 'a'] })
    expect(digestMigrationValue({ b: 1, a: 2 })).toBe(digestMigrationValue({ a: 2, b: 1 }))
  })

  it('builds a deterministic project-only snapshot including unsupported bindings', () => {
    const input = {
      projectId,
      schemaName: 'dru_a',
      runtimeMode: 'compatibility' as const,
      roles,
      inventory: [{ tableName: 'orders', ...inventoryColumns(['title', 'id']), realtimeEnabled: true }],
      source: source(),
      metadata: {},
    }
    const first = buildProjectMigrationSnapshot(input)
    const reordered = buildProjectMigrationSnapshot({
      ...input,
      inventory: [{ tableName: 'orders', ...inventoryColumns(['id', 'title']), realtimeEnabled: true }],
      source: {
        ...source(),
        tables: [{
          ...source().tables[0],
          select_permissions: [{ role: 'user', permission: { columns: ['title', 'id'], filter: {} } }],
        }],
      },
    })

    expect(first.tables[0]).toMatchObject({
      tableName: 'orders', columns: ['id', 'title'], insertableColumns: ['id', 'title'],
      updateableColumns: ['id', 'title'], realtimeEnabled: true, inventoryStatus: 'managed_table',
    })
    expect(first.tables[0].permissions[0].permission.columns).toBe('*')
    expect(first.unsupportedApiBindings).toEqual([{ kind: 'function', objectName: 'dru_a.search', role: 'user' }])
    expect(digestMigrationValue(first)).not.toBe(digestMigrationValue(reordered))
  })

  it('detects source customization, unsupported bindings, and external scoped-role use', () => {
    const metadata = source()
    metadata.customization = { root_fields: { namespace: 'api' } }
    metadata.tables.push({
      table: { schema: 'other', name: 'audit' },
      configuration: { custom_name: 'Audit', custom_root_fields: { select: 'audit' } },
      select_permissions: [{ role: roles.authenticated, permission: { columns: ['id'], filter: {} } }],
    })
    const snapshot = buildProjectMigrationSnapshot({
      projectId,
      schemaName: 'dru_a',
      runtimeMode: 'compatibility',
      roles,
      inventory: [{ tableName: 'orders', ...inventoryColumns(['id', 'title']), realtimeEnabled: false }],
      source: metadata,
      metadata: {},
    })
    const plan = buildProjectMigrationPlan(snapshot, roles)

    expect(plan.blockers.map((item) => item.reason)).toEqual(expect.arrayContaining([
      'unsupported_source_customization',
      'unsupported_tracked_object',
      'cross_project_role_binding',
    ]))
  })

  it('blocks top-level Hasura API bindings for migration actor roles', () => {
    const snapshot = buildProjectMigrationSnapshot({
      projectId,
      schemaName: 'dru_a',
      runtimeMode: 'compatibility',
      roles,
      inventory: [{ tableName: 'orders', ...inventoryColumns(['id', 'title']), realtimeEnabled: false }],
      source: source(),
      metadata: {
        actions: [{ name: 'publishOrder', permissions: [{ role: roles.authenticated }] }],
        remote_schemas: [{ name: 'billing', permissions: [{ role: 'anonymous' }] }],
        inherited_roles: [{ role_name: 'combined_viewer', role_set: ['viewer', roles.anonymous] }],
      },
    })

    expect(snapshot.unsupportedApiBindings).toEqual(expect.arrayContaining([
      { kind: 'action', objectName: 'publishOrder', role: roles.authenticated },
      { kind: 'remote_schema', objectName: 'billing', role: 'anonymous' },
      { kind: 'inherited_role', objectName: 'combined_viewer', role: roles.anonymous },
    ]))
    expect(buildProjectMigrationPlan(snapshot, roles).blockers).toEqual(expect.arrayContaining([
      expect.objectContaining({ reason: 'unsupported_tracked_object' }),
    ]))
  })

  it('projects only redacted business summaries', () => {
    const snapshot = buildProjectMigrationSnapshot({
      projectId,
      schemaName: 'dru_a',
      runtimeMode: 'compatibility',
      roles,
      inventory: [{ tableName: 'orders', ...inventoryColumns(['id', 'title']), realtimeEnabled: false }],
      source: source(),
      metadata: {},
    })
    const plan = buildProjectMigrationPlan(snapshot, roles)
    const report = toPublicMigrationReport({
      migrationId: 'migration-1', projectId, status: 'preview_ready', phase: 'preview',
      sourceDigest: digestMigrationValue(snapshot), appliedDigest: null, recoveryTarget: null,
      appliedAt: null, rollbackPreviewDigest: null, error: null, plan,
    })

    expect(report.canApply).toBe(false)
    expect(report.summary.totalTables).toBe(1)
    expect(report.summary.blockerCount).toBe(1)
    expect(JSON.stringify(report)).not.toContain(roles.authenticated)
    expect(JSON.stringify(report)).not.toContain('permissions')
  })

  it('does not advertise a stored version 1 preview as applyable', () => {
    const report = toPublicMigrationReport({
      migrationId: 'mig_v1',
      projectId,
      status: 'preview_ready',
      phase: 'preview',
      sourceDigest: 'source-digest',
      appliedDigest: null,
      recoveryTarget: null,
      appliedAt: null,
      rollbackPreviewDigest: null,
      error: null,
      plan: {
        version: 1,
        projectId,
        schemaName: 'dru_a',
        targetPolicies: [],
        legacyDrops: [],
        blockers: [],
        destructiveChanges: [],
      },
    })

    expect(report.canApply).toBe(false)
  })

  it('stores operation-specific column capabilities in version 2 plans', () => {
    const snapshot = buildProjectMigrationSnapshot({
      projectId,
      schemaName: 'dru_a',
      runtimeMode: 'compatibility',
      roles,
      inventory: [{
        tableName: 'observations',
        columns: ['id', 'observed_at'],
        insertableColumns: ['id'],
        updateableColumns: ['id'],
        realtimeEnabled: false,
      }],
      source: { name: 'default', tables: [] },
      metadata: {},
    })

    expect(snapshot.tables[0]).toMatchObject({
      columns: ['id', 'observed_at'],
      insertableColumns: ['id'],
      updateableColumns: ['id'],
    })
    expect(buildProjectMigrationPlan(snapshot, roles).version).toBe(2)
  })

  it('keeps version 1 snapshot digests compatible with stored records', () => {
    const snapshot = buildProjectMigrationSnapshot({
      projectId,
      schemaName: 'dru_a',
      runtimeMode: 'compatibility',
      roles,
      inventory: [{
        tableName: 'orders',
        ...inventoryColumns(['id', 'title']),
        realtimeEnabled: false,
      }],
      source: source(),
      metadata: {},
    })
    const legacyShape = {
      ...snapshot,
      tables: snapshot.tables.map(({ insertableColumns: _insert, updateableColumns: _update, ...table }) => table),
    }

    expect(digestProjectMigrationSnapshot(snapshot, 1))
      .toBe(digestMigrationValue(legacyShape))
    expect(digestProjectMigrationSnapshot(snapshot, 2))
      .not.toBe(digestMigrationValue(legacyShape))
  })
})
