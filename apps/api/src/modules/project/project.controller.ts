import type { FastifyRequest, FastifyReply } from 'fastify';
import * as projectService from './project.service.js';
import type { CreateProjectInput, UpdateProjectInput } from '@druvia/shared';

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
