import type { FastifyReply, FastifyRequest } from 'fastify';
import type { ProjectCapability, ProjectMemberRole } from '@druvia/shared';
import { isPlatformUser } from '../../middleware/auth.js';
import {
  assertProjectCapability,
  resolveProjectAccess,
} from '../../lib/project-authorization.js';
import * as service from './project-members.service.js';

interface ProjectParams { projectId: string }
interface MemberParams extends ProjectParams { userId: string }

function sendError(reply: FastifyReply, error: unknown) {
  const candidate = error as { statusCode?: unknown; code?: unknown; message?: unknown };
  if (
    typeof candidate.statusCode === 'number'
    && typeof candidate.code === 'string'
  ) {
    return reply.status(candidate.statusCode as number).send({
      success: false,
      error: { code: candidate.code, message: String(candidate.message ?? 'Request failed') },
    });
  }
  throw error;
}

async function authorize(
  request: FastifyRequest<{ Params: ProjectParams }>,
  capability: ProjectCapability,
) {
  if (request.projectAccess?.capabilities.includes(capability)) return request.projectAccess;
  return assertProjectCapability(request.user, request.params.projectId, capability);
}

export async function getProjectAccess(
  request: FastifyRequest<{ Params: ProjectParams }>,
  reply: FastifyReply,
) {
  try {
    const access = request.projectAccess
      ?? await resolveProjectAccess(request.user, request.params.projectId)
      ?? await assertProjectCapability(request.user, request.params.projectId, 'project:read');
    return reply.send({ success: true, data: access });
  } catch (error) {
    return sendError(reply, error);
  }
}

export async function listProjectMembers(
  request: FastifyRequest<{ Params: ProjectParams }>,
  reply: FastifyReply,
) {
  try {
    await authorize(request, 'members:read');
    const members = await service.listProjectMembers(request.params.projectId);
    return reply.send({ success: true, data: members });
  } catch (error) {
    return sendError(reply, error);
  }
}

export async function searchProjectMemberCandidates(
  request: FastifyRequest<{ Params: ProjectParams; Querystring: { q?: string } }>,
  reply: FastifyReply,
) {
  try {
    await authorize(request, 'members:manage');
    const candidates = await service.searchProjectMemberCandidates(
      request.params.projectId,
      request.query.q ?? '',
    );
    return reply.send({ success: true, data: candidates });
  } catch (error) {
    return sendError(reply, error);
  }
}

function validateMemberInput(
  reply: FastifyReply,
  body: { userId?: unknown; role?: unknown },
): body is { userId: string; role: ProjectMemberRole } {
  if (!service.isProjectMemberRole(body.role)) {
    void reply.status(400).send({
      success: false,
      error: { code: 'INVALID_ROLE', message: 'Invalid project member role' },
    });
    return false;
  }
  if (typeof body.userId !== 'string' || !body.userId.trim()) {
    void reply.status(400).send({
      success: false,
      error: { code: 'INVALID_INPUT', message: 'Platform user ID is required' },
    });
    return false;
  }
  return true;
}

export async function createProjectMember(
  request: FastifyRequest<{ Params: ProjectParams; Body: { userId?: unknown; role?: unknown } }>,
  reply: FastifyReply,
) {
  const body = request.body ?? {};
  if (!validateMemberInput(reply, body)) return;
  const { userId, role } = body;
  try {
    await authorize(request, 'members:manage');
    if (!request.user || !isPlatformUser(request.user)) {
      return reply.status(401).send({
        success: false,
        error: { code: 'UNAUTHORIZED', message: 'Platform authentication required' },
      });
    }
    const member = await service.addProjectMember(
      request.user, request.params.projectId, userId, role, request.id,
    );
    return reply.status(201).send({ success: true, data: member });
  } catch (error) {
    return sendError(reply, error);
  }
}

export async function updateProjectMember(
  request: FastifyRequest<{ Params: MemberParams; Body: { role?: unknown } }>,
  reply: FastifyReply,
) {
  if (!service.isProjectMemberRole(request.body?.role)) {
    return reply.status(400).send({
      success: false,
      error: { code: 'INVALID_ROLE', message: 'Invalid project member role' },
    });
  }
  try {
    await authorize(request, 'members:manage');
    if (!request.user || !isPlatformUser(request.user)) {
      return reply.status(401).send({
        success: false,
        error: { code: 'UNAUTHORIZED', message: 'Platform authentication required' },
      });
    }
    const member = await service.updateProjectMemberRole(
      request.user, request.params.projectId, request.params.userId, request.body.role, request.id,
    );
    return reply.send({ success: true, data: member });
  } catch (error) {
    return sendError(reply, error);
  }
}

export async function deleteProjectMember(
  request: FastifyRequest<{ Params: MemberParams }>,
  reply: FastifyReply,
) {
  try {
    await authorize(request, 'members:manage');
    if (!request.user || !isPlatformUser(request.user)) {
      return reply.status(401).send({
        success: false,
        error: { code: 'UNAUTHORIZED', message: 'Platform authentication required' },
      });
    }
    await service.removeProjectMember(
      request.user, request.params.projectId, request.params.userId, request.id,
    );
    return reply.status(204).send();
  } catch (error) {
    return sendError(reply, error);
  }
}
