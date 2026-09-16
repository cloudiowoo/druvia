import { randomUUID } from 'node:crypto'
import type { PoolClient } from 'pg'
import { createApiLogger } from '../../lib/logger.js'
import * as projectService from '../project/project.service.js'
import * as tableService from '../table/table.service.js'
import {
  HasuraMetadataRequestError,
  hasuraMetadataRequestWithOptions,
} from '../realtime/realtime.service.js'
import {
  buildAuthorizationProjectionMetadata,
  authorizationProjectionMetadataDigest,
  loadAuthorizationProjectionDependencies,
  parseAuthorizationProjectionContract,
  type AuthorizationProjectionContract,
} from './data-access-authorization-projection.js'
import {
  getManagedPolicyWithClient,
  saveManagedPolicy,
  supersedePolicyPreviews,
  type ManagedPolicyRecord,
} from './data-access-managed-policy.repository.js'
import {
  buildTableColumnCapabilities,
} from './data-access-column-capabilities.js'
import {
  capabilitiesEqual,
  createPermissionSnapshot,
  permissionSnapshotDigest,
  policyOperationRecoverySafeAt,
  stableDigest,
} from './data-access-managed-policy.js'
import { withProjectDataAccessMutationLock } from './data-access-mutation-lock.js'
import { materializeTableDataAccessPolicy } from './data-access-policy.js'
import {
  claimLatestCompletedProjectionRecovery,
  createProjectionOperation,
  getActiveProjectionOperation,
  getEffectiveFailClosedProjectionOperationWithClient,
  getProjectionOperationWithClient,
  renewProjectionOperationWriterLease,
  supersedeProjectionPreviews,
  transitionProjectionOperation,
  type ProjectionOperationRecord,
} from './data-access-projection-operation.repository.js'
import { resolveDataScopeRole } from './data-scope-role.js'
import type {
  DataAccessOperation,
  MaterializedDataPermission,
  TableDataAccessInput,
} from './data-access.types.js'

const SOURCE_NAME = 'default'
const WRITER_LEASE_MS = 30_000
const logger = createApiLogger({ module: 'data-access-authorization-projection' })

interface VersionedMetadataExport {
  resource_version: number
  metadata: Record<string, unknown>
}

export interface AuthorizationProjectionPreview {
  operationId: string
  projectId: string
  schemaName: string
  status: string
  sourceDigest: string
  targetDigest: string
  dependencyDigest: string
  baselineRevisions: Record<string, string>
  tables: Array<{
    table: string
    relationship: string
    ownerColumn: string
    allowColumn: string
  }>
}

export interface ApplyAuthorizationProjectionInput {
  projectAlias: string
  sourceDigest: string
  targetDigest: string
  dependencyDigest: string
  baselineRevisions: Record<string, string>
}

export class AuthorizationProjectionOperationError extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
    this.name = 'AuthorizationProjectionOperationError'
  }
}

export async function getActiveAuthorizationProjection(
  projectId: string
): Promise<AuthorizationProjectionPreview | null> {
  const operation = await getActiveProjectionOperation(projectId)
  return operation ? toPreview(operation) : null
}

