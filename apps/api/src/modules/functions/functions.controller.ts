import type { FastifyRequest, FastifyReply } from 'fastify';
import * as functionsService from './functions.service.js';
import * as projectService from '../project/project.service.js';
import { checkProjectAccess } from '../../lib/access.js';
import { assertProjectCapability, AuthorizationError } from '../../lib/project-authorization.js';
import { isPlatformUser } from '../../middleware/auth.js';
import {
  ProjectActorRequiredError,
  ProjectActorScopeError,
  resolvePlatformProjectActor,
  resolveScopedProjectActor,
  type ProjectActorContext,
} from '../../lib/project-actor.js';

interface ProjectParams {
  projectId: string;
}

interface FunctionParams extends ProjectParams {
  name: string;
}

interface SecretParams extends ProjectParams {
  key: string;
}

interface ScheduleParams extends ProjectParams {
  name: string;
  scheduleId: string;
}

async function verifyProjectExists(projectId: string, reply: FastifyReply): Promise<boolean> {
  const project = await projectService.getProjectById(projectId);
  if (!project) {
    reply.status(404).send({
      success: false,
      error: { code: 'NOT_FOUND', message: 'Project not found' },
    });
    return false;
  }

  return true;
}

// 验证项目访问权限
async function verifyProjectAccess(
  request: FastifyRequest<{ Params: ProjectParams }>,
  reply: FastifyReply
): Promise<{ projectId: string } | null> {
  const { projectId } = request.params;
  const user = request.user;

  if (!user || !isPlatformUser(user)) {
    reply.status(401).send({
      success: false,
      error: { code: 'UNAUTHORIZED', message: 'Not authenticated' },
    });
    return null;
  }

  try {
    await assertProjectCapability(user, projectId, 'functions:manage');
    return { projectId };
  } catch (error) {
    if (!(error instanceof AuthorizationError)) throw error;
    reply.status(error.statusCode).send({
      success: false,
      error: { code: error.code, message: error.message },
    });
    return null;
  }
}

async function verifyInvokeAccess(
  request: FastifyRequest<{ Params: FunctionParams }>,
  reply: FastifyReply
): Promise<{ projectId: string; actor: ProjectActorContext } | null> {
  const { projectId } = request.params;
  const user = request.user;

  if (!user) {
    reply.status(401).send({
      success: false,
      error: { code: 'UNAUTHORIZED', message: 'Not authenticated' },
    });
    return null;
  }

  if (!(await verifyProjectExists(projectId, reply))) {
    return null;
  }

  if (!isPlatformUser(user)) {
    if (user.projectId !== projectId) {
      reply.status(403).send({
        success: false,
        error: { code: 'FORBIDDEN', message: 'No access to this project' },
      });
      return null;
    }

    try {
      return { projectId, actor: resolveScopedProjectActor(user, projectId) };
    } catch (error) {
      const status = error instanceof ProjectActorScopeError ? 403 : 401;
      reply.status(status).send({
        success: false,
        error: {
          code: status === 403 ? 'FORBIDDEN' : 'UNAUTHORIZED',
          message: status === 403 ? 'No access to this project' : 'Not authenticated',
        },
      });
      return null;
    }
  }

  try {
    await assertProjectCapability(user, projectId, 'functions:manage');
  } catch (error) {
    if (!(error instanceof AuthorizationError)) throw error;
    reply.status(error.statusCode).send({
      success: false,
      error: { code: error.code, message: error.message },
    });
    return null;
  }

  return {
    projectId,
    actor: resolvePlatformProjectActor(user, projectId),
  };
}

// ============================================
// Functions CRUD
// ============================================

export async function listFunctions(
  request: FastifyRequest<{ Params: ProjectParams }>,
  reply: FastifyReply
) {
  const verified = await verifyProjectAccess(request, reply);
  if (!verified) return;

  try {
    const functions = await functionsService.listFunctions(verified.projectId);
    return reply.send({ success: true, data: functions });
  } catch (error) {
    const err = error as Error;
    return reply.status(500).send({
      success: false,
      error: { code: 'LIST_FAILED', message: err.message },
    });
  }
}

