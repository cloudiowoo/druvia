import type { FastifyInstance } from 'fastify';
import * as controller from './tenant.controller.js';

export async function tenantRoutes(app: FastifyInstance) {
  app.post('/tenants', controller.createTenant);
  app.get('/tenants', controller.listTenants);
  app.get('/tenants/:id', controller.getTenant);
  app.patch('/tenants/:id', controller.updateTenant);
  app.delete('/tenants/:id', controller.deleteTenant);
  app.get('/tenants/:id/config', controller.getTenantConfig);
}
