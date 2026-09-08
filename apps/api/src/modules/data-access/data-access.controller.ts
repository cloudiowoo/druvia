import type { FastifyReply, FastifyRequest } from 'fastify'
import { checkProjectAccess } from '../../lib/access.js'
import {
  DataAccessConflictError,
  DataAccessNotFoundError,
  DataAccessUpstreamError,
  getProjectDataAccessOverview as getProjectDataAccessOverviewState,
  getTableDataAccess as getTableDataAccessState,
  updateTableDataAccess as updateTableDataAccessState,
} from './data-access.service.js'
import type {
  AuthenticatedAccessMode,
  DataAccessColumnGrants,
  TableDataAccessInput,
  TableDataAccessUpdateInput,
} from './data-access.types.js'
import { DataAccessValidationError } from './data-access-policy.js'
import { DataAccessMutationLockedError } from './data-access-mutation-lock.js'
import {
  DataAccessMigrationConflictError,
  DataAccessMigrationInputError,
  DataAccessMigrationNotFoundError,
  applyDataAccessMigration as applyDataAccessMigrationState,
  getDataAccessMigration as getDataAccessMigrationState,
  previewDataAccessMigration as previewDataAccessMigrationState,
  previewDataAccessMigrationRollback as previewDataAccessMigrationRollbackState,
  recoverDataAccessMigration as recoverDataAccessMigrationState,
  rollbackDataAccessMigration as rollbackDataAccessMigrationState,
  type ApplyDataAccessMigrationInput,
  type PreviewDataAccessMigrationInput,
  type RecoverDataAccessMigrationInput,
  type RollbackDataAccessMigrationInput,
} from './data-access-migration.service.js'
import type { ProjectDataAccessMigrationReport } from './data-access-migration.types.js'
import {
  DataAccessPolicyOperationError,
  applyPolicyAdoption as applyPolicyAdoptionState,
  applyPolicyReconcile as applyPolicyReconcileState,
  getActivePolicyOperation as getActivePolicyOperationState,
  previewPolicyAdoption as previewPolicyAdoptionState,
  previewPolicyReconcile as previewPolicyReconcileState,
  recoverPolicyOperation as recoverPolicyOperationState,
} from './data-access-policy-operation.service.js'

interface TableDataAccessParams {
  projectId: string
  tableName: string
}

interface ProjectDataAccessParams {
  projectId: string
}

interface DataAccessMigrationParams extends ProjectDataAccessParams {
  migrationId: string
}

interface DataAccessPolicyOperationParams extends ProjectDataAccessParams {
  operationId: string
}

const ACCESS_MODES = new Set<AuthenticatedAccessMode>(['none', 'all', 'owner'])

export async function getProjectDataAccessOverview(
  request: FastifyRequest<{ Params: ProjectDataAccessParams }>,
  reply: FastifyReply
) {
  if (!(await verifyManagementAccess(request.user, request.params.projectId, reply))) return

  try {
    const overview = await getProjectDataAccessOverviewState(request.params.projectId)
    return reply.send({ success: true, data: overview })
  } catch (error) {
    return sendDataAccessError(error, reply, request)
  }
}

export async function getTableDataAccess(
  request: FastifyRequest<{ Params: TableDataAccessParams }>,
  reply: FastifyReply
) {
  if (!(await verifyManagementAccess(request.user, request.params.projectId, reply))) return

  try {
    const state = await getTableDataAccessState(
      request.params.projectId,
      request.params.tableName
    )
    return reply.send({ success: true, data: state })
  } catch (error) {
    return sendDataAccessError(error, reply, request)
  }
}

export async function updateTableDataAccess(
  request: FastifyRequest<{
    Params: TableDataAccessParams
    Body: TableDataAccessUpdateInput
  }>,
  reply: FastifyReply
) {
  if (!(await verifyManagementAccess(request.user, request.params.projectId, reply))) return
  if (!isTableDataAccessInput(request.body)) {
    return reply.status(400).send({
      success: false,
      error: { code: 'INVALID_DATA_ACCESS_POLICY', message: 'Invalid data access policy' },
    })
  }

  try {
    const state = await updateTableDataAccessState(
      request.params.projectId,
      request.params.tableName,
      request.body,
      platformUserId(request.user)
    )
    return reply.send({ success: true, data: state })
  } catch (error) {
    if (error instanceof DataAccessValidationError) {
      return reply.status(400).send({
        success: false,
        error: { code: 'INVALID_DATA_ACCESS_POLICY', message: error.message },
      })
    }
    return sendDataAccessError(error, reply, request)
  }
}