export async function createFunction(
  request: FastifyRequest<{ Params: ProjectParams; Body: { name: string; code: string; description?: string; invokeAuthMode?: functionsService.FunctionInvokeAuthMode } }>,
  reply: FastifyReply
) {
  const verified = await verifyProjectAccess(request, reply);
  if (!verified) return;

  const { name, code, description, invokeAuthMode } = request.body;

  if (!name || !code) {
    return reply.status(400).send({
      success: false,
      error: { code: 'INVALID_INPUT', message: 'Name and code are required' },
    });
  }

  try {
    const func = await functionsService.createFunction(verified.projectId, { name, code, description, invokeAuthMode });
    return reply.status(201).send({ success: true, data: func });
  } catch (error) {
    const err = error as Error;
    if (err.message.includes('duplicate key') || err.message.includes('unique constraint')) {
      return reply.status(409).send({
        success: false,
        error: { code: 'DUPLICATE', message: 'Function with this name already exists' },
      });
    }
    return reply.status(500).send({
      success: false,
      error: { code: 'CREATE_FAILED', message: err.message },
    });
  }
}

export async function getFunction(
  request: FastifyRequest<{ Params: FunctionParams }>,
  reply: FastifyReply
) {
  const verified = await verifyProjectAccess(request, reply);
  if (!verified) return;

  const { name } = request.params;

  try {
    const func = await functionsService.getFunction(verified.projectId, name);
    if (!func) {
      return reply.status(404).send({
        success: false,
        error: { code: 'NOT_FOUND', message: 'Function not found' },
      });
    }
    return reply.send({ success: true, data: func });
  } catch (error) {
    const err = error as Error;
    return reply.status(500).send({
      success: false,
      error: { code: 'GET_FAILED', message: err.message },
    });
  }
}

export async function updateFunction(
  request: FastifyRequest<{ Params: FunctionParams; Body: { code?: string; status?: string; description?: string; invokeAuthMode?: functionsService.FunctionInvokeAuthMode } }>,
  reply: FastifyReply
) {
  const verified = await verifyProjectAccess(request, reply);
  if (!verified) return;

  const { name } = request.params;
  const { code, status, description, invokeAuthMode } = request.body;

  try {
    const func = await functionsService.updateFunction(verified.projectId, name, { code, status, description, invokeAuthMode });
    if (!func) {
      return reply.status(404).send({
        success: false,
        error: { code: 'NOT_FOUND', message: 'Function not found' },
      });
    }
    return reply.send({ success: true, data: func });
  } catch (error) {
    const err = error as Error;
    return reply.status(500).send({
      success: false,
      error: { code: 'UPDATE_FAILED', message: err.message },
    });
  }
}

export async function deleteFunction(
  request: FastifyRequest<{ Params: FunctionParams }>,
  reply: FastifyReply
) {
  const verified = await verifyProjectAccess(request, reply);
  if (!verified) return;

  const { name } = request.params;

  try {
    const deleted = await functionsService.deleteFunction(verified.projectId, name);
    if (!deleted) {
      return reply.status(404).send({
        success: false,
        error: { code: 'NOT_FOUND', message: 'Function not found' },
      });
    }
    return reply.send({ success: true });
  } catch (error) {
    const err = error as Error;
    return reply.status(500).send({
      success: false,
      error: { code: 'DELETE_FAILED', message: err.message },
    });
  }
}

// ============================================
// Invoke
// ============================================

