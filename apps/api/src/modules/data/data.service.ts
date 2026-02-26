import { pool, query, queryOne } from '../../db/index.js';

// Filter operator types
export type FilterOperator =
  | 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte'
  | 'like' | 'ilike' | 'is_null' | 'is_not_null';

export interface Filter {
  column: string;
  operator: FilterOperator;
  value?: unknown;
}

export interface ListRowsOptions {
  limit?: number;
  offset?: number;
  orderBy?: string;
  orderDir?: 'asc' | 'desc';
  filters?: Filter[];
}

export interface ColumnInfo {
  name: string;
  type: string;
}

export interface ListRowsResult {
  rows: Record<string, unknown>[];
  total: number;
  columns: ColumnInfo[];
}

// Validate identifier (schema/table/column names) - prevent SQL injection
const IDENTIFIER_REGEX = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

export function validateIdentifier(name: string, type: string): void {
  if (!name || !IDENTIFIER_REGEX.test(name)) {
    throw new Error(`Invalid ${type} name: ${name}. Only alphanumeric characters and underscores allowed.`);
  }
}

// Get primary key columns for a table
export async function getPrimaryKeyColumns(
  schemaName: string,
  tableName: string
): Promise<string[]> {
  const result = await query<{ column_name: string }>(
    `SELECT a.attname as column_name
     FROM pg_index i
     JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
     WHERE i.indrelid = $1::regclass AND i.indisprimary
     ORDER BY array_position(i.indkey, a.attnum)`,
    [`"${schemaName}"."${tableName}"`]
  );
  return result.map(r => r.column_name);
}

// Get column info for a table
export async function getColumnInfo(
  schemaName: string,
  tableName: string
): Promise<ColumnInfo[]> {
  const columns = await query<{ column_name: string; data_type: string }>(
    `SELECT column_name, data_type
     FROM information_schema.columns
     WHERE table_schema = $1 AND table_name = $2
     ORDER BY ordinal_position`,
    [schemaName, tableName]
  );
  return columns.map(c => ({ name: c.column_name, type: c.data_type }));
}

// Build WHERE clause from filters
function buildWhereClause(
  filters: Filter[],
  startParamIndex: number
): { clause: string; params: unknown[] } {
  if (!filters || filters.length === 0) {
    return { clause: '', params: [] };
  }

  const conditions: string[] = [];
  const params: unknown[] = [];
  let paramIndex = startParamIndex;

  for (const filter of filters) {
    validateIdentifier(filter.column, 'column');
    const col = `"${filter.column}"`;

    switch (filter.operator) {
      case 'eq':
        conditions.push(`${col} = $${paramIndex++}`);
        params.push(filter.value);
        break;
      case 'neq':
        conditions.push(`${col} != $${paramIndex++}`);
        params.push(filter.value);
        break;
      case 'gt':
        conditions.push(`${col} > $${paramIndex++}`);
        params.push(filter.value);
        break;
      case 'gte':
        conditions.push(`${col} >= $${paramIndex++}`);
        params.push(filter.value);
        break;
      case 'lt':
        conditions.push(`${col} < $${paramIndex++}`);
        params.push(filter.value);
        break;
      case 'lte':
        conditions.push(`${col} <= $${paramIndex++}`);
        params.push(filter.value);
        break;
      case 'like':
        conditions.push(`${col} LIKE $${paramIndex++}`);
        params.push(filter.value);
        break;
      case 'ilike':
        conditions.push(`${col} ILIKE $${paramIndex++}`);
        params.push(filter.value);
        break;
      case 'is_null':
        conditions.push(`${col} IS NULL`);
        break;
      case 'is_not_null':
        conditions.push(`${col} IS NOT NULL`);
        break;
      default:
        throw new Error(`Unknown filter operator: ${filter.operator}`);
    }
  }

  return {
    clause: conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '',
    params,
  };
}