export async function previewAuthorizationProjection(
  projectId: string,
  rawContract: unknown,
  actorId: string
): Promise<AuthorizationProjectionPreview> {
  const contract = parseAuthorizationProjectionContract(rawContract)
  const project = await requireProject(projectId)
  const operationId = `dapo_${randomUUID()}`
  return withProjectDataAccessMutationLock(projectId, async (client) => {
    await assertContractCoversExistingProjectionBaselines(
      client, projectId, project.schemaName, contract
    )
    const exported = await exportVersionedMetadata()
    const baselines = await loadBaselines(client, projectId, project.schemaName, contract)
    await assertProjectionBaselineCapabilitiesCurrent(project.schemaName, contract, baselines)
    const failClosedOperation = await getEffectiveFailClosedProjectionOperationWithClient(
      client, projectId
    )
    const roles = projectRoles(projectId)
    assertManagedSources(
      exported.metadata, project.schemaName, roles, baselines, contract, failClosedOperation
    )

    const targetPolicies = buildTargetPolicies(contract, baselines)
    const tableSelectPermissions = contract.relationships.map((relationship) => {
      const baseline = baselines.get(relationship.table)!
      const permissions = materializeTableDataAccessPolicy(
        targetPolicies.get(relationship.table)!,
        {
          roles,
          capabilities: baseline.capabilitiesSnapshot,
          columnGrants: baseline.columnGrants,
        }
      )
      const select = permissions.find((item) => (
        item.role === roles.authenticated && item.operation === 'select'
      ))
      if (!select) throw invalid('Projection target select permission is unavailable')
      return { table: relationship.table, permission: select.permission }
    })
    const targetMetadata = buildAuthorizationProjectionMetadata({
      metadata: exported.metadata,
      sourceName: SOURCE_NAME,
      schemaName: project.schemaName,
      contract,
      authenticatedRole: roles.authenticated,
      tableSelectPermissions,
    })
    const { snapshot: dependencySnapshot } = await loadAuthorizationProjectionDependencies({
      client,
      projectId,
      schemaName: project.schemaName,
      contract,
      metadata: targetMetadata,
    })
    const baselineRevisions = Object.fromEntries([...baselines].map(
      ([table, baseline]) => [table, baseline.revision.toString()]
    ))
    const sourceDigest = authorizationProjectionMetadataDigest(
      exported.metadata, SOURCE_NAME, project.schemaName, contract
    )
    const targetDigest = authorizationProjectionMetadataDigest(
      targetMetadata, SOURCE_NAME, project.schemaName, contract
    )
    const requestDigest = stableDigest({ contract, sourceDigest, targetDigest, baselineRevisions })

    await supersedePolicyPreviews(client, projectId)
    await supersedeProjectionPreviews(client, projectId)
    const operation = await createProjectionOperation(client, {
      operationId, projectId, schemaName: project.schemaName, contract, baselineRevisions,
      sourceMetadata: exported.metadata, targetMetadata, dependencySnapshot,
      dependencyDigest: dependencySnapshot.digest, sourceDigest, targetDigest,
      sourceResourceVersion: BigInt(exported.resource_version), requestDigest, createdBy: actorId,
    })
    return toPreview(operation)
  }, { purpose: 'projection_operation', operationId })
}