export async function invokeFunction(
  request: FastifyRequest<{ Params: FunctionParams; Body: { payload?: unknown } }>,
  reply: FastifyReply
) {
  const verified = await verifyInvokeAccess(request, reply);
  if (!verified) return;

  const { name } = request.params;
  const { payload } = request.body || {};

  try {
    const result = await functionsService.invokeFunction(verified.projectId, name, payload, verified.actor);
    return reply.send({ success: true, data: result });
  } catch (error) {
    if (error instanceof functionsService.FunctionInvokeForbiddenError) {
      return reply.status(403).send({
        success: false,
        error: { code: 'FORBIDDEN', message: 'Function requires an authenticated user' },
      });
    }
    if (error instanceof functionsService.FunctionActorScopeError || error instanceof ProjectActorScopeError) {
      return reply.status(403).send({
        success: false,
        error: { code: 'FORBIDDEN', message: 'No access to this project' },
      });
    }
    if (error instanceof functionsService.FunctionNotFoundError) {
      return reply.status(404).send({
        success: false,
        error: { code: 'NOT_FOUND', message: 'Function not found' },
      });
    }
    if (error instanceof functionsService.FunctionDisabledError) {
      return reply.status(400).send({
        success: false,
        error: { code: 'INVOKE_FAILED', message: 'Function is disabled' },
      });
    }
    if (error instanceof ProjectActorRequiredError) {
      return reply.status(401).send({
        success: false,
        error: { code: 'UNAUTHORIZED', message: 'Not authenticated' },
      });
    }
    return reply.status(500).send({
      success: false,
      error: { code: 'INVOKE_FAILED', message: 'Function invocation failed' },
    });
  }
}

// ============================================
// Logs
// ============================================

export async function getFunctionLogs(
  request: FastifyRequest<{ Params: FunctionParams; Querystring: { limit?: string; offset?: string; level?: string } }>,
  reply: FastifyReply
) {
  const verified = await verifyProjectAccess(request, reply);
  if (!verified) return;

  const { name } = request.params;
  const { limit, offset, level } = request.query;

  try {
    const func = await functionsService.getFunction(verified.projectId, name);
    if (!func) {
      return reply.status(404).send({
        success: false,
        error: { code: 'NOT_FOUND', message: 'Function not found' },
      });
    }

    const logs = await functionsService.getLogs(func.id, {
      limit: limit ? parseInt(limit, 10) : undefined,
      offset: offset ? parseInt(offset, 10) : undefined,
      level,
    });
    return reply.send({ success: true, data: logs });
  } catch (error) {
    const err = error as Error;
    return reply.status(500).send({
      success: false,
      error: { code: 'GET_LOGS_FAILED', message: err.message },
    });
  }
}

// ============================================
// Secrets
// ============================================

export async function listSecrets(
  request: FastifyRequest<{ Params: ProjectParams }>,
  reply: FastifyReply
) {
  const verified = await verifyProjectAccess(request, reply);
  if (!verified) return;

  try {
    const secrets = await functionsService.listSecrets(verified.projectId);
    return reply.send({ success: true, data: secrets });
  } catch (error) {
    const err = error as Error;
    return reply.status(500).send({
      success: false,
      error: { code: 'LIST_FAILED', message: err.message },
    });
  }
}

export async function createSecret(
  request: FastifyRequest<{ Params: ProjectParams; Body: { key: string; value: string } }>,
  reply: FastifyReply
) {
  const verified = await verifyProjectAccess(request, reply);
  if (!verified) return;

  const { key, value } = request.body;

  if (!key || !value) {
    return reply.status(400).send({
      success: false,
      error: { code: 'INVALID_INPUT', message: 'Key and value are required' },
    });
  }

  try {
    const secret = await functionsService.createSecret(verified.projectId, key, value);
    return reply.status(201).send({ success: true, data: secret });
  } catch (error) {
    const err = error as Error;
    return reply.status(500).send({
      success: false,
      error: { code: 'CREATE_FAILED', message: err.message },
    });
  }
}

