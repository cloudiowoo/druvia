import { pool, query, queryOne } from '../../db/index.js';

// Column definition
export interface ColumnDefinition {
  name: string;
  type: string;
  nullable?: boolean;
  defaultValue?: string;
  primaryKey?: boolean;
  unique?: boolean;
  references?: {
    table: string;
    column: string;
    onDelete?: 'CASCADE' | 'SET NULL' | 'RESTRICT' | 'NO ACTION';
  };
}

// Table definition
export interface TableDefinition {
  name: string;
  columns: ColumnDefinition[];
  primaryKey?: string[];
  indexes?: Array<{
    name: string;
    columns: string[];
    unique?: boolean;
  }>;
}

// Table metadata from database
export interface TableMetadata {
  schemaName: string;
  tableName: string;
  columns: Array<{
    name: string;
    type: string;
    nullable: boolean;
    defaultValue: string | null;
    isPrimaryKey: boolean;
  }>;
  rowCount: number;
  sizeBytes: number;
}

// Generate column DDL
function generateColumnDDL(col: ColumnDefinition): string {
  let ddl = `"${col.name}" ${col.type}`;

  if (col.primaryKey) {
    ddl += ' PRIMARY KEY';
  }
  if (!col.nullable && !col.primaryKey) {
    ddl += ' NOT NULL';
  }
  if (col.unique && !col.primaryKey) {
    ddl += ' UNIQUE';
  }
  if (col.defaultValue !== undefined) {
    ddl += ` DEFAULT ${col.defaultValue}`;
  }
  if (col.references) {
    ddl += ` REFERENCES "${col.references.table}"("${col.references.column}")`;
    if (col.references.onDelete) {
      ddl += ` ON DELETE ${col.references.onDelete}`;
    }
  }

  return ddl;
}

// Generate CREATE TABLE DDL
export function generateCreateTableDDL(schemaName: string, table: TableDefinition): string {
  const columns = table.columns.map(generateColumnDDL);

  // Add composite primary key if specified
  if (table.primaryKey && table.primaryKey.length > 1) {
    columns.push(`PRIMARY KEY (${table.primaryKey.map(c => `"${c}"`).join(', ')})`);
  }

  let ddl = `CREATE TABLE "${schemaName}"."${table.name}" (\n  ${columns.join(',\n  ')}\n)`;

  return ddl;
}

// Generate index DDL
export function generateIndexDDL(
  schemaName: string,
  tableName: string,
  index: { name: string; columns: string[]; unique?: boolean }
): string {
  const unique = index.unique ? 'UNIQUE ' : '';
  const columns = index.columns.map(c => `"${c}"`).join(', ');
  return `CREATE ${unique}INDEX "${index.name}" ON "${schemaName}"."${tableName}" (${columns})`;
}