export async function applyAuthorizationProjection(
  projectId: string,
  operationId: string,
  input: ApplyAuthorizationProjectionInput
): Promise<AuthorizationProjectionPreview> {
  return withProjectDataAccessMutationLock(projectId, async (client) => {
    const operation = await requireOperation(client, projectId, operationId)
    const project = await requireProject(projectId)
    assertOperationConfirmation(operation, project.schemaName, project.alias, input)
    if (operation.status === 'completed') return toPreview(operation)
    if (operation.status !== 'preview_ready') {
      throw conflict('Projection operation is not ready to apply')
    }

    const current = await exportVersionedMetadata()
    if (BigInt(current.resource_version) !== operation.sourceResourceVersion) {
      throw conflict('Hasura metadata changed after projection preview')
    }
    if (metadataDigest(current.metadata, operation) !== operation.sourceDigest) {
      throw conflict('Projection source metadata changed after preview')
    }
    const baselines = await loadBaselines(
      client, projectId, project.schemaName, operation.contract, operation.baselineRevisions
    )
    await assertProjectionBaselineCapabilitiesCurrent(
      project.schemaName, operation.contract, baselines
    )
    const dependency = await loadAuthorizationProjectionDependencies({
      client, projectId, schemaName: project.schemaName,
      contract: operation.contract, metadata: operation.targetMetadata,
    })
    if (dependency.snapshot.digest !== operation.dependencyDigest) {
      throw conflict('Projection dependency changed after preview')
    }

    const writerEpoch = randomUUID()
    await transitionProjectionOperation(client, operationId, ['preview_ready'], {
      status: 'applying', phase: 'source_check', writerEpoch,
      writeDeadlineAt: new Date(Date.now() + WRITER_LEASE_MS), startedAt: new Date(),
    })
    try {
      await renewProjectionOperationWriterLease(
        client, operationId, 'applying', writerEpoch, new Date(Date.now() + WRITER_LEASE_MS)
      )
      await transitionProjectionOperation(client, operationId, ['applying'], { phase: 'apply_metadata' })
      await hasuraMetadataRequestWithOptions('replace_metadata', {
        allow_inconsistent_metadata: false,
        metadata: operation.targetMetadata,
      }, { resourceVersion: BigInt(current.resource_version), timeoutMs: 30_000 })

      await transitionProjectionOperation(client, operationId, ['applying'], { phase: 'verify_target' })
      const verified = await exportVersionedMetadata()
      if (metadataDigest(verified.metadata, operation) !== operation.targetDigest) {
        throw new Error('Projection target metadata verification failed')
      }
      const verifiedDependency = await loadAuthorizationProjectionDependencies({
        client, projectId, schemaName: project.schemaName,
        contract: operation.contract, metadata: verified.metadata,
      })
      if (verifiedDependency.snapshot.digest !== operation.dependencyDigest) {
        throw new Error('Projection dependency verification failed')
      }
      await assertProjectionBaselineCapabilitiesCurrent(
        project.schemaName, operation.contract, baselines
      )
      const completed = await persistTargetBaselines(
        client, operation, baselines, projectId, project.schemaName,
        BigInt(verified.resource_version), 'applying'
      )
      return toPreview(completed)
    } catch (error) {
      const definitive = error instanceof HasuraMetadataRequestError
        && error.isDefinitiveRejection
      logger.error('Authorization projection apply failed', {
        projectId,
        schemaName: operation.schemaName,
        operationId,
        phase: 'apply',
      }, error)
      await markApplyFailure(client, operation, error)
      if (definitive) {
        throw new AuthorizationProjectionOperationError(
          'DATA_ACCESS_PROJECTION_REJECTED',
          'Hasura rejected the projection metadata'
        )
      }
      throw error instanceof AuthorizationProjectionOperationError
        ? error
        : new AuthorizationProjectionOperationError(
            'DATA_ACCESS_PROJECTION_RECOVERY_REQUIRED',
            'Projection update requires recovery verification'
          )
    }
  }, { purpose: 'projection_operation', operationId })
}

