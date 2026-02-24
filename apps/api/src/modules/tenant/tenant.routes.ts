import type { FastifyInstance } from 'fastify';
import * as controller from './tenant.controller.js';

export async function tenantRoutes(app: FastifyInstance) {
  // Create tenant
  app.post('/tenants', controller.createTenant);

  // List tenants
  app.get('/tenants', controller.listTenants);

  // Get tenant by ID
  app.get('/tenants/:tenantId', controller.getTenant);

  // Get tenant by alias
  app.get('/tenants/alias/:alias', controller.getTenantByAlias);

  // Update tenant
  app.patch('/tenants/:tenantId', controller.updateTenant);

  // Delete tenant
  app.delete('/tenants/:tenantId', controller.deleteTenant);
}
