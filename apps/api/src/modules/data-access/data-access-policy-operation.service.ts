import { randomUUID } from 'node:crypto'
import type { PoolClient } from 'pg'
import { createApiLogger } from '../../lib/logger.js'
import * as projectService from '../project/project.service.js'
import * as tableService from '../table/table.service.js'
import {
  HasuraMetadataRequestError,
  hasuraMetadataRequestWithOptions,
} from '../realtime/realtime.service.js'
import { resolveDataScopeRole } from './data-scope-role.js'
import { buildTableColumnCapabilities } from './data-access-column-capabilities.js'
import {
  inspectTableDataAccessMetadata,
  materializeInspectedTableDataAccess,
  type HasuraTableMetadata,
  type InspectedTableDataAccess,
} from './data-access-inspection.js'
import {
  buildColumnCapabilityDrift,
  capabilitiesEqual,
  classifyManagedPolicyState,
  createPermissionSnapshot,
  isRecoverablePermissionSnapshot,
  isPolicyOperationRecoveryRequired,
  materializeReconcileGrants,
  normalizeColumnGrantsForPolicy,
  policyOperationRecoverySafeAt,
  validateReconcilePolicyTransition,
  permissionSnapshotDigest,
  stableDigest,
} from './data-access-managed-policy.js'
import {
  createPolicyOperation,
  getManagedPolicyWithClient,
  getManagedPolicy,
  getPolicyOperation,
  getPolicyOperationWithClient,
  getProjectPolicyOperation,
  PolicyOperationWriterLeaseError,
  renewPolicyOperationWriterLease,
  saveManagedPolicy,
  supersedePolicyPreviews,
  transitionPolicyOperation,
  type ManagedPolicyRecord,
  type PolicyOperationRecord,
} from './data-access-managed-policy.repository.js'
import { withProjectDataAccessMutationLock } from './data-access-mutation-lock.js'
import {
  materializeTableDataAccessPolicy,
  validateTableDataAccessInput,
} from './data-access-policy.js'
import {
  applyHasuraMetadataCommands,
  replaceHasuraTablePermissions,
  type HasuraMetadataCommand,
  type HasuraMetadataDocument,
} from './hasura-metadata-bulk.js'
import type {
  DataAccessColumnCapabilities,
  DataAccessColumnGrants,
  DataAccessPolicyOperationState,
  DataAccessPolicyPreview,
  MaterializedDataPermission,
  TableDataAccessInput,
  TableDataAccessState,
  TableDataAccessUpdateInput,
} from './data-access.types.js'

interface HasuraMetadata {
  sources?: Array<{ name?: string; tables?: HasuraTableMetadata[] }>
}

interface VersionedMetadataExport {
  resource_version: number
  metadata: HasuraMetadata
}

const logger = createApiLogger({ module: 'data-access-policy-operation' })
const POLICY_WRITER_LEASE_MS = 30_000

interface OperationContext {
  projectId: string
  projectAlias: string
  schemaName: string
  tableName: string
  capabilities: DataAccessColumnCapabilities
  roles: { authenticated: string; anonymous: string }
  tableMetadata: HasuraTableMetadata | null
  metadata: HasuraMetadata
  inspected: InspectedTableDataAccess
  resourceVersion: bigint
}

export class DataAccessPolicyOperationError extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
    this.name = 'DataAccessPolicyOperationError'
  }
}

export interface AdoptionApplyInput {
  operationId: string
  sourceDigest: string
  projectAlias: string
}

export interface ReconcilePreviewInput {
  columnGrants?: DataAccessColumnGrants
  policy?: TableDataAccessInput
}

export interface ReconcileApplyInput {
  operationId: string
  sourceDigest: string
  targetDigest: string
  baselineRevision: number
  projectAlias: string
  columnGrants: DataAccessColumnGrants
  policy: TableDataAccessInput
}

export interface RecoverPolicyOperationInput {
  sourceDigest: string
  projectAlias: string
}

export async function updateManagedTablePolicy(
  projectId: string,
  tableName: string,
  input: TableDataAccessUpdateInput,
  actorId: string,
  getState: () => Promise<TableDataAccessState>
): Promise<TableDataAccessState> {
  assertOperationId(input.operationId)
  const requestDigest = stableDigest({ projectId, tableName, input })
  const prior = await getPolicyOperation(projectId, input.operationId)
  if (prior) {
    assertIdempotentRequest(prior, requestDigest)
    return withProjectDataAccessMutationLock(projectId, async (client) => {
      const current = await getPolicyOperationWithClient(client, projectId, input.operationId)
      if (!current) throw stale('Policy operation no longer exists')
      assertIdempotentRequest(current, requestDigest)
      return resolveExistingPolicyUpdate(client, current, actorId, getState)
    }, { purpose: 'policy_operation', operationId: input.operationId })
  }

  return withProjectDataAccessMutationLock(projectId, async (client) => {
    const existing = await getPolicyOperationWithClient(client, projectId, input.operationId)
    if (existing) {
      assertIdempotentRequest(existing, requestDigest)
      return resolveExistingPolicyUpdate(client, existing, actorId, getState)
    }
    await supersedePolicyPreviews(client, projectId)
    const tracked = await tableService.trackTableInHasura(
      (await requireProject(projectId)).schemaName!, tableName
    )
    if (!tracked) {
      throw new DataAccessPolicyOperationError(
        'DATA_ACCESS_UPSTREAM_ERROR', 'Unable to connect table to data interface'
      )
    }
    const context = await loadOperationContext(projectId, tableName)
    const baseline = await getManagedPolicyWithClient(client, projectId, context.schemaName, tableName)
    const state = classify(context, baseline, null)
    if (state === 'adoption_required') {
      throw conflict('DATA_ACCESS_ADOPTION_REQUIRED', 'Existing data access rules require adoption')
    }
    if (state === 'refresh_required') {
      throw conflict('DATA_ACCESS_REFRESH_REQUIRED', 'Table structure changes require reconciliation')
    }
    if (state === 'custom') {
      throw conflict('DATA_ACCESS_CUSTOM_POLICY', 'Custom data access rules cannot be overwritten')
    }
    if (state === 'recovery_required') {
      throw conflict('DATA_ACCESS_RECONCILE_RECOVERY_REQUIRED', 'Data access recovery is required')
    }

    validateTableDataAccessInput(input, context.capabilities)
    validateExpectedRevision(input, baseline)
    const grants = normalizeColumnGrantsForPolicy(
      input,
      resolvePolicyUpdateGrants(input, baseline, context.capabilities)
    )
    validateColumnGrantModes(input, grants)
    const targetPermissions = createPermissionSnapshot(materializeTableDataAccessPolicy(input, {
      roles: context.roles,
      capabilities: context.capabilities,
      columnGrants: grants,
    }))
    const sourcePermissions = snapshotManagedSource(context, baseline)
    const sourceDigest = createSourceDigest(context, baseline, sourcePermissions)
    const targetDigest = createTargetDigest(
      stripUpdateEnvelope(input), grants, context.capabilities, targetPermissions
    )

    const operation = await createPolicyOperation(client, {
      operationId: input.operationId,
      projectId,
      schemaName: context.schemaName,
      tableName,
      kind: 'policy_update',
      baselineRevision: baseline?.revision ?? null,
      sourceCapabilities: context.capabilities,
      sourcePermissions,
      sourceDigest,
      sourceResourceVersion: context.resourceVersion,
      targetPolicy: stripUpdateEnvelope(input),
      targetColumnGrants: grants,
      targetCapabilities: context.capabilities,
      targetPermissions,
      targetDigest,
      requestDigest,
      createdBy: actorId,
    })
    if (baseline && isVerifiedNoop(
      baseline, input, grants, context.capabilities, targetPermissions
    )) {
      await transitionPolicyOperation(client, operation.operationId, ['preview_ready'], {
        status: 'completed', phase: 'completed', completedAt: new Date(),
      })
      return getState()
    }
    await applyPolicyOperation(client, context, operation, actorId)
    return getState()
  }, { purpose: 'policy_operation', operationId: input.operationId })
}

