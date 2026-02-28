// apps/api/src/modules/settings/settings.routes.ts
import type { FastifyInstance } from 'fastify';
import * as controller from './settings.controller.js';
import { authenticate } from '../../middleware/auth.js';

export async function settingsRoutes(app: FastifyInstance) {
  app.get('/settings', { preHandler: authenticate }, controller.getSettings);
  app.patch('/settings', { preHandler: authenticate }, controller.updateSettings as never);
}
