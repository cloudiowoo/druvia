import type { FastifyRequest, FastifyReply } from 'fastify';
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
  const userId = request.user?.userId;
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

async function getProjectSchema(projectId: string): Promise<string | null> {
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
  request: FastifyRequest<{ Params: ProjectParams }>,
  reply: FastifyReply
) {
  if (!(await verifyProjectAccess(request, reply))) return;

  const { projectId } = request.params;

  // 获取项目 schema
  const schemaName = await getProjectSchema(projectId);
  if (!schemaName) {
    return reply.status(404).send({
      success: false,
      error: { code: 'NOT_FOUND', message: 'Project not found' },
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
  }>,
  reply: FastifyReply
) {
  if (!(await verifyProjectAccess(request, reply))) return;

  const { projectId, tableName } = request.params;
  const { enabled, role } = request.body;

  // 获取项目 schema
  const schemaName = await getProjectSchema(projectId);
  if (!schemaName) {
    return reply.status(404).send({
      success: false,
      error: { code: 'NOT_FOUND', message: 'Project not found' },
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
  request: FastifyRequest<{ Params: ProjectParams }>,
  reply: FastifyReply
) {
  if (!(await verifyProjectAccess(request, reply))) return;

  const { projectId } = request.params;

  // 获取项目 schema
  const schemaName = await getProjectSchema(projectId);
  if (!schemaName) {
    return reply.status(404).send({
      success: false,
      error: { code: 'NOT_FOUND', message: 'Project not found' },
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
    Querystring: { operation?: string };
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

  // 获取项目 schema
  const schemaName = await getProjectSchema(projectId);
  if (!schemaName) {
    return reply.status(404).send({
      success: false,
      error: { code: 'NOT_FOUND', message: 'Project not found' },
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
  request: FastifyRequest<{ Params: ProjectParams }>,
  reply: FastifyReply
) {
  if (!(await verifyProjectAccess(request, reply))) return;

  const { projectId } = request.params;

  // 获取项目 schema
  const schemaName = await getProjectSchema(projectId);
  if (!schemaName) {
    return reply.status(404).send({
      success: false,
      error: { code: 'NOT_FOUND', message: 'Project not found' },
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
