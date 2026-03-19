import type { FastifyRequest, FastifyReply } from 'fastify';
import * as tableService from './table.service.js';
import * as schemaService from '../schema/schema.service.js';
import type { TableDefinition, ColumnDefinition, ForeignKeyDetail } from './table.service.js';

interface SchemaParams {
  schemaName: string;
}

interface TableParams extends SchemaParams {
  tableName: string;
}

interface ColumnParams extends TableParams {
  columnName: string;
}

// Create table
export async function createTable(
  request: FastifyRequest<{ Params: SchemaParams; Body: TableDefinition }>,
  reply: FastifyReply
) {
  const { schemaName } = request.params;
  const table = request.body;

  if (!table.name || !table.columns || table.columns.length === 0) {
    return reply.status(400).send({
      success: false,
      error: { code: 'INVALID_INPUT', message: 'Table name and columns are required' },
    });
  }

  try {
    await tableService.createTable(schemaName, table);
    const metadata = await tableService.getTableMetadata(schemaName, table.name);
    return reply.status(201).send({ success: true, data: metadata });
  } catch (error) {
    const err = error as Error;
    return reply.status(400).send({
      success: false,
      error: { code: 'CREATE_FAILED', message: err.message },
    });
  }
}

// Drop table
export async function dropTable(
  request: FastifyRequest<{ Params: TableParams }>,
  reply: FastifyReply
) {
  const { schemaName, tableName } = request.params;

  try {
    await tableService.dropTable(schemaName, tableName);
    return reply.status(204).send();
  } catch (error) {
    const err = error as Error;
    return reply.status(400).send({
      success: false,
      error: { code: 'DROP_FAILED', message: err.message },
    });
  }
}

// Get table metadata
export async function getTable(
  request: FastifyRequest<{ Params: TableParams }>,
  reply: FastifyReply
) {
  const { schemaName, tableName } = request.params;

  const metadata = await tableService.getTableMetadata(schemaName, tableName);

  if (!metadata) {
    return reply.status(404).send({
      success: false,
      error: { code: 'NOT_FOUND', message: 'Table not found' },
    });
  }

  return reply.send({ success: true, data: metadata });
}

// List tables
export async function listTables(
  request: FastifyRequest<{ Params: SchemaParams }>,
  reply: FastifyReply
) {
  const { schemaName } = request.params;

  try {
    const tables = await tableService.listTables(schemaName);
    return reply.send({ success: true, data: tables });
  } catch (error) {
    const err = error as Error;
    return reply.status(400).send({
      success: false,
      error: { code: 'LIST_FAILED', message: err.message },
    });
  }
}

// Add column
export async function addColumn(
  request: FastifyRequest<{ Params: TableParams; Body: ColumnDefinition }>,
  reply: FastifyReply
) {
  const { schemaName, tableName } = request.params;
  const column = request.body;

  if (!column.name || !column.type) {
    return reply.status(400).send({
      success: false,
      error: { code: 'INVALID_INPUT', message: 'Column name and type are required' },
    });
  }

  try {
    await tableService.addColumn(schemaName, tableName, column);
    const metadata = await tableService.getTableMetadata(schemaName, tableName);
    return reply.send({ success: true, data: metadata });
  } catch (error) {
    const err = error as Error;
    return reply.status(400).send({
      success: false,
      error: { code: 'ADD_COLUMN_FAILED', message: err.message },
    });
  }
}

// Drop column
export async function dropColumn(
  request: FastifyRequest<{ Params: ColumnParams }>,
  reply: FastifyReply
) {
  const { schemaName, tableName, columnName } = request.params;

  try {
    await tableService.dropColumn(schemaName, tableName, columnName);
    const metadata = await tableService.getTableMetadata(schemaName, tableName);
    return reply.send({ success: true, data: metadata });
  } catch (error) {
    const err = error as Error;
    return reply.status(400).send({
      success: false,
      error: { code: 'DROP_COLUMN_FAILED', message: err.message },
    });
  }
}

// Rename column
export async function renameColumn(
  request: FastifyRequest<{ Params: ColumnParams; Body: { newName: string } }>,
  reply: FastifyReply
) {
  const { schemaName, tableName, columnName } = request.params;
  const { newName } = request.body;

  if (!newName) {
    return reply.status(400).send({
      success: false,
      error: { code: 'INVALID_INPUT', message: 'New column name is required' },
    });
  }

  try {
    await tableService.renameColumn(schemaName, tableName, columnName, newName);
    const metadata = await tableService.getTableMetadata(schemaName, tableName);
    return reply.send({ success: true, data: metadata });
  } catch (error) {
    const err = error as Error;
    return reply.status(400).send({
      success: false,
      error: { code: 'RENAME_COLUMN_FAILED', message: err.message },
    });
  }
}

// Sync metadata
export async function syncMetadata(
  request: FastifyRequest<{ Params: SchemaParams }>,
  reply: FastifyReply
) {
  const { schemaName } = request.params;

  try {
    await tableService.syncTableMetadata(schemaName);
    return reply.send({ success: true, message: 'Metadata synced successfully' });
  } catch (error) {
    const err = error as Error;
    return reply.status(400).send({
      success: false,
      error: { code: 'SYNC_FAILED', message: err.message },
    });
  }
}

