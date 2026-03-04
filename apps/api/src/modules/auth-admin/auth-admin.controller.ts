import type { FastifyRequest, FastifyReply } from 'fastify';
import * as authService from './auth-admin.service.js';
import { checkProjectAccess } from '../../lib/access.js';
import { queryOne } from '../../db/index.js';

// ============================================
// Parameter/Query Types
// ============================================

interface ProjectParams {
  projectId: string;
}

interface ProviderParams extends ProjectParams {
  provider: string;
}

interface UserParams extends ProjectParams {
  userId: string;
}

interface CreateProviderBody {
  provider: string;
  enabled?: boolean;
  clientId?: string;
  clientSecret?: string;
  config?: Record<string, unknown>;
}

interface UpdateProviderBody {
  enabled?: boolean;
  clientId?: string;
  clientSecret?: string;
  config?: Record<string, unknown>;
}

interface UpdateUserBody {
  status?: 'active' | 'disabled';
}

interface UpdateAuthConfigBody {
  jwtExpiresIn?: number;
  refreshTokenExpiresIn?: number;
  passwordMinLength?: number;
  requireEmailVerification?: boolean;
  allowSignup?: boolean;
}

interface ListUsersQuery {
  limit?: string;
  offset?: string;
  status?: string;
  search?: string;
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

// 获取项目的 schema 名称
async function getProjectSchemaName(projectId: string): Promise<string | null> {
  const result = await queryOne<{ schema_name: string }>(
    'SELECT schema_name FROM druvia_projects WHERE project_id = $1',
    [projectId]
  );
  return result?.schema_name || null;
}

// ============================================
// Provider Controllers
// ============================================

export async function listProviders(
  request: FastifyRequest<{ Params: ProjectParams }>,
  reply: FastifyReply
) {
  if (!(await verifyProjectAccess(request, reply))) return;

  const providers = await authService.listProviders(request.params.projectId);
  const supportedProviders = authService.getSupportedProviders();

  // 合并支持的提供商和已配置的提供商
  const result = supportedProviders.map(sp => {
    const configured = providers.find(p => p.provider === sp.id);
    return {
      ...sp,
      enabled: configured?.enabled ?? false,
      configured: !!configured,
      hasCredentials: !!configured?.clientId,
    };
  });

  return reply.send({ success: true, data: result });
}

export async function getProvider(
  request: FastifyRequest<{ Params: ProviderParams }>,
  reply: FastifyReply
) {
  if (!(await verifyProjectAccess(request, reply))) return;

  const provider = await authService.getProvider(
    request.params.projectId,
    request.params.provider
  );

  if (!provider) {
    return reply.status(404).send({
      success: false,
      error: { code: 'NOT_FOUND', message: 'Provider not configured' },
    });
  }

  return reply.send({ success: true, data: provider });
}

export async function createProvider(
  request: FastifyRequest<{ Params: ProjectParams; Body: CreateProviderBody }>,
  reply: FastifyReply
) {
  if (!(await verifyProjectAccess(request, reply))) return;

  // 验证 provider 类型
  const supportedProviders = authService.getSupportedProviders();
  if (!supportedProviders.some(sp => sp.id === request.body.provider)) {
    return reply.status(400).send({
      success: false,
      error: { code: 'INVALID_PROVIDER', message: 'Unsupported provider type' },
    });
  }

  try {
    const provider = await authService.createProvider(
      request.params.projectId,
      request.body
    );
    return reply.status(201).send({ success: true, data: provider });
  } catch (error) {
    const err = error as Error;
    if (err.message.includes('duplicate key') || err.message.includes('unique constraint')) {
      return reply.status(409).send({
        success: false,
        error: { code: 'PROVIDER_EXISTS', message: 'Provider already configured' },
      });
    }
    throw error;
  }
}

export async function updateProvider(
  request: FastifyRequest<{ Params: ProviderParams; Body: UpdateProviderBody }>,
  reply: FastifyReply
) {
  if (!(await verifyProjectAccess(request, reply))) return;

  const provider = await authService.updateProvider(
    request.params.projectId,
    request.params.provider,
    request.body
  );

  if (!provider) {
    return reply.status(404).send({
      success: false,
      error: { code: 'NOT_FOUND', message: 'Provider not configured' },
    });
  }

  return reply.send({ success: true, data: provider });
}

export async function deleteProvider(
  request: FastifyRequest<{ Params: ProviderParams }>,
  reply: FastifyReply
) {
  if (!(await verifyProjectAccess(request, reply))) return;

  const deleted = await authService.deleteProvider(
    request.params.projectId,
    request.params.provider
  );

  if (!deleted) {
    return reply.status(404).send({
      success: false,
      error: { code: 'NOT_FOUND', message: 'Provider not configured' },
    });
  }

  return reply.status(204).send();
}

// ============================================
// Auth Config Controllers
// ============================================

export async function getAuthConfig(
  request: FastifyRequest<{ Params: ProjectParams }>,
  reply: FastifyReply
) {
  if (!(await verifyProjectAccess(request, reply))) return;

  const config = await authService.getAuthConfig(request.params.projectId);
  return reply.send({ success: true, data: config });
}

export async function updateAuthConfig(
  request: FastifyRequest<{ Params: ProjectParams; Body: UpdateAuthConfigBody }>,
  reply: FastifyReply
) {
  if (!(await verifyProjectAccess(request, reply))) return;

  // 验证数值范围
  const { jwtExpiresIn, refreshTokenExpiresIn, passwordMinLength } = request.body;

  if (jwtExpiresIn !== undefined && (jwtExpiresIn < 300 || jwtExpiresIn > 86400)) {
    return reply.status(400).send({
      success: false,
      error: { code: 'INVALID_VALUE', message: 'JWT expires must be between 300 and 86400 seconds' },
    });
  }

  if (refreshTokenExpiresIn !== undefined && (refreshTokenExpiresIn < 3600 || refreshTokenExpiresIn > 2592000)) {
    return reply.status(400).send({
      success: false,
      error: { code: 'INVALID_VALUE', message: 'Refresh token expires must be between 1 hour and 30 days' },
    });
  }

  if (passwordMinLength !== undefined && (passwordMinLength < 6 || passwordMinLength > 128)) {
    return reply.status(400).send({
      success: false,
      error: { code: 'INVALID_VALUE', message: 'Password min length must be between 6 and 128' },
    });
  }

  const config = await authService.updateAuthConfig(request.params.projectId, request.body);
  return reply.send({ success: true, data: config });
}

// ============================================
// User Management Controllers
// ============================================

export async function listUsers(
  request: FastifyRequest<{ Params: ProjectParams; Querystring: ListUsersQuery }>,
  reply: FastifyReply
) {
  if (!(await verifyProjectAccess(request, reply))) return;

  const schemaName = await getProjectSchemaName(request.params.projectId);
  if (!schemaName) {
    return reply.status(404).send({
      success: false,
      error: { code: 'NOT_FOUND', message: 'Project schema not found' },
    });
  }

  const limit = parseInt(request.query.limit || '50', 10);
  const offset = parseInt(request.query.offset || '0', 10);

  try {
    const result = await authService.listProjectUsers(schemaName, {
      limit,
      offset,
      status: request.query.status,
      search: request.query.search,
    });

    return reply.send({
      success: true,
      data: result.users,
      pagination: { limit, offset, total: result.total },
    });
  } catch (error) {
    const err = error as Error;
    // 表不存在的情况（项目可能还没有用户表）
    if (err.message.includes('does not exist') || err.message.includes('relation')) {
      return reply.send({
        success: true,
        data: [],
        pagination: { limit, offset, total: 0 },
      });
    }
    throw error;
  }
}

export async function getUser(
  request: FastifyRequest<{ Params: UserParams }>,
  reply: FastifyReply
) {
  if (!(await verifyProjectAccess(request, reply))) return;

  const schemaName = await getProjectSchemaName(request.params.projectId);
  if (!schemaName) {
    return reply.status(404).send({
      success: false,
      error: { code: 'NOT_FOUND', message: 'Project schema not found' },
    });
  }

  const user = await authService.getProjectUser(schemaName, request.params.userId);

  if (!user) {
    return reply.status(404).send({
      success: false,
      error: { code: 'NOT_FOUND', message: 'User not found' },
    });
  }

  return reply.send({ success: true, data: user });
}

export async function updateUser(
  request: FastifyRequest<{ Params: UserParams; Body: UpdateUserBody }>,
  reply: FastifyReply
) {
  if (!(await verifyProjectAccess(request, reply))) return;

  const schemaName = await getProjectSchemaName(request.params.projectId);
  if (!schemaName) {
    return reply.status(404).send({
      success: false,
      error: { code: 'NOT_FOUND', message: 'Project schema not found' },
    });
  }

  const user = await authService.updateProjectUser(
    schemaName,
    request.params.userId,
    request.body
  );

  if (!user) {
    return reply.status(404).send({
      success: false,
      error: { code: 'NOT_FOUND', message: 'User not found' },
    });
  }

  return reply.send({ success: true, data: user });
}

export async function deleteUser(
  request: FastifyRequest<{ Params: UserParams }>,
  reply: FastifyReply
) {
  if (!(await verifyProjectAccess(request, reply))) return;

  const schemaName = await getProjectSchemaName(request.params.projectId);
  if (!schemaName) {
    return reply.status(404).send({
      success: false,
      error: { code: 'NOT_FOUND', message: 'Project schema not found' },
    });
  }

  const deleted = await authService.deleteProjectUser(schemaName, request.params.userId);

  if (!deleted) {
    return reply.status(404).send({
      success: false,
      error: { code: 'NOT_FOUND', message: 'User not found' },
    });
  }

  return reply.status(204).send();
}

// ============================================
// Supported Providers
// ============================================

export async function getSupportedProviders(
  request: FastifyRequest,
  reply: FastifyReply
) {
  const providers = authService.getSupportedProviders();
  return reply.send({ success: true, data: providers });
}
