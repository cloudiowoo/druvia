import { randomUUID } from 'node:crypto'
import type { Project, ProjectDataAccessMode } from '@druvia/shared'
import { createApiLogger } from '../../lib/logger.js'
import * as projectService from '../project/project.service.js'
import {
  getProjectRuntimeContext,
  getRuntimeContextHasuraSessionVariables,
} from '../project/project-runtime-context.service.js'
import { hasuraMetadataRequest } from '../realtime/realtime.service.js'
import type { ProjectDataExecutionContext } from './project-data-actor.js'
import { getDataAccessInventory } from './data-access-inventory.js'
import { resolveDataScopeRole } from './data-scope-role.js'
import { materializeTableDataAccessPolicy } from './data-access-policy.js'
import { applyHasuraMetadataCommands } from './hasura-metadata-bulk.js'
import { getStoredColumnCapabilities } from './data-access-column-capabilities.js'
import {
  buildProjectMigrationPlan,
  buildProjectMigrationSnapshot,
  digestProjectMigrationSnapshot,
  digestMigrationValue,
  toPublicMigrationReport,
} from './data-access-migration-plan.js'
import {
  buildActiveRuntimeHttpContexts,
  buildMigrationRealtimeContexts,
  verifyMigrationHttpVisibility,
  verifyMigrationMetadata,
  verifyMigrationRealtimeActors,
} from './data-access-migration-verifier.js'
import {
  withProjectDataAccessMutationLock,
  type DataAccessMutationLockOptions,
} from './data-access-mutation-lock.js'
import * as defaultRepository from './data-access-migration.repository.js'
import type {
  DataAccessMigrationRecord,
  MigrationTransitionPatch,
} from './data-access-migration.repository.js'
import type {
  DataAccessMigrationOperation,
  ProjectDataAccessMigrationPlan,
  ProjectDataAccessMigrationReport,
  ProjectDataAccessMigrationSnapshot,
} from './data-access-migration.types.js'

const logger = createApiLogger({ module: 'data-access-migration' })

type ManagedProject = Project & { schemaName: string }
type MetadataCommand = { type: string; args: Record<string, unknown> }

export class DataAccessMigrationNotFoundError extends Error {
  readonly code = 'DATA_ACCESS_MIGRATION_NOT_FOUND'
}
export class DataAccessMigrationConflictError extends Error {
  constructor(message: string, readonly code = 'DATA_ACCESS_MIGRATION_CONFLICT') {
    super(message)
  }
}
export class DataAccessMigrationInputError extends Error {
  readonly code = 'INVALID_DATA_ACCESS_MIGRATION_INPUT'
}

export interface PreviewDataAccessMigrationInput {
  skipLegacyInferenceTables?: string[]
}
export interface ApplyDataAccessMigrationInput {
  sourceDigest: string
  confirmInferredPolicies: boolean
  confirmDestructiveChanges: boolean
  projectAlias?: string
}
export interface RecoverDataAccessMigrationInput {
  expectedRecoveryDigest: string
  projectAlias: string
}
export interface RollbackDataAccessMigrationInput {
  rollbackPreviewDigest: string
  projectAlias: string
}

interface MigrationRepository {
  createMigrationPreview: typeof defaultRepository.createMigrationPreview
  getLatestProjectMigration: typeof defaultRepository.getLatestProjectMigration
  getProjectMigration: typeof defaultRepository.getProjectMigration
  transitionMigration: typeof defaultRepository.transitionMigration
  setProjectDataAccessMode: typeof defaultRepository.setProjectDataAccessMode
}

export interface DataAccessMigrationServiceDependencies {
  repository: MigrationRepository
  getProject(projectId: string): Promise<Project | null>
  snapshotProject(project: ManagedProject): Promise<ProjectDataAccessMigrationSnapshot>
  applyPermissionCommands(
    commands: MetadataCommand[],
    targetSnapshot: ProjectDataAccessMigrationSnapshot
  ): Promise<void>
  verifyPreparedMetadata(
    current: ProjectDataAccessMigrationSnapshot,
    source: ProjectDataAccessMigrationSnapshot,
    plan: ProjectDataAccessMigrationPlan
  ): Promise<void>
  verifyPreparedHttp(
    current: ProjectDataAccessMigrationSnapshot,
    plan: ProjectDataAccessMigrationPlan
  ): Promise<void>
  verifyPreparedRealtime(current: ProjectDataAccessMigrationSnapshot): Promise<void>
  verifyRuntime(
    current: ProjectDataAccessMigrationSnapshot,
    plan: ProjectDataAccessMigrationPlan,
    mode: ProjectDataAccessMode
  ): Promise<void>
  withLock<T>(
    projectId: string,
    callback: () => Promise<T>,
    options: DataAccessMutationLockOptions
  ): Promise<T>
  now(): Date
  createId(): string
}