async function resolveExistingPolicyUpdate(
  client: PoolClient,
  operation: PolicyOperationRecord,
  actorId: string,
  getState: () => Promise<TableDataAccessState>
): Promise<TableDataAccessState> {
  await assertOperationSchemaCurrent(operation)
  if (operation.status === 'completed') {
    assertCompletedOperationCurrent(
      operation,
      await getManagedPolicyWithClient(
        client, operation.projectId, operation.schemaName, operation.tableName
      )
    )
    return getState()
  }
  if (operation.status === 'preview_ready' && operation.kind === 'policy_update') {
    const context = await loadOperationContext(operation.projectId, operation.tableName)
    await applyPolicyOperation(client, context, operation, actorId)
    return getState()
  }
  throwPriorOperationState(operation)
}

export async function previewPolicyAdoption(
  projectId: string,
  tableName: string,
  actorId: string
): Promise<DataAccessPolicyPreview> {
  const operationId = createOperationId()
  return withProjectDataAccessMutationLock(projectId, async (client) => {
    await supersedePolicyPreviews(client, projectId)
    const context = await loadOperationContext(projectId, tableName)
    const baseline = await getManagedPolicyWithClient(client, projectId, context.schemaName, tableName)
    if (classify(context, baseline, null) !== 'adoption_required') {
      throw conflict('DATA_ACCESS_ADOPTION_REQUIRED', 'Table does not have adoptable data access rules')
    }
    const permissions = snapshotInspected(context)
    const sourceDigest = createSourceDigest(context, null, permissions)
    const targetDigest = createTargetDigest(
      context.inspected.policy,
      context.inspected.columnGrants,
      context.capabilities,
      permissions
    )
    const operation = await createPolicyOperation(client, {
      operationId, projectId, schemaName: context.schemaName, tableName,
      kind: 'adoption', baselineRevision: null,
      sourceCapabilities: context.capabilities, sourcePermissions: permissions, sourceDigest,
      sourceResourceVersion: context.resourceVersion, targetPolicy: context.inspected.policy,
      targetColumnGrants: context.inspected.columnGrants,
      targetCapabilities: context.capabilities, targetPermissions: permissions, targetDigest,
      requestDigest: stableDigest({ projectId, tableName, sourceDigest, kind: 'adoption' }),
      createdBy: actorId,
    })
    return toPreview(context, operation, null)
  }, { purpose: 'policy_operation', operationId })
}

export async function applyPolicyAdoption(
  projectId: string,
  tableName: string,
  input: AdoptionApplyInput,
  actorId: string,
  getState: () => Promise<TableDataAccessState>
): Promise<TableDataAccessState> {
  return withProjectDataAccessMutationLock(projectId, async (client) => {
    const operation = await requireOperation(client, projectId, input.operationId, 'adoption')
    assertOperationConfirmation(operation, input.sourceDigest, null)
    await assertOperationSchemaCurrent(operation)
    const context = await loadOperationContext(projectId, tableName)
    assertProjectAlias(context, input.projectAlias)
    if (operation.tableName !== tableName) throw stale('Adoption target changed')
    assertOperationContext(operation, context)
    const baseline = await getManagedPolicyWithClient(client, projectId, context.schemaName, tableName)
    if (operation.status === 'completed') {
      assertCompletedOperationCurrent(operation, baseline)
      return getState()
    }
    if (baseline) {
      throw stale('Adoption target changed')
    }
    const current = snapshotInspected(context)
    if (createSourceDigest(context, null, current) !== operation.sourceDigest) throw stale()
    await client.query('BEGIN')
    try {
      await saveManagedPolicy(client, {
        projectId, tableName, schemaName: context.schemaName,
        policy: operation.targetPolicy!, columnGrants: operation.targetColumnGrants!,
        capabilitiesSnapshot: context.capabilities, permissionsSnapshot: current,
        metadataDigest: permissionSnapshotDigest(current), actorId, expectedRevision: null,
      })
      await transitionPolicyOperation(client, operation.operationId, ['preview_ready'], {
        status: 'completed', phase: 'completed', completedAt: new Date(),
      })
      await client.query('COMMIT')
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    }
    return getState()
  }, { purpose: 'policy_operation', operationId: input.operationId })
}

