import type { FastifyInstance } from 'fastify';
import * as controller from './sql.controller.js';
import { authenticate } from '../../middleware/auth.js';

export async function sqlRoutes(app: FastifyInstance) {
  // All SQL routes require authentication
  app.addHook('preHandler', authenticate);

  // Get exportable tables
  app.get('/projects/:projectId/sql/tables', controller.listExportableTables as never);

  // Export SQL
  app.get('/projects/:projectId/sql/export', controller.exportSql as never);

  // Import SQL
  app.post('/projects/:projectId/sql/import', controller.importSql as never);
}