export async function previewPolicyAdoption(
  request: FastifyRequest<{ Params: TableDataAccessParams }>,
  reply: FastifyReply
) {
  if (!(await verifyManagementAccess(request.user, request.params.projectId, reply))) return
  try {
    const data = await previewPolicyAdoptionState(
      request.params.projectId, request.params.tableName, platformUserId(request.user)
    )
    return reply.send({ success: true, data })
  } catch (error) {
    return sendDataAccessError(error, reply, request)
  }
}

export async function applyPolicyAdoption(
  request: FastifyRequest<{
    Params: TableDataAccessParams
    Body: { operationId: string; sourceDigest: string; projectAlias: string }
  }>,
  reply: FastifyReply
) {
  if (!(await verifyManagementAccess(request.user, request.params.projectId, reply))) return
  if (!isOperationConfirmation(request.body, false)) return sendInvalidPolicyOperationInput(reply)
  try {
    const data = await applyPolicyAdoptionState(
      request.params.projectId, request.params.tableName, request.body, platformUserId(request.user),
      () => getTableDataAccessState(request.params.projectId, request.params.tableName)
    )
    return reply.send({ success: true, data })
  } catch (error) {
    return sendDataAccessError(error, reply, request)
  }
}

export async function previewPolicyReconcile(
  request: FastifyRequest<{
    Params: TableDataAccessParams
    Body: { columnGrants?: DataAccessColumnGrants; policy?: TableDataAccessInput }
  }>,
  reply: FastifyReply
) {
  if (!(await verifyManagementAccess(request.user, request.params.projectId, reply))) return
  if ((request.body?.columnGrants !== undefined && !isColumnGrants(request.body.columnGrants))
    || (request.body?.policy !== undefined && !isTableDataAccessPolicy(request.body.policy))) {
    return sendInvalidPolicyOperationInput(reply)
  }
  try {
    const data = await previewPolicyReconcileState(
      request.params.projectId, request.params.tableName, platformUserId(request.user), request.body ?? {}
    )
    return reply.send({ success: true, data })
  } catch (error) {
    return sendDataAccessError(error, reply, request)
  }
}

export async function applyPolicyReconcile(
  request: FastifyRequest<{
    Params: TableDataAccessParams
    Body: {
      operationId: string; sourceDigest: string; targetDigest: string
      baselineRevision: number; projectAlias: string; columnGrants: DataAccessColumnGrants
      policy: TableDataAccessInput
    }
  }>,
  reply: FastifyReply
) {
  if (!(await verifyManagementAccess(request.user, request.params.projectId, reply))) return
  if (!isOperationConfirmation(request.body, true)
    || !Number.isSafeInteger(request.body.baselineRevision)
    || !isColumnGrants(request.body.columnGrants)
    || !isTableDataAccessPolicy(request.body.policy)) return sendInvalidPolicyOperationInput(reply)
  try {
    const data = await applyPolicyReconcileState(
      request.params.projectId, request.params.tableName, request.body, platformUserId(request.user),
      () => getTableDataAccessState(request.params.projectId, request.params.tableName)
    )
    return reply.send({ success: true, data })
  } catch (error) {
    return sendDataAccessError(error, reply, request)
  }
}

export async function getActivePolicyOperation(
  request: FastifyRequest<{ Params: ProjectDataAccessParams }>,
  reply: FastifyReply
) {
  if (!(await verifyManagementAccess(request.user, request.params.projectId, reply))) return
  try {
    return reply.send({
      success: true,
      data: await getActivePolicyOperationState(request.params.projectId),
    })
  } catch (error) {
    return sendDataAccessError(error, reply, request)
  }
}

