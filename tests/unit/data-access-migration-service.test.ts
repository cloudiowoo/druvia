import { beforeEach, describe, expect, it, vi } from 'vitest'
import { resolveDataScopeRole } from '../../apps/api/src/modules/data-access/data-scope-role.js'
import {
  DataAccessMigrationConflictError,
  DataAccessMigrationInputError,
  createDataAccessMigrationService,
} from '../../apps/api/src/modules/data-access/data-access-migration.service.js'
import type { DataAccessMigrationRecord } from '../../apps/api/src/modules/data-access/data-access-migration.repository.js'
import type { ProjectDataAccessMigrationSnapshot } from '../../apps/api/src/modules/data-access/data-access-migration.types.js'

const project = { projectId: 'proj_1', schemaName: 'dru_1', alias: 'demo', dataAccessMode: 'compatibility' as const }
const roles = {
  authenticated: resolveDataScopeRole({ projectId: project.projectId, actor: 'authenticated' }),
  anonymous: resolveDataScopeRole({ projectId: project.projectId, actor: 'anonymous' }),
}
const source: ProjectDataAccessMigrationSnapshot = {
  projectId: project.projectId, schemaName: project.schemaName, runtimeMode: 'compatibility', sourceGraphqlNaming: null,
  tables: [{
    tableName: 'orders', columns: ['id'], realtimeEnabled: true,
    graphqlNaming: { customName: null, customRootFields: {} }, inventoryStatus: 'managed_table',
    permissions: [{ role: 'user', operation: 'select', permission: { columns: ['id'], filter: {}, allow_aggregations: true } }],
  }], unsupportedApiBindings: [], externalScopedRoleBindings: [],
}
const applied: ProjectDataAccessMigrationSnapshot = {
  ...source, runtimeMode: 'explicit',
  tables: [{ ...source.tables[0], permissions: [{
    role: roles.authenticated, operation: 'select', permission: { columns: ['id'], filter: {}, allow_aggregations: false },
  }] }],
}

function createHarness() {
  let record: DataAccessMigrationRecord | null = null
  let current = source
  let mode: 'compatibility' | 'explicit' = 'compatibility'
  const phases: string[] = []
  const repository = {
    createMigrationPreview: vi.fn(async (input) => {
      record = {
        migrationId: input.migrationId, projectId: input.projectId, status: 'preview_ready', phase: 'preview',
        sourceSnapshot: input.sourceSnapshot, migrationPlan: input.migrationPlan, sourceDigest: input.sourceDigest,
        appliedSnapshot: null, appliedDigest: null, rollbackPreviewDigest: null, recoveryTarget: null,
        hasDestructiveChanges: input.hasDestructiveChanges, createdBy: input.createdBy, error: null,
        createdAt: new Date(), startedAt: null, appliedAt: null, completedAt: null, updatedAt: new Date(),
      }
      return record
    }),
    getLatestProjectMigration: vi.fn(async () => record),
    getProjectMigration: vi.fn(async () => record),
    transitionMigration: vi.fn(async (_id, _expected, patch) => {
      if (!record) throw new Error('missing record')
      phases.push(patch.phase ?? record.phase)
      record = {
        ...record, ...patch,
        appliedSnapshot: patch.appliedSnapshot ?? record.appliedSnapshot,
        appliedDigest: patch.appliedDigest ?? record.appliedDigest,
        rollbackPreviewDigest: patch.rollbackPreviewDigest === undefined ? record.rollbackPreviewDigest : patch.rollbackPreviewDigest,
        recoveryTarget: patch.recoveryTarget === undefined ? record.recoveryTarget : patch.recoveryTarget,
        error: patch.error === undefined ? record.error : patch.error,
      }
      return record
    }),
    setProjectDataAccessMode: vi.fn(async (_id, expected, next) => {
      if (mode !== expected) return false
      mode = next
      current = mode === 'explicit' ? applied : source
      return true
    }),
  }
  const dependencies = {
    repository,
    getProject: vi.fn(async () => ({ ...project, dataAccessMode: mode })),
    snapshotProject: vi.fn(async () => current),
    applyPermissionCommands: vi.fn(async (commands, target) => {
      current = target
      expect(commands.length).toBeGreaterThan(0)
    }),
    verifyPreparedMetadata: vi.fn(async () => undefined),
    verifyPreparedHttp: vi.fn(async () => undefined),
    verifyPreparedRealtime: vi.fn(async () => undefined),
    verifyRuntime: vi.fn(async () => undefined),
    withLock: vi.fn(async (_projectId, callback) => callback()),
    now: () => new Date('2026-08-18T00:00:00Z'),
    createId: () => 'mig_1',
  }
  return {
    service: createDataAccessMigrationService(dependencies as never),
    dependencies, repository, phases,
    setCurrent(value: ProjectDataAccessMigrationSnapshot) { current = value },
    getRecord() { return record },
  }
}

