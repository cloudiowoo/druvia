// apps/api/src/modules/dashboard/dashboard.controller.ts
import type { FastifyRequest, FastifyReply } from 'fastify';
import * as dashboardService from './dashboard.service.js';
import * as activityService from '../activity/activity.service.js';
import { checkTenantAccess } from '../../lib/access.js';
import { isPlatformUser } from '../../middleware/auth.js';

export async function getStats(request: FastifyRequest, reply: FastifyReply) {
  const stats = await dashboardService.getStats();
  return reply.send({ success: true, data: stats });
}

export async function getTrends(
  request: FastifyRequest<{ Querystring: { days?: string } }>,
  reply: FastifyReply
) {
  const days = parseInt(request.query.days || '7', 10);
  const trends = await dashboardService.getTrends(days);
  return reply.send({ success: true, data: trends });
}

export async function getActivities(
  request: FastifyRequest<{ Querystring: { limit?: string; offset?: string } }>,
  reply: FastifyReply
) {
  const limit = parseInt(request.query.limit || '20', 10);
  const offset = parseInt(request.query.offset || '0', 10);
  const result = await activityService.listActivities(limit, offset);
  return reply.send({ success: true, data: result });
}

export async function getResources(request: FastifyRequest, reply: FastifyReply) {
  const resources = await dashboardService.getResourceUsage();
  return reply.send({ success: true, data: resources });
}

async function verifyTenantDashboardAccess(
  request: FastifyRequest<{ Params: { tenantId: string } }>,
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

  const hasAccess = await checkTenantAccess(user.userId, request.params.tenantId);
  if (!hasAccess) {
    reply.status(403).send({
      success: false,
      error: { code: 'FORBIDDEN', message: 'No access to this tenant' },
    });
    return false;
  }

  return true;
}

export async function getTenantOverview(
  request: FastifyRequest<{ Params: { tenantId: string } }>,
  reply: FastifyReply
) {
  if (!(await verifyTenantDashboardAccess(request, reply))) {
    return;
  }

  const overview = await dashboardService.getTenantOverview(request.params.tenantId);
  return reply.send({ success: true, data: overview });
}

export async function getTenantProjects(
  request: FastifyRequest<{ Params: { tenantId: string } }>,
  reply: FastifyReply
) {
  if (!(await verifyTenantDashboardAccess(request, reply))) {
    return;
  }

  const projects = await dashboardService.getTenantProjectHealth(request.params.tenantId);
  return reply.send({ success: true, data: projects });
}

export async function getTenantTimeline(
  request: FastifyRequest<{ Params: { tenantId: string }; Querystring: { limit?: string } }>,
  reply: FastifyReply
) {
  if (!(await verifyTenantDashboardAccess(request, reply))) {
    return;
  }

  const limit = parseInt(request.query.limit || '20', 10);
  const timeline = await dashboardService.getTenantTimeline(request.params.tenantId, limit);
  return reply.send({ success: true, data: timeline });
}
