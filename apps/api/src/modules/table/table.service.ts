import { pool, query, queryOne } from '../../db/index.js';
import { hasuraMetadataRequest } from '../realtime/realtime.service.js';
import { createApiLogger } from '../../lib/logger.js';

const logger = createApiLogger({ module: 'table' });

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
function generateColumnDDL(col: ColumnDefinition, schemaName: string): string {
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
    ddl += ` REFERENCES "${schemaName}"."${col.references.table}"("${col.references.column}")`;
    if (col.references.onDelete) {
      ddl += ` ON DELETE ${col.references.onDelete}`;
    }
  }

  return ddl;
}

// Generate CREATE TABLE DDL
export function generateCreateTableDDL(schemaName: string, table: TableDefinition): string {
  const columns = table.columns.map(col => generateColumnDDL(col, schemaName));

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

  // Track table in Hasura (after DB transaction commits)
  await trackTableInHasura(schemaName, table.name);
}

// Track table in Hasura for GraphQL access
export async function trackTableInHasura(schemaName: string, tableName: string): Promise<void> {
  try {
    // 1. Track the table
    await hasuraMetadataRequest('pg_track_table', {
      source: 'default',
      table: { schema: schemaName, name: tableName },
    });
  } catch (error) {
    // Ignore if already tracked
    const errorMsg = error instanceof Error ? error.message : String(error);
    if (!errorMsg.includes('already tracked') && !errorMsg.includes('already exists')) {
      logger.warn('failed to track table in hasura', { schemaName, tableName }, error);
    }
  }

  // 2. Add permissions for 'user' role (full CRUD)
  const table = { schema: schemaName, name: tableName };
  const userPermissionOps = [
    { type: 'pg_create_select_permission', permission: { columns: '*', filter: {}, allow_aggregations: true } },
    { type: 'pg_create_insert_permission', permission: { columns: '*', check: {} } },
    { type: 'pg_create_update_permission', permission: { columns: '*', filter: {}, check: {} } },
    { type: 'pg_create_delete_permission', permission: { filter: {} } },
  ];

  for (const op of userPermissionOps) {
    try {
      await hasuraMetadataRequest(op.type, {
        source: 'default',
        table,
        role: 'user',
        permission: op.permission,
      });
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      if (!errorMsg.includes('already exists')) {
        logger.warn('failed to create user permission in hasura', {
          schemaName,
          tableName,
          operation: op.type,
          role: 'user',
        }, error);
      }
    }
  }

  // 3. Add permissions for 'anonymous' role (insert/update/delete only, NO select)
  // anonymous select_permission is managed by Realtime page
  const anonPermissionOps = [
    { type: 'pg_create_insert_permission', permission: { columns: '*', check: {} } },
    { type: 'pg_create_update_permission', permission: { columns: '*', filter: {}, check: {} } },
    { type: 'pg_create_delete_permission', permission: { filter: {} } },
  ];

  for (const op of anonPermissionOps) {
    try {
      await hasuraMetadataRequest(op.type, {
        source: 'default',
        table,
        role: 'anonymous',
        permission: op.permission,
      });
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      if (!errorMsg.includes('already exists')) {
        logger.warn('failed to create anonymous permission in hasura', {
          schemaName,
          tableName,
          operation: op.type,
          role: 'anonymous',
        }, error);
      }
    }
  }
}