describe('data access migration service', () => {
  let harness: ReturnType<typeof createHarness>
  beforeEach(() => { harness = createHarness() })

  it('creates a deterministic preview and validates skipped table names', async () => {
    const report = await harness.service.previewMigration(project.projectId, 'usr_1', {})
    expect(report.status).toBe('preview_ready')
    expect(report.summary.migratedTables).toBe(1)
    expect(harness.repository.createMigrationPreview).toHaveBeenCalledOnce()

    await expect(harness.service.previewMigration(project.projectId, 'usr_1', {
      skipLegacyInferenceTables: ['missing'],
    })).rejects.toBeInstanceOf(DataAccessMigrationConflictError)
  })

  it('applies every persisted stage and stores one applied snapshot', async () => {
    const preview = await harness.service.previewMigration(project.projectId, 'usr_1', {})
    const report = await harness.service.applyMigration(project.projectId, preview.migrationId, {
      sourceDigest: preview.sourceDigest,
      confirmInferredPolicies: true,
      confirmDestructiveChanges: true,
      projectAlias: project.alias,
    })

    expect(report.status).toBe('applied')
    expect(harness.phases).toEqual(expect.arrayContaining([
      'snapshot_check', 'prepare_scoped_permissions', 'verify_scoped_metadata', 'verify_scoped_http',
      'verify_scoped_realtime', 'remove_legacy_permissions', 'activate_explicit_mode', 'verify_active_runtime', 'completed',
    ]))
    expect(harness.getRecord()?.appliedSnapshot).toEqual(applied)
    expect(harness.dependencies.verifyRuntime).toHaveBeenCalledWith(applied, expect.anything(), 'explicit')
  })

  it('rejects stale previews and incomplete inferred or destructive confirmations', async () => {
    const preview = await harness.service.previewMigration(project.projectId, 'usr_1', {})
    const input = {
      sourceDigest: preview.sourceDigest,
      confirmInferredPolicies: true,
      confirmDestructiveChanges: true,
      projectAlias: project.alias,
    }

    await expect(harness.service.applyMigration(project.projectId, preview.migrationId, {
      ...input, confirmInferredPolicies: false,
    })).rejects.toBeInstanceOf(DataAccessMigrationInputError)
    await expect(harness.service.applyMigration(project.projectId, preview.migrationId, {
      ...input, confirmDestructiveChanges: false,
    })).rejects.toBeInstanceOf(DataAccessMigrationInputError)
    await expect(harness.service.applyMigration(project.projectId, preview.migrationId, {
      ...input, projectAlias: 'wrong',
    })).rejects.toBeInstanceOf(DataAccessMigrationInputError)

    harness.setCurrent({
      ...source,
      tables: [{ ...source.tables[0], columns: ['id', 'changed_after_preview'] }],
    })
    await expect(harness.service.applyMigration(project.projectId, preview.migrationId, input))
      .rejects.toMatchObject({ code: 'DATA_ACCESS_MIGRATION_DRIFT' })
  })

  it('restores source permissions and compatibility mode after an apply failure', async () => {
    const preview = await harness.service.previewMigration(project.projectId, 'usr_1', {})
    harness.dependencies.verifyPreparedMetadata.mockRejectedValueOnce(new Error('upstream details'))

    const report = await harness.service.applyMigration(project.projectId, preview.migrationId, {
      sourceDigest: preview.sourceDigest, confirmInferredPolicies: true,
      confirmDestructiveChanges: true, projectAlias: project.alias,
    })

    expect(report.status).toBe('failed')
    expect(report.phase).toBe('verify_scoped_metadata')
    expect(report.error?.code).toBe('DATA_ACCESS_MIGRATION_APPLY_FAILED')
    expect(report.recoveryTarget).toBeNull()
    expect(harness.dependencies.applyPermissionCommands).toHaveBeenLastCalledWith(expect.any(Array), source)
  })

  it('marks recovery required when source restoration also fails', async () => {
    const preview = await harness.service.previewMigration(project.projectId, 'usr_1', {})
    harness.dependencies.verifyPreparedMetadata.mockRejectedValueOnce(new Error('apply failed'))
    let permissionWriteCount = 0
    harness.dependencies.applyPermissionCommands.mockImplementation(async (_commands, target) => {
      permissionWriteCount += 1
      if (permissionWriteCount === 2) throw new Error('restore failed')
      harness.setCurrent(target)
    })

    const report = await harness.service.applyMigration(project.projectId, preview.migrationId, {
      sourceDigest: preview.sourceDigest, confirmInferredPolicies: true,
      confirmDestructiveChanges: true, projectAlias: project.alias,
    })
    expect(report.status).toBe('failed')
    expect(report.error?.code).toBe('DATA_ACCESS_MIGRATION_RECOVERY_REQUIRED')
    expect(report.recoveryTarget).toBe('pre_migration')
  })

  it('explicitly recovers a failed apply to the persisted source target', async () => {
    const preview = await harness.service.previewMigration(project.projectId, 'usr_1', {})
    harness.dependencies.verifyPreparedMetadata.mockRejectedValueOnce(new Error('apply failed'))
    let permissionWriteCount = 0
    harness.dependencies.applyPermissionCommands.mockImplementation(async (_commands, target) => {
      permissionWriteCount += 1
      if (permissionWriteCount === 2) throw new Error('automatic restore failed')
      harness.setCurrent(target)
    })

    const failed = await harness.service.applyMigration(project.projectId, preview.migrationId, {
      sourceDigest: preview.sourceDigest, confirmInferredPolicies: true,
      confirmDestructiveChanges: true, projectAlias: project.alias,
    })
    expect(failed.recoveryTarget).toBe('pre_migration')

    harness.dependencies.applyPermissionCommands.mockImplementation(async (_commands, target) => {
      harness.setCurrent(target)
    })
    const recovered = await harness.service.recoverMigration(project.projectId, preview.migrationId, {
      expectedRecoveryDigest: preview.sourceDigest,
      projectAlias: project.alias,
    })
    expect(recovered.status).toBe('recovered')
    expect(recovered.recoveryTarget).toBeNull()
    expect(harness.dependencies.verifyRuntime).toHaveBeenLastCalledWith(source, expect.anything(), 'compatibility')
  })

  it('previews and rolls back only an unchanged applied snapshot', async () => {
    const preview = await harness.service.previewMigration(project.projectId, 'usr_1', {})
    const appliedReport = await harness.service.applyMigration(project.projectId, preview.migrationId, {
      sourceDigest: preview.sourceDigest, confirmInferredPolicies: true,
      confirmDestructiveChanges: true, projectAlias: project.alias,
    })
    const rollbackPreview = await harness.service.previewRollback(project.projectId, appliedReport.migrationId, project.alias)
    expect(rollbackPreview.rollbackPreviewDigest).toMatch(/^[a-f0-9]{64}$/)

    const result = await harness.service.rollbackMigration(project.projectId, appliedReport.migrationId, {
      rollbackPreviewDigest: rollbackPreview.rollbackPreviewDigest!, projectAlias: project.alias,
    })
    expect(result.status).toBe('rolled_back')
    expect(harness.dependencies.verifyRuntime).toHaveBeenLastCalledWith(source, expect.anything(), 'compatibility')
  })

  it('restores the applied snapshot when rollback verification fails', async () => {
    const preview = await harness.service.previewMigration(project.projectId, 'usr_1', {})
    const appliedReport = await harness.service.applyMigration(project.projectId, preview.migrationId, {
      sourceDigest: preview.sourceDigest, confirmInferredPolicies: true,
      confirmDestructiveChanges: true, projectAlias: project.alias,
    })
    const rollbackPreview = await harness.service.previewRollback(
      project.projectId, appliedReport.migrationId, project.alias
    )
    harness.dependencies.verifyRuntime.mockRejectedValueOnce(new Error('rollback verification failed'))

    const result = await harness.service.rollbackMigration(project.projectId, appliedReport.migrationId, {
      rollbackPreviewDigest: rollbackPreview.rollbackPreviewDigest!, projectAlias: project.alias,
    })

    expect(result.status).toBe('applied')
    expect(result.error?.code).toBe('DATA_ACCESS_ROLLBACK_FAILED')
    expect(result.rollbackPreviewDigest).toBeNull()
    expect(harness.dependencies.applyPermissionCommands).toHaveBeenLastCalledWith(expect.any(Array), applied)
    expect(harness.dependencies.verifyRuntime).toHaveBeenLastCalledWith(applied, expect.anything(), 'explicit')
  })

  it('requires explicit applied-state recovery when rollback restoration cannot be verified', async () => {
    const preview = await harness.service.previewMigration(project.projectId, 'usr_1', {})
    const appliedReport = await harness.service.applyMigration(project.projectId, preview.migrationId, {
      sourceDigest: preview.sourceDigest, confirmInferredPolicies: true,
      confirmDestructiveChanges: true, projectAlias: project.alias,
    })
    const rollbackPreview = await harness.service.previewRollback(
      project.projectId, appliedReport.migrationId, project.alias
    )
    harness.dependencies.verifyRuntime.mockRejectedValue(new Error('verification unavailable'))

    const failed = await harness.service.rollbackMigration(project.projectId, appliedReport.migrationId, {
      rollbackPreviewDigest: rollbackPreview.rollbackPreviewDigest!, projectAlias: project.alias,
    })
    expect(failed.status).toBe('failed')
    expect(failed.error?.code).toBe('DATA_ACCESS_ROLLBACK_RECOVERY_REQUIRED')
    expect(failed.recoveryTarget).toBe('current_explicit')

    harness.dependencies.verifyRuntime.mockResolvedValue(undefined)
    const recovered = await harness.service.recoverMigration(project.projectId, appliedReport.migrationId, {
      expectedRecoveryDigest: appliedReport.requiredRecoveryDigest ?? harness.getRecord()!.appliedDigest!,
      projectAlias: project.alias,
    })
    expect(recovered.status).toBe('applied')
    expect(recovered.error).toBeNull()
    expect(recovered.recoveryTarget).toBeNull()
  })
})