export async function recoverAuthorizationProjection(
  projectId: string,
  operationId: string,
  projectAlias: string
): Promise<AuthorizationProjectionPreview> {
  return withProjectDataAccessMutationLock(projectId, async (client) => {
    const operation = await requireOperation(client, projectId, operationId)
    const project = await requireProject(projectId)
    if (project.alias !== projectAlias || project.schemaName !== operation.schemaName) {
      throw conflict('Projection recovery confirmation is stale')
    }
    if (operation.status === 'failed') return toPreview(operation)
    if (!['applying', 'recovering', 'recovery_required', 'completed'].includes(operation.status)) {
      throw conflict('Projection operation does not require recovery')
    }
    if (operation.status !== 'completed') {
      const safeAt = policyOperationRecoverySafeAt(operation)
      if (safeAt === null || Date.now() < safeAt) {
        throw conflict('Projection metadata writer may still be active')
      }
    }
    const writerEpoch = randomUUID()
    const writeDeadlineAt = new Date(Date.now() + WRITER_LEASE_MS)
    if (operation.status === 'completed') {
      const claimed = await claimLatestCompletedProjectionRecovery(
        client, projectId, operationId, writerEpoch, writeDeadlineAt
      )
      if (!claimed) throw conflict('Only the latest completed projection batch can be recovered')
    } else {
      await transitionProjectionOperation(client, operationId, [operation.status], {
        status: 'recovering', phase: 'inspect_recovery', writerEpoch,
        writeDeadlineAt, completedAt: null,
      })
    }
    try {
      const renewWriterLease = () => renewProjectionOperationWriterLease(
        client, operationId, 'recovering', writerEpoch,
        new Date(Date.now() + WRITER_LEASE_MS)
      )
      await renewWriterLease()
      const current = await exportVersionedMetadata()
      const currentDigest = metadataDigest(current.metadata, operation)
      if (currentDigest === operation.targetDigest) {
        const dependencyValid = await loadAuthorizationProjectionDependencies({
          client, projectId, schemaName: project.schemaName,
          contract: operation.contract, metadata: current.metadata,
        }).then((dependency) => dependency.snapshot.digest === operation.dependencyDigest)
          .catch(() => false)
        if (dependencyValid) {
          const baselines = await loadBaselinesForRecovery(
            client, projectId, project.schemaName, operation
          )
          const capabilitiesValid = await assertProjectionBaselineCapabilitiesCurrent(
            project.schemaName, operation.contract, baselines
          ).then(() => true).catch(() => false)
          if (capabilitiesValid && targetPermissionsMatchCurrentBaselines(
            current.metadata, project.schemaName, projectId, operation.contract, baselines
          )) {
            return toPreview(await persistTargetBaselines(
              client, operation, baselines, projectId, project.schemaName,
              BigInt(current.resource_version), 'recovering'
            ))
          }
        }
      }
      if (currentDigest === operation.sourceDigest
        && operation.targetResourceVersion === null
        && BigInt(current.resource_version) === operation.sourceResourceVersion) {
        return toPreview(await transitionProjectionOperation(client, operationId, ['recovering'], {
          status: 'failed', phase: 'completed', writerEpoch: null, writeDeadlineAt: null,
          completedAt: new Date(),
          error: { code: 'DATA_ACCESS_PROJECTION_NOT_APPLIED', message: 'Source metadata remained active' },
        }))
      }

      await transitionProjectionOperation(client, operationId, ['recovering'], { phase: 'fail_closed' })
      const closed = buildFailClosedMetadata(
        current.metadata, project.schemaName, operation.contract,
        projectRoles(projectId).authenticated
      )
      await renewWriterLease()
      await hasuraMetadataRequestWithOptions('replace_metadata', {
        allow_inconsistent_metadata: false, metadata: closed,
      }, { resourceVersion: BigInt(current.resource_version), timeoutMs: 30_000 })
      const verified = await exportVersionedMetadata()
      if (metadataDigest(verified.metadata, operation) !== metadataDigest(closed, operation)) {
        throw new Error('Fail-closed metadata verification failed')
      }
      return toPreview(await transitionProjectionOperation(client, operationId, ['recovering'], {
        status: 'failed', phase: 'completed', writerEpoch: null, writeDeadlineAt: null,
        completedAt: new Date(),
        error: { code: 'DATA_ACCESS_PROJECTION_FAILED_CLOSED', message: 'Authenticated select was disabled' },
      }))
    } catch (error) {
      logger.error('Authorization projection recovery failed', {
        projectId,
        schemaName: operation.schemaName,
        operationId,
        phase: 'recover',
      }, error)
      await transitionProjectionOperation(client, operationId, ['recovering'], {
        status: 'recovery_required', phase: 'verify_fail_closed', writerEpoch: null,
        error: {
          code: 'DATA_ACCESS_PROJECTION_RECOVERY_REQUIRED',
          message: 'Projection recovery outcome requires verification',
        },
      }).catch(() => undefined)
      throw new AuthorizationProjectionOperationError(
        'DATA_ACCESS_PROJECTION_RECOVERY_REQUIRED',
        'Projection recovery requires operator attention'
      )
    }
  }, { purpose: 'projection_operation', operationId })
}

