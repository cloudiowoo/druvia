// apps/api/src/modules/dashboard/dashboard.routes.ts
import type { FastifyInstance } from 'fastify';
import * as controller from './dashboard.controller.js';
import { authenticate } from '../../middleware/auth.js';

export async function dashboardRoutes(app: FastifyInstance) {
  app.get('/dashboard/stats', { preHandler: authenticate }, controller.getStats);
  app.get('/dashboard/trends', { preHandler: authenticate }, controller.getTrends as never);
  app.get('/dashboard/activities', { preHandler: authenticate }, controller.getActivities as never);
  app.get('/dashboard/resources', { preHandler: authenticate }, controller.getResources);
  app.get('/tenants/:tenantId/dashboard/overview', { preHandler: authenticate }, controller.getTenantOverview as never);
  app.get('/tenants/:tenantId/dashboard/projects', { preHandler: authenticate }, controller.getTenantProjects as never);
  app.get('/tenants/:tenantId/dashboard/timeline', { preHandler: authenticate }, controller.getTenantTimeline as never);
}
