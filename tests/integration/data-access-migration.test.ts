import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { config } from '../../apps/api/src/config/index.js'
import { pool } from '../../apps/api/src/db/index.js'
import { resolveDataScopeRole } from '../../apps/api/src/modules/data-access/data-scope-role.js'
import { getDataAccessInventory } from '../../apps/api/src/modules/data-access/data-access-inventory.js'
import {
  buildProjectMigrationSnapshot,
  digestMigrationValue,
} from '../../apps/api/src/modules/data-access/data-access-migration-plan.js'
import {
  getLatestProjectMigration,
  getProjectMigration,
} from '../../apps/api/src/modules/data-access/data-access-migration.repository.js'
import {
  createDataAccessMigrationService,
  defaultDataAccessMigrationDependencies,
} from '../../apps/api/src/modules/data-access/data-access-migration.service.js'
import {
  buildActiveRuntimeHttpContexts,
  verifyMigrationHttpVisibility,
} from '../../apps/api/src/modules/data-access/data-access-migration-verifier.js'
import { hasuraMetadataRequest } from '../../apps/api/src/modules/realtime/realtime.service.js'
import * as projectService from '../../apps/api/src/modules/project/project.service.js'
import * as tenantService from '../../apps/api/src/modules/tenant/tenant.service.js'
import * as tableService from '../../apps/api/src/modules/table/table.service.js'

const runIntegration = process.env.DRUVIA_RUN_DATA_ACCESS_MIGRATION_INTEGRATION === '1'
const TABLE_NAME = 'migration_events'

interface ProjectFixture {
  projectId: string
  alias: string
  schemaName: string
  authenticatedRole: string
  anonymousRole: string
}