function targetPermissionsMatchCurrentBaselines(
  metadata: Record<string, unknown>,
  schemaName: string,
  projectId: string,
  contract: AuthorizationProjectionContract,
  baselines: Map<string, ManagedPolicyRecord>
): boolean {
  try {
    const roles = projectRoles(projectId)
    const policies = buildTargetPolicies(contract, baselines)
    return contract.relationships.every((relationship) => {
      const baseline = baselines.get(relationship.table)!
      const expected = materializeTableDataAccessPolicy(policies.get(relationship.table)!, {
        roles, capabilities: baseline.capabilitiesSnapshot, columnGrants: baseline.columnGrants,
      })
      const current = extractScopedPermissions(metadata, schemaName, relationship.table, roles)
      return permissionSnapshotDigest(current) === permissionSnapshotDigest(expected)
    })
  } catch {
    return false
  }
}

async function persistTargetBaselines(
  client: PoolClient,
  operation: ProjectionOperationRecord,
  baselines: Map<string, ManagedPolicyRecord>,
  projectId: string,
  schemaName: string,
  targetResourceVersion: bigint,
  operationStatus: 'applying' | 'recovering'
): Promise<ProjectionOperationRecord> {
  const roles = projectRoles(projectId)
  const targetPolicies = buildTargetPolicies(operation.contract, baselines)
  await transitionProjectionOperation(client, operation.operationId, [operationStatus], {
    phase: 'persist_baselines',
  })
  await client.query('BEGIN')
  try {
    for (const relationship of operation.contract.relationships) {
      const baseline = baselines.get(relationship.table)!
      const policy = targetPolicies.get(relationship.table)!
      const permissions = createPermissionSnapshot(materializeTableDataAccessPolicy(policy, {
        roles, capabilities: baseline.capabilitiesSnapshot, columnGrants: baseline.columnGrants,
      }))
      if (baseline.policyVersion === 2
        && baseline.dependencyDigest === operation.dependencyDigest
        && permissionSnapshotDigest(baseline.permissionsSnapshot) === permissionSnapshotDigest(permissions)) {
        continue
      }
      await saveManagedPolicy(client, {
        projectId, schemaName, tableName: relationship.table, policy,
        columnGrants: baseline.columnGrants,
        capabilitiesSnapshot: baseline.capabilitiesSnapshot,
        permissionsSnapshot: permissions,
        metadataDigest: permissionSnapshotDigest(permissions),
        dependencySnapshot: operation.dependencySnapshot,
        dependencyDigest: operation.dependencyDigest,
        actorId: operation.createdBy,
        expectedRevision: baseline.revision,
      })
    }
    const completed = await transitionProjectionOperation(client, operation.operationId, [operationStatus], {
      status: 'completed', phase: 'completed', writerEpoch: null, writeDeadlineAt: null,
      targetResourceVersion, completedAt: new Date(),
    })
    await client.query('COMMIT')
    return completed
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  }
}

function buildTargetPolicies(
  contract: AuthorizationProjectionContract,
  baselines: Map<string, ManagedPolicyRecord>
): Map<string, TableDataAccessInput> {
  return new Map(contract.relationships.map((relationship) => {
    const baseline = baselines.get(relationship.table)!
    if (baseline.policy.authenticated.select !== 'owner'
      || baseline.policy.authenticated.ownerColumn !== relationship.ownerColumn) {
      throw invalid('Projection requires an existing managed owner select policy')
    }
    return [relationship.table, {
      policyVersion: 2,
      authenticated: {
        ...baseline.policy.authenticated,
        selectConstraint: {
          type: 'authorization_projection',
          relationshipPath: [relationship.name],
          actorColumn: relationship.actorColumn,
          allowColumn: relationship.allowColumn,
        },
      },
      anonymous: { ...baseline.policy.anonymous },
    }]
  }))
}

