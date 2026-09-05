import type { FastifyInstance } from 'fastify';
import * as controller from './project.controller.js';
import { authenticate } from '../../middleware/auth.js';
import { requireProjectCapability, requireTenantAccess } from '../../lib/project-authorization.js';

export async function projectRoutes(app: FastifyInstance) {
  // All project routes require authentication
  app.addHook('preHandler', authenticate);

  // Create project under tenant
  app.post('/tenants/:tenantId/projects', {
    preHandler: requireTenantAccess({ ownerOnly: true }),
  }, controller.createProject as never);

  // List projects for tenant
  app.get('/tenants/:tenantId/projects', {
    preHandler: requireTenantAccess(),
  }, controller.listProjects as never);

  // Get project by alias
  app.get('/tenants/:tenantId/projects/alias/:alias', controller.getProjectByAlias as never);

  // Get project by ID
  app.get('/projects/:projectId', {
    preHandler: requireProjectCapability('project:read'),
  }, controller.getProject as never);

  // Update project
  app.patch('/projects/:projectId', {
    preHandler: requireProjectCapability('project:update'),
  }, controller.updateProject as never);

  // Delete project
  app.delete('/projects/:projectId', {
    preHandler: requireProjectCapability('project:delete'),
  }, controller.deleteProject as never);

  // Execute SQL query
  app.post('/projects/:projectId/query', {
    preHandler: requireProjectCapability('database:read'),
  }, controller.executeQuery as never);

  // Execute DDL/DML
  app.post('/projects/:projectId/ddl', {
    preHandler: requireProjectCapability('database:write'),
  }, controller.executeDdl as never);

  // Database credentials management
  app.get('/projects/:projectId/db', { preHandler: requireProjectCapability('database:credentials') }, controller.getDbInfo as never);
  app.post('/projects/:projectId/db/user', { preHandler: requireProjectCapability('database:credentials') }, controller.createDbUser as never);
  app.post('/projects/:projectId/db/reset-password', { preHandler: requireProjectCapability('database:credentials') }, controller.resetDbPassword as never);
  app.delete('/projects/:projectId/db/user', { preHandler: requireProjectCapability('database:credentials') }, controller.deleteDbUser as never);
}
