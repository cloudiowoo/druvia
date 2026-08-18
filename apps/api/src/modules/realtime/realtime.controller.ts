import type { FastifyRequest, FastifyReply } from 'fastify';
import type { ProjectDataAccessMode } from '@druvia/shared';
import type { JwtPayload } from '../../middleware/auth.js';
import * as realtimeService from './realtime.service.js';
import { checkProjectAccess } from '../../lib/access.js';
import { queryOne } from '../../db/index.js';
import { checkRealtimeTokenRateLimit } from '../../middleware/ratelimit.js';
import * as projectService from '../project/project.service.js';
import { createApiLogger } from '../../lib/logger.js';
import {
  isRealtimeActor,
  resolveRealtimeExecutionContext,
} from './realtime-actor.js';
import {
  issueRealtimeAccessToken,
  RealtimeTokenUnavailableError,
} from './realtime-token.service.js';
import {
  DataAccessMutationLockedError,
  withProjectDataAccessMutationLock,
} from '../data-access/data-access-mutation-lock.js';

const logger = createApiLogger({ module: 'realtime' });

// ============================================
// Types
// ============================================

interface ProjectParams {
  projectId: string;
}

interface TableParams extends ProjectParams {
  tableName: string;
}

interface ConfigureSubscriptionBody {
  enabled: boolean;
}

// ============================================
// Access Control Helper
// ============================================

async function verifyProjectAccess(
  request: FastifyRequest<{ Params: ProjectParams }>,
  reply: FastifyReply
): Promise<boolean> {
  const userId = (request.user as JwtPayload | undefined)?.userId;
  if (!userId) {
    reply.status(401).send({
      success: false,
      error: { code: 'UNAUTHORIZED', message: 'Authentication required' },
    });
    return false;
  }

  const hasAccess = await checkProjectAccess(userId, request.params.projectId);
  if (!hasAccess) {
    reply.status(403).send({
      success: false,
      error: { code: 'FORBIDDEN', message: 'No access to this project' },
    });
    return false;
  }

  return true;
}

// ============================================
// Helper: Resolve the schema and immutable role scope together.
// ============================================

interface RealtimeRuntimeTarget {
  schemaName: string;
  runtimeScope: realtimeService.RealtimeRuntimeScope;
  runtimeAvailability: 'available' | 'environment_identity_required';
}

function normalizeRuntimeMode(value: string | null | undefined): ProjectDataAccessMode {
  return value === 'explicit' ? 'explicit' : 'compatibility';
}

async function getRealtimeRuntimeTarget(
  projectId: string,
  envName?: string
): Promise<RealtimeRuntimeTarget | null> {
  if (envName && envName !== 'prod') {
    const env = await queryOne<{
      id: number;
      schema_name: string;
      data_access_mode?: string | null;
    }>(
      `SELECT e.id, e.schema_name, p.data_access_mode
       FROM druvia_project_environments e
       JOIN druvia_projects p ON p.project_id = e.project_id
       WHERE e.project_id = $1 AND e.env_name = $2`,
      [projectId, envName]
    );
    if (!env) return null;

    return {
      schemaName: env.schema_name,
      runtimeScope: {
        projectId,
        runtimeMode: normalizeRuntimeMode(env.data_access_mode),
        environmentId: env.id,
      },
      runtimeAvailability: 'environment_identity_required',
    };
  }

  const project = await queryOne<{
    schema_name: string | null;
    data_access_mode?: string | null;
  }>(
    'SELECT schema_name, data_access_mode FROM druvia_projects WHERE project_id = $1',
    [projectId]
  );
  if (!project?.schema_name) return null;

  return {
    schemaName: project.schema_name,
    runtimeScope: {
      projectId,
      runtimeMode: normalizeRuntimeMode(project.data_access_mode),
    },
    runtimeAvailability: 'available',
  };
}

// ============================================
// Controllers
// ============================================