async function loadBaselines(
  client: PoolClient,
  projectId: string,
  schemaName: string,
  contract: AuthorizationProjectionContract,
  expected?: Record<string, string>
): Promise<Map<string, ManagedPolicyRecord>> {
  const entries = await Promise.all(contract.relationships.map(async (relationship) => {
    const baseline = await getManagedPolicyWithClient(client, projectId, schemaName, relationship.table)
    if (!baseline) throw invalid(`Managed baseline is required for table ${relationship.table}`)
    if (expected && expected[relationship.table] !== baseline.revision.toString()) {
      throw conflict('Projection baseline revision changed after preview')
    }
    return [relationship.table, baseline] as const
  }))
  if (expected && Object.keys(expected).length !== entries.length) {
    throw conflict('Projection baseline confirmation does not match the contract')
  }
  return new Map(entries)
}

async function assertProjectionBaselineCapabilitiesCurrent(
  schemaName: string,
  contract: AuthorizationProjectionContract,
  baselines: Map<string, ManagedPolicyRecord>
): Promise<void> {
  await Promise.all(contract.relationships.map(async (relationship) => {
    const table = await tableService.getTableMetadata(schemaName, relationship.table)
    const baseline = baselines.get(relationship.table)
    if (!table || !baseline) throw invalid(`Managed baseline table is unavailable: ${relationship.table}`)
    const current = buildTableColumnCapabilities(table.columns)
    if (!capabilitiesEqual(current, baseline.capabilitiesSnapshot)) {
      throw conflict(`Table structure changes require reconciliation: ${relationship.table}`)
    }
  }))
}

async function assertContractCoversExistingProjectionBaselines(
  client: PoolClient,
  projectId: string,
  schemaName: string,
  contract: AuthorizationProjectionContract
): Promise<void> {
  const result = await client.query<{ table_name: string }>(
    `SELECT table_name
     FROM druvia_data_access_managed_policies
     WHERE project_id = $1 AND schema_name = $2 AND policy_version = 2
     ORDER BY table_name`,
    [projectId, schemaName]
  )
  const contractTables = new Set(contract.relationships.map((item) => item.table))
  const omitted = result.rows
    .map((row) => row.table_name)
    .filter((tableName) => !contractTables.has(tableName))
  if (omitted.length > 0) {
    throw invalid('Projection contract must include every existing v2 managed table')
  }
}

async function loadBaselinesForRecovery(
  client: PoolClient,
  projectId: string,
  schemaName: string,
  operation: ProjectionOperationRecord
): Promise<Map<string, ManagedPolicyRecord>> {
  const entries = await Promise.all(operation.contract.relationships.map(async (relationship) => {
    const baseline = await getManagedPolicyWithClient(client, projectId, schemaName, relationship.table)
    if (!baseline) throw conflict('Projection baseline disappeared during recovery')
    const sourceRevision = BigInt(operation.baselineRevisions[relationship.table] ?? '-1')
    if (baseline.revision !== sourceRevision
      && !(baseline.policyVersion === 2 && baseline.dependencyDigest === operation.dependencyDigest)) {
      throw conflict('Projection baseline changed outside the recorded operation')
    }
    return [relationship.table, baseline] as const
  }))
  return new Map(entries)
}

function assertManagedSources(
  metadata: Record<string, unknown>,
  schemaName: string,
  roles: ReturnType<typeof projectRoles>,
  baselines: Map<string, ManagedPolicyRecord>,
  contract: AuthorizationProjectionContract,
  failClosedOperation: ProjectionOperationRecord | null
): void {
  for (const [tableName, baseline] of baselines) {
    const current = extractScopedPermissions(metadata, schemaName, tableName, roles)
    if (permissionSnapshotDigest(current) === permissionSnapshotDigest(baseline.permissionsSnapshot)) continue
    if (isRecordedFailClosedSource(
      current, baseline, tableName, roles.authenticated, schemaName, contract, failClosedOperation
    )) continue
    throw conflict(`Managed permission drift must be resolved before projection preview: ${tableName}`)
  }
}