export async function deleteSecret(
  request: FastifyRequest<{ Params: SecretParams }>,
  reply: FastifyReply
) {
  const verified = await verifyProjectAccess(request, reply);
  if (!verified) return;

  const { key } = request.params;

  try {
    const deleted = await functionsService.deleteSecret(verified.projectId, key);
    if (!deleted) {
      return reply.status(404).send({
        success: false,
        error: { code: 'NOT_FOUND', message: 'Secret not found' },
      });
    }
    return reply.send({ success: true });
  } catch (error) {
    const err = error as Error;
    return reply.status(500).send({
      success: false,
      error: { code: 'DELETE_FAILED', message: err.message },
    });
  }
}

// ============================================
// Schedules
// ============================================

export async function listSchedules(
  request: FastifyRequest<{ Params: FunctionParams }>,
  reply: FastifyReply
) {
  const verified = await verifyProjectAccess(request, reply);
  if (!verified) return;

  const { name } = request.params;

  try {
    const func = await functionsService.getFunction(verified.projectId, name);
    if (!func) {
      return reply.status(404).send({
        success: false,
        error: { code: 'NOT_FOUND', message: 'Function not found' },
      });
    }

    const schedules = await functionsService.listSchedules(func.id);
    return reply.send({ success: true, data: schedules });
  } catch (error) {
    const err = error as Error;
    return reply.status(500).send({
      success: false,
      error: { code: 'LIST_FAILED', message: err.message },
    });
  }
}

export async function createSchedule(
  request: FastifyRequest<{ Params: FunctionParams; Body: { cronExpression: string } }>,
  reply: FastifyReply
) {
  const verified = await verifyProjectAccess(request, reply);
  if (!verified) return;

  const { name } = request.params;
  const { cronExpression } = request.body;

  if (!cronExpression) {
    return reply.status(400).send({
      success: false,
      error: { code: 'INVALID_INPUT', message: 'Cron expression is required' },
    });
  }

  try {
    const func = await functionsService.getFunction(verified.projectId, name);
    if (!func) {
      return reply.status(404).send({
        success: false,
        error: { code: 'NOT_FOUND', message: 'Function not found' },
      });
    }

    const schedule = await functionsService.createSchedule(func.id, cronExpression);
    return reply.status(201).send({ success: true, data: schedule });
  } catch (error) {
    const err = error as Error;
    return reply.status(500).send({
      success: false,
      error: { code: 'CREATE_FAILED', message: err.message },
    });
  }
}

export async function updateSchedule(
  request: FastifyRequest<{ Params: ScheduleParams; Body: { cronExpression?: string; enabled?: boolean } }>,
  reply: FastifyReply
) {
  const verified = await verifyProjectAccess(request, reply);
  if (!verified) return;

  const { scheduleId } = request.params;
  const { cronExpression, enabled } = request.body;

  try {
    const schedule = await functionsService.updateSchedule(scheduleId, { cronExpression, enabled });
    if (!schedule) {
      return reply.status(404).send({
        success: false,
        error: { code: 'NOT_FOUND', message: 'Schedule not found' },
      });
    }
    return reply.send({ success: true, data: schedule });
  } catch (error) {
    const err = error as Error;
    return reply.status(500).send({
      success: false,
      error: { code: 'UPDATE_FAILED', message: err.message },
    });
  }
}

export async function deleteSchedule(
  request: FastifyRequest<{ Params: ScheduleParams }>,
  reply: FastifyReply
) {
  const verified = await verifyProjectAccess(request, reply);
  if (!verified) return;

  const { scheduleId } = request.params;

  try {
    const deleted = await functionsService.deleteSchedule(scheduleId);
    if (!deleted) {
      return reply.status(404).send({
        success: false,
        error: { code: 'NOT_FOUND', message: 'Schedule not found' },
      });
    }
    return reply.send({ success: true });
  } catch (error) {
    const err = error as Error;
    return reply.status(500).send({
      success: false,
      error: { code: 'DELETE_FAILED', message: err.message },
    });
  }
}