// Create table in schema
export async function createTable(schemaName: string, table: TableDefinition): Promise<void> {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // Create table
    const createDDL = generateCreateTableDDL(schemaName, table);
    await client.query(createDDL);

    // Create indexes
    if (table.indexes) {
      for (const index of table.indexes) {
        const indexDDL = generateIndexDDL(schemaName, table.name, index);
        await client.query(indexDDL);
      }
    }

    // Register in _meta_tables
    await client.query(
      `INSERT INTO "${schemaName}"._meta_tables (table_name, description, row_count)
       VALUES ($1, $2, 0)
       ON CONFLICT (table_name) DO NOTHING`,
      [table.name, null]
    );

    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

// Drop table from schema
export async function dropTable(schemaName: string, tableName: string): Promise<void> {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // Drop table
    await client.query(`DROP TABLE IF EXISTS "${schemaName}"."${tableName}" CASCADE`);

    // Remove from _meta_tables
    await client.query(
      `DELETE FROM "${schemaName}"._meta_tables WHERE table_name = $1`,
      [tableName]
    );

    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

// Add column to table
export async function addColumn(
  schemaName: string,
  tableName: string,
  column: ColumnDefinition
): Promise<void> {
  const colDDL = generateColumnDDL(column);
  await pool.query(`ALTER TABLE "${schemaName}"."${tableName}" ADD COLUMN ${colDDL}`);
}

// Drop column from table
export async function dropColumn(
  schemaName: string,
  tableName: string,
  columnName: string
): Promise<void> {
  await pool.query(`ALTER TABLE "${schemaName}"."${tableName}" DROP COLUMN "${columnName}"`);
}

// Rename column
export async function renameColumn(
  schemaName: string,
  tableName: string,
  oldName: string,
  newName: string
): Promise<void> {
  await pool.query(
    `ALTER TABLE "${schemaName}"."${tableName}" RENAME COLUMN "${oldName}" TO "${newName}"`
  );
}

// Get table metadata
export async function getTableMetadata(
  schemaName: string,
  tableName: string
): Promise<TableMetadata | null> {
  // Get columns
  const columns = await query<{
    column_name: string;
    data_type: string;
    is_nullable: string;
    column_default: string | null;
  }>(
    `SELECT column_name, data_type, is_nullable, column_default
     FROM information_schema.columns
     WHERE table_schema = $1 AND table_name = $2
     ORDER BY ordinal_position`,
    [schemaName, tableName]
  );

  if (columns.length === 0) return null;

  // Get primary key columns
  const pkResult = await query<{ column_name: string }>(
    `SELECT a.attname as column_name
     FROM pg_index i
     JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
     WHERE i.indrelid = $1::regclass AND i.indisprimary`,
    [`"${schemaName}"."${tableName}"`]
  );
  const pkColumns = new Set(pkResult.map(r => r.column_name));

  // Get row count and size
  const statsResult = await queryOne<{ row_count: string; size_bytes: string }>(
    `SELECT
       (SELECT reltuples::bigint FROM pg_class WHERE oid = $1::regclass) as row_count,
       pg_total_relation_size($1::regclass) as size_bytes`,
    [`"${schemaName}"."${tableName}"`]
  );

  return {
    schemaName,
    tableName,
    columns: columns.map(col => ({
      name: col.column_name,
      type: col.data_type,
      nullable: col.is_nullable === 'YES',
      defaultValue: col.column_default,
      isPrimaryKey: pkColumns.has(col.column_name),
    })),
    rowCount: parseInt(statsResult?.row_count || '0', 10),
    sizeBytes: parseInt(statsResult?.size_bytes || '0', 10),
  };
}

// List tables in schema (optimized single query)
export async function listTables(schemaName: string): Promise<Array<{
  tableName: string;
  rowCount: number;
  sizeBytes: number;
}>> {
  const tables = await query<{
    table_name: string;
    row_count: string;
    size_bytes: string;
  }>(
    `SELECT
       t.table_name,
       COALESCE(c.reltuples::bigint, 0) as row_count,
       COALESCE(pg_total_relation_size(quote_ident($1) || '.' || quote_ident(t.table_name)), 0) as size_bytes
     FROM information_schema.tables t
     LEFT JOIN pg_namespace n ON n.nspname = t.table_schema
     LEFT JOIN pg_class c ON c.relnamespace = n.oid AND c.relname = t.table_name
     WHERE t.table_schema = $1
       AND t.table_type = 'BASE TABLE'
       AND t.table_name NOT LIKE '\\_%'
     ORDER BY t.table_name`,
    [schemaName]
  );

  return tables.map(t => ({
    tableName: t.table_name,
    rowCount: parseInt(t.row_count || '0', 10),
    sizeBytes: parseInt(t.size_bytes || '0', 10),
  }));
}

// Sync metadata to _meta_tables
export async function syncTableMetadata(schemaName: string): Promise<void> {
  const tables = await listTables(schemaName);

  for (const table of tables) {
    await pool.query(
      `INSERT INTO "${schemaName}"._meta_tables (table_name, row_count)
       VALUES ($1, $2)
       ON CONFLICT (table_name) DO UPDATE SET row_count = $2, updated_at = NOW()`,
      [table.tableName, table.rowCount]
    );
  }
}
