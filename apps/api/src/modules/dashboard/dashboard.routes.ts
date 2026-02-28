// apps/api/src/modules/dashboard/dashboard.routes.ts
import type { FastifyInstance } from 'fastify';
import * as controller from './dashboard.controller.js';
import { authenticate } from '../../middleware/auth.js';

export async function dashboardRoutes(app: FastifyInstance) {
  app.get('/dashboard/stats', { preHandler: authenticate }, controller.getStats);
  app.get('/dashboard/trends', { preHandler: authenticate }, controller.getTrends as never);
  app.get('/dashboard/activities', { preHandler: authenticate }, controller.getActivities as never);
  app.get('/dashboard/resources', { preHandler: authenticate }, controller.getResources);
}
