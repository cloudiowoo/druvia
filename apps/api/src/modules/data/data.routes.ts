import type { FastifyInstance } from 'fastify';
import * as controller from './data.controller.js';
import { authenticate } from '../../middleware/auth.js';

export async function dataRoutes(app: FastifyInstance) {
  // All data routes require authentication
  app.addHook('preHandler', authenticate);

  // List rows with pagination, sorting, and filtering
  app.get('/schemas/:schema/tables/:table/rows', controller.listRows as never);

  // Create a new row
  app.post('/schemas/:schema/tables/:table/rows', controller.createRow as never);

  // Update a row by primary key
  app.patch('/schemas/:schema/tables/:table/rows', controller.updateRow as never);

  // Delete a row by primary key
  app.delete('/schemas/:schema/tables/:table/rows', controller.deleteRow as never);

  // Batch delete rows
  app.delete('/schemas/:schema/tables/:table/rows/batch', controller.batchDeleteRows as never);

  // Export data as CSV or JSON
  app.get('/schemas/:schema/tables/:table/export', controller.exportData as never);
}