function isRecordedFailClosedSource(
  current: MaterializedDataPermission[],
  baseline: ManagedPolicyRecord,
  tableName: string,
  authenticatedRole: string,
  schemaName: string,
  contract: AuthorizationProjectionContract,
  failClosedOperation: ProjectionOperationRecord | null
): boolean {
  if (failClosedOperation?.status !== 'failed'
    || failClosedOperation.error?.code !== 'DATA_ACCESS_PROJECTION_FAILED_CLOSED'
    || failClosedOperation.schemaName !== schemaName
    || stableDigest(failClosedOperation.contract.relationships.map((item) => item.table).sort())
      !== stableDigest(contract.relationships.map((item) => item.table).sort())
    || !failClosedOperation.contract.relationships.some((item) => item.table === tableName)) {
    return false
  }
  const expectedClosed = baseline.permissionsSnapshot.filter((permission) => !(
    permission.role === authenticatedRole && permission.operation === 'select'
  ))
  return permissionSnapshotDigest(current) === permissionSnapshotDigest(expectedClosed)
}

function extractScopedPermissions(
  metadata: Record<string, unknown>,
  schemaName: string,
  tableName: string,
  roles: { authenticated: string; anonymous: string }
): MaterializedDataPermission[] {
  const source = metadataSource(metadata)
  const table = source.tables.find((item) => (
    item.table.schema === schemaName && item.table.name === tableName
  ))
  if (!table) throw invalid(`Tracked source table is unavailable: ${tableName}`)
  const scoped = new Set([roles.authenticated, roles.anonymous])
  const permissions: MaterializedDataPermission[] = []
  for (const operation of ['select', 'insert', 'update', 'delete'] as DataAccessOperation[]) {
    const entries = table[`${operation}_permissions`]
    if (!Array.isArray(entries)) continue
    for (const entry of entries) {
      if (isRecord(entry) && typeof entry.role === 'string' && scoped.has(entry.role)
        && isRecord(entry.permission)) {
        permissions.push({
          role: entry.role,
          operation,
          permission: operation === 'select' && entry.permission.allow_aggregations === undefined
            ? { ...entry.permission, allow_aggregations: false }
            : entry.permission,
        })
      }
    }
  }
  return createPermissionSnapshot(permissions)
}

function buildFailClosedMetadata(
  metadata: Record<string, unknown>,
  schemaName: string,
  contract: AuthorizationProjectionContract,
  authenticatedRole: string
): Record<string, unknown> {
  const result = structuredClone(metadata)
  const source = metadataSource(result)
  const tables = new Set(contract.relationships.map((item) => item.table))
  for (const table of source.tables) {
    if (table.table.schema !== schemaName || !tables.has(table.table.name)) continue
    const preserved = Array.isArray(table.select_permissions)
      ? table.select_permissions.filter((item) => !isRecord(item) || item.role !== authenticatedRole)
      : []
    if (preserved.length > 0) table.select_permissions = preserved
    else delete table.select_permissions
  }
  return result
}

function metadataSource(metadata: Record<string, unknown>): {
  tables: Array<Record<string, unknown> & { table: { schema: string; name: string } }>
} {
  if (!Array.isArray(metadata.sources)) throw invalid('Default metadata source is unavailable')
  const source = metadata.sources.find((item) => isRecord(item) && item.name === SOURCE_NAME)
  if (!isRecord(source) || !Array.isArray(source.tables)) throw invalid('Default metadata source is unavailable')
  return { tables: source.tables.filter((item): item is Record<string, unknown> & {
    table: { schema: string; name: string }
  } => isRecord(item) && isRecord(item.table)
    && typeof item.table.schema === 'string' && typeof item.table.name === 'string') }
}

async function exportVersionedMetadata(): Promise<VersionedMetadataExport> {
  const exported = await hasuraMetadataRequestWithOptions<VersionedMetadataExport>(
    'export_metadata', {}, { version: 2 }
  )
  if (!Number.isSafeInteger(exported.resource_version) || !isRecord(exported.metadata)) {
    throw new AuthorizationProjectionOperationError(
      'DATA_ACCESS_PROJECTION_UPSTREAM_ERROR', 'Data interface metadata is unavailable'
    )
  }
  return exported
}