export async function issueToken(
  request: FastifyRequest<{ Params: ProjectParams }>,
  reply: FastifyReply
) {
  const actor = request.user;
  const { projectId } = request.params;

  if (!isRealtimeActor(actor)) {
    return reply.status(403).send({
      success: false,
      error: {
        code: 'PROJECT_ACTOR_REQUIRED',
        message: 'Project actor credential required',
      },
    });
  }

  if (actor.projectId !== projectId) {
    return reply.status(403).send({
      success: false,
      error: {
        code: 'PROJECT_SCOPE_MISMATCH',
        message: 'Project actor does not match the requested project',
      },
    });
  }

  const project = await projectService.getProjectById(projectId);
  if (!project?.schemaName) {
    return reply.status(404).send({
      success: false,
      error: { code: 'PROJECT_NOT_FOUND', message: 'Project not found' },
    });
  }

  await checkRealtimeTokenRateLimit(request, reply, projectId);
  if (reply.sent) return;

  try {
    const context = resolveRealtimeExecutionContext({
      projectId,
      runtimeMode: project.dataAccessMode,
      actor,
    });
    const result = issueRealtimeAccessToken({ projectId, context });

    logger.info('Realtime access token issued', {
      requestId: request.id,
      operationId: result.operationId,
      projectId,
      actorType: context.actorType,
      ...(context.actorType === 'project_user'
        ? { projectUserId: context.subject }
        : {}),
      runtimeMode: project.dataAccessMode,
      expiresAt: result.expiresAt,
    });

    return reply.send({
      success: true,
      data: {
        token: result.token,
        expiresIn: result.expiresIn,
        expiresAt: result.expiresAt,
        websocketUrl: result.websocketUrl,
      },
    });
  } catch (error) {
    if (error instanceof RealtimeTokenUnavailableError) {
      logger.error('Realtime token service unavailable', {
        requestId: request.id,
        projectId,
      }, error);
      return reply.status(503).send({
        success: false,
        error: {
          code: 'REALTIME_TOKEN_UNAVAILABLE',
          message: 'Realtime token service is unavailable',
        },
      });
    }

    throw error;
  }
}

/**
 * 获取项目的所有表订阅配置
 */
