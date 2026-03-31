import type { FastifyRequest, FastifyReply } from 'fastify';
import * as projectService from './project.service.js';
import * as dbCredentialsService from './db-credentials.service.js';
import type { CreateProjectInput, UpdateProjectInput } from '@druvia/shared';
import { checkProjectAccess } from '../../lib/access.js';
import { isPlatformUser } from '../../middleware/auth.js';

interface ProjectParams {
  projectId: string;
}

interface TenantProjectParams {
  tenantId: string;
  projectId?: string;
  alias?: string;
}

interface ListProjectsQuery {
  limit?: string;
  offset?: string;
}

async function verifyDeleteProjectAccess(
  request: FastifyRequest<{ Params: ProjectParams }>,
  reply: FastifyReply
): Promise<boolean> {
  const user = request.user;
  if (!user || !isPlatformUser(user)) {
    reply.status(401).send({
      success: false,
      error: { code: 'UNAUTHORIZED', message: 'Authentication required' },
    });
    return false;
  }

  const project = await projectService.getProjectById(request.params.projectId);
  if (!project) {
    reply.status(404).send({
      success: false,
      error: { code: 'NOT_FOUND', message: 'Project not found' },
    });
    return false;
  }

  const hasAccess = await checkProjectAccess(user.userId, request.params.projectId);
  if (!hasAccess) {
    reply.status(403).send({
      success: false,
      error: { code: 'FORBIDDEN', message: 'No access to this project' },
    });
    return false;
  }

  return true;
}

export async function createProject(
  request: FastifyRequest<{ Params: { tenantId: string }; Body: Omit<CreateProjectInput, 'tenantId'> }>,
  reply: FastifyReply
) {
  try {
    const project = await projectService.createProject({
      ...request.body,
      tenantId: request.params.tenantId,
    });
    return reply.status(201).send({ success: true, data: project });
  } catch (error: unknown) {
    const err = error as { code?: string; message?: string };
    if (err.code === '23505') {
      return reply.status(409).send({
        success: false,
        error: { code: 'CONFLICT', message: 'Project alias already exists in this tenant' },
      });
    }
    if (err.code === '23503' || err.message === 'Tenant not found') {
      return reply.status(404).send({
        success: false,
        error: { code: 'NOT_FOUND', message: 'Tenant not found' },
      });
    }
    throw error;
  }
}

export async function getProject(
  request: FastifyRequest<{ Params: ProjectParams }>,
  reply: FastifyReply
) {
  const project = await projectService.getProjectById(request.params.projectId);
  if (!project) {
    return reply.status(404).send({
      success: false,
      error: { code: 'NOT_FOUND', message: 'Project not found' },
    });
  }
  return reply.send({ success: true, data: project });
}

export async function getProjectByAlias(
  request: FastifyRequest<{ Params: { tenantId: string; alias: string } }>,
  reply: FastifyReply
) {
  const project = await projectService.getProjectByAlias(
    request.params.tenantId,
    request.params.alias
  );
  if (!project) {
    return reply.status(404).send({
      success: false,
      error: { code: 'NOT_FOUND', message: 'Project not found' },
    });
  }
  return reply.send({ success: true, data: project });
}

export async function listProjects(
  request: FastifyRequest<{ Params: { tenantId: string }; Querystring: ListProjectsQuery }>,
  reply: FastifyReply
) {
  const limit = parseInt(request.query.limit || '50', 10);
  const offset = parseInt(request.query.offset || '0', 10);

  const projects = await projectService.listProjects(request.params.tenantId, limit, offset);

  return reply.send({
    success: true,
    data: projects,
    pagination: { limit, offset, count: projects.length },
  });
}

export async function updateProject(
  request: FastifyRequest<{ Params: ProjectParams; Body: UpdateProjectInput }>,
  reply: FastifyReply
) {
  const project = await projectService.updateProject(request.params.projectId, request.body);
  if (!project) {
    return reply.status(404).send({
      success: false,
      error: { code: 'NOT_FOUND', message: 'Project not found' },
    });
  }
  return reply.send({ success: true, data: project });
}

export async function deleteProject(
  request: FastifyRequest<{ Params: ProjectParams }>,
  reply: FastifyReply
) {
  if (!(await verifyDeleteProjectAccess(request, reply))) {
    return;
  }

  const deleted = await projectService.deleteProject(request.params.projectId);
  if (!deleted) {
    return reply.status(404).send({
      success: false,
      error: { code: 'NOT_FOUND', message: 'Project not found' },
    });
  }
  return reply.status(204).send();
}