export async function previewPolicyReconcile(
  projectId: string,
  tableName: string,
  actorId: string,
  input: ReconcilePreviewInput = {}
): Promise<DataAccessPolicyPreview> {
  const operationId = createOperationId()
  return withProjectDataAccessMutationLock(projectId, async (client) => {
    await supersedePolicyPreviews(client, projectId)
    const context = await loadOperationContext(projectId, tableName)
    const baseline = await getManagedPolicyWithClient(client, projectId, context.schemaName, tableName)
    if (!baseline || classify(context, baseline, null) !== 'refresh_required') {
      throw conflict('DATA_ACCESS_REFRESH_REQUIRED', 'Table does not require reconciliation')
    }
    const policy = input.policy ?? materializeSafeReconcilePolicy(
      baseline.policy, context.capabilities
    )
    try {
      validateReconcilePolicyTransition(baseline.policy, policy)
    } catch (error) {
      throw new DataAccessPolicyOperationError(
        'INVALID_DATA_ACCESS_POLICY',
        error instanceof Error ? error.message : 'Reconciliation cannot broaden data access'
      )
    }
    validateTableDataAccessInput(policy, context.capabilities)
    const grants = normalizeColumnGrantsForPolicy(
      policy,
      input.columnGrants ?? materializeReconcileGrants(
        baseline.columnGrants, context.capabilities
      )
    )
    validateColumnGrantModes(policy, grants)
    const targetPermissions = createPermissionSnapshot(materializeTableDataAccessPolicy(
      policy,
      { roles: context.roles, capabilities: context.capabilities, columnGrants: grants }
    ))
    const sourcePermissions = snapshotManagedSource(context, baseline)
    const sourceDigest = createSourceDigest(context, baseline, sourcePermissions)
    const targetDigest = createTargetDigest(
      policy, grants, context.capabilities, targetPermissions
    )
    const operation = await createPolicyOperation(client, {
      operationId, projectId, schemaName: context.schemaName, tableName,
      kind: 'reconcile', baselineRevision: baseline.revision,
      sourceCapabilities: context.capabilities, sourcePermissions, sourceDigest,
      sourceResourceVersion: context.resourceVersion, targetPolicy: policy,
      targetColumnGrants: grants, targetCapabilities: context.capabilities,
      targetPermissions, targetDigest,
      requestDigest: stableDigest({ projectId, tableName, sourceDigest, targetDigest }),
      createdBy: actorId,
    })
    return toPreview(context, operation, buildColumnCapabilityDrift(
      baseline.capabilitiesSnapshot, context.capabilities
    ))
  }, { purpose: 'policy_operation', operationId })
}

export async function applyPolicyReconcile(
  projectId: string,
  tableName: string,
  input: ReconcileApplyInput,
  actorId: string,
  getState: () => Promise<TableDataAccessState>
): Promise<TableDataAccessState> {
  return withProjectDataAccessMutationLock(projectId, async (client) => {
    const operation = await requireOperation(client, projectId, input.operationId, 'reconcile')
    assertOperationConfirmation(operation, input.sourceDigest, input.targetDigest)
    await assertOperationSchemaCurrent(operation)
    if (operation.baselineRevision !== BigInt(input.baselineRevision)) throw stale()
    if (stableDigest(operation.targetColumnGrants) !== stableDigest(input.columnGrants)) throw stale()
    if (stableDigest(operation.targetPolicy) !== stableDigest(input.policy)) throw stale()
    const context = await loadOperationContext(projectId, tableName)
    assertOperationContext(operation, context)
    assertProjectAlias(context, input.projectAlias)
    if (operation.tableName !== tableName) throw stale('Reconciliation target changed')
    const baseline = await getManagedPolicyWithClient(client, projectId, context.schemaName, tableName)
    if (operation.status === 'completed') {
      assertCompletedOperationCurrent(operation, baseline)
      return getState()
    }
    if (!baseline || baseline.revision !== operation.baselineRevision) throw stale()
    if (createSourceDigest(
      context,
      baseline,
      snapshotManagedSource(context, baseline)
    ) !== operation.sourceDigest) {
      throw stale()
    }
    await applyPolicyOperation(client, context, operation, actorId)
    return getState()
  }, { purpose: 'policy_operation', operationId: input.operationId })
}

export async function getActivePolicyOperation(
  projectId: string
): Promise<DataAccessPolicyOperationState | null> {
  const operation = await getProjectPolicyOperation(projectId)
  return operation ? toOperationState(operation) : null
}