export function createDataAccessMigrationService(deps: DataAccessMigrationServiceDependencies) {
  async function getMigration(projectId: string): Promise<ProjectDataAccessMigrationReport | null> {
    const record = await deps.repository.getLatestProjectMigration(projectId)
    return record ? report(record) : null
  }

  async function previewMigration(
    projectId: string,
    createdBy: string,
    input: PreviewDataAccessMigrationInput
  ): Promise<ProjectDataAccessMigrationReport> {
    const migrationId = deps.createId()
    return deps.withLock(projectId, async () => {
      const project = await requireProject(projectId)
      if (project.dataAccessMode !== 'compatibility') {
        throw new DataAccessMigrationConflictError('Project already uses explicit data access', 'PROJECT_ALREADY_EXPLICIT')
      }
      const latest = await deps.repository.getLatestProjectMigration(projectId)
      if (latest && isRecoveryRequired(latest)) {
        throw new DataAccessMigrationConflictError('Existing migration requires recovery')
      }

      const snapshot = await deps.snapshotProject(project)
      const roles = projectRoles(projectId)
      const basePlan = buildProjectMigrationPlan(snapshot, roles)
      const skipped = input.skipLegacyInferenceTables ?? []
      validateSkippedTables(skipped, snapshot, basePlan)
      const plan = buildProjectMigrationPlan(snapshot, roles, { skipLegacyInferenceTables: skipped })
      if (latest?.status === 'preview_ready') {
        await deps.repository.transitionMigration(latest.migrationId, ['preview_ready'], {
          status: 'superseded', phase: 'completed', completedAt: deps.now(),
        })
      }
      const record = await deps.repository.createMigrationPreview({
        migrationId,
        projectId,
        sourceSnapshot: snapshot,
        migrationPlan: plan,
        sourceDigest: digestProjectMigrationSnapshot(snapshot, plan.version),
        hasDestructiveChanges: plan.destructiveChanges.length > 0,
        createdBy,
      })
      return report(record)
    }, migrationLock(migrationId))
  }

  async function applyMigration(
    projectId: string,
    migrationId: string,
    input: ApplyDataAccessMigrationInput
  ): Promise<ProjectDataAccessMigrationReport> {
    return deps.withLock(projectId, async () => {
      let record = await requireMigration(projectId, migrationId)
      const project = await requireProject(projectId)
      validateApply(record, project, input)
      const current = await deps.snapshotProject(project)
      if (digestProjectMigrationSnapshot(current, record.migrationPlan.version) !== record.sourceDigest) {
        throw new DataAccessMigrationConflictError('Migration preview is stale', 'DATA_ACCESS_MIGRATION_DRIFT')
      }

      record = await deps.repository.transitionMigration(migrationId, ['preview_ready'], {
        status: 'applying', phase: 'snapshot_check', recoveryTarget: 'source',
        startedAt: deps.now(), error: null,
      })
      try {
        const scopedTarget = buildTargetSnapshot(current, record.migrationPlan, projectRoles(projectId), true, 'compatibility')
        record = await phase(record, 'prepare_scoped_permissions')
        await deps.applyPermissionCommands(buildPermissionDiffCommands(current, scopedTarget, projectRoles(projectId)), scopedTarget)

        record = await phase(record, 'verify_scoped_metadata')
        const prepared = await deps.snapshotProject(await requireProject(projectId))
        await deps.verifyPreparedMetadata(prepared, record.sourceSnapshot, record.migrationPlan)
        record = await phase(record, 'verify_scoped_http')
        await deps.verifyPreparedHttp(prepared, record.migrationPlan)
        record = await phase(record, 'verify_scoped_realtime')
        await deps.verifyPreparedRealtime(prepared)

        const explicitTarget = buildTargetSnapshot(prepared, record.migrationPlan, projectRoles(projectId), false, 'explicit')
        record = await phase(record, 'remove_legacy_permissions')
        await deps.applyPermissionCommands(buildPermissionDiffCommands(prepared, explicitTarget, projectRoles(projectId)), explicitTarget)
        record = await phase(record, 'activate_explicit_mode')
        if (!await deps.repository.setProjectDataAccessMode(projectId, 'compatibility', 'explicit')) {
          throw new Error('Project runtime mode changed')
        }
        record = await phase(record, 'verify_active_runtime')
        const appliedSnapshot = await deps.snapshotProject(await requireProject(projectId))
        await deps.verifyRuntime(appliedSnapshot, record.migrationPlan, 'explicit')
        const now = deps.now()
        record = await deps.repository.transitionMigration(migrationId, ['applying'], {
          status: 'applied', phase: 'completed', recoveryTarget: null,
          appliedSnapshot,
          appliedDigest: digestProjectMigrationSnapshot(appliedSnapshot, record.migrationPlan.version),
          appliedAt: now, completedAt: now, error: null,
        })
        return report(record)
      } catch (error) {
        record = await restoreAfterFailure(record, 'source', error, false)
        return report(record)
      }
    }, migrationLock(migrationId))
  }

  async function recoverMigration(
    projectId: string,
    migrationId: string,
    input: RecoverDataAccessMigrationInput
  ): Promise<ProjectDataAccessMigrationReport> {
    return deps.withLock(projectId, async () => {
      let record = await requireMigration(projectId, migrationId)
      const project = await requireProject(projectId)
      if (!record.recoveryTarget || !isRecoveryRequired(record)) {
        throw new DataAccessMigrationConflictError('Migration is not eligible for recovery')
      }
      requireAlias(project, input.projectAlias)
      const digest = record.recoveryTarget === 'source' ? record.sourceDigest : record.appliedDigest
      if (!digest || input.expectedRecoveryDigest !== digest) {
        throw new DataAccessMigrationConflictError('Recovery digest does not match')
      }
      const target = record.recoveryTarget
      const activeStatus = target === 'source' ? 'applying' : 'rolling_back'
      record = await deps.repository.transitionMigration(migrationId, [record.status], {
        status: activeStatus, phase: 'restore_permissions', recoveryTarget: target, error: null,
      })
      try {
        record = await restoreTarget(record, target)
      } catch {
        record = await deps.repository.transitionMigration(migrationId, [activeStatus], {
          status: 'failed', recoveryTarget: target,
          error: {
            code: target === 'source'
              ? 'DATA_ACCESS_MIGRATION_RECOVERY_REQUIRED'
              : 'DATA_ACCESS_ROLLBACK_RECOVERY_REQUIRED',
            message: 'Recovery could not be verified',
          },
        })
        return report(record)
      }
      const terminalStatus = target === 'source' ? 'recovered' : 'applied'
      record = await deps.repository.transitionMigration(migrationId, [activeStatus], {
        status: terminalStatus, phase: 'completed', recoveryTarget: null,
        completedAt: deps.now(), rollbackPreviewDigest: null, error: null,
      })
      return report(record)
    }, migrationLock(migrationId))
  }

  async function previewRollback(
    projectId: string,
    migrationId: string,
    projectAlias: string
  ): Promise<ProjectDataAccessMigrationReport> {
    return deps.withLock(projectId, async () => {
      let record = await requireMigration(projectId, migrationId)
      const project = await requireProject(projectId)
      requireAlias(project, projectAlias)
      const latest = await deps.repository.getLatestProjectMigration(projectId)
      if (record.status !== 'applied' || latest?.migrationId !== migrationId || !record.appliedDigest) {
        throw new DataAccessMigrationConflictError('Rollback is unavailable')
      }
      const current = await deps.snapshotProject(project)
      if (digestProjectMigrationSnapshot(current, record.migrationPlan.version) !== record.appliedDigest) {
        throw new DataAccessMigrationConflictError('Applied data access metadata has changed', 'DATA_ACCESS_MIGRATION_DRIFT')
      }
      const rollbackPreviewDigest = digestMigrationValue({
        migrationId, appliedDigest: record.appliedDigest,
        sourceDigest: record.sourceDigest, projectAlias,
      })
      record = await deps.repository.transitionMigration(migrationId, ['applied'], { rollbackPreviewDigest })
      return report(record)
    }, migrationLock(migrationId))
  }

  async function rollbackMigration(
    projectId: string,
    migrationId: string,
    input: RollbackDataAccessMigrationInput
  ): Promise<ProjectDataAccessMigrationReport> {
    return deps.withLock(projectId, async () => {
      let record = await requireMigration(projectId, migrationId)
      const project = await requireProject(projectId)
      requireAlias(project, input.projectAlias)
      if (record.status !== 'applied' || !record.rollbackPreviewDigest
        || record.rollbackPreviewDigest !== input.rollbackPreviewDigest || !record.appliedSnapshot) {
        throw new DataAccessMigrationConflictError('Rollback confirmation is stale')
      }
      const current = await deps.snapshotProject(project)
      if (digestProjectMigrationSnapshot(current, record.migrationPlan.version) !== record.appliedDigest) {
        throw new DataAccessMigrationConflictError('Applied data access metadata has changed', 'DATA_ACCESS_MIGRATION_DRIFT')
      }
      record = await deps.repository.transitionMigration(migrationId, ['applied'], {
        status: 'rolling_back', phase: 'rollback_snapshot_check', recoveryTarget: 'applied',
        rollbackPreviewDigest: null, startedAt: deps.now(), error: null,
      })
      try {
        record = await phase(record, 'restore_permissions')
        await deps.applyPermissionCommands(
          buildPermissionDiffCommands(current, record.sourceSnapshot, projectRoles(projectId)),
          record.sourceSnapshot
        )
        record = await phase(record, 'restore_runtime_mode')
        await ensureMode(projectId, 'compatibility')
        record = await phase(record, 'verify_recovery_target')
        const restored = await deps.snapshotProject(await requireProject(projectId))
        if (digestProjectMigrationSnapshot(restored, record.migrationPlan.version) !== record.sourceDigest) {
          throw new Error('Rollback target digest mismatch')
        }
        await deps.verifyRuntime(restored, record.migrationPlan, 'compatibility')
        record = await deps.repository.transitionMigration(migrationId, ['rolling_back'], {
          status: 'rolled_back', phase: 'completed', recoveryTarget: null,
          completedAt: deps.now(), error: null,
        })
        return report(record)
      } catch (error) {
        record = await restoreAfterFailure(record, 'applied', error, true)
        return report(record)
      }
    }, migrationLock(migrationId))
  }

  async function phase(
    record: DataAccessMigrationRecord,
    next: MigrationTransitionPatch['phase']
  ): Promise<DataAccessMigrationRecord> {
    return deps.repository.transitionMigration(record.migrationId, [record.status], { phase: next })
  }

  async function restoreAfterFailure(
    record: DataAccessMigrationRecord,
    target: 'source' | 'applied',
    originalError: unknown,
    rollback: boolean
  ): Promise<DataAccessMigrationRecord> {
    const failedPhase = record.phase
    logger.error('Project data access migration operation failed', {
      projectId: record.projectId,
      migrationId: record.migrationId,
      phase: failedPhase,
      recoveryTarget: target,
    }, originalError)
    try {
      record = await restoreTarget(record, target)
      return deps.repository.transitionMigration(record.migrationId, [record.status], {
        status: rollback ? 'applied' : 'failed',
        phase: rollback ? 'completed' : failedPhase,
        recoveryTarget: null,
        rollbackPreviewDigest: null, completedAt: deps.now(),
        error: {
          code: rollback ? 'DATA_ACCESS_ROLLBACK_FAILED' : 'DATA_ACCESS_MIGRATION_APPLY_FAILED',
          message: rollback ? 'Rollback failed; the explicit state was restored' : 'Migration failed; the previous state was restored',
        },
      })
    } catch {
      return deps.repository.transitionMigration(record.migrationId, [record.status], {
        status: 'failed', recoveryTarget: target,
        error: {
          code: rollback
            ? 'DATA_ACCESS_ROLLBACK_RECOVERY_REQUIRED'
            : 'DATA_ACCESS_MIGRATION_RECOVERY_REQUIRED',
          message: 'Automatic recovery could not be verified',
        },
      })
    }
  }

  async function restoreTarget(
    record: DataAccessMigrationRecord,
    target: 'source' | 'applied'
  ): Promise<DataAccessMigrationRecord> {
    const targetSnapshot = target === 'source' ? record.sourceSnapshot : record.appliedSnapshot
    const expectedDigest = target === 'source' ? record.sourceDigest : record.appliedDigest
    const mode: ProjectDataAccessMode = target === 'source' ? 'compatibility' : 'explicit'
    if (!targetSnapshot || !expectedDigest) throw new Error('Recovery target is unavailable')
    record = await phase(record, 'restore_permissions')
    const current = await deps.snapshotProject(await requireProject(record.projectId))
    const commands = buildPermissionDiffCommands(current, targetSnapshot, projectRoles(record.projectId))
    if (commands.length > 0) await deps.applyPermissionCommands(commands, targetSnapshot)
    record = await phase(record, 'restore_runtime_mode')
    await ensureMode(record.projectId, mode)
    record = await phase(record, 'verify_recovery_target')
    const restored = await deps.snapshotProject(await requireProject(record.projectId))
    if (digestProjectMigrationSnapshot(restored, record.migrationPlan.version) !== expectedDigest) {
      throw new Error('Recovery target digest mismatch')
    }
    await deps.verifyRuntime(restored, record.migrationPlan, mode)
    return record
  }

  async function ensureMode(projectId: string, mode: ProjectDataAccessMode): Promise<void> {
    const current = await requireProject(projectId)
    if (current.dataAccessMode === mode) return
    if (!await deps.repository.setProjectDataAccessMode(projectId, current.dataAccessMode, mode)) {
      throw new Error('Project runtime mode changed during recovery')
    }
  }

  async function requireProject(projectId: string): Promise<ManagedProject> {
    const project = await deps.getProject(projectId)
    if (!project?.schemaName) throw new DataAccessMigrationNotFoundError('Project or schema not found')
    return project as ManagedProject
  }

  async function requireMigration(projectId: string, migrationId: string): Promise<DataAccessMigrationRecord> {
    const record = await deps.repository.getProjectMigration(projectId, migrationId)
    if (!record) throw new DataAccessMigrationNotFoundError('Migration not found')
    return record
  }

  return {
    getMigration,
    previewMigration,
    applyMigration,
    recoverMigration,
    previewRollback,
    rollbackMigration,
  }
}