// List rows with pagination, sorting, and filtering
export async function listRows(
  schemaName: string,
  tableName: string,
  options: ListRowsOptions = {}
): Promise<ListRowsResult> {
  validateIdentifier(schemaName, 'schema');
  validateIdentifier(tableName, 'table');

  const { limit = 50, offset = 0, orderBy, orderDir = 'asc', filters } = options;

  // Get column info
  const columns = await getColumnInfo(schemaName, tableName);
  if (columns.length === 0) {
    throw new Error(`Table ${schemaName}.${tableName} not found`);
  }

  // Build WHERE clause
  const { clause: whereClause, params: whereParams } = buildWhereClause(filters || [], 1);

  // Build ORDER BY clause
  let orderClause = '';
  if (orderBy) {
    validateIdentifier(orderBy, 'column');
    const dir = orderDir.toLowerCase() === 'desc' ? 'DESC' : 'ASC';
    orderClause = `ORDER BY "${orderBy}" ${dir}`;
  }

  // Get total count
  const countSql = `SELECT COUNT(*) as count FROM "${schemaName}"."${tableName}" ${whereClause}`;
  const countResult = await queryOne<{ count: string }>(countSql, whereParams);
  const total = parseInt(countResult?.count || '0', 10);

  // Get rows
  const nextParamIndex = whereParams.length + 1;
  const rowsSql = `
    SELECT * FROM "${schemaName}"."${tableName}"
    ${whereClause}
    ${orderClause}
    LIMIT $${nextParamIndex} OFFSET $${nextParamIndex + 1}
  `;
  const rows = await query<Record<string, unknown>>(rowsSql, [...whereParams, limit, offset]);

  return { rows, total, columns };
}

// Insert a new row
export async function insertRow(
  schemaName: string,
  tableName: string,
  data: Record<string, unknown>
): Promise<Record<string, unknown>> {
  validateIdentifier(schemaName, 'schema');
  validateIdentifier(tableName, 'table');

  const keys = Object.keys(data);
  if (keys.length === 0) {
    throw new Error('No data provided for insert');
  }

  // Validate column names
  keys.forEach(k => validateIdentifier(k, 'column'));

  const columns = keys.map(k => `"${k}"`).join(', ');
  const placeholders = keys.map((_, i) => `$${i + 1}`).join(', ');
  const values = keys.map(k => data[k]);

  const sql = `
    INSERT INTO "${schemaName}"."${tableName}" (${columns})
    VALUES (${placeholders})
    RETURNING *
  `;

  const result = await queryOne<Record<string, unknown>>(sql, values);
  if (!result) {
    throw new Error('Insert failed');
  }
  return result;
}

// Update a row by primary key
export async function updateRow(
  schemaName: string,
  tableName: string,
  primaryKey: Record<string, unknown>,
  data: Record<string, unknown>
): Promise<Record<string, unknown>> {
  validateIdentifier(schemaName, 'schema');
  validateIdentifier(tableName, 'table');

  const pkKeys = Object.keys(primaryKey);
  const dataKeys = Object.keys(data);

  if (pkKeys.length === 0) {
    throw new Error('Primary key is required for update');
  }
  if (dataKeys.length === 0) {
    throw new Error('No data provided for update');
  }

  // Validate all identifiers
  pkKeys.forEach(k => validateIdentifier(k, 'column'));
  dataKeys.forEach(k => validateIdentifier(k, 'column'));

  // Build SET clause
  let paramIndex = 1;
  const setClauses = dataKeys.map(k => `"${k}" = $${paramIndex++}`);
  const setValues = dataKeys.map(k => data[k]);

  // Build WHERE clause for primary key
  const whereClauses = pkKeys.map(k => `"${k}" = $${paramIndex++}`);
  const whereValues = pkKeys.map(k => primaryKey[k]);

  const sql = `
    UPDATE "${schemaName}"."${tableName}"
    SET ${setClauses.join(', ')}
    WHERE ${whereClauses.join(' AND ')}
    RETURNING *
  `;

  const result = await queryOne<Record<string, unknown>>(sql, [...setValues, ...whereValues]);
  if (!result) {
    throw new Error('Row not found or update failed');
  }
  return result;
}

