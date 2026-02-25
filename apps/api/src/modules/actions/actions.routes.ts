import type { FastifyInstance } from 'fastify';
import * as controller from './actions.controller.js';
import { verifyHasuraWebhook } from '../../middleware/hasura.js';

export async function actionsRoutes(app: FastifyInstance) {
  // Verify all action requests come from Hasura
  app.addHook('preHandler', verifyHasuraWebhook);

  // Auth actions
  app.post('/actions/register', controller.actionRegister as never);
  app.post('/actions/login', controller.actionLogin as never);
  app.post('/actions/me', controller.actionGetMe as never);

  // Tenant actions
  app.post('/actions/create-tenant', controller.actionCreateTenant as never);
}
