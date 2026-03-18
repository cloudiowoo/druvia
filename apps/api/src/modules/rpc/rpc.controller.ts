import type { FastifyRequest, FastifyReply } from 'fastify';
import { callFunction, RpcError } from './rpc.service.js';
import * as projectService from '../project/project.service.js';
import { checkProjectAccess } from '../../lib/access.js';

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
): Promise<{ projectId: string; schemaName: string } | null> {
  const { projectId } = request.params;
  const userId = (request as unknown as { user?: { userId?: string } }).user?.userId;

  if (!userId) {
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

  const hasAccess = await checkProjectAccess(userId, projectId);
  if (!hasAccess) {
    reply.status(403).send({
      success: false,
      error: { code: 'FORBIDDEN', message: 'No access to this project' },
    });
    return null;
  }

  if (!project.schemaName) {
    reply.status(400).send({
      success: false,
      error: { code: 'NO_SCHEMA', message: 'Project has no schema configured' },
    });
    return null;
  }

  return { projectId, schemaName: project.schemaName };
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
    const data = await callFunction(verified.schemaName, functionName, args);
    return reply.send({ data, error: null });
  } catch (error) {
    if (error instanceof RpcError) {
      const status = error.code === 'FUNCTION_NOT_FOUND' ? 404 : 400;
      return reply.status(status).send({
        data: null,
        error: { code: error.code, message: error.message },
      });
    }
    const err = error as Error;
    return reply.status(500).send({
      data: null,
      error: { code: 'RPC_ERROR', message: err.message },
    });
  }
}
