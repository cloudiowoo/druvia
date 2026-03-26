import type { FastifyInstance } from 'fastify';
import * as controller from './table.controller.js';
import { authenticate, verifySchemaAccess } from '../../middleware/auth.js';
import { importRoutes } from './import.routes.js';

export async function tableRoutes(app: FastifyInstance) {
  // All table routes require authentication and schema access verification
  app.addHook('preHandler', authenticate);
  app.addHook('preHandler', verifySchemaAccess);

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

  // Get table foreign keys
  app.get('/schemas/:schemaName/tables/:tableName/foreign-keys', controller.getTableForeignKeys as never);

  // Add foreign key
  app.post('/schemas/:schemaName/tables/:tableName/foreign-keys', controller.addForeignKey as never);

  // Drop foreign key
  app.delete('/schemas/:schemaName/tables/:tableName/foreign-keys/:constraintName', controller.dropForeignKey as never);

  // Track all tables in Hasura (for GraphQL access)
  app.post('/schemas/:schemaName/hasura/track-all', controller.trackAllTablesInHasura as never);

  // Reload Hasura metadata/schema cache for this schema context
  app.post('/schemas/:schemaName/hasura/reload', controller.reloadHasuraMetadata as never);

  // Track single table in Hasura
  app.post('/schemas/:schemaName/tables/:tableName/hasura/track', controller.trackTableInHasura as never);

  // Get Hasura permission status for schema
  app.get('/schemas/:schemaName/hasura/status', controller.getHasuraStatus as never);

  // Register import routes
  app.register(importRoutes, { prefix: '/schemas' });
}