function validateApply(
  record: DataAccessMigrationRecord,
  project: ManagedProject,
  input: ApplyDataAccessMigrationInput
): void {
  if (record.status !== 'preview_ready' || project.dataAccessMode !== 'compatibility') {
    throw new DataAccessMigrationConflictError('Migration cannot be applied in its current state')
  }
  if (record.migrationPlan.version !== 2) {
    throw new DataAccessMigrationConflictError('Migration preview must be regenerated')
  }
  if (record.migrationPlan.blockers.length > 0) {
    throw new DataAccessMigrationConflictError('Migration plan contains blockers')
  }
  if (input.sourceDigest !== record.sourceDigest) throw new DataAccessMigrationConflictError('Source digest does not match')
  const inferred = record.migrationPlan.targetPolicies.some((item) => item.inferredOperations.length > 0)
  const destructive = record.migrationPlan.destructiveChanges.length > 0
  if (inferred && !input.confirmInferredPolicies) throw new DataAccessMigrationInputError('Inferred policies require confirmation')
  if (destructive && !input.confirmDestructiveChanges) throw new DataAccessMigrationInputError('Destructive changes require confirmation')
  if ((inferred || destructive) && input.projectAlias !== project.alias) {
    throw new DataAccessMigrationInputError('Project alias confirmation does not match')
  }
}