export async function listSubscriptions(
  request: FastifyRequest<{ Params: ProjectParams; Querystring: { env?: string } }>,
  reply: FastifyReply
) {
  if (!(await verifyProjectAccess(request, reply))) return;

  const { projectId } = request.params;
  const envName = request.query.env;

  const target = await getRealtimeRuntimeTarget(projectId, envName);
  if (!target) {
    return reply.status(404).send({
      success: false,
      error: { code: 'NOT_FOUND', message: envName ? 'Environment not found' : 'Project not found' },
    });
  }

  try {
    const subscriptions = await realtimeService.getTableSubscriptions(
      target.schemaName,
      target.runtimeScope
    );
    const stats = realtimeService.summarizeSubscriptions(subscriptions);

    return reply.send({
      success: true,
      data: {
        subscriptions,
        stats,
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return reply.status(500).send({
      success: false,
      error: { code: 'INTERNAL_ERROR', message },
    });
  }
}

/**
 * 配置表订阅
 */
export async function configureSubscription(
  request: FastifyRequest<{
    Params: TableParams;
    Body: ConfigureSubscriptionBody;
    Querystring: { env?: string };
  }>,
  reply: FastifyReply
) {
  if (!(await verifyProjectAccess(request, reply))) return;

  const { projectId, tableName } = request.params;
  const { enabled } = request.body;
  const envName = request.query.env;

  const target = await getRealtimeRuntimeTarget(projectId, envName);
  if (!target) {
    return reply.status(404).send({
      success: false,
      error: { code: 'NOT_FOUND', message: envName ? 'Environment not found' : 'Project not found' },
    });
  }

  try {
    const configure = () => realtimeService.configureTableSubscription(
      target.schemaName, tableName, enabled, target.runtimeScope,
    );
    const subscription = !envName || envName === 'prod'
      ? await withProjectDataAccessMutationLock(projectId, configure)
      : await configure();

    return reply.send({
      success: true,
      data: subscription,
    });
  } catch (error) {
    if (error instanceof DataAccessMutationLockedError) {
      return reply.status(409).send({
        success: false,
        error: { code: error.code, message: 'Project data changes are temporarily locked' },
      });
    }
    const message = error instanceof Error ? error.message : 'Unknown error';
    return reply.status(500).send({
      success: false,
      error: { code: 'INTERNAL_ERROR', message },
    });
  }
}

/**
 * 获取实时配置信息
 */
export async function getConfig(
  request: FastifyRequest<{ Params: ProjectParams; Querystring: { env?: string } }>,
  reply: FastifyReply
) {
  if (!(await verifyProjectAccess(request, reply))) return;

  const { projectId } = request.params;
  const envName = request.query.env;

  const target = await getRealtimeRuntimeTarget(projectId, envName);
  if (!target) {
    return reply.status(404).send({
      success: false,
      error: { code: 'NOT_FOUND', message: envName ? 'Environment not found' : 'Project not found' },
    });
  }

  try {
    const config = realtimeService.getRealtimeConfig(target.schemaName);
    const hasuraOk = await realtimeService.checkHasuraConnection();

    return reply.send({
      success: true,
      data: {
        ...config,
        runtimeAvailability: target.runtimeAvailability,
        hasuraConnected: hasuraOk,
      },
    });
  } catch (error) {
    if (error instanceof RealtimeTokenUnavailableError) {
      return reply.status(503).send({
        success: false,
        error: {
          code: 'REALTIME_TOKEN_UNAVAILABLE',
          message: 'Realtime token service is unavailable',
        },
      });
    }
    const message = error instanceof Error ? error.message : 'Unknown error';
    return reply.status(500).send({
      success: false,
      error: { code: 'INTERNAL_ERROR', message },
    });
  }
}

/**
 * 获取订阅代码示例
 */
export async function getSubscriptionExample(
  request: FastifyRequest<{
    Params: TableParams;
    Querystring: { operation?: string; env?: string };
  }>,
  reply: FastifyReply
) {
  if (!(await verifyProjectAccess(request, reply))) return;

  const { projectId, tableName } = request.params;
  const operation = (request.query.operation?.toUpperCase() || 'ALL') as
    | 'INSERT'
    | 'UPDATE'
    | 'DELETE'
    | 'ALL';
  const envName = request.query.env;

  const target = await getRealtimeRuntimeTarget(projectId, envName);
  if (!target) {
    return reply.status(404).send({
      success: false,
      error: { code: 'NOT_FOUND', message: envName ? 'Environment not found' : 'Project not found' },
    });
  }

  try {
    const examples = realtimeService.generateSubscriptionExample(
      target.schemaName,
      tableName,
      operation
    );

    return reply.send({
      success: true,
      data: examples,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return reply.status(500).send({
      success: false,
      error: { code: 'INTERNAL_ERROR', message },
    });
  }
}

/**
 * 获取 schema 下的所有表
 */
export async function listTables(
  request: FastifyRequest<{ Params: ProjectParams; Querystring: { env?: string } }>,
  reply: FastifyReply
) {
  if (!(await verifyProjectAccess(request, reply))) return;

  const { projectId } = request.params;
  const envName = request.query.env;

  const target = await getRealtimeRuntimeTarget(projectId, envName);
  if (!target) {
    return reply.status(404).send({
      success: false,
      error: { code: 'NOT_FOUND', message: envName ? 'Environment not found' : 'Project not found' },
    });
  }

  try {
    const tables = await realtimeService.getTablesInSchema(target.schemaName);

    return reply.send({
      success: true,
      data: tables,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return reply.status(500).send({
      success: false,
      error: { code: 'INTERNAL_ERROR', message },
    });
  }
}