export async function recoverPolicyOperation(
  projectId: string,
  operationId: string,
  input: RecoverPolicyOperationInput
): Promise<DataAccessPolicyOperationState> {
  return withProjectDataAccessMutationLock(projectId, async (client) => {
    const operation = await requireOperation(client, projectId, operationId)
    if (!['applying', 'recovering', 'recovery_required'].includes(operation.status)) {
      return toOperationState(operation)
    }
    if (operation.sourceDigest !== input.sourceDigest) throw stale('Recovery source changed')
    await assertOperationSchemaCurrent(operation)
    const context = await loadOperationContext(projectId, operation.tableName)
    assertOperationContext(operation, context)
    const baseline = await getManagedPolicyWithClient(
      client, projectId, context.schemaName, operation.tableName
    )
    assertProjectAlias(context, input.projectAlias)
    const safeAfter = policyOperationRecoverySafeAt(operation)
    if (safeAfter === null || Date.now() < safeAfter) {
      throw conflict('DATA_ACCESS_POLICY_OPERATION_IN_PROGRESS', 'Metadata writer may still be active')
    }
    const current = snapshotRecoveryPermissions(context)
    assertRecoverablePermissionState(current, operation)
    const commands = buildPermissionCommands(context, current, operation.sourcePermissions)
    const writerEpoch = randomUUID()
    const deadline = new Date(Date.now() + POLICY_WRITER_LEASE_MS)
    await transitionPolicyOperation(client, operationId, [operation.status], {
      status: 'recovering', phase: 'restore_source', writerEpoch, writeDeadlineAt: deadline,
    })
    try {
      const renewWriterLease = () => renewPolicyOperationWriterLease(
        client,
        operationId,
        'recovering',
        writerEpoch,
        new Date(Date.now() + POLICY_WRITER_LEASE_MS)
      )
      await renewWriterLease()
      if (commands.length > 0) {
        await applyPermissionMutation(
          context,
          current,
          operation.sourcePermissions,
          context.resourceVersion,
          renewWriterLease
        )
      } else {
        await hasuraMetadataRequestWithOptions('pg_set_table_customization', {
          source: 'default',
          table: { schema: context.schemaName, name: context.tableName },
          configuration: context.tableMetadata?.configuration ?? {},
        }, { resourceVersion: context.resourceVersion, timeoutMs: 30_000 })
      }
      const restored = await loadOperationContext(projectId, operation.tableName)
      if (permissionSnapshotDigest(snapshotWithCapabilities(
        restored,
        baseline?.revision === operation.baselineRevision
          ? baseline.capabilitiesSnapshot
          : operation.sourceCapabilities
      ))
        !== permissionSnapshotDigest(operation.sourcePermissions)) throw new Error('Source verification failed')
      if (restored.resourceVersion <= context.resourceVersion) {
        throw new Error('Recovery resource version did not advance')
      }
      const completed = await transitionPolicyOperation(client, operationId, ['recovering'], {
        status: 'failed', phase: 'completed', completedAt: new Date(),
        error: { code: 'DATA_ACCESS_OPERATION_RESTORED', message: 'Source permissions restored' },
      })
      return toOperationState(completed)
    } catch (error) {
      if (error instanceof PolicyOperationWriterLeaseError) throw writerLeaseExpired()
      await transitionPolicyOperation(client, operationId, ['recovering'], {
        status: 'recovery_required', phase: 'verify_source',
        error: { code: 'DATA_ACCESS_RECONCILE_RECOVERY_REQUIRED', message: 'Unable to verify restored permissions' },
      })
      throw new DataAccessPolicyOperationError(
        'DATA_ACCESS_RECONCILE_RECOVERY_REQUIRED',
        'Unable to verify restored permissions'
      )
    }
  }, { purpose: 'policy_operation', operationId })
}

async function applyPolicyOperation(
  client: PoolClient,
  context: OperationContext,
  operation: PolicyOperationRecord,
  actorId: string
): Promise<void> {
  const second = await loadOperationContext(context.projectId, context.tableName)
  assertOperationContext(operation, second)
  const baseline = await getManagedPolicyWithClient(
    client, context.projectId, context.schemaName, context.tableName
  )
  if (
    second.resourceVersion !== operation.sourceResourceVersion
    || createSourceDigest(
      second,
      baseline,
      snapshotManagedSource(second, baseline)
    ) !== operation.sourceDigest
  ) {
    await transitionPolicyOperation(client, operation.operationId, [operation.status], {
      status: 'failed', phase: 'completed', completedAt: new Date(),
      error: { code: 'DATA_ACCESS_RECONCILE_STALE', message: 'Data access source changed' },
    })
    throw stale()
  }
  const writerEpoch = randomUUID()
  const deadline = new Date(Date.now() + POLICY_WRITER_LEASE_MS)
  await transitionPolicyOperation(client, operation.operationId, [operation.status], {
    status: 'applying', phase: 'apply_permissions', writerEpoch, writeDeadlineAt: deadline,
    startedAt: operation.startedAt ?? new Date(),
  })
  let metadataApplied = false
  try {
    const renewWriterLease = () => renewPolicyOperationWriterLease(
      client,
      operation.operationId,
      'applying',
      writerEpoch,
      new Date(Date.now() + POLICY_WRITER_LEASE_MS)
    )
    await renewWriterLease()
    await applyPermissionMutation(
      second,
      operation.sourcePermissions,
      operation.targetPermissions ?? [],
      second.resourceVersion,
      renewWriterLease
    )
    metadataApplied = true
    const target = await loadOperationContext(context.projectId, context.tableName)
    const verifiedTargetPermissions = snapshotInspected(target)
    if (createTargetDigest(
      operation.targetPolicy!,
      operation.targetColumnGrants!,
      operation.targetCapabilities!,
      verifiedTargetPermissions
    ) !== operation.targetDigest) {
      logger.error('Data access target permission digest mismatch', {
        projectId: context.projectId,
        tableName: context.tableName,
        operationId: operation.operationId,
        expectedPermissions: JSON.stringify(summarizePermissions(operation.targetPermissions ?? [])),
        actualPermissions: JSON.stringify(summarizePermissions(verifiedTargetPermissions)),
      })
      throw new Error('Target permission verification failed')
    }
    const owned = await getPolicyOperationWithClient(client, context.projectId, operation.operationId)
    if (!owned || owned.status !== 'applying' || owned.writerEpoch !== writerEpoch) {
      throw new Error('Policy operation writer ownership changed')
    }
    await client.query('BEGIN')
    let commitAttempted = false
    try {
      await saveManagedPolicy(client, {
        projectId: context.projectId, tableName: context.tableName, schemaName: context.schemaName,
        policy: operation.targetPolicy!, columnGrants: operation.targetColumnGrants!,
        capabilitiesSnapshot: operation.targetCapabilities!, permissionsSnapshot: operation.targetPermissions!,
        metadataDigest: permissionSnapshotDigest(operation.targetPermissions!), actorId,
        expectedRevision: operation.baselineRevision,
      })
      await transitionPolicyOperation(client, operation.operationId, ['applying'], {
        status: 'completed', phase: 'completed', targetResourceVersion: target.resourceVersion,
        completedAt: new Date(),
      })
      commitAttempted = true
      await client.query('COMMIT')
    } catch (error) {
      if (!commitAttempted) {
        await client.query('ROLLBACK')
        throw error
      }
      const confirmed = await confirmUnknownPolicyCommit(operation)
      if (confirmed === 'committed') return
      if (confirmed === 'not_committed') throw error
      throw new DataAccessPolicyOperationError(
        'DATA_ACCESS_RECONCILE_RECOVERY_REQUIRED',
        'Data access commit result requires recovery verification'
      )
    }
  } catch (error) {
    if (error instanceof PolicyOperationWriterLeaseError) throw writerLeaseExpired()
    logger.error('Data access policy operation failed', {
      projectId: context.projectId,
      schemaName: context.schemaName,
      tableName: context.tableName,
      operationId: operation.operationId,
      phase: 'apply_permissions',
    }, error)
    if (error instanceof DataAccessPolicyOperationError
      && error.code === 'DATA_ACCESS_RECONCILE_RECOVERY_REQUIRED') throw error
    if (!metadataApplied && !isDefinitiveHasuraRejection(error)) {
      await transitionPolicyOperation(client, operation.operationId, ['applying'], {
        status: 'recovery_required', phase: 'verify_source',
        error: {
          code: 'DATA_ACCESS_RECONCILE_RECOVERY_REQUIRED',
          message: 'Metadata write outcome requires recovery verification',
        },
      })
      throw new DataAccessPolicyOperationError(
        'DATA_ACCESS_RECONCILE_RECOVERY_REQUIRED',
        'Data access update requires recovery verification'
      )
    }
    if (metadataApplied) await restoreSource(client, context, operation, baseline)
    else await transitionPolicyOperation(client, operation.operationId, ['applying'], {
      status: 'failed', phase: 'completed', completedAt: new Date(),
      error: { code: 'DATA_ACCESS_OPERATION_FAILED', message: 'Data access update failed' },
    })
    if (error instanceof DataAccessPolicyOperationError) throw error
    throw new DataAccessPolicyOperationError(
      'DATA_ACCESS_UPSTREAM_ERROR', 'Unable to apply data access metadata'
    )
  }
}

