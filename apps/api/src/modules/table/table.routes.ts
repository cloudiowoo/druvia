import type { FastifyInstance } from 'fastify';
import * as controller from './table.controller.js';
import { authenticate } from '../../middleware/auth.js';

export async function tableRoutes(app: FastifyInstance) {
  // All table routes require authentication
  app.addHook('preHandler', authenticate);

  // Get schema metadata (for SQL editor autocomplete)
  app.get('/schemas/:schemaName/metadata', controller.getSchemaMetadata as never);

  // Get schema relations for ER diagram
  app.get('/schemas/:schemaName/relations', controller.getSchemaRelations as never);

  // List tables in schema
  app.get('/schemas/:schemaName/tables', controller.listTables as never);

  // Create table
  app.post('/schemas/:schemaName/tables', controller.createTable as never);

  // Preview DDL (dry run)
  app.post('/schemas/:schemaName/tables/preview', controller.previewDDL as never);

  // Sync metadata
  app.post('/schemas/:schemaName/sync', controller.syncMetadata as never);

  // Get table metadata
  app.get('/schemas/:schemaName/tables/:tableName', controller.getTable as never);

  // Drop table
  app.delete('/schemas/:schemaName/tables/:tableName', controller.dropTable as never);

  // Add column
  app.post('/schemas/:schemaName/tables/:tableName/columns', controller.addColumn as never);

  // Drop column
  app.delete('/schemas/:schemaName/tables/:tableName/columns/:columnName', controller.dropColumn as never);

  // Rename column
  app.patch('/schemas/:schemaName/tables/:tableName/columns/:columnName', controller.renameColumn as never);
}