function validateSkippedTables(
  skipped: string[],
  snapshot: ProjectDataAccessMigrationSnapshot,
  plan: ProjectDataAccessMigrationPlan
): void {
  if (new Set(skipped).size !== skipped.length) throw new DataAccessMigrationInputError('Skipped tables contain duplicates')
  for (const tableName of skipped) {
    const table = snapshot.tables.find((item) => item.tableName === tableName)
    if (!table || table.inventoryStatus !== 'managed_table'
      || plan.blockers.some((blocker) => blocker.tableName === tableName)) {
      throw new DataAccessMigrationConflictError(`Table cannot be skipped: ${tableName}`)
    }
  }
}

function requireAlias(project: ManagedProject, alias: string): void {
  if (!alias || alias !== project.alias) throw new DataAccessMigrationInputError('Project alias confirmation does not match')
}

function isRecoveryRequired(record: DataAccessMigrationRecord): boolean {
  return !!record.recoveryTarget && (
    record.status === 'applying'
    || record.status === 'rolling_back'
    || (record.status === 'failed' && (
      record.error?.code === 'DATA_ACCESS_MIGRATION_RECOVERY_REQUIRED'
      || record.error?.code === 'DATA_ACCESS_ROLLBACK_RECOVERY_REQUIRED'
    ))
  )
}

