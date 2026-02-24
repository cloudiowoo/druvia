import type { FastifyInstance } from 'fastify';
import * as controller from './oauth.controller.js';
import { authenticate, optionalAuth } from '../../middleware/auth.js';

export async function oauthRoutes(app: FastifyInstance) {
  // Get OAuth authorization URL (public)
  app.get('/tenants/:tenantId/oauth/:provider/authorize', controller.getAuthUrl as never);

  // Handle OAuth callback (public)
  app.post('/tenants/:tenantId/oauth/:provider/callback', controller.handleCallback as never);

  // Bind provider to current user (authenticated)
  app.post('/tenants/:tenantId/oauth/:provider/bind', { preHandler: authenticate }, controller.bindProvider as never);

  // List user's bound providers (authenticated)
  app.get('/users/me/providers', { preHandler: authenticate }, controller.listProviders);

  // Unbind provider from user (authenticated)
  app.delete('/users/me/providers/:provider', { preHandler: authenticate }, controller.unbindProvider as never);
}
