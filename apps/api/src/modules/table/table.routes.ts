import type { FastifyInstance } from 'fastify';
import * as controller from './table.controller.js';
import { authenticate } from '../../middleware/auth.js';
import { requireSchemaCapability } from '../../lib/project-authorization.js';
import { importRoutes } from './import.routes.js';

export async function tableRoutes(app: FastifyInstance) {
  // All table routes require authentication and schema access verification
  app.addHook('preHandler', authenticate);

  // Get schema metadata (for SQL editor autocomplete)
  app.get('/schemas/:schemaName/metadata', { preHandler: requireSchemaCapability('database:read') }, controller.getSchemaMetadata as never);

  // Get schema relations for ER diagram
  app.get('/schemas/:schemaName/relations', { preHandler: requireSchemaCapability('database:read') }, controller.getSchemaRelations as never);

  // List tables in schema
  app.get('/schemas/:schemaName/tables', { preHandler: requireSchemaCapability('database:read') }, controller.listTables as never);

  // Create table
  app.post('/schemas/:schemaName/tables', { preHandler: requireSchemaCapability('database:write') }, controller.createTable as never);

  // Preview DDL (dry run)
  app.post('/schemas/:schemaName/tables/preview', { preHandler: requireSchemaCapability('database:write') }, controller.previewDDL as never);

  // Sync metadata
  app.post('/schemas/:schemaName/sync', { preHandler: requireSchemaCapability('database:write') }, controller.syncMetadata as never);

  // Get table metadata
  app.get('/schemas/:schemaName/tables/:tableName', { preHandler: requireSchemaCapability('database:read') }, controller.getTable as never);

  // Drop table
  app.delete('/schemas/:schemaName/tables/:tableName', { preHandler: requireSchemaCapability('database:write') }, controller.dropTable as never);

  // Add column
  app.post('/schemas/:schemaName/tables/:tableName/columns', { preHandler: requireSchemaCapability('database:write') }, controller.addColumn as never);

  // Drop column
  app.delete('/schemas/:schemaName/tables/:tableName/columns/:columnName', { preHandler: requireSchemaCapability('database:write') }, controller.dropColumn as never);

  // Rename column
  app.patch('/schemas/:schemaName/tables/:tableName/columns/:columnName', { preHandler: requireSchemaCapability('database:write') }, controller.renameColumn as never);

  // Get table foreign keys
  app.get('/schemas/:schemaName/tables/:tableName/foreign-keys', { preHandler: requireSchemaCapability('database:read') }, controller.getTableForeignKeys as never);

  // Add foreign key
  app.post('/schemas/:schemaName/tables/:tableName/foreign-keys', { preHandler: requireSchemaCapability('database:write') }, controller.addForeignKey as never);

  // Drop foreign key
  app.delete('/schemas/:schemaName/tables/:tableName/foreign-keys/:constraintName', { preHandler: requireSchemaCapability('database:write') }, controller.dropForeignKey as never);

  // Track all tables in Hasura (for GraphQL access)
  app.post('/schemas/:schemaName/hasura/track-all', { preHandler: requireSchemaCapability('database:write') }, controller.trackAllTablesInHasura as never);

  // Reload Hasura metadata/schema cache for this schema context
  app.post('/schemas/:schemaName/hasura/reload', { preHandler: requireSchemaCapability('database:write') }, controller.reloadHasuraMetadata as never);

  // Track single table in Hasura
  app.post('/schemas/:schemaName/tables/:tableName/hasura/track', { preHandler: requireSchemaCapability('database:write') }, controller.trackTableInHasura as never);

  // Get Hasura permission status for schema
  app.get('/schemas/:schemaName/hasura/status', { preHandler: requireSchemaCapability('database:read') }, controller.getHasuraStatus as never);

  // Register import routes
  app.register(importRoutes, { prefix: '/schemas' });
}