// Delete a row by primary key
export async function deleteRow(
  schemaName: string,
  tableName: string,
  primaryKey: Record<string, unknown>
): Promise<boolean> {
  validateIdentifier(schemaName, 'schema');
  validateIdentifier(tableName, 'table');

  const pkKeys = Object.keys(primaryKey);
  if (pkKeys.length === 0) {
    throw new Error('Primary key is required for delete');
  }

  // Validate identifiers
  pkKeys.forEach(k => validateIdentifier(k, 'column'));

  // Build WHERE clause
  const whereClauses = pkKeys.map((k, i) => `"${k}" = $${i + 1}`);
  const whereValues = pkKeys.map(k => primaryKey[k]);

  const sql = `
    DELETE FROM "${schemaName}"."${tableName}"
    WHERE ${whereClauses.join(' AND ')}
  `;

  const result = await pool.query(sql, whereValues);
  return (result.rowCount || 0) > 0;
}

// Batch delete rows by primary keys
export async function deleteRows(
  schemaName: string,
  tableName: string,
  primaryKeys: Array<Record<string, unknown>>
): Promise<number> {
  validateIdentifier(schemaName, 'schema');
  validateIdentifier(tableName, 'table');

  if (!primaryKeys || primaryKeys.length === 0) {
    return 0;
  }

  const client = await pool.connect();
  let deletedCount = 0;

  try {
    await client.query('BEGIN');

    for (const pk of primaryKeys) {
      const pkKeys = Object.keys(pk);
      if (pkKeys.length === 0) continue;

      pkKeys.forEach(k => validateIdentifier(k, 'column'));

      const whereClauses = pkKeys.map((k, i) => `"${k}" = $${i + 1}`);
      const whereValues = pkKeys.map(k => pk[k]);

      const sql = `DELETE FROM "${schemaName}"."${tableName}" WHERE ${whereClauses.join(' AND ')}`;
      const result = await client.query(sql, whereValues);
      deletedCount += result.rowCount || 0;
    }

    await client.query('COMMIT');
    return deletedCount;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

// Export data as stream generator
export async function* exportRows(
  schemaName: string,
  tableName: string,
  format: 'csv' | 'json',
  filters?: Filter[]
): AsyncGenerator<string> {
  validateIdentifier(schemaName, 'schema');
  validateIdentifier(tableName, 'table');

  // Get columns for CSV header
  const columns = await getColumnInfo(schemaName, tableName);
  if (columns.length === 0) {
    throw new Error(`Table ${schemaName}.${tableName} not found`);
  }

  // Build WHERE clause
  const { clause: whereClause, params: whereParams } = buildWhereClause(filters || [], 1);

  const sql = `SELECT * FROM "${schemaName}"."${tableName}" ${whereClause}`;

  const client = await pool.connect();
  try {
    const cursor = client.query(new (await import('pg')).default.Query(sql, whereParams));

    if (format === 'csv') {
      // CSV header
      yield columns.map(c => escapeCSV(c.name)).join(',') + '\n';

      // Use streaming query
      const result = await client.query(sql, whereParams);
      for (const row of result.rows) {
        yield columns.map(c => escapeCSV(String(row[c.name] ?? ''))).join(',') + '\n';
      }
    } else {
      // JSON format - array of objects
      yield '[\n';
      const result = await client.query(sql, whereParams);
      for (let i = 0; i < result.rows.length; i++) {
        const row = result.rows[i];
        yield (i > 0 ? ',\n' : '') + JSON.stringify(row);
      }
      yield '\n]';
    }
  } finally {
    client.release();
  }
}

// Helper to escape CSV values
function escapeCSV(value: string): string {
  if (value.includes(',') || value.includes('"') || value.includes('\n')) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}
