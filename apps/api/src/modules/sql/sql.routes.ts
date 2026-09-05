import type { FastifyInstance } from 'fastify';
import * as controller from './sql.controller.js';
import { authenticate } from '../../middleware/auth.js';
import { requireProjectCapability } from '../../lib/project-authorization.js';

export async function sqlRoutes(app: FastifyInstance) {
  // All SQL routes require authentication
  app.addHook('preHandler', authenticate);

  // Get exportable tables
  app.get('/projects/:projectId/sql/tables', { preHandler: requireProjectCapability('database:read') }, controller.listExportableTables as never);

  // Export SQL
  app.get('/projects/:projectId/sql/export', { preHandler: requireProjectCapability('database:read') }, controller.exportSql as never);

  // Import SQL
  app.post('/projects/:projectId/sql/import', { preHandler: requireProjectCapability('database:write') }, controller.importSql as never);
}
