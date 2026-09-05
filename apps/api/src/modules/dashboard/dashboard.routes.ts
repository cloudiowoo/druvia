// apps/api/src/modules/dashboard/dashboard.routes.ts
import type { FastifyInstance } from 'fastify';
import * as controller from './dashboard.controller.js';
import { authenticate } from '../../middleware/auth.js';
import { requireSuperAdmin, requireTenantAccess } from '../../lib/project-authorization.js';

export async function dashboardRoutes(app: FastifyInstance) {
  app.get('/dashboard/stats', { preHandler: [authenticate, requireSuperAdmin] }, controller.getStats);
  app.get('/dashboard/trends', { preHandler: [authenticate, requireSuperAdmin] }, controller.getTrends as never);
  app.get('/dashboard/activities', { preHandler: [authenticate, requireSuperAdmin] }, controller.getActivities as never);
  app.get('/dashboard/resources', { preHandler: [authenticate, requireSuperAdmin] }, controller.getResources);
  app.get('/tenants/:tenantId/dashboard/overview', { preHandler: [authenticate, requireTenantAccess()] }, controller.getTenantOverview as never);
  app.get('/tenants/:tenantId/dashboard/projects', { preHandler: [authenticate, requireTenantAccess()] }, controller.getTenantProjects as never);
  app.get('/tenants/:tenantId/dashboard/timeline', { preHandler: [authenticate, requireTenantAccess()] }, controller.getTenantTimeline as never);
}