async function requireProject(projectId: string): Promise<{ schemaName: string; alias: string }> {
  const project = await projectService.getProjectById(projectId)
  if (!project?.schemaName) throw new AuthorizationProjectionOperationError(
    'DATA_ACCESS_NOT_FOUND', 'Project schema not found'
  )
  return { schemaName: project.schemaName, alias: project.alias }
}

async function requireOperation(
  client: PoolClient,
  projectId: string,
  operationId: string
): Promise<ProjectionOperationRecord> {
  const operation = await getProjectionOperationWithClient(client, projectId, operationId)
  if (!operation) throw new AuthorizationProjectionOperationError(
    'DATA_ACCESS_NOT_FOUND', 'Projection operation not found'
  )
  return operation
}

function assertOperationConfirmation(
  operation: ProjectionOperationRecord,
  schemaName: string,
  projectAlias: string,
  input: ApplyAuthorizationProjectionInput
): void {
  if (operation.schemaName !== schemaName || input.projectAlias !== projectAlias
    || input.sourceDigest !== operation.sourceDigest || input.targetDigest !== operation.targetDigest
    || input.dependencyDigest !== operation.dependencyDigest
    || stableDigest(input.baselineRevisions) !== stableDigest(operation.baselineRevisions)) {
    throw conflict('Projection operation confirmation is stale')
  }
}

async function markApplyFailure(
  client: PoolClient,
  operation: ProjectionOperationRecord,
  error: unknown
): Promise<void> {
  const definitive = error instanceof HasuraMetadataRequestError && error.isDefinitiveRejection
  await transitionProjectionOperation(client, operation.operationId, ['applying'], {
    status: definitive ? 'failed' : 'recovery_required',
    phase: definitive ? 'completed' : 'inspect_recovery',
    writerEpoch: null,
    ...(definitive ? { writeDeadlineAt: null } : {}),
    completedAt: definitive ? new Date() : null,
    error: {
      code: definitive ? 'DATA_ACCESS_PROJECTION_REJECTED' : 'DATA_ACCESS_PROJECTION_RECOVERY_REQUIRED',
      message: definitive ? 'Hasura rejected the projection metadata' : 'Projection outcome requires verification',
    },
  }).catch(() => undefined)
}

function projectRoles(projectId: string) {
  return {
    authenticated: resolveDataScopeRole({ projectId, actor: 'authenticated' }),
    anonymous: resolveDataScopeRole({ projectId, actor: 'anonymous' }),
  }
}

function metadataDigest(
  metadata: Record<string, unknown>,
  operation: ProjectionOperationRecord
): string {
  return authorizationProjectionMetadataDigest(
    metadata, SOURCE_NAME, operation.schemaName, operation.contract
  )
}

function toPreview(operation: ProjectionOperationRecord): AuthorizationProjectionPreview {
  return {
    operationId: operation.operationId, projectId: operation.projectId,
    schemaName: operation.schemaName, status: operation.status,
    sourceDigest: operation.sourceDigest, targetDigest: operation.targetDigest,
    dependencyDigest: operation.dependencyDigest,
    baselineRevisions: operation.baselineRevisions,
    tables: operation.contract.relationships.map((item) => ({
      table: item.table, relationship: item.name,
      ownerColumn: item.ownerColumn, allowColumn: item.allowColumn,
    })),
  }
}

function invalid(message: string): AuthorizationProjectionOperationError {
  return new AuthorizationProjectionOperationError('INVALID_DATA_ACCESS_PROJECTION', message)
}

function conflict(message: string): AuthorizationProjectionOperationError {
  return new AuthorizationProjectionOperationError('DATA_ACCESS_PROJECTION_CONFLICT', message)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}