function summarizePermissions(permissions: MaterializedDataPermission[]) {
  return permissions.map((item) => ({
    role: item.role,
    operation: item.operation,
    columns: Array.isArray(item.permission.columns) ? item.permission.columns : null,
    digest: stableDigest(item.permission),
  }))
}

async function confirmUnknownPolicyCommit(
  operation: PolicyOperationRecord
): Promise<'committed' | 'not_committed' | 'uncertain'> {
  try {
    const [persistedOperation, baseline] = await Promise.all([
      getPolicyOperation(operation.projectId, operation.operationId),
      getManagedPolicy(operation.projectId, operation.schemaName, operation.tableName),
    ])
    const expectedRevision = (operation.baselineRevision ?? 0n) + 1n
    if (
      persistedOperation?.status === 'completed'
      && baseline?.revision === expectedRevision
      && baseline.metadataDigest === permissionSnapshotDigest(operation.targetPermissions ?? [])
    ) return 'committed'
    const sourceRevisionMatches = operation.baselineRevision === null
      ? baseline === null
      : baseline?.revision === operation.baselineRevision
        && permissionSnapshotDigest(baseline.permissionsSnapshot)
          === permissionSnapshotDigest(operation.sourcePermissions)
    if (persistedOperation?.status === 'applying' && sourceRevisionMatches) {
      return 'not_committed'
    }
    return 'uncertain'
  } catch {
    return 'uncertain'
  }
}

async function restoreSource(
  client: PoolClient,
  context: OperationContext,
  operation: PolicyOperationRecord,
  baseline: ManagedPolicyRecord | null
): Promise<void> {
  try {
    const current = await loadOperationContext(context.projectId, context.tableName)
    assertOperationContext(operation, current)
    const currentPermissions = snapshotRecoveryPermissions(current)
    assertRecoverablePermissionState(currentPermissions, operation)
    const writerEpoch = randomUUID()
    await transitionPolicyOperation(client, operation.operationId, ['applying'], {
      status: 'recovering', phase: 'restore_source', writerEpoch,
      writeDeadlineAt: new Date(Date.now() + POLICY_WRITER_LEASE_MS),
    })
    const renewWriterLease = () => renewPolicyOperationWriterLease(
      client,
      operation.operationId,
      'recovering',
      writerEpoch,
      new Date(Date.now() + POLICY_WRITER_LEASE_MS)
    )
    await renewWriterLease()
    await applyPermissionMutation(
      current,
      currentPermissions,
      operation.sourcePermissions,
      current.resourceVersion,
      renewWriterLease
    )
    const restored = await loadOperationContext(context.projectId, context.tableName)
    if (permissionSnapshotDigest(snapshotWithCapabilities(
      restored,
      baseline?.revision === operation.baselineRevision
        ? baseline.capabilitiesSnapshot
        : operation.sourceCapabilities
    ))
      !== permissionSnapshotDigest(operation.sourcePermissions)) throw new Error('Restore mismatch')
    await transitionPolicyOperation(client, operation.operationId, ['recovering'], {
      status: 'failed', phase: 'completed', completedAt: new Date(),
      error: { code: 'DATA_ACCESS_OPERATION_FAILED', message: 'Source permissions restored' },
    })
  } catch (error) {
    if (error instanceof PolicyOperationWriterLeaseError) throw writerLeaseExpired()
    await transitionPolicyOperation(client, operation.operationId, ['applying', 'recovering'], {
      status: 'recovery_required', phase: 'verify_source',
      error: { code: 'DATA_ACCESS_RECONCILE_RECOVERY_REQUIRED', message: 'Permission recovery requires attention' },
    }).catch(() => undefined)
    throw new DataAccessPolicyOperationError(
      'DATA_ACCESS_RECONCILE_RECOVERY_REQUIRED',
      'Permission recovery requires attention'
    )
  }
}