export async function recoverPolicyOperation(
  request: FastifyRequest<{
    Params: DataAccessPolicyOperationParams
    Body: { sourceDigest: string; projectAlias: string }
  }>,
  reply: FastifyReply
) {
  if (!(await verifyManagementAccess(request.user, request.params.projectId, reply))) return
  if (!isRecord(request.body) || !isDigest(request.body.sourceDigest)
    || typeof request.body.projectAlias !== 'string') return sendInvalidPolicyOperationInput(reply)
  try {
    const data = await recoverPolicyOperationState(
      request.params.projectId, request.params.operationId, request.body
    )
    return reply.send({ success: true, data })
  } catch (error) {
    return sendDataAccessError(error, reply, request)
  }
}

export async function getDataAccessMigration(
  request: FastifyRequest<{ Params: ProjectDataAccessParams }>,
  reply: FastifyReply
) {
  if (!(await verifyManagementAccess(request.user, request.params.projectId, reply))) return
  try {
    const migration = await getDataAccessMigrationState(request.params.projectId)
    return reply.send({ success: true, data: migration })
  } catch (error) {
    return sendMigrationError(error, reply)
  }
}

export async function previewDataAccessMigration(
  request: FastifyRequest<{ Params: ProjectDataAccessParams; Body: PreviewDataAccessMigrationInput }>,
  reply: FastifyReply
) {
  if (!(await verifyManagementAccess(request.user, request.params.projectId, reply))) return
  if (!isPreviewInput(request.body) || request.user?.kind !== 'platform_user') {
    return sendInvalidMigrationInput(reply)
  }
  try {
    const migration = await previewDataAccessMigrationState(
      request.params.projectId, request.user.userId, request.body
    )
    return reply.send({ success: true, data: migration })
  } catch (error) {
    return sendMigrationError(error, reply)
  }
}

export async function applyDataAccessMigration(
  request: FastifyRequest<{ Params: DataAccessMigrationParams; Body: ApplyDataAccessMigrationInput }>,
  reply: FastifyReply
) {
  if (!(await verifyManagementAccess(request.user, request.params.projectId, reply))) return
  if (!isApplyInput(request.body)) return sendInvalidMigrationInput(reply)
  try {
    const migration = await applyDataAccessMigrationState(
      request.params.projectId, request.params.migrationId, request.body
    )
    return sendMigrationOperationResult(migration, reply)
  } catch (error) {
    return sendMigrationError(error, reply)
  }
}

export async function recoverDataAccessMigration(
  request: FastifyRequest<{ Params: DataAccessMigrationParams; Body: RecoverDataAccessMigrationInput }>,
  reply: FastifyReply
) {
  if (!(await verifyManagementAccess(request.user, request.params.projectId, reply))) return
  if (!isRecoveryInput(request.body)) return sendInvalidMigrationInput(reply)
  try {
    const migration = await recoverDataAccessMigrationState(
      request.params.projectId, request.params.migrationId, request.body
    )
    return sendMigrationOperationResult(migration, reply)
  } catch (error) {
    return sendMigrationError(error, reply)
  }
}

export async function previewDataAccessMigrationRollback(
  request: FastifyRequest<{ Params: DataAccessMigrationParams; Body: { projectAlias: string } }>,
  reply: FastifyReply
) {
  if (!(await verifyManagementAccess(request.user, request.params.projectId, reply))) return
  if (!isRecord(request.body) || typeof request.body.projectAlias !== 'string' || !request.body.projectAlias) {
    return sendInvalidMigrationInput(reply)
  }
  try {
    const migration = await previewDataAccessMigrationRollbackState(
      request.params.projectId, request.params.migrationId, request.body.projectAlias
    )
    return reply.send({ success: true, data: migration })
  } catch (error) {
    return sendMigrationError(error, reply)
  }
}

export async function rollbackDataAccessMigration(
  request: FastifyRequest<{ Params: DataAccessMigrationParams; Body: RollbackDataAccessMigrationInput }>,
  reply: FastifyReply
) {
  if (!(await verifyManagementAccess(request.user, request.params.projectId, reply))) return
  if (!isRollbackInput(request.body)) return sendInvalidMigrationInput(reply)
  try {
    const migration = await rollbackDataAccessMigrationState(
      request.params.projectId, request.params.migrationId, request.body
    )
    return sendMigrationOperationResult(migration, reply)
  } catch (error) {
    return sendMigrationError(error, reply)
  }
}

