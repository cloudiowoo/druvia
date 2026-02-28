// apps/api/src/modules/dashboard/dashboard.controller.ts
import type { FastifyRequest, FastifyReply } from 'fastify';
import * as dashboardService from './dashboard.service.js';
import * as activityService from '../activity/activity.service.js';

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