// Drop table from schema
export async function dropTable(schemaName: string, tableName: string): Promise<void> {
  // Untrack from Hasura first (before dropping the table)
  await untrackTableFromHasura(schemaName, tableName);

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

// Untrack table from Hasura
async function untrackTableFromHasura(schemaName: string, tableName: string): Promise<void> {
  try {
    await hasuraMetadataRequest('pg_untrack_table', {
      source: 'default',
      table: { schema: schemaName, name: tableName },
      cascade: true,
    });
  } catch (error) {
    // Ignore if not tracked
    const errorMsg = error instanceof Error ? error.message : String(error);
    if (!errorMsg.includes('not tracked') && !errorMsg.includes('does not exist')) {
      logger.warn('failed to untrack table from hasura', { schemaName, tableName }, error);
    }
  }
}

export async function reloadHasuraMetadata(): Promise<void> {
  await hasuraMetadataRequest('reload_metadata', {
    reload_sources: true,
    reload_remote_schemas: true,
    recreate_event_triggers: true,
  });
}

// Add column to table
export async function addColumn(
  schemaName: string,
  tableName: string,
  column: ColumnDefinition
): Promise<void> {
  const colDDL = generateColumnDDL(column, schemaName);
  await pool.query(`ALTER TABLE "${schemaName}"."${tableName}" ADD COLUMN ${colDDL}`);
  await reloadHasuraMetadata();
}

// Drop column from table
export async function dropColumn(
  schemaName: string,
  tableName: string,
  columnName: string
): Promise<void> {
  await pool.query(`ALTER TABLE "${schemaName}"."${tableName}" DROP COLUMN "${columnName}"`);
  await reloadHasuraMetadata();
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
  await reloadHasuraMetadata();
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

// Foreign key information
export interface ForeignKey {
  fromTable: string;
  fromColumn: string;
  toTable: string;
  toColumn: string;
}

// Get foreign keys in schema
export async function getForeignKeys(schemaName: string): Promise<ForeignKey[]> {
  const result = await query<{
    from_table: string;
    from_column: string;
    to_table: string;
    to_column: string;
  }>(
    `SELECT
       tc.table_name as from_table,
       kcu.column_name as from_column,
       ccu.table_name as to_table,
       ccu.column_name as to_column
     FROM information_schema.table_constraints tc
     JOIN information_schema.key_column_usage kcu
       ON tc.constraint_name = kcu.constraint_name
       AND tc.table_schema = kcu.table_schema
     JOIN information_schema.constraint_column_usage ccu
       ON ccu.constraint_name = tc.constraint_name
     WHERE tc.constraint_type = 'FOREIGN KEY'
       AND tc.table_schema = $1
       AND ccu.table_schema = $1`,
    [schemaName]
  );

  return result.map(row => ({
    fromTable: row.from_table,
    fromColumn: row.from_column,
    toTable: row.to_table,
    toColumn: row.to_column,
  }));
}

// Get schema relations (tables with columns + foreign keys) - optimized single query
export async function getSchemaRelations(schemaName: string): Promise<{
  tables: Array<{
    name: string;
    columns: Array<{ name: string; type: string; isPrimaryKey: boolean }>;
  }>;
  foreignKeys: ForeignKey[];
}> {
  // Get all columns for all tables in one query
  const columnsResult = await query<{
    table_name: string;
    column_name: string;
    data_type: string;
    is_primary: boolean;
  }>(
    `SELECT
       c.table_name,
       c.column_name,
       c.data_type,
       COALESCE(pk.is_primary, false) as is_primary
     FROM information_schema.columns c
     LEFT JOIN (
       SELECT a.attname as column_name, t.relname as table_name, true as is_primary
       FROM pg_index i
       JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
       JOIN pg_class t ON t.oid = i.indrelid
       JOIN pg_namespace n ON n.oid = t.relnamespace
       WHERE i.indisprimary AND n.nspname = $1
     ) pk ON pk.table_name = c.table_name AND pk.column_name = c.column_name
     WHERE c.table_schema = $1
       AND c.table_name NOT LIKE '\\_%'
     ORDER BY c.table_name, c.ordinal_position`,
    [schemaName]
  );

  // Group columns by table
  const tableMap = new Map<string, Array<{ name: string; type: string; isPrimaryKey: boolean }>>();
  for (const row of columnsResult) {
    if (!tableMap.has(row.table_name)) {
      tableMap.set(row.table_name, []);
    }
    tableMap.get(row.table_name)!.push({
      name: row.column_name,
      type: row.data_type,
      isPrimaryKey: row.is_primary,
    });
  }

  const tables = Array.from(tableMap.entries()).map(([name, columns]) => ({
    name,
    columns,
  }));

  const foreignKeys = await getForeignKeys(schemaName);

  return { tables, foreignKeys };
}

// 获取表的外键详情（包含约束名和级联规则）
export interface ForeignKeyDetail {
  constraintName: string;
  fromColumn: string;
  toTable: string;
  toColumn: string;
  onDelete: string;
  onUpdate: string;
}

export async function getTableForeignKeys(
  schemaName: string,
  tableName: string
): Promise<ForeignKeyDetail[]> {
  const result = await query<{
    constraint_name: string;
    column_name: string;
    foreign_table_name: string;
    foreign_column_name: string;
    delete_rule: string;
    update_rule: string;
  }>(
    `SELECT
       tc.constraint_name,
       kcu.column_name,
       ccu.table_name AS foreign_table_name,
       ccu.column_name AS foreign_column_name,
       rc.delete_rule,
       rc.update_rule
     FROM information_schema.table_constraints tc
     JOIN information_schema.key_column_usage kcu
       ON tc.constraint_name = kcu.constraint_name
       AND tc.table_schema = kcu.table_schema
     JOIN information_schema.constraint_column_usage ccu
       ON ccu.constraint_name = tc.constraint_name
       AND ccu.table_schema = tc.table_schema
     JOIN information_schema.referential_constraints rc
       ON rc.constraint_name = tc.constraint_name
       AND rc.constraint_schema = tc.table_schema
     WHERE tc.constraint_type = 'FOREIGN KEY'
       AND tc.table_schema = $1
       AND tc.table_name = $2`,
    [schemaName, tableName]
  );

  return result.map(row => ({
    constraintName: row.constraint_name,
    fromColumn: row.column_name,
    toTable: row.foreign_table_name,
    toColumn: row.foreign_column_name,
    onDelete: row.delete_rule,
    onUpdate: row.update_rule,
  }));
}

// 添加外键约束
export async function addForeignKey(
  schemaName: string,
  tableName: string,
  config: {
    column: string;
    targetTable: string;
    targetColumn: string;
    onDelete?: 'CASCADE' | 'SET NULL' | 'RESTRICT' | 'NO ACTION';
    onUpdate?: 'CASCADE' | 'SET NULL' | 'RESTRICT' | 'NO ACTION';
  }
): Promise<string> {
  // 验证标识符格式，防止 SQL 注入
  const identifierRegex = /^[a-z_][a-z0-9_]*$/i;
  if (!identifierRegex.test(schemaName) ||
      !identifierRegex.test(tableName) ||
      !identifierRegex.test(config.column) ||
      !identifierRegex.test(config.targetTable) ||
      !identifierRegex.test(config.targetColumn)) {
    throw new Error('Invalid identifier format');
  }

  const constraintName = `fk_${tableName}_${config.column}_${config.targetTable}`;
  const onDelete = config.onDelete || 'NO ACTION';
  const onUpdate = config.onUpdate || 'NO ACTION';

  // 验证级联规则是有效值
  const validActions = ['CASCADE', 'SET NULL', 'RESTRICT', 'NO ACTION'];
  if (!validActions.includes(onDelete) || !validActions.includes(onUpdate)) {
    throw new Error('Invalid cascade action');
  }

  await pool.query(
    `ALTER TABLE "${schemaName}"."${tableName}"
     ADD CONSTRAINT "${constraintName}"
     FOREIGN KEY ("${config.column}")
     REFERENCES "${schemaName}"."${config.targetTable}"("${config.targetColumn}")
     ON DELETE ${onDelete}
     ON UPDATE ${onUpdate}`
  );

  return constraintName;
}

// 删除外键约束
export async function dropForeignKey(
  schemaName: string,
  tableName: string,
  constraintName: string
): Promise<void> {
  // 验证标识符格式，防止 SQL 注入
  const identifierRegex = /^[a-z_][a-z0-9_]*$/i;
  if (!identifierRegex.test(schemaName) ||
      !identifierRegex.test(tableName) ||
      !identifierRegex.test(constraintName)) {
    throw new Error('Invalid identifier format');
  }

  await pool.query(
    `ALTER TABLE "${schemaName}"."${tableName}" DROP CONSTRAINT "${constraintName}"`
  );
}

// Track all existing tables in schema to Hasura (permissions + relationships)
export async function trackAllTablesInHasura(schemaName: string): Promise<{
  tracked: string[];
  failed: string[];
  relationships: number;
  untracked: number;
}> {
  const tables = await listTables(schemaName);
  const tracked: string[] = [];
  const failed: string[] = [];
  let relationships = 0;

  // 1. Track tables + permissions
  for (const table of tables) {
    try {
      await trackTableInHasura(schemaName, table.tableName);
      tracked.push(table.tableName);
    } catch (error) {
      logger.error('failed to track table during schema sync', {
        schemaName,
        tableName: table.tableName,
      }, error);
      failed.push(table.tableName);
    }
  }

  // 1.5 Clean up anonymous select_permission for tables where realtime is disabled
  try {
    const metaRows = await query<{ table_name: string; realtime_enabled: boolean }>(
      `SELECT table_name, realtime_enabled FROM "${schemaName}"._meta_tables`,
      []
    );
    const realtimeEnabledSet = new Set(
      metaRows.filter(r => r.realtime_enabled).map(r => r.table_name)
    );

    for (const table of tables) {
      if (!realtimeEnabledSet.has(table.tableName)) {
        // Drop anonymous select_permission if it exists (legacy cleanup)
        try {
          await hasuraMetadataRequest('pg_drop_select_permission', {
            source: 'default',
            table: { schema: schemaName, name: table.tableName },
            role: 'anonymous',
          });
        } catch (error) {
          const errorMsg = error instanceof Error ? error.message : String(error);
          if (!errorMsg.includes('does not exist')) {
            logger.warn('failed to drop anonymous select permission', {
              schemaName,
              tableName: table.tableName,
              role: 'anonymous',
              operation: 'select',
            }, error);
          }
        }
      }
    }
  } catch (error) {
    logger.warn('failed to clean up anonymous select permissions', {
      schemaName,
      role: 'anonymous',
      operation: 'select',
    }, error);
  }

  // 2. Create relationships based on foreign keys
  for (const table of tables) {
    try {
      const fks = await getTableForeignKeys(schemaName, table.tableName);
      for (const fk of fks) {
        // Object relationship on source table (many-to-one)
        let relName = fk.fromColumn.replace(/_id$/, '');
        try {
          await hasuraMetadataRequest('pg_create_object_relationship', {
            source: 'default',
            table: { schema: schemaName, name: table.tableName },
            name: relName,
            using: { foreign_key_constraint_on: fk.fromColumn },
          });
          relationships++;
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          // "relationship already exists" → skip; "field with name already exists" → retry with suffix
          if (msg.includes('field with name')) {
            try {
              await hasuraMetadataRequest('pg_create_object_relationship', {
                source: 'default',
                table: { schema: schemaName, name: table.tableName },
                name: `${relName}_rel`,
                using: { foreign_key_constraint_on: fk.fromColumn },
              });
              relationships++;
            } catch { /* ignore */ }
          }
        }

        // Array relationship on target table (one-to-many)
        try {
          await hasuraMetadataRequest('pg_create_array_relationship', {
            source: 'default',
            table: { schema: schemaName, name: fk.toTable },
            name: table.tableName,
            using: { foreign_key_constraint_on: { table: { schema: schemaName, name: table.tableName }, column: fk.fromColumn } },
          });
          relationships++;
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          if (msg.includes('field with name')) {
            try {
              await hasuraMetadataRequest('pg_create_array_relationship', {
                source: 'default',
                table: { schema: schemaName, name: fk.toTable },
                name: `${table.tableName}_by_${fk.fromColumn.replace(/_id$/, '')}`,
                using: { foreign_key_constraint_on: { table: { schema: schemaName, name: table.tableName }, column: fk.fromColumn } },
              });
              relationships++;
            } catch { /* ignore */ }
          }
        }
      }
    } catch { /* ignore FK fetch errors */ }
  }

  // 3. Untrack tables that exist in Hasura but not in PostgreSQL
  const existingTableNames = new Set(tables.map(t => t.tableName));
  let untracked = 0;
  try {
    // Drop inconsistent metadata first (stale references block all operations)
    await hasuraMetadataRequest('drop_inconsistent_metadata', {});

    const status = await getHasuraStatus(schemaName);
    const staleNames = Object.keys(status).filter(t => !existingTableNames.has(t));

    if (staleNames.length > 0) {
      // Use replace_metadata to remove stale tables (pg_untrack_table fails when references exist)
      const metadata = await hasuraMetadataRequest('export_metadata', {}) as Record<string, unknown> & {
        sources?: Array<{ tables?: Array<{ table: { schema: string; name: string } }> }>;
      };
      const staleSet = new Set(staleNames);
      const source = metadata.sources?.[0];
      if (source?.tables) {
        // Remove stale tables
        source.tables = source.tables.filter(
          t => t.table.schema !== schemaName || !staleSet.has(t.table.name)
        );
        // Remove relationships pointing to stale tables
        for (const t of source.tables) {
          const tbl = t as Record<string, unknown>;
          if (Array.isArray(tbl.array_relationships)) {
            tbl.array_relationships = (tbl.array_relationships as Array<{ name: string }>).filter(
              r => !staleSet.has(r.name)
            );
          }
        }
        await hasuraMetadataRequest('replace_metadata', {
          allow_inconsistent_metadata: true,
          metadata,
        });
        untracked = staleNames.length;
      }
    }
  } catch { /* ignore */ }

  return { tracked, failed, relationships, untracked };
}

// Get Hasura permission status for all tables in schema
export async function getHasuraStatus(schemaName: string): Promise<Record<string, { tracked: boolean; roles: string[] }>> {
  const metadata = await hasuraMetadataRequest('export_metadata', {}) as {
    sources?: Array<{ tables?: Array<{ table: { schema: string; name: string }; select_permissions?: Array<{ role: string }> }> }>;
  };

  const result: Record<string, { tracked: boolean; roles: string[] }> = {};
  const source = metadata.sources?.[0];
  if (!source?.tables) return result;

  for (const t of source.tables) {
    if (t.table.schema === schemaName) {
      result[t.table.name] = {
        tracked: true,
        roles: t.select_permissions?.map(p => p.role) ?? [],
      };
    }
  }

  return result;
}