async function loadOperationContext(projectId: string, tableName: string): Promise<OperationContext> {
  const project = await requireProject(projectId)
  const table = await tableService.getTableMetadata(project.schemaName!, tableName)
  if (!table) throw new DataAccessPolicyOperationError('DATA_ACCESS_NOT_FOUND', 'Table not found')
  const exported = await hasuraMetadataRequestWithOptions<VersionedMetadataExport>(
    'export_metadata', {}, { version: 2 }
  )
  const source = exported.metadata.sources?.find((item) => item.name === 'default')
  if (!source || !Number.isSafeInteger(exported.resource_version)) {
    throw new DataAccessPolicyOperationError('DATA_ACCESS_UPSTREAM_ERROR', 'Data interface metadata is unavailable')
  }
  const roles = {
    authenticated: resolveDataScopeRole({ projectId, actor: 'authenticated' }),
    anonymous: resolveDataScopeRole({ projectId, actor: 'anonymous' }),
  }
  const tableMetadata = source.tables?.find(
    (item) => item.table.schema === project.schemaName && item.table.name === tableName
  ) ?? null
  const capabilities = buildTableColumnCapabilities(table.columns)
  return {
    projectId, projectAlias: project.alias, schemaName: project.schemaName!, tableName,
    capabilities, roles, tableMetadata, metadata: exported.metadata,
    inspected: inspectTableDataAccessMetadata(tableMetadata, roles, capabilities),
    resourceVersion: BigInt(exported.resource_version),
  }
}

async function requireProject(projectId: string) {
  const project = await projectService.getProjectById(projectId)
  if (!project?.schemaName) {
    throw new DataAccessPolicyOperationError('DATA_ACCESS_NOT_FOUND', 'Project schema not found')
  }
  return project
}

async function assertOperationSchemaCurrent(operation: PolicyOperationRecord): Promise<void> {
  const project = await requireProject(operation.projectId)
  if (project.schemaName !== operation.schemaName) {
    throw stale('Policy operation schema changed')
  }
}

function assertOperationContext(
  operation: PolicyOperationRecord,
  context: OperationContext
): void {
  if (operation.schemaName !== context.schemaName) {
    throw stale('Policy operation schema changed')
  }
}

function classify(
  context: OperationContext,
  baseline: ManagedPolicyRecord | null,
  operation: PolicyOperationRecord | null
) {
  const source = inspectManagedSource(context, baseline)
  return classifyManagedPolicyState({
    inspectedState: source.authenticatedState === 'custom'
      || source.anonymousState === 'custom' ? 'custom' : 'managed',
    hasScopedPermissions: source.permissions.length > 0,
    containsWildcard: source.containsWildcard,
    currentPermissions: source.containsWildcard
      || source.authenticatedState === 'custom'
      || source.anonymousState === 'custom'
      ? []
      : snapshotWithCapabilities(
          { ...context, inspected: source },
          baseline?.capabilitiesSnapshot ?? context.capabilities
        ),
    currentCapabilities: context.capabilities,
    baseline,
    recoveryRequired: isPolicyOperationRecoveryRequired(operation),
  })
}

function inspectManagedSource(
  context: OperationContext,
  baseline: ManagedPolicyRecord | null
): InspectedTableDataAccess {
  if (!baseline) return context.inspected
  return inspectTableDataAccessMetadata(
    context.tableMetadata,
    context.roles,
    baseline.capabilitiesSnapshot
  )
}

function snapshotManagedSource(
  context: OperationContext,
  baseline: ManagedPolicyRecord | null
): MaterializedDataPermission[] {
  const inspected = inspectManagedSource(context, baseline)
  return snapshotWithCapabilities(
    { ...context, inspected },
    baseline?.capabilitiesSnapshot ?? context.capabilities
  )
}

function snapshotInspected(context: OperationContext): MaterializedDataPermission[] {
  return snapshotWithCapabilities(context, context.capabilities)
}

function snapshotWithCapabilities(
  context: OperationContext,
  capabilities: DataAccessColumnCapabilities
): MaterializedDataPermission[] {
  const inspected = inspectTableDataAccessMetadata(
    context.tableMetadata,
    context.roles,
    capabilities
  )
  return createPermissionSnapshot(materializeInspectedTableDataAccess(
    inspected,
    context.roles,
    capabilities
  ))
}

function snapshotRawPermissions(context: OperationContext): MaterializedDataPermission[] {
  return createPermissionSnapshot(context.inspected.permissions)
}

function snapshotRecoveryPermissions(context: OperationContext): MaterializedDataPermission[] {
  try {
    return snapshotRawPermissions(context)
  } catch {
    throw new DataAccessPolicyOperationError(
      'DATA_ACCESS_RECONCILE_RECOVERY_REQUIRED',
      'Scoped permissions cannot be attributed to the recorded operation'
    )
  }
}

function resolvePolicyUpdateGrants(
  input: TableDataAccessUpdateInput,
  baseline: ManagedPolicyRecord | null,
  capabilities: DataAccessColumnCapabilities
): DataAccessColumnGrants {
  if (!baseline) return input.columnGrants ?? defaultColumnGrants(input, capabilities)
  if (input.columnGrants) return input.columnGrants
  const next = materializeReconcileGrants(baseline.columnGrants, capabilities)
  for (const operation of ['select', 'insert', 'update'] as const) {
    const previousMode = baseline.policy.authenticated[operation]
    const nextMode = input.authenticated[operation]
    if (nextMode === 'none') next.authenticated[operation] = []
    else if (previousMode === 'none') {
      throw new DataAccessPolicyOperationError(
        'INVALID_DATA_ACCESS_POLICY', `Column grants are required when enabling ${operation}`
      )
    }
  }
  if (!input.anonymous.select) next.anonymous.select = []
  else if (!baseline.policy.anonymous.select) {
    throw new DataAccessPolicyOperationError(
      'INVALID_DATA_ACCESS_POLICY', 'Column grants are required when enabling anonymous select'
    )
  }
  if (
    baseline.policy.authenticated.ownerColumn !== input.authenticated.ownerColumn
    && (input.authenticated.insert === 'owner' || input.authenticated.update === 'owner')
  ) {
    throw new DataAccessPolicyOperationError(
      'INVALID_DATA_ACCESS_POLICY', 'Column grants are required when changing the owner column'
    )
  }
  const owner = input.authenticated.ownerColumn
  if (input.authenticated.insert === 'owner') {
    next.authenticated.insert = next.authenticated.insert.filter((column) => column !== owner)
  }
  if (input.authenticated.update === 'owner') {
    next.authenticated.update = next.authenticated.update.filter((column) => column !== owner)
  }
  return next
}

