import type { FastifyInstance } from 'fastify';
import { authenticate } from '../../middleware/auth.js';
import { requireSuperAdmin } from '../../lib/project-authorization.js';
import * as controller from './system-update.controller.js';

export async function systemUpdateRoutes(app: FastifyInstance) {
  app.get('/system/update/status', { preHandler: [authenticate, requireSuperAdmin] }, controller.getUpdateStatus);
  app.post('/system/update/check', { preHandler: [authenticate, requireSuperAdmin] }, controller.checkUpdate);
  app.post('/system/update/download', { preHandler: [authenticate, requireSuperAdmin] }, controller.downloadUpdate);
  app.post('/system/update/apply', { preHandler: [authenticate, requireSuperAdmin] }, controller.applyUpdate);
  app.post('/system/update/rollback', { preHandler: [authenticate, requireSuperAdmin] }, controller.rollbackUpdate);
  app.post('/system/restart', { preHandler: [authenticate, requireSuperAdmin] }, controller.restartSystem);
}
