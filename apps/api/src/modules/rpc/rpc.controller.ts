import type { FastifyRequest, FastifyReply } from 'fastify';
import { callFunction, RpcError } from './rpc.service.js';
import * as projectService from '../project/project.service.js';
import { checkProjectAccess } from '../../lib/access.js';
import { assertProjectCapability, AuthorizationError } from '../../lib/project-authorization.js';
import { isPlatformUser, isProjectUser } from '../../middleware/auth.js';
import { ProjectRuntimeContextError } from '../project/project-runtime-context.service.js';
import {
  resolvePlatformProjectActor,
  resolveScopedProjectActor,
  toProjectActorAuditContext,
  type ProjectActorContext,
} from '../../lib/project-actor.js';
import { createApiLogger } from '../../lib/logger.js';

const logger = createApiLogger({ module: 'rpc' });

interface RpcParams {
  projectId: string;
  functionName: string;
}

interface RpcBody {
  args?: Record<string, unknown>;
}

async function verifyProjectAccess(
  request: FastifyRequest<{ Params: RpcParams }>,
  reply: FastifyReply,
): Promise<{ projectId: string; schemaName: string; actor: ProjectActorContext } | null> {
  const { projectId } = request.params;
  const user = request.user;

  if (!user || (!isPlatformUser(user) && !isProjectUser(user))) {
    reply.status(401).send({
      success: false,
      error: { code: 'UNAUTHORIZED', message: 'Not authenticated' },
    });
    return null;
  }

  const project = await projectService.getProjectById(projectId);
  if (!project) {
    reply.status(404).send({
      success: false,
      error: { code: 'NOT_FOUND', message: 'Project not found' },
    });
    return null;
  }

  let actor: ProjectActorContext;
  if (isPlatformUser(user)) {
    try {
      await assertProjectCapability(user, projectId, 'database:write');
    } catch (error) {
      if (!(error instanceof AuthorizationError)) throw error;
      reply.status(error.statusCode).send({
        success: false,
        error: { code: error.code, message: error.message },
      });
      return null;
    }
    actor = resolvePlatformProjectActor(user, projectId);
  } else if (user.projectId !== projectId) {
    reply.status(403).send({
      success: false,
      error: { code: 'FORBIDDEN', message: 'No access to this project' },
    });
    return null;
  } else {
    actor = resolveScopedProjectActor(user, projectId);
  }

  if (!project.schemaName) {
    reply.status(400).send({
      success: false,
      error: { code: 'NO_SCHEMA', message: 'Project has no schema configured' },
    });
    return null;
  }

  return { projectId, schemaName: project.schemaName, actor };
}

export async function invokeRpc(
  request: FastifyRequest<{ Params: RpcParams; Body: RpcBody }>,
  reply: FastifyReply,
) {
  const verified = await verifyProjectAccess(request, reply);
  if (!verified) return;

  const { functionName } = request.params;
  const { args } = request.body || {};

  try {
    const data = await callFunction(verified.schemaName, functionName, args, verified.actor);
    logger.info('rpc invocation succeeded', {
      ...toProjectActorAuditContext(verified.actor),
      functionName,
    });
    return reply.send({ data, error: null });
  } catch (error) {
    const auditContext = {
      ...toProjectActorAuditContext(verified.actor),
      functionName,
    };
    if (error instanceof ProjectRuntimeContextError) {
      logger.error('rpc project runtime context unavailable', auditContext, error);
      return reply.status(error.statusCode).send({
        data: null,
        error: {
          code: error.code,
          message: 'Project runtime context is unavailable',
        },
      });
    }
    if (error instanceof RpcError) {
      if (error.code === 'RPC_REJECTED') {
        logger.warn('rpc invocation rejected', auditContext);
      } else {
        logger.error('rpc invocation failed', auditContext, error);
      }
      const status = error.code === 'FUNCTION_NOT_FOUND' ? 404 : 400;
      return reply.status(status).send({
        data: null,
        error: {
          code: error.code,
          message: error.code === 'FUNCTION_NOT_FOUND'
            ? 'Function not found'
            : error.code === 'RPC_REJECTED'
              ? 'RPC request rejected'
              : 'RPC request failed',
        },
      });
    }
    logger.error('rpc invocation failed', auditContext, error);
    return reply.status(500).send({
      data: null,
      error: { code: 'RPC_ERROR', message: 'RPC execution failed' },
    });
  }
}
