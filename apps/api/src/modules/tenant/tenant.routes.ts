import type { FastifyInstance } from 'fastify';
import * as controller from './tenant.controller.js';
import { authenticate } from '../../middleware/auth.js';

export async function tenantRoutes(app: FastifyInstance) {
  // Create tenant (requires auth)
  app.post('/tenants', { preHandler: authenticate }, controller.createTenant as never);

  // List tenants (requires auth)
  app.get('/tenants', { preHandler: authenticate }, controller.listTenants as never);

  // Get tenant by ID (requires auth)
  app.get('/tenants/:tenantId', { preHandler: authenticate }, controller.getTenant as never);

  // Get tenant by alias (requires auth)
  app.get('/tenants/alias/:alias', { preHandler: authenticate }, controller.getTenantByAlias as never);

  // Update tenant (requires auth)
  app.patch('/tenants/:tenantId', { preHandler: authenticate }, controller.updateTenant as never);

  // Delete tenant (requires auth)
  app.delete('/tenants/:tenantId', { preHandler: authenticate }, controller.deleteTenant as never);
}
