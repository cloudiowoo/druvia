import type { FastifyInstance } from 'fastify';
import * as controller from './project.controller.js';
import { authenticate } from '../../middleware/auth.js';

export async function projectRoutes(app: FastifyInstance) {
  // All project routes require authentication
  app.addHook('preHandler', authenticate);

  // Create project under tenant
  app.post('/tenants/:tenantId/projects', controller.createProject as never);

  // List projects for tenant
  app.get('/tenants/:tenantId/projects', controller.listProjects as never);

  // Get project by alias
  app.get('/tenants/:tenantId/projects/alias/:alias', controller.getProjectByAlias as never);

  // Get project by ID
  app.get('/projects/:projectId', controller.getProject);

  // Update project
  app.patch('/projects/:projectId', controller.updateProject as never);

  // Delete project
  app.delete('/projects/:projectId', controller.deleteProject);
}
