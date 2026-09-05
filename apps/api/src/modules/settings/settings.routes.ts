// apps/api/src/modules/settings/settings.routes.ts
import type { FastifyInstance } from 'fastify';
import * as controller from './settings.controller.js';
import { authenticate } from '../../middleware/auth.js';
import { requireSuperAdmin } from '../../lib/project-authorization.js';

export async function settingsRoutes(app: FastifyInstance) {
  app.get('/settings', { preHandler: [authenticate, requireSuperAdmin] }, controller.getSettings);
  app.patch('/settings', { preHandler: [authenticate, requireSuperAdmin] }, controller.updateSettings as never);
}
