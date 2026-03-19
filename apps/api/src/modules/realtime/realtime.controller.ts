import type { FastifyRequest, FastifyReply } from 'fastify';
import type { JwtPayload } from '../../middleware/auth.js';
import * as realtimeService from './realtime.service.js';
import { checkProjectAccess } from '../../lib/access.js';
import { queryOne } from '../../db/index.js';

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
  role?: string;
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
// Helper: Get Schema Name
// ============================================

async function getProjectSchema(projectId: string, envName?: string): Promise<string | null> {
  // 如果指定了环境且不是 prod，从环境表获取 schema
  if (envName && envName !== 'prod') {
    const env = await queryOne<{ schema_name: string }>(
      'SELECT schema_name FROM druvia_project_environments WHERE project_id = $1 AND env_name = $2',
      [projectId, envName]
    );
    if (env) {
      return env.schema_name;
    }
    // 环境不存在，返回 null
    return null;
  }

  // 默认返回项目基础 schema (prod)
  const project = await queryOne<{ schema_name: string }>(
    'SELECT schema_name FROM druvia_projects WHERE project_id = $1',
    [projectId]
  );
  return project?.schema_name || null;
}

// ============================================
// Controllers
// ============================================

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

  // 获取项目 schema
  const schemaName = await getProjectSchema(projectId, envName);
  if (!schemaName) {
    return reply.status(404).send({
      success: false,
      error: { code: 'NOT_FOUND', message: envName ? 'Environment not found' : 'Project not found' },
    });
  }

  try {
    const subscriptions = await realtimeService.getTableSubscriptions(schemaName);
    const stats = await realtimeService.getSubscriptionStats(schemaName);

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
  const { enabled, role } = request.body;
  const envName = request.query.env;

  // 获取项目 schema
  const schemaName = await getProjectSchema(projectId, envName);
  if (!schemaName) {
    return reply.status(404).send({
      success: false,
      error: { code: 'NOT_FOUND', message: envName ? 'Environment not found' : 'Project not found' },
    });
  }

  try {
    const subscription = await realtimeService.configureTableSubscription(
      schemaName,
      tableName,
      enabled,
      role
    );

    return reply.send({
      success: true,
      data: subscription,
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
 * 获取实时配置信息
 */
export async function getConfig(
  request: FastifyRequest<{ Params: ProjectParams; Querystring: { env?: string } }>,
  reply: FastifyReply
) {
  if (!(await verifyProjectAccess(request, reply))) return;

  const { projectId } = request.params;
  const envName = request.query.env;

  // 获取项目 schema
  const schemaName = await getProjectSchema(projectId, envName);
  if (!schemaName) {
    return reply.status(404).send({
      success: false,
      error: { code: 'NOT_FOUND', message: envName ? 'Environment not found' : 'Project not found' },
    });
  }

  try {
    const config = realtimeService.getRealtimeConfig(schemaName);
    const hasuraOk = await realtimeService.checkHasuraConnection();

    return reply.send({
      success: true,
      data: {
        ...config,
        hasuraConnected: hasuraOk,
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

  // 获取项目 schema
  const schemaName = await getProjectSchema(projectId, envName);
  if (!schemaName) {
    return reply.status(404).send({
      success: false,
      error: { code: 'NOT_FOUND', message: envName ? 'Environment not found' : 'Project not found' },
    });
  }

  try {
    const examples = realtimeService.generateSubscriptionExample(
      schemaName,
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

  // 获取项目 schema
  const schemaName = await getProjectSchema(projectId, envName);
  if (!schemaName) {
    return reply.status(404).send({
      success: false,
      error: { code: 'NOT_FOUND', message: envName ? 'Environment not found' : 'Project not found' },
    });
  }

  try {
    const tables = await realtimeService.getTablesInSchema(schemaName);

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
