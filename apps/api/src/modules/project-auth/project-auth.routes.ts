import type { FastifyInstance } from 'fastify';
import { authenticate } from '../../middleware/auth.js';
import * as controller from './project-auth.controller.js';

export async function projectAuthRoutes(app: FastifyInstance) {
  app.post('/projects/:projectId/auth/:provider/login', controller.providerLogin as never);
  app.post('/projects/:projectId/auth/:provider/silent-login', controller.providerSilentLogin as never);
  app.post('/projects/:projectId/auth/trusted/issue-session', controller.issueTrustedSession as never);
  app.post('/projects/:projectId/auth/wechat/login', controller.wechatLogin as never);
  app.post('/projects/:projectId/auth/wechat/silent-login', controller.wechatSilentLogin as never);
  app.post('/projects/:projectId/auth/refresh', controller.refresh as never);
  app.post('/projects/:projectId/auth/logout', { preHandler: authenticate }, controller.logout as never);
}