function report(record: DataAccessMigrationRecord): ProjectDataAccessMigrationReport {
  return toPublicMigrationReport({
    migrationId: record.migrationId,
    projectId: record.projectId,
    status: record.status,
    phase: record.phase,
    sourceDigest: record.sourceDigest,
    appliedDigest: record.appliedDigest,
    recoveryTarget: record.recoveryTarget,
    appliedAt: record.appliedAt?.toISOString() ?? null,
    rollbackPreviewDigest: record.rollbackPreviewDigest,
    error: record.error,
    plan: record.migrationPlan,
  })
}

function projectRoles(projectId: string) {
  return {
    authenticated: resolveDataScopeRole({ projectId, actor: 'authenticated' }),
    anonymous: resolveDataScopeRole({ projectId, actor: 'anonymous' }),
  }
}

function migrationLock(migrationId: string): DataAccessMutationLockOptions {
  return { purpose: 'migration', migrationId, operationId: randomUUID() }
}

function buildTargetSnapshot(
  current: ProjectDataAccessMigrationSnapshot,
  plan: ProjectDataAccessMigrationPlan,
  roles: ReturnType<typeof projectRoles>,
  preserveLegacy: boolean,
  runtimeMode: ProjectDataAccessMode
): ProjectDataAccessMigrationSnapshot {
  return {
    ...current,
    runtimeMode,
    tables: current.tables.map((table) => {
      const target = plan.targetPolicies.find((item) => item.tableName === table.tableName)
      if (!target) return table
      const managed = materializeTableDataAccessPolicy(target.policy, {
        roles,
        capabilities: getStoredColumnCapabilities(table),
      })
      return {
        ...table,
        permissions: [
          ...table.permissions.filter((item) => (
            item.role !== roles.authenticated
            && item.role !== roles.anonymous
            && (preserveLegacy || (item.role !== 'user' && item.role !== 'anonymous'))
          )),
          ...managed,
        ].sort(comparePermission),
      }
    }),
  }
}