async function verifyManagementAccess(
  user: FastifyRequest['user'],
  projectId: string,
  reply: FastifyReply
): Promise<boolean> {
  if (!user || user.kind !== 'platform_user') {
    reply.status(401).send({
      success: false,
      error: { code: 'UNAUTHORIZED', message: 'Platform authentication required' },
    })
    return false
  }

  let hasAccess: boolean
  try {
    hasAccess = await checkProjectAccess(user.userId, projectId)
  } catch (error) {
    sendDataAccessError(error, reply)
    return false
  }
  if (!hasAccess) {
    reply.status(403).send({
      success: false,
      error: { code: 'FORBIDDEN', message: 'No access to this project' },
    })
    return false
  }
  return true
}

function isTableDataAccessInput(value: unknown): value is TableDataAccessUpdateInput {
  if (!isRecord(value) || !isTableDataAccessPolicy(value)) return false
  const envelope = value as Record<string, unknown>
  return typeof envelope.operationId === 'string'
    && (envelope.expectedBaselineRevision === undefined
      || Number.isSafeInteger(envelope.expectedBaselineRevision))
    && (envelope.columnGrants === undefined || isColumnGrants(envelope.columnGrants))
}

function isTableDataAccessPolicy(value: unknown): value is TableDataAccessInput {
  if (!isRecord(value) || !isRecord(value.authenticated) || !isRecord(value.anonymous)) {
    return false
  }
  const authenticated = value.authenticated
  const ownerColumn = authenticated.ownerColumn
  return ['select', 'insert', 'update', 'delete'].every(
    (operation) => ACCESS_MODES.has(authenticated[operation] as AuthenticatedAccessMode)
  )
    && (ownerColumn === null || typeof ownerColumn === 'string')
    && typeof value.anonymous.select === 'boolean'
}

function isColumnGrants(value: unknown): value is DataAccessColumnGrants {
  if (!isRecord(value) || !isRecord(value.authenticated) || !isRecord(value.anonymous)) return false
  const authenticated = value.authenticated
  const anonymous = value.anonymous
  return ['select', 'insert', 'update'].every(
    (operation) => isStringArray(authenticated[operation])
  ) && isStringArray(anonymous.select)
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string')
}

function isOperationConfirmation(
  value: unknown,
  targetRequired: boolean
): value is {
  operationId: string; sourceDigest: string; targetDigest: string
  projectAlias: string
} {
  return isRecord(value)
    && typeof value.operationId === 'string'
    && isDigest(value.sourceDigest)
    && (!targetRequired || isDigest(value.targetDigest))
    && typeof value.projectAlias === 'string'
}