function defaultColumnGrants(
  policy: TableDataAccessInput,
  capabilities: DataAccessColumnCapabilities
): DataAccessColumnGrants {
  const owner = policy.authenticated.ownerColumn
  return {
    authenticated: {
      select: policy.authenticated.select === 'none' ? [] : [...capabilities.readableColumns],
      insert: policy.authenticated.insert === 'none' ? [] : capabilities.insertableColumns
        .filter((column) => policy.authenticated.insert !== 'owner' || column !== owner),
      update: policy.authenticated.update === 'none' ? [] : capabilities.updateableColumns
        .filter((column) => policy.authenticated.update !== 'owner' || column !== owner),
    },
    anonymous: {
      select: policy.anonymous.select ? [...capabilities.readableColumns] : [],
    },
  }
}

function materializeSafeReconcilePolicy(
  baseline: TableDataAccessInput,
  capabilities: DataAccessColumnCapabilities
): TableDataAccessInput {
  const policy: TableDataAccessInput = {
    authenticated: { ...baseline.authenticated },
    anonymous: { ...baseline.anonymous },
  }
  const ownerColumn = policy.authenticated.ownerColumn
  if (!ownerColumn) return policy
  if (!capabilities.readableColumns.includes(ownerColumn)) {
    for (const operation of ['select', 'insert', 'update', 'delete'] as const) {
      if (policy.authenticated[operation] === 'owner') {
        policy.authenticated[operation] = 'none'
      }
    }
  } else if (
    policy.authenticated.insert === 'owner'
    && !capabilities.insertableColumns.includes(ownerColumn)
  ) {
    policy.authenticated.insert = 'none'
  }
  if (!(['select', 'insert', 'update', 'delete'] as const).some(
    (operation) => policy.authenticated[operation] === 'owner'
  )) {
    policy.authenticated.ownerColumn = null
  }
  return policy
}

function validateColumnGrantModes(
  policy: TableDataAccessInput,
  grants: DataAccessColumnGrants
): void {
  for (const operation of ['select', 'insert', 'update'] as const) {
    if (policy.authenticated[operation] === 'none'
      && grants.authenticated[operation].length > 0) {
      throw new DataAccessPolicyOperationError(
        'INVALID_DATA_ACCESS_POLICY', `Closed ${operation} cannot retain column grants`
      )
    }
  }
  if (!policy.anonymous.select && grants.anonymous.select.length > 0) {
    throw new DataAccessPolicyOperationError(
      'INVALID_DATA_ACCESS_POLICY', 'Closed anonymous select cannot retain column grants'
    )
  }
}

function validateExpectedRevision(
  input: TableDataAccessUpdateInput,
  baseline: ManagedPolicyRecord | null
): void {
  if (!baseline) {
    if (input.expectedBaselineRevision !== undefined) throw stale()
    return
  }
  if (input.expectedBaselineRevision === undefined
    || BigInt(input.expectedBaselineRevision) !== baseline.revision) throw stale()
}

function buildPermissionCommands(
  context: OperationContext,
  source: MaterializedDataPermission[],
  target: MaterializedDataPermission[]
): HasuraMetadataCommand[] {
  const table = { schema: context.schemaName, name: context.tableName }
  return [
    ...source.map((item) => ({
      type: `pg_drop_${item.operation}_permission`,
      args: { source: 'default', table, role: item.role },
    })),
    ...target.map((item) => ({
      type: `pg_create_${item.operation}_permission`,
      args: { source: 'default', table, role: item.role, permission: item.permission },
    })),
  ]
}

async function applyPermissionMutation(
  context: OperationContext,
  source: MaterializedDataPermission[],
  target: MaterializedDataPermission[],
  resourceVersion: bigint,
  beforeFallback: () => Promise<void>
): Promise<void> {
  const sourceHasUnavailableColumns = hasUnavailablePermissionColumns(
    source, context.capabilities
  )
  const targetHasUnavailableColumns = hasUnavailablePermissionColumns(
    target, context.capabilities
  )
  if (sourceHasUnavailableColumns || targetHasUnavailableColumns) {
    await replaceHasuraTablePermissions(context.metadata as HasuraMetadataDocument, {
      sourceName: 'default',
      schemaName: context.schemaName,
      tableName: context.tableName,
      scopedRoles: [context.roles.authenticated, context.roles.anonymous],
      permissions: target,
      resourceVersion,
      allowInconsistentMetadata: sourceHasUnavailableColumns || targetHasUnavailableColumns,
      timeoutMs: 30_000,
    })
    return
  }
  await applyHasuraMetadataCommands(
    buildPermissionCommands(context, source, target),
    { resourceVersion, timeoutMs: 30_000, beforeFallback }
  )
}

function hasUnavailablePermissionColumns(
  permissions: MaterializedDataPermission[],
  capabilities: DataAccessColumnCapabilities
): boolean {
  return permissions.some((item) => {
    if (item.operation === 'delete') return false
    const columns = item.permission.columns
    if (!Array.isArray(columns)) return true
    const available = item.operation === 'select'
      ? capabilities.readableColumns
      : item.operation === 'insert'
        ? capabilities.insertableColumns
        : capabilities.updateableColumns
    return columns.some((column) => typeof column !== 'string' || !available.includes(column))
  })
}

function isDefinitiveHasuraRejection(error: unknown): boolean {
  return error instanceof HasuraMetadataRequestError && error.isDefinitiveRejection
}

function assertRecoverablePermissionState(
  current: MaterializedDataPermission[],
  operation: PolicyOperationRecord
): void {
  if (isRecoverablePermissionSnapshot(
    current,
    operation.sourcePermissions,
    operation.targetPermissions ?? []
  )) return
  throw new DataAccessPolicyOperationError(
    'DATA_ACCESS_RECONCILE_RECOVERY_REQUIRED',
    'Scoped permissions changed outside the recorded operation'
  )
}

function createSourceDigest(
  context: OperationContext,
  baseline: ManagedPolicyRecord | null,
  permissions: MaterializedDataPermission[]
): string {
  return stableDigest({
    projectId: context.projectId, schemaName: context.schemaName, tableName: context.tableName,
    baselineRevision: baseline?.revision.toString() ?? null,
    sourceCapabilities: context.capabilities, sourcePermissions: permissions,
  })
}