export function buildPermissionDiffCommands(
  current: ProjectDataAccessMigrationSnapshot,
  target: ProjectDataAccessMigrationSnapshot,
  roles: ReturnType<typeof projectRoles>
): MetadataCommand[] {
  const relevantRoles = new Set(['user', 'anonymous', roles.authenticated, roles.anonymous])
  const drops: MetadataCommand[] = []
  const creates: MetadataCommand[] = []
  const tableNames = new Set([...current.tables, ...target.tables].map((table) => table.tableName))
  for (const tableName of [...tableNames].sort()) {
    const currentTable = current.tables.find((table) => table.tableName === tableName)
    const targetTable = target.tables.find((table) => table.tableName === tableName)
    for (const role of [...relevantRoles].sort()) {
      for (const operation of ['select', 'insert', 'update', 'delete'] as DataAccessMigrationOperation[]) {
        const before = currentTable?.permissions.find((item) => item.role === role && item.operation === operation)
        const after = targetTable?.permissions.find((item) => item.role === role && item.operation === operation)
        if (before && (!after || !samePermission(before.permission, after.permission))) {
          drops.push({
            type: `pg_drop_${operation}_permission`,
            args: { source: 'default', table: { schema: current.schemaName, name: tableName }, role },
          })
        }
        if (after && (!before || !samePermission(before.permission, after.permission))) {
          creates.push({
            type: `pg_create_${operation}_permission`,
            args: {
              source: 'default', table: { schema: target.schemaName, name: tableName },
              role, permission: after.permission,
            },
          })
        }
      }
    }
  }
  return [...drops, ...creates]
}

function samePermission(left: unknown, right: unknown): boolean {
  return digestMigrationValue(left) === digestMigrationValue(right)
}

function comparePermission(
  left: { role: string; operation: DataAccessMigrationOperation },
  right: { role: string; operation: DataAccessMigrationOperation }
): number {
  return `${left.role}:${left.operation}`.localeCompare(`${right.role}:${right.operation}`)
}