export async function executeQuery(
  request: FastifyRequest<{ Params: ProjectParams; Body: { sql: string } }>,
  reply: FastifyReply
) {
  try {
    const result = await projectService.executeQuery(
      request.params.projectId,
      request.body.sql
    );
    return reply.send({ success: true, data: result });
  } catch (error: unknown) {
    const err = error as { message?: string };
    if (err.message === 'Project not found') {
      return reply.status(404).send({
        success: false,
        error: { code: 'NOT_FOUND', message: 'Project not found' },
      });
    }
    if (err.message === 'Only SELECT queries are allowed') {
      return reply.status(400).send({
        success: false,
        error: { code: 'INVALID_QUERY', message: '只允许执行 SELECT 查询' },
      });
    }
    // SQL 语法错误等
    return reply.status(400).send({
      success: false,
      error: { code: 'QUERY_ERROR', message: err.message || '查询执行失败' },
    });
  }
}

// 获取项目数据库连接信息
export async function getDbInfo(
  request: FastifyRequest<{ Params: ProjectParams }>,
  reply: FastifyReply
) {
  const info = await dbCredentialsService.getProjectDbInfo(request.params.projectId);
  if (!info) {
    return reply.status(404).send({
      success: false,
      error: { code: 'NOT_FOUND', message: 'Project not found' },
    });
  }
  return reply.send({ success: true, data: info });
}

// 创建项目数据库用户
export async function createDbUser(
  request: FastifyRequest<{ Params: ProjectParams }>,
  reply: FastifyReply
) {
  // 获取项目信息
  const project = await projectService.getProjectById(request.params.projectId);
  if (!project) {
    return reply.status(404).send({
      success: false,
      error: { code: 'NOT_FOUND', message: 'Project not found' },
    });
  }

  if (!project.schemaName) {
    return reply.status(400).send({
      success: false,
      error: { code: 'NO_SCHEMA', message: 'Project has no schema' },
    });
  }

  try {
    const credentials = await dbCredentialsService.createProjectDbUser(
      request.params.projectId,
      project.schemaName
    );
    return reply.status(201).send({ success: true, data: credentials });
  } catch (error: unknown) {
    const err = error as { message?: string };
    return reply.status(500).send({
      success: false,
      error: { code: 'DB_ERROR', message: err.message || '创建数据库用户失败' },
    });
  }
}

// 重置项目数据库密码
export async function resetDbPassword(
  request: FastifyRequest<{ Params: ProjectParams }>,
  reply: FastifyReply
) {
  try {
    const credentials = await dbCredentialsService.resetProjectDbPassword(request.params.projectId);
    if (!credentials) {
      return reply.status(404).send({
        success: false,
        error: { code: 'NOT_FOUND', message: 'Project or database user not found' },
      });
    }
    return reply.send({ success: true, data: credentials });
  } catch (error: unknown) {
    const err = error as { message?: string };
    return reply.status(500).send({
      success: false,
      error: { code: 'DB_ERROR', message: err.message || '重置密码失败' },
    });
  }
}

// 删除项目数据库用户
export async function deleteDbUser(
  request: FastifyRequest<{ Params: ProjectParams }>,
  reply: FastifyReply
) {
  try {
    const deleted = await dbCredentialsService.dropProjectDbUser(request.params.projectId);
    if (!deleted) {
      return reply.status(404).send({
        success: false,
        error: { code: 'NOT_FOUND', message: 'Project or database user not found' },
      });
    }
    return reply.status(204).send();
  } catch (error: unknown) {
    const err = error as { message?: string };
    return reply.status(500).send({
      success: false,
      error: { code: 'DB_ERROR', message: err.message || '删除数据库用户失败' },
    });
  }
}

// 执行 DDL/DML 语句
export async function executeDdl(
  request: FastifyRequest<{ Params: ProjectParams; Body: { sql: string } }>,
  reply: FastifyReply
) {
  try {
    const result = await projectService.executeDdl(
      request.params.projectId,
      request.body.sql
    );
    return reply.send({ success: true, data: result });
  } catch (error: unknown) {
    const err = error as { message?: string };
    if (err.message === 'Project not found') {
      return reply.status(404).send({
        success: false,
        error: { code: 'NOT_FOUND', message: 'Project not found' },
      });
    }
    return reply.status(400).send({
      success: false,
      error: { code: 'DDL_ERROR', message: err.message || 'DDL 执行失败' },
    });
  }
}
