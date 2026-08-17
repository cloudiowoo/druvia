import type { FastifyReply, FastifyRequest } from 'fastify'
import { checkProjectAccess } from '../../lib/access.js'
import {
  DataAccessConflictError,
  DataAccessNotFoundError,
  DataAccessUpstreamError,
  getTableDataAccess as getTableDataAccessState,
  updateTableDataAccess as updateTableDataAccessState,
} from './data-access.service.js'
import type { AuthenticatedAccessMode, TableDataAccessInput } from './data-access.types.js'
import { DataAccessValidationError } from './data-access-policy.js'

interface TableDataAccessParams {
  projectId: string
  tableName: string
}

const ACCESS_MODES = new Set<AuthenticatedAccessMode>(['none', 'all', 'owner'])

export async function getTableDataAccess(
  request: FastifyRequest<{ Params: TableDataAccessParams }>,
  reply: FastifyReply
) {
  if (!(await verifyManagementAccess(request, reply))) return

  try {
    const state = await getTableDataAccessState(
      request.params.projectId,
      request.params.tableName
    )
    return reply.send({ success: true, data: state })
  } catch (error) {
    return sendDataAccessError(error, reply)
  }
}

export async function updateTableDataAccess(
  request: FastifyRequest<{
    Params: TableDataAccessParams
    Body: TableDataAccessInput
  }>,
  reply: FastifyReply
) {
  if (!(await verifyManagementAccess(request, reply))) return
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
      request.body
    )
    return reply.send({ success: true, data: state })
  } catch (error) {
    if (error instanceof DataAccessValidationError) {
      return reply.status(400).send({
        success: false,
        error: { code: 'INVALID_DATA_ACCESS_POLICY', message: error.message },
      })
    }
    return sendDataAccessError(error, reply)
  }
}

async function verifyManagementAccess(
  request: FastifyRequest<{ Params: TableDataAccessParams }>,
  reply: FastifyReply
): Promise<boolean> {
  const user = request.user
  if (!user || user.kind !== 'platform_user') {
    reply.status(401).send({
      success: false,
      error: { code: 'UNAUTHORIZED', message: 'Platform authentication required' },
    })
    return false
  }

  const hasAccess = await checkProjectAccess(user.userId, request.params.projectId)
  if (!hasAccess) {
    reply.status(403).send({
      success: false,
      error: { code: 'FORBIDDEN', message: 'No access to this project' },
    })
    return false
  }
  return true
}

function isTableDataAccessInput(value: unknown): value is TableDataAccessInput {
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function sendDataAccessError(error: unknown, reply: FastifyReply) {
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