export const defaultDataAccessMigrationDependencies: DataAccessMigrationServiceDependencies = {
  repository: defaultRepository,
  getProject: projectService.getProjectById,
  async snapshotProject(project) {
    const [inventory, metadata] = await Promise.all([
      getDataAccessInventory(project.schemaName),
      hasuraMetadataRequest<{ sources?: Record<string, unknown>[] }>('export_metadata', {}),
    ])
    const source = metadata.sources?.find((item) => item.name === 'default')
    if (!source) throw new Error('Default Hasura source is unavailable')
    return buildProjectMigrationSnapshot({
      projectId: project.projectId,
      schemaName: project.schemaName,
      runtimeMode: project.dataAccessMode,
      roles: projectRoles(project.projectId),
      inventory,
      source,
      metadata,
    })
  },
  async applyPermissionCommands(commands) {
    await applyHasuraMetadataCommands(commands)
  },
  async verifyPreparedMetadata(current, source, plan) {
    const roles = projectRoles(current.projectId)
    verifyMigrationMetadata({ currentSnapshot: current, sourceSnapshot: source, plan, roles, stage: 'prepared' })
  },
  async verifyPreparedHttp(current, plan) {
    const roles = projectRoles(current.projectId)
    const runtimeSessionVariables = getRuntimeContextHasuraSessionVariables(
      await getProjectRuntimeContext(current.projectId),
    )
    const contexts: Array<{
      actor: 'authenticated' | 'anonymous'
      context: ProjectDataExecutionContext
    }> = [
      {
        actor: 'authenticated' as const,
        context: {
          kind: 'project_actor' as const,
          role: roles.authenticated,
          sessionVariables: {
            'x-hasura-user-id': `migration-probe:${current.projectId}`,
            'x-hasura-project-id': current.projectId,
            'x-hasura-actor-type': 'project_user',
            ...runtimeSessionVariables,
          },
        },
      },
      {
        actor: 'anonymous' as const,
        context: {
          kind: 'project_actor' as const,
          role: roles.anonymous,
          sessionVariables: {
            'x-hasura-project-id': current.projectId,
            'x-hasura-actor-type': 'apikey',
            ...runtimeSessionVariables,
          },
        },
      },
    ]
    for (const item of contexts) {
      await verifyMigrationHttpVisibility({
        schemaName: current.schemaName, plan, snapshot: current,
        actor: item.actor, context: item.context,
      })
    }
  },
  async verifyPreparedRealtime(current) {
    const runtimeSessionVariables = getRuntimeContextHasuraSessionVariables(
      await getProjectRuntimeContext(current.projectId),
    )
    await verifyMigrationRealtimeActors({
      projectId: current.projectId,
      runtimeMode: 'compatibility',
      contexts: buildMigrationRealtimeContexts(current.projectId, 'explicit', runtimeSessionVariables),
    })
  },
  async verifyRuntime(current, plan, mode) {
    const roles = projectRoles(current.projectId)
    const runtimeSessionVariables = getRuntimeContextHasuraSessionVariables(
      await getProjectRuntimeContext(current.projectId),
    )
    const runtimePlan = mode === 'explicit'
      ? plan
      : buildProjectMigrationPlan(current, roles)
    if (mode === 'explicit') {
      verifyMigrationMetadata({
        currentSnapshot: current,
        sourceSnapshot: current,
        plan,
        roles,
        stage: 'legacy_removed',
      })
    }
    const contexts = mode === 'explicit'
      ? buildActiveRuntimeHttpContexts(current.projectId, mode, runtimeSessionVariables)
      : [
          {
            actor: 'authenticated' as const,
            context: { kind: 'project_actor' as const, role: 'user', sessionVariables: runtimeSessionVariables },
          },
          {
            actor: 'anonymous' as const,
            context: { kind: 'project_actor' as const, role: 'anonymous', sessionVariables: runtimeSessionVariables },
          },
        ]
    for (const item of contexts) {
      await verifyMigrationHttpVisibility({
        schemaName: current.schemaName, plan: runtimePlan, snapshot: current,
        actor: item.actor, context: item.context,
      })
    }
    await verifyMigrationRealtimeActors({
      projectId: current.projectId,
      runtimeMode: mode,
      runtimeSessionVariables,
    })
  },
  withLock: withProjectDataAccessMutationLock as DataAccessMigrationServiceDependencies['withLock'],
  now: () => new Date(),
  createId: () => randomUUID(),
}

const service = createDataAccessMigrationService(defaultDataAccessMigrationDependencies)
export const getDataAccessMigration = service.getMigration
export const previewDataAccessMigration = service.previewMigration
export const applyDataAccessMigration = service.applyMigration
export const recoverDataAccessMigration = service.recoverMigration
export const previewDataAccessMigrationRollback = service.previewRollback
export const rollbackDataAccessMigration = service.rollbackMigration
