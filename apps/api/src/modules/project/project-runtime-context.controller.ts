import type { FastifyReply, FastifyRequest } from 'fastify'
import { SERVICE_ENVIRONMENTS, type ServiceEnvironment } from '@druvia/shared'
import { isPlatformUser, type PlatformJwtUser } from '../../middleware/auth.js'
import {
  disableProjectRuntimeContext,
  getProjectRuntimeContext,
  ProjectRuntimeContextError,
  ProjectRuntimeContextInUseError,
  ProjectRuntimeContextNotFoundError,
  setProjectRuntimeContext,
} from './project-runtime-context.service.js'

type ProjectParams = { projectId: string }

function isServiceEnvironment(value: unknown): value is ServiceEnvironment {
  return typeof value === 'string'
    && (SERVICE_ENVIRONMENTS as readonly string[]).includes(value)
}

function validContextBody(value: unknown): value is { serviceEnvironment: ServiceEnvironment } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const body = value as Record<string, unknown>
  return Object.keys(body).length === 1 && isServiceEnvironment(body.serviceEnvironment)
}

function sendError(reply: FastifyReply, error: unknown) {
  if (error instanceof ProjectRuntimeContextInUseError) {
    return reply.status(error.statusCode).send({
      success: false,
      error: { code: error.code, message: 'Project runtime context is in use' },
    })
  }
  if (error instanceof ProjectRuntimeContextError) {
    return reply.status(error.statusCode).send({
      success: false,
      error: { code: error.code, message: 'Project runtime context is unavailable' },
    })
  }
  if (error instanceof ProjectRuntimeContextNotFoundError) {
    return reply.status(error.statusCode).send({
      success: false,
      error: { code: error.code, message: 'Project not found' },
    })
  }
  throw error
}

function requirePlatformActor(
  request: FastifyRequest,
  reply: FastifyReply,
): PlatformJwtUser | null {
  if (request.user && isPlatformUser(request.user)) return request.user
  reply.status(401).send({
    success: false,
    error: { code: 'UNAUTHORIZED', message: 'Platform authentication required' },
  })
  return null
}

export async function getRuntimeContext(
  request: FastifyRequest<{ Params: ProjectParams }>,
  reply: FastifyReply,
) {
  try {
    return reply.send({
      success: true,
      data: await getProjectRuntimeContext(request.params.projectId),
    })
  } catch (error) {
    return sendError(reply, error)
  }
}

export async function setRuntimeContext(
  request: FastifyRequest<{ Params: ProjectParams; Body: unknown }>,
  reply: FastifyReply,
) {
  const actor = requirePlatformActor(request, reply)
  if (!actor) return
  if (!validContextBody(request.body)) {
    return reply.status(400).send({
      success: false,
      error: { code: 'INVALID_INPUT', message: 'Invalid project runtime context' },
    })
  }
  try {
    return reply.send({
      success: true,
      data: await setProjectRuntimeContext({
        projectId: request.params.projectId,
        serviceEnvironment: request.body.serviceEnvironment,
        actorUserId: actor.userId,
        requestId: request.id,
      }),
    })
  } catch (error) {
    return sendError(reply, error)
  }
}

export async function disableRuntimeContext(
  request: FastifyRequest<{ Params: ProjectParams }>,
  reply: FastifyReply,
) {
  const actor = requirePlatformActor(request, reply)
  if (!actor) return
  try {
    return reply.send({
      success: true,
      data: await disableProjectRuntimeContext({
        projectId: request.params.projectId,
        actorUserId: actor.userId,
        requestId: request.id,
      }),
    })
  } catch (error) {
    return sendError(reply, error)
  }
}
