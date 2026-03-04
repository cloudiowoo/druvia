import type { FastifyInstance } from 'fastify';
import * as controller from './functions.controller.js';
import { authenticate } from '../../middleware/auth.js';

const auth = { preHandler: authenticate };

export async function functionsRoutes(fastify: FastifyInstance) {
  // Secrets (必须在 :name 路由之前，避免 "secrets" 被解析为函数名)
  fastify.get('/projects/:projectId/functions/secrets', auth, controller.listSecrets as never);
  fastify.post('/projects/:projectId/functions/secrets', auth, controller.createSecret as never);
  fastify.delete('/projects/:projectId/functions/secrets/:key', auth, controller.deleteSecret as never);

  // Functions CRUD
  fastify.get('/projects/:projectId/functions', auth, controller.listFunctions as never);
  fastify.post('/projects/:projectId/functions', auth, controller.createFunction as never);
  fastify.get('/projects/:projectId/functions/:name', auth, controller.getFunction as never);
  fastify.put('/projects/:projectId/functions/:name', auth, controller.updateFunction as never);
  fastify.delete('/projects/:projectId/functions/:name', auth, controller.deleteFunction as never);

  // Invoke
  fastify.post('/projects/:projectId/functions/:name/invoke', auth, controller.invokeFunction as never);

  // Logs
  fastify.get('/projects/:projectId/functions/:name/logs', auth, controller.getFunctionLogs as never);

  // Schedules
  fastify.get('/projects/:projectId/functions/:name/schedules', auth, controller.listSchedules as never);
  fastify.post('/projects/:projectId/functions/:name/schedules', auth, controller.createSchedule as never);
  fastify.patch('/projects/:projectId/functions/:name/schedules/:scheduleId', auth, controller.updateSchedule as never);
  fastify.delete('/projects/:projectId/functions/:name/schedules/:scheduleId', auth, controller.deleteSchedule as never);
}
