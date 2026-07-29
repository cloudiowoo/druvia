import type { FastifyInstance } from 'fastify';
import { authenticate } from '../../middleware/auth.js';
import * as controller from './system-update.controller.js';

export async function systemUpdateRoutes(app: FastifyInstance) {
  app.get('/system/update/status', { preHandler: authenticate }, controller.getUpdateStatus);
  app.post('/system/update/check', { preHandler: authenticate }, controller.checkUpdate);
  app.post('/system/update/download', { preHandler: authenticate }, controller.downloadUpdate);
  app.post('/system/update/apply', { preHandler: authenticate }, controller.applyUpdate);
  app.post('/system/update/rollback', { preHandler: authenticate }, controller.rollbackUpdate);
  app.post('/system/restart', { preHandler: authenticate }, controller.restartSystem);
}