function createTargetDigest(
  policy: TableDataAccessInput,
  grants: DataAccessColumnGrants,
  capabilities: DataAccessColumnCapabilities,
  permissions: MaterializedDataPermission[]
): string {
  return stableDigest({
    targetPolicy: policy, targetColumnGrants: grants,
    targetCapabilities: capabilities, targetPermissions: permissions,
  })
}

function stripUpdateEnvelope(input: TableDataAccessUpdateInput): TableDataAccessInput {
  return { authenticated: { ...input.authenticated }, anonymous: { ...input.anonymous } }
}

function isVerifiedNoop(
  baseline: ManagedPolicyRecord,
  input: TableDataAccessUpdateInput,
  grants: DataAccessColumnGrants,
  capabilities: DataAccessColumnCapabilities,
  permissions: MaterializedDataPermission[]
): boolean {
  return stableDigest(baseline.policy) === stableDigest(stripUpdateEnvelope(input))
    && stableDigest(baseline.columnGrants) === stableDigest(grants)
    && capabilitiesEqual(baseline.capabilitiesSnapshot, capabilities)
    && permissionSnapshotDigest(baseline.permissionsSnapshot) === permissionSnapshotDigest(permissions)
}

function toPreview(
  context: OperationContext,
  operation: PolicyOperationRecord,
  drift: ReturnType<typeof buildColumnCapabilityDrift> | null
): DataAccessPolicyPreview {
  return {
    operation: toOperationState(operation), projectId: context.projectId,
    schemaName: context.schemaName, tableName: context.tableName,
    baselineRevision: operation.baselineRevision === null ? null : Number(operation.baselineRevision),
    policy: operation.targetPolicy!, columnGrants: operation.targetColumnGrants!,
    capabilities: {
      readable: context.capabilities.readableColumns,
      insertable: context.capabilities.insertableColumns,
      updateable: context.capabilities.updateableColumns,
    },
    drift,
  }
}

export function toOperationState(operation: PolicyOperationRecord): DataAccessPolicyOperationState {
  return {
    operationId: operation.operationId, tableName: operation.tableName, kind: operation.kind,
    status: operation.status, phase: operation.phase, sourceDigest: operation.sourceDigest,
    targetDigest: operation.targetDigest,
    writeDeadlineAt: operation.writeDeadlineAt?.toISOString() ?? null,
    startedAt: operation.startedAt?.toISOString() ?? null, error: operation.error,
  }
}

async function requireOperation(
  client: PoolClient,
  projectId: string,
  operationId: string,
  kind?: PolicyOperationRecord['kind']
): Promise<PolicyOperationRecord> {
  const operation = await getPolicyOperationWithClient(client, projectId, operationId)
  if (!operation || (kind && operation.kind !== kind)) {
    throw new DataAccessPolicyOperationError('DATA_ACCESS_NOT_FOUND', 'Policy operation not found')
  }
  return operation
}

function assertIdempotentRequest(operation: PolicyOperationRecord, digest: string): void {
  if (operation.requestDigest !== digest) {
    throw conflict('DATA_ACCESS_POLICY_STALE', 'Operation ID was already used for another request')
  }
}

function assertCompletedOperationCurrent(
  operation: PolicyOperationRecord,
  baseline: ManagedPolicyRecord | null
): void {
  const expectedRevision = operation.targetResourceVersion === null
    && operation.baselineRevision !== null
    ? operation.baselineRevision
    : (operation.baselineRevision ?? 0n) + 1n
  if (!baseline
    || baseline.revision !== expectedRevision
    || !operation.targetPolicy
    || !operation.targetColumnGrants
    || !operation.targetCapabilities
    || !operation.targetPermissions
    || stableDigest(baseline.policy) !== stableDigest(operation.targetPolicy)
    || stableDigest(baseline.columnGrants) !== stableDigest(operation.targetColumnGrants)
    || stableDigest(baseline.capabilitiesSnapshot) !== stableDigest(operation.targetCapabilities)
    || permissionSnapshotDigest(baseline.permissionsSnapshot)
      !== permissionSnapshotDigest(operation.targetPermissions)) {
    throw conflict('DATA_ACCESS_POLICY_STALE', 'Completed operation has been superseded')
  }
}

function throwPriorOperationState(operation: PolicyOperationRecord): never {
  if (operation.status === 'recovery_required') {
    throw conflict(
      'DATA_ACCESS_RECONCILE_RECOVERY_REQUIRED',
      'Data access recovery is required'
    )
  }
  if (operation.status === 'failed' || operation.status === 'superseded') {
    throw conflict(
      operation.error?.code ?? 'DATA_ACCESS_POLICY_STALE',
      'Data access operation cannot be retried'
    )
  }
  throw conflict('DATA_ACCESS_POLICY_OPERATION_IN_PROGRESS', 'Data access operation is not complete')
}

function assertOperationConfirmation(
  operation: PolicyOperationRecord,
  sourceDigest: string,
  targetDigest: string | null
): void {
  if (operation.sourceDigest !== sourceDigest
    || (targetDigest !== null && operation.targetDigest !== targetDigest)) throw stale()
}

function assertProjectAlias(context: OperationContext, alias: string): void {
  if (!alias || alias !== context.projectAlias) {
    throw new DataAccessPolicyOperationError('INVALID_DATA_ACCESS_CONFIRMATION', 'Project alias does not match')
  }
}

function assertOperationId(value: string): void {
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(value)) {
    throw new DataAccessPolicyOperationError('INVALID_DATA_ACCESS_POLICY', 'Invalid operation ID')
  }
}

function createOperationId(): string {
  return `dap_${randomUUID()}`
}

function stale(message = 'Data access preview is stale') {
  return conflict('DATA_ACCESS_RECONCILE_STALE', message)
}

function conflict(code: string, message: string) {
  return new DataAccessPolicyOperationError(code, message)
}

function writerLeaseExpired() {
  return conflict(
    'DATA_ACCESS_POLICY_OPERATION_IN_PROGRESS',
    'Metadata writer lease expired before the update was sent'
  )
}