// Generate DDL preview
export async function previewDDL(
  request: FastifyRequest<{ Params: SchemaParams; Body: TableDefinition }>,
  reply: FastifyReply
) {
  const { schemaName } = request.params;
  const table = request.body;

  if (!table.name || !table.columns) {
    return reply.status(400).send({
      success: false,
      error: { code: 'INVALID_INPUT', message: 'Table name and columns are required' },
    });
  }

  const ddl = tableService.generateCreateTableDDL(schemaName, table);
  const indexes = (table.indexes || []).map(idx =>
    tableService.generateIndexDDL(schemaName, table.name, idx)
  );

  return reply.send({
    success: true,
    data: {
      createTable: ddl,
      createIndexes: indexes,
    },
  });
}

// Get schema metadata (for SQL editor autocomplete)
export async function getSchemaMetadata(
  request: FastifyRequest<{ Params: SchemaParams }>,
  reply: FastifyReply
) {
  const { schemaName } = request.params;

  try {
    const metadata = await schemaService.getSchemaMetadata(schemaName);
    return reply.send({ success: true, data: metadata });
  } catch (error) {
    const err = error as Error;
    return reply.status(400).send({
      success: false,
      error: { code: 'GET_METADATA_FAILED', message: err.message },
    });
  }
}

// Get schema relations for ER diagram
export async function getSchemaRelations(
  request: FastifyRequest<{ Params: { schemaName: string } }>,
  reply: FastifyReply
) {
  const { schemaName } = request.params;

  try {
    const relations = await tableService.getSchemaRelations(schemaName);
    return reply.send({ success: true, data: relations });
  } catch (error) {
    const err = error as Error;
    return reply.status(500).send({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: err.message || 'Failed to get schema relations' },
    });
  }
}

// Foreign key params
interface ForeignKeyParams extends TableParams {
  constraintName: string;
}

// Foreign key body
interface AddForeignKeyBody {
  column: string;
  targetTable: string;
  targetColumn: string;
  onDelete?: 'CASCADE' | 'SET NULL' | 'RESTRICT' | 'NO ACTION';
  onUpdate?: 'CASCADE' | 'SET NULL' | 'RESTRICT' | 'NO ACTION';
}

// Get table foreign keys
export async function getTableForeignKeys(
  request: FastifyRequest<{ Params: TableParams }>,
  reply: FastifyReply
) {
  const { schemaName, tableName } = request.params;

  try {
    const foreignKeys = await tableService.getTableForeignKeys(schemaName, tableName);
    return reply.send({ success: true, data: foreignKeys });
  } catch (error) {
    const err = error as Error;
    return reply.status(400).send({
      success: false,
      error: { code: 'GET_FOREIGN_KEYS_FAILED', message: err.message },
    });
  }
}

// Add foreign key
export async function addForeignKey(
  request: FastifyRequest<{ Params: TableParams; Body: AddForeignKeyBody }>,
  reply: FastifyReply
) {
  const { schemaName, tableName } = request.params;
  const body = request.body;

  if (!body.column || !body.targetTable || !body.targetColumn) {
    return reply.status(400).send({
      success: false,
      error: { code: 'INVALID_INPUT', message: 'column, targetTable, and targetColumn are required' },
    });
  }

  try {
    const constraintName = await tableService.addForeignKey(schemaName, tableName, body);
    return reply.status(201).send({ success: true, data: { constraintName } });
  } catch (error) {
    const err = error as Error;
    return reply.status(400).send({
      success: false,
      error: { code: 'ADD_FOREIGN_KEY_FAILED', message: err.message },
    });
  }
}

// Drop foreign key
export async function dropForeignKey(
  request: FastifyRequest<{ Params: ForeignKeyParams }>,
  reply: FastifyReply
) {
  const { schemaName, tableName, constraintName } = request.params;

  try {
    await tableService.dropForeignKey(schemaName, tableName, constraintName);
    return reply.send({ success: true });
  } catch (error) {
    const err = error as Error;
    return reply.status(400).send({
      success: false,
      error: { code: 'DROP_FOREIGN_KEY_FAILED', message: err.message },
    });
  }
}

// Track all tables in Hasura
export async function trackAllTablesInHasura(
  request: FastifyRequest<{ Params: SchemaParams }>,
  reply: FastifyReply
) {
  const { schemaName } = request.params;

  try {
    const result = await tableService.trackAllTablesInHasura(schemaName);
    return reply.send({
      success: true,
      data: result,
      message: `Tracked ${result.tracked.length} tables, ${result.failed.length} failed`,
    });
  } catch (error) {
    const err = error as Error;
    return reply.status(400).send({
      success: false,
      error: { code: 'TRACK_FAILED', message: err.message },
    });
  }
}

// Track single table in Hasura
export async function trackTableInHasura(
  request: FastifyRequest<{ Params: TableParams }>,
  reply: FastifyReply
) {
  const { schemaName, tableName } = request.params;

  try {
    await tableService.trackTableInHasura(schemaName, tableName);
    return reply.send({
      success: true,
      message: `Table ${tableName} tracked in Hasura`,
    });
  } catch (error) {
    const err = error as Error;
    return reply.status(400).send({
      success: false,
      error: { code: 'TRACK_FAILED', message: err.message },
    });
  }
}

// Get Hasura permission status for schema
export async function getHasuraStatus(
  request: FastifyRequest<{ Params: SchemaParams }>,
  reply: FastifyReply
) {
  const { schemaName } = request.params;

  try {
    const status = await tableService.getHasuraStatus(schemaName);
    return reply.send({ success: true, data: status });
  } catch (error) {
    const err = error as Error;
    return reply.status(400).send({
      success: false,
      error: { code: 'HASURA_STATUS_FAILED', message: err.message },
    });
  }
}