function sendInvalidPolicyOperationInput(reply: FastifyReply) {
  return reply.status(400).send({
    success: false,
    error: { code: 'INVALID_DATA_ACCESS_POLICY_OPERATION', message: 'Invalid data access operation' },
  })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function isPreviewInput(value: unknown): value is PreviewDataAccessMigrationInput {
  if (!isRecord(value)) return false
  if (value.skipLegacyInferenceTables === undefined) return true
  return Array.isArray(value.skipLegacyInferenceTables)
    && value.skipLegacyInferenceTables.every((item) => typeof item === 'string' && item.length > 0)
}

function isApplyInput(value: unknown): value is ApplyDataAccessMigrationInput {
  return isRecord(value)
    && isDigest(value.sourceDigest)
    && typeof value.confirmInferredPolicies === 'boolean'
    && typeof value.confirmDestructiveChanges === 'boolean'
    && (value.projectAlias === undefined || typeof value.projectAlias === 'string')
}

function isRecoveryInput(value: unknown): value is RecoverDataAccessMigrationInput {
  return isRecord(value)
    && isDigest(value.expectedRecoveryDigest)
    && typeof value.projectAlias === 'string'
    && value.projectAlias.length > 0
}

function isRollbackInput(value: unknown): value is RollbackDataAccessMigrationInput {
  return isRecord(value)
    && isDigest(value.rollbackPreviewDigest)
    && typeof value.projectAlias === 'string'
    && value.projectAlias.length > 0
}

function isDigest(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
}

function sendInvalidMigrationInput(reply: FastifyReply) {
  return reply.status(400).send({
    success: false,
    error: { code: 'INVALID_DATA_ACCESS_MIGRATION_INPUT', message: 'Invalid migration request' },
  })
}

function sendMigrationOperationResult(
  migration: ProjectDataAccessMigrationReport,
  reply: FastifyReply
) {
  if (migration.error) {
    return reply.status(502).send({
      success: false,
      data: migration,
      error: { code: migration.error.code, message: migration.error.message },
    })
  }
  return reply.send({ success: true, data: migration })
}

function sendMigrationError(error: unknown, reply: FastifyReply) {
  if (error instanceof DataAccessMigrationInputError) {
    return reply.status(400).send({
      success: false,
      error: { code: error.code, message: 'Migration confirmation is invalid' },
    })
  }
  if (error instanceof DataAccessMigrationNotFoundError) {
    return reply.status(404).send({
      success: false,
      error: { code: error.code, message: 'Migration or project was not found' },
    })
  }
  if (error instanceof DataAccessMigrationConflictError || error instanceof DataAccessMutationLockedError) {
    return reply.status(409).send({
      success: false,
      error: {
        code: error instanceof DataAccessMigrationConflictError ? error.code : error.code,
        message: 'Migration state changed or project data is temporarily locked',
      },
    })
  }
  return reply.status(500).send({
    success: false,
    error: { code: 'DATA_ACCESS_MIGRATION_FAILED', message: 'Unable to manage data access migration' },
  })
}

function sendDataAccessError(
  error: unknown,
  reply: FastifyReply,
  request?: FastifyRequest
) {
  if (error instanceof DataAccessMutationLockedError) {
    return reply.status(409).send({
      success: false,
      error: { code: error.code, message: 'Project data changes are temporarily locked' },
    })
  }
  if (error instanceof DataAccessPolicyOperationError) {
    const status = error.code === 'DATA_ACCESS_UPSTREAM_ERROR'
      ? 502
      : error.code === 'DATA_ACCESS_NOT_FOUND'
      ? 404
      : error.code.startsWith('INVALID_')
        ? 400
        : 409
    return reply.status(status).send({
      success: false,
      error: {
        code: error.code,
        message: status === 502 ? 'Data access service is temporarily unavailable' : error.message,
      },
    })
  }
  if (error instanceof DataAccessValidationError) {
    return reply.status(400).send({
      success: false,
      error: { code: 'INVALID_DATA_ACCESS_POLICY', message: error.message },
    })
  }
  if (error instanceof DataAccessNotFoundError) {
    return reply.status(404).send({
      success: false,
      error: { code: 'DATA_ACCESS_NOT_FOUND', message: error.message },
    })
  }
  if (error instanceof DataAccessConflictError) {
    return reply.status(409).send({
      success: false,
      error: { code: 'DATA_ACCESS_CONFLICT', message: error.message },
    })
  }
  if (error instanceof DataAccessUpstreamError) {
    const requestParams = isRecord(request?.params) ? request.params : {}
    request?.log?.error({
      requestId: request.id,
      projectId: error.projectId ?? stringValue(requestParams.projectId),
      schemaName: error.schemaName,
      tableName: error.tableName ?? stringValue(requestParams.tableName),
      operation: error.operation,
      upstreamCode: error.upstreamCode,
      upstreamMessage: error.upstreamMessage,
    }, 'Data access upstream request failed')
    return reply.status(502).send({
      success: false,
      error: {
        code: 'DATA_ACCESS_SERVICE_UNAVAILABLE',
        message: 'Data access service is temporarily unavailable',
      },
    })
  }
  return reply.status(500).send({
    success: false,
    error: { code: 'DATA_ACCESS_FAILED', message: 'Unable to manage data access' },
  })
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function platformUserId(user: FastifyRequest['user']): string {
  if (!user || user.kind !== 'platform_user') throw new Error('Platform authentication required')
  return user.userId
}