describe.skipIf(!runIntegration)('project data access migration against PostgreSQL and Hasura', () => {
  let userId = 0
  let userPublicId = ''
  let tenantId = ''
  let primary!: ProjectFixture
  let control!: ProjectFixture
  const fixtures: ProjectFixture[] = []
  let originalAdminSecret = ''
  let originalRealtimeSecret = ''
  let originalRealtimeSecretSource: typeof config.realtime.tokenSecretSource

  beforeAll(async () => {
    const integrationAdminSecret = process.env.DRUVIA_INTEGRATION_HASURA_ADMIN_SECRET || ''
    const integrationJwtSecret = process.env.DRUVIA_INTEGRATION_HASURA_JWT_SECRET
      || config.realtime.tokenSecret
    if (!integrationAdminSecret || integrationJwtSecret.length < 32) {
      throw new Error('Migration integration requires Hasura admin and JWT secrets')
    }
    originalAdminSecret = config.hasura.adminSecret
    originalRealtimeSecret = config.realtime.tokenSecret
    originalRealtimeSecretSource = config.realtime.tokenSecretSource
    config.hasura.adminSecret = integrationAdminSecret
    config.realtime.tokenSecret = integrationJwtSecret
    config.realtime.tokenSecretSource = 'HASURA_JWT_SECRET'

    const migrationTable = await pool.query<{ available: boolean }>(
      `SELECT to_regclass('public.druvia_data_access_migrations') IS NOT NULL AS available`
    )
    if (!migrationTable.rows[0]?.available) {
      throw new Error('Migration integration requires database migration 019')
    }

    const suffix = randomUUID().replaceAll('-', '').slice(0, 8)
    userPublicId = `migration-${suffix}`
    const user = await pool.query<{ id: number }>(
      `INSERT INTO druvia_users (user_id, email, username, status)
       VALUES ($1, $2, $3, 'active') RETURNING id`,
      [userPublicId, `${userPublicId}@test.local`, `mig_${suffix}`]
    )
    userId = user.rows[0].id
    const tenant = await tenantService.createTenant({
      alias: `m${suffix}`.slice(0, 16), name: 'Data Access Migration Integration', ownerUid: userId,
    })
    tenantId = tenant.tenantId

    primary = await createProjectFixture(`a${suffix}`.slice(0, 16))
    control = await createProjectFixture(`b${suffix}`.slice(0, 16))
    await installPrimaryPermissions(primary)
    await installControlPermissions(control)
  }, 30_000)

  afterAll(async () => {
    for (const fixture of fixtures.reverse()) {
      const latest = await getLatestProjectMigration(fixture.projectId).catch(() => null)
      let cleanupAllowed = true
      if (latest?.recoveryTarget) {
        const expectedRecoveryDigest = latest.recoveryTarget === 'source'
          ? latest.sourceDigest
          : latest.appliedDigest
        if (expectedRecoveryDigest) {
          const recovered = await defaultService().recoverMigration(fixture.projectId, latest.migrationId, {
            expectedRecoveryDigest,
            projectAlias: fixture.alias,
          }).catch(() => null)
          cleanupAllowed = !!recovered && !recovered.recoveryTarget
        } else {
          cleanupAllowed = false
        }
      }
      if (!cleanupAllowed) continue
      await hasuraMetadataRequest('pg_untrack_table', {
        source: 'default', table: { schema: fixture.schemaName, name: TABLE_NAME }, cascade: true,
      }).catch(() => undefined)
      await pool.query(`DROP SCHEMA IF EXISTS "${fixture.schemaName}" CASCADE`).catch(() => undefined)
      await pool.query('DELETE FROM druvia_projects WHERE project_id = $1', [fixture.projectId]).catch(() => undefined)
    }
    if (tenantId) await pool.query('DELETE FROM druvia_tenants WHERE tenant_id = $1', [tenantId]).catch(() => undefined)
    if (userId) await pool.query('DELETE FROM druvia_users WHERE id = $1', [userId]).catch(() => undefined)
    config.hasura.adminSecret = originalAdminSecret
    config.realtime.tokenSecret = originalRealtimeSecret
    config.realtime.tokenSecretSource = originalRealtimeSecretSource
  })

  it('isolates apply and rollback and restores both failure targets', async () => {
    const source = await snapshotProject(primary)
    const controlDigest = digestMigrationValue(await snapshotProject(control))

    const preview = await defaultService().previewMigration(primary.projectId, userPublicId, {})
    expect(preview.status).toBe('preview_ready')
    expect(preview.summary.inferredOperationCount).toBe(3)
    expect(preview.summary.destructiveChangeCount).toBe(2)
    expect(preview.tables[0]).toMatchObject({
      targetSource: 'mixed', authenticated: 'read_write', anonymousRead: true,
      removesAnonymousWrite: true, removesAuthenticatedAggregations: true,
    })

    const applied = await defaultService().applyMigration(primary.projectId, preview.migrationId, {
      sourceDigest: preview.sourceDigest,
      confirmInferredPolicies: true,
      confirmDestructiveChanges: true,
      projectAlias: primary.alias,
    })
    expect(applied.status).toBe('applied')
    await assertAppliedState(primary, control, applied.migrationId, controlDigest)

    const rollbackPreview = await defaultService().previewRollback(
      primary.projectId, applied.migrationId, primary.alias
    )
    const rolledBack = await defaultService().rollbackMigration(primary.projectId, applied.migrationId, {
      rollbackPreviewDigest: rollbackPreview.rollbackPreviewDigest!, projectAlias: primary.alias,
    })
    expect(rolledBack.status).toBe('rolled_back')
    expect(digestMigrationValue(await snapshotProject(primary))).toBe(digestMigrationValue(source))

    const failingApplyService = createDataAccessMigrationService({
      ...defaultDataAccessMigrationDependencies,
      verifyPreparedHttp: async () => { throw new Error('injected prepared HTTP failure') },
    })
    const failurePreview = await failingApplyService.previewMigration(primary.projectId, userPublicId, {})
    const failedApply = await failingApplyService.applyMigration(primary.projectId, failurePreview.migrationId, {
      sourceDigest: failurePreview.sourceDigest,
      confirmInferredPolicies: true,
      confirmDestructiveChanges: true,
      projectAlias: primary.alias,
    })
    expect(failedApply).toMatchObject({
      status: 'failed', recoveryTarget: null,
      error: { code: 'DATA_ACCESS_MIGRATION_APPLY_FAILED' },
    })
    expect(digestMigrationValue(await snapshotProject(primary))).toBe(digestMigrationValue(source))

    const retryPreview = await defaultService().previewMigration(primary.projectId, userPublicId, {})
    const retryApplied = await defaultService().applyMigration(primary.projectId, retryPreview.migrationId, {
      sourceDigest: retryPreview.sourceDigest,
      confirmInferredPolicies: true,
      confirmDestructiveChanges: true,
      projectAlias: primary.alias,
    })
    const retryRollbackPreview = await defaultService().previewRollback(
      primary.projectId, retryApplied.migrationId, primary.alias
    )
    let rejectCompatibilityVerification = true
    const failingRollbackService = createDataAccessMigrationService({
      ...defaultDataAccessMigrationDependencies,
      async verifyRuntime(current, plan, mode) {
        if (mode === 'compatibility' && rejectCompatibilityVerification) {
          rejectCompatibilityVerification = false
          throw new Error('injected rollback verification failure')
        }
        return defaultDataAccessMigrationDependencies.verifyRuntime(current, plan, mode)
      },
    })
    const restoredApplied = await failingRollbackService.rollbackMigration(
      primary.projectId,
      retryApplied.migrationId,
      { rollbackPreviewDigest: retryRollbackPreview.rollbackPreviewDigest!, projectAlias: primary.alias }
    )
    expect(restoredApplied).toMatchObject({
      status: 'applied', recoveryTarget: null,
      error: { code: 'DATA_ACCESS_ROLLBACK_FAILED' },
    })
    const persisted = await getProjectMigration(primary.projectId, retryApplied.migrationId)
    expect(digestMigrationValue(await snapshotProject(primary))).toBe(persisted?.appliedDigest)
    expect(digestMigrationValue(await snapshotProject(control))).toBe(controlDigest)
  }, 120_000)

  async function createProjectFixture(alias: string): Promise<ProjectFixture> {
    const project = await projectService.createProject({
      tenantId, alias, name: `Migration Fixture ${alias}`,
    })
    if (!project.schemaName) throw new Error('Fixture project schema was not created')
    const fixture = {
      projectId: project.projectId,
      alias,
      schemaName: project.schemaName,
      authenticatedRole: resolveDataScopeRole({ projectId: project.projectId, actor: 'authenticated' }),
      anonymousRole: resolveDataScopeRole({ projectId: project.projectId, actor: 'anonymous' }),
    }
    fixtures.push(fixture)
    await pool.query(
      `UPDATE druvia_projects SET data_access_mode = 'compatibility' WHERE project_id = $1`,
      [fixture.projectId]
    )
    await pool.query(`
      CREATE TABLE "${fixture.schemaName}"."${TABLE_NAME}" (
        id BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
        system_id BIGINT GENERATED ALWAYS AS IDENTITY UNIQUE,
        owner_id TEXT NOT NULL,
        message TEXT NOT NULL,
        message_upper TEXT GENERATED ALWAYS AS (upper(message)) STORED
      )
    `)
    await pool.query(
      `INSERT INTO "${fixture.schemaName}"._meta_tables (table_name, realtime_enabled)
       VALUES ($1, true)
       ON CONFLICT (table_name) DO UPDATE SET realtime_enabled = true`,
      [TABLE_NAME]
    )
    if (!await tableService.trackTableInHasura(fixture.schemaName, TABLE_NAME)) {
      throw new Error('Fixture table could not be connected to the data interface')
    }
    return fixture
  }

  async function installPrimaryPermissions(fixture: ProjectFixture): Promise<void> {
    const permissions = [
      ['user', 'select', { columns: '*', filter: {}, allow_aggregations: true }],
      ['user', 'insert', { columns: ['id', 'owner_id', 'message'], check: {} }],
      ['user', 'update', { columns: ['id', 'owner_id', 'message'], filter: {}, check: {} }],
      ['user', 'delete', { filter: {} }],
      ['anonymous', 'select', { columns: '*', filter: {}, allow_aggregations: false }],
      ['anonymous', 'insert', { columns: ['id', 'owner_id', 'message'], check: {} }],
      [fixture.authenticatedRole, 'select', {
        columns: '*', filter: { owner_id: { _eq: 'X-Hasura-User-Id' } }, allow_aggregations: false,
      }],
      [fixture.anonymousRole, 'select', {
        columns: '*', filter: {}, allow_aggregations: false,
      }],
    ] as const
    for (const [role, operation, permission] of permissions) {
      await createPermission(fixture, role, operation, permission)
    }
  }

  async function installControlPermissions(fixture: ProjectFixture): Promise<void> {
    await createPermission(fixture, 'user', 'select', {
      columns: '*', filter: {}, allow_aggregations: true,
    })
    await createPermission(fixture, 'anonymous', 'select', {
      columns: '*', filter: {}, allow_aggregations: false,
    })
  }

  async function createPermission(
    fixture: ProjectFixture,
    role: string,
    operation: 'select' | 'insert' | 'update' | 'delete',
    permission: Record<string, unknown>
  ): Promise<void> {
    await hasuraMetadataRequest(`pg_create_${operation}_permission`, {
      source: 'default', table: { schema: fixture.schemaName, name: TABLE_NAME }, role, permission,
    })
  }

  async function snapshotProject(fixture: ProjectFixture) {
    const [project, inventory, metadata] = await Promise.all([
      projectService.getProjectById(fixture.projectId),
      getDataAccessInventory(fixture.schemaName),
      hasuraMetadataRequest<{ sources?: Record<string, unknown>[] }>('export_metadata', {}),
    ])
    const source = metadata.sources?.find((item) => item.name === 'default')
    if (!project || !source) throw new Error('Fixture snapshot dependencies are unavailable')
    return buildProjectMigrationSnapshot({
      projectId: fixture.projectId,
      schemaName: fixture.schemaName,
      runtimeMode: project.dataAccessMode,
      roles: { authenticated: fixture.authenticatedRole, anonymous: fixture.anonymousRole },
      inventory,
      source,
      metadata,
    })
  }

  async function assertAppliedState(
    fixture: ProjectFixture,
    other: ProjectFixture,
    migrationId: string,
    controlDigest: string
  ): Promise<void> {
    const persisted = await getProjectMigration(fixture.projectId, migrationId)
    expect(persisted?.appliedSnapshot).not.toBeNull()
    expect(persisted?.appliedDigest).toMatch(/^[a-f0-9]{64}$/)
    expect(persisted?.appliedAt).toBeInstanceOf(Date)
    expect(persisted?.appliedSnapshot?.tables[0].permissions.some(
      (permission) => permission.role === 'user' || permission.role === 'anonymous'
    )).toBe(false)
    const ownerPermission = persisted?.appliedSnapshot?.tables[0].permissions.find(
      (permission) => permission.role === fixture.authenticatedRole && permission.operation === 'select'
    )
    expect(ownerPermission?.permission.filter).toEqual({ owner_id: { _eq: 'X-Hasura-User-Id' } })
    const insertPermission = persisted?.appliedSnapshot?.tables[0].permissions.find(
      (permission) => permission.role === fixture.authenticatedRole && permission.operation === 'insert'
    )
    const updatePermission = persisted?.appliedSnapshot?.tables[0].permissions.find(
      (permission) => permission.role === fixture.authenticatedRole && permission.operation === 'update'
    )
    expect(insertPermission?.permission.columns).toEqual(['id', 'message', 'owner_id'])
    expect(updatePermission?.permission.columns).toEqual(['id', 'message', 'owner_id'])
    expect(JSON.stringify([insertPermission, updatePermission])).not.toContain('message_upper')
    expect(JSON.stringify([insertPermission, updatePermission])).not.toContain('system_id')
    expect(digestMigrationValue(await snapshotProject(other))).toBe(controlDigest)

    for (const actor of buildActiveRuntimeHttpContexts(fixture.projectId, 'explicit')) {
      await verifyMigrationHttpVisibility({
        schemaName: fixture.schemaName,
        plan: persisted!.migrationPlan,
        snapshot: persisted!.appliedSnapshot!,
        actor: actor.actor,
        context: actor.context,
        forbiddenRootFields: [
          `${other.schemaName}_${TABLE_NAME}`,
          `${other.schemaName}_${TABLE_NAME}_aggregate`,
          `insert_${other.schemaName}_${TABLE_NAME}`,
          `update_${other.schemaName}_${TABLE_NAME}`,
          `delete_${other.schemaName}_${TABLE_NAME}`,
        ],
      })
    }
  }

  function defaultService() {
    return createDataAccessMigrationService(defaultDataAccessMigrationDependencies)
  }
})
