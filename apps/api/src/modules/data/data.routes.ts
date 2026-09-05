import type { FastifyInstance } from 'fastify';
import * as controller from './data.controller.js';
import { authenticate } from '../../middleware/auth.js';
import { requireSchemaCapability } from '../../lib/project-authorization.js';

export async function dataRoutes(app: FastifyInstance) {
  // All data routes require authentication and schema access verification
  app.addHook('preHandler', authenticate);

  // List rows with pagination, sorting, and filtering
  app.get('/schemas/:schema/tables/:table/rows', { preHandler: requireSchemaCapability('database:read') }, controller.listRows as never);

  // Create a new row
  app.post('/schemas/:schema/tables/:table/rows', { preHandler: requireSchemaCapability('database:write') }, controller.createRow as never);

  // Update a row by primary key
  app.patch('/schemas/:schema/tables/:table/rows', { preHandler: requireSchemaCapability('database:write') }, controller.updateRow as never);

  // Delete a row by primary key
  app.delete('/schemas/:schema/tables/:table/rows', { preHandler: requireSchemaCapability('database:write') }, controller.deleteRow as never);

  // Batch delete rows
  app.delete('/schemas/:schema/tables/:table/rows/batch', { preHandler: requireSchemaCapability('database:write') }, controller.batchDeleteRows as never);

  // Export data as CSV or JSON
  app.get('/schemas/:schema/tables/:table/export', { preHandler: requireSchemaCapability('database:read') }, controller.exportData as never);
}
