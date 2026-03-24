import { pool, query } from '../../db/index.js';
import format from 'pg-format';

export interface ExportOptions {
  tables?: string[];        // 指定表，为空则导出所有
  includeData?: boolean;    // 是否包含数据
  includeDrops?: boolean;   // 是否包含 DROP 语句
}

export interface ImportResult {
  statementsExecuted: number;
  errors: string[];
  rolledBack: boolean;      // 是否已回滚
}

export interface ImportOptions {
  atomic?: boolean;         // 是否原子导入（任意错误则回滚）
}

function stripLeadingSqlComments(sql: string): string {
  let result = sql.trimStart();

  while (result.length > 0) {
    if (result.startsWith('--')) {
      const newlineIndex = result.search(/[\r\n]/);
      result = newlineIndex === -1 ? '' : result.slice(newlineIndex + 1).trimStart();
      continue;
    }

    if (result.startsWith('/*')) {
      const endIndex = result.indexOf('*/');
      result = endIndex === -1 ? '' : result.slice(endIndex + 2).trimStart();
      continue;
    }

    break;
  }

  return result;
}

// 验证标识符名称（防止 SQL 注入）
function validateIdentifier(name: string): boolean {
  // PostgreSQL 标识符规则：字母或下划线开头，后跟字母、数字、下划线
  return /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name);
}

/**
 * 导出 Schema 为 SQL
 */
export async function exportSchema(
  schemaName: string,
  options: ExportOptions = {}
): Promise<string> {
  // 验证 schema 名称
  if (!validateIdentifier(schemaName)) {
    throw new Error('Invalid schema name');
  }

  const { tables: selectedTables, includeData = false, includeDrops = false } = options;
  const sqlParts: string[] = [];

  // 头部注释
  sqlParts.push(`-- Druvia SQL Export`);
  sqlParts.push(`-- Schema: ${schemaName}`);
  sqlParts.push(`-- Date: ${new Date().toISOString()}`);
  sqlParts.push(`-- Include Data: ${includeData}`);
  sqlParts.push('');

  // 获取所有表（使用参数化查询）
  const tablesResult = await query<{ table_name: string }>(
    `SELECT table_name FROM information_schema.tables
     WHERE table_schema = $1 AND table_type = 'BASE TABLE'
     AND table_name NOT LIKE '_meta_%'
     ORDER BY table_name`,
    [schemaName]
  );

  const tables = selectedTables?.length
    ? tablesResult.filter(t => selectedTables.includes(t.table_name))
    : tablesResult;

  for (const { table_name: tableName } of tables) {
    // 验证表名
    if (!validateIdentifier(tableName)) continue;

    // DROP 语句（使用 pg-format 安全引用）
    if (includeDrops) {
      sqlParts.push(format('DROP TABLE IF EXISTS %I.%I CASCADE;', schemaName, tableName));
    }

    // 获取表结构
    const createTableSql = await getCreateTableStatement(schemaName, tableName);
    sqlParts.push(createTableSql);
    sqlParts.push('');

    // 导出数据
    if (includeData) {
      const dataSql = await getInsertStatements(schemaName, tableName);
      if (dataSql) {
        sqlParts.push(dataSql);
        sqlParts.push('');
      }
    }
  }

  // 导出索引
  const indexesSql = await getIndexStatements(schemaName, tables.map(t => t.table_name));
  if (indexesSql) {
    sqlParts.push('-- Indexes');
    sqlParts.push(indexesSql);
  }

  return sqlParts.join('\n');
}

/**
 * 导入 SQL 文件
 */
export async function importSql(
  schemaName: string,
  sqlContent: string,
  options: ImportOptions = {}
): Promise<ImportResult> {
  // 验证 schema 名称
  if (!validateIdentifier(schemaName)) {
    throw new Error('Invalid schema name');
  }

  const { atomic = false } = options;
  const client = await pool.connect();
  const result: ImportResult = {
    statementsExecuted: 0,
    errors: [],
    rolledBack: false,
  };

  try {
    await client.query('BEGIN');

    // 设置 search_path（使用 pg-format 安全引用）
    await client.query(format('SET search_path TO %I, public', schemaName));

    // 分割 SQL 语句
    const statements = splitSqlStatements(sqlContent);

    for (const stmt of statements) {
      const trimmed = stmt.trim();
      const executable = stripLeadingSqlComments(trimmed);
      if (!executable) continue;
      if (/^(BEGIN|COMMIT|ROLLBACK)\b/i.test(executable)) continue;

      try {
        await client.query(executable);
        result.statementsExecuted++;
      } catch (error) {
        const err = error as Error;
        result.errors.push(`Statement failed: ${executable.substring(0, 50)}... Error: ${err.message}`);

        // 原子模式：任意错误则回滚
        if (atomic) {
          await client.query('ROLLBACK');
          result.rolledBack = true;
          return result;
        }
        // 非原子模式：继续执行后续语句
      }
    }

    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    result.rolledBack = true;
    const err = error as Error;
    result.errors.push(`Transaction failed: ${err.message}`);
  } finally {
    client.release();
  }

  return result;
}

/**
 * 获取 CREATE TABLE 语句
 */
async function getCreateTableStatement(schemaName: string, tableName: string): Promise<string> {
  // 获取列信息（使用参数化查询）
  const columnsResult = await query<{
    column_name: string;
    data_type: string;
    udt_name: string;
    is_nullable: string;
    column_default: string | null;
    character_maximum_length: number | null;
  }>(
    `SELECT column_name, data_type, udt_name, is_nullable, column_default, character_maximum_length
     FROM information_schema.columns
     WHERE table_schema = $1 AND table_name = $2
     ORDER BY ordinal_position`,
    [schemaName, tableName]
  );

  // 获取主键信息
  const pkResult = await query<{ column_name: string }>(
    `SELECT kcu.column_name
     FROM information_schema.table_constraints tc
     JOIN information_schema.key_column_usage kcu
       ON tc.constraint_name = kcu.constraint_name
       AND tc.table_schema = kcu.table_schema
     WHERE tc.constraint_type = 'PRIMARY KEY'
       AND tc.table_schema = $1
       AND tc.table_name = $2`,
    [schemaName, tableName]
  );
  const pkColumns = new Set(pkResult.map(r => r.column_name));

  // 构建 CREATE TABLE（使用 pg-format 安全引用列名）
  const columnDefs = columnsResult.map(col => {
    let typeName = col.udt_name;
    if (col.character_maximum_length) {
      typeName = `${col.data_type}(${col.character_maximum_length})`;
    } else if (col.data_type === 'ARRAY') {
      typeName = `${col.udt_name.replace(/^_/, '')}[]`;
    }

    let def = format('  %I %s', col.column_name, typeName);
    if (col.is_nullable === 'NO') def += ' NOT NULL';
    if (col.column_default) def += ` DEFAULT ${col.column_default}`;
    return def;
  });

  // 添加主键约束
  if (pkColumns.size > 0) {
    const pkCols = Array.from(pkColumns).map(c => format('%I', c)).join(', ');
    columnDefs.push(`  PRIMARY KEY (${pkCols})`);
  }

  return format('CREATE TABLE %I.%I (\n', schemaName, tableName) + columnDefs.join(',\n') + '\n);';
}

/**
 * 获取 INSERT 语句
 */
async function getInsertStatements(schemaName: string, tableName: string): Promise<string> {
  // 使用 pg-format 构建安全的 SELECT 语句
  const selectSql = format('SELECT * FROM %I.%I', schemaName, tableName);
  const result = await query<Record<string, unknown>>(selectSql, []);

  if (result.length === 0) return '';

  const columns = Object.keys(result[0]);
  const insertParts: string[] = [];

  for (const row of result) {
    const values = columns.map(col => formatSqlValue(row[col]));
    const colNames = columns.map(c => format('%I', c)).join(', ');
    insertParts.push(format('INSERT INTO %I.%I (%s) VALUES (%s);', schemaName, tableName, colNames, values.join(', ')));
  }

  return insertParts.join('\n');
}

/**
 * 获取索引语句
 */
async function getIndexStatements(schemaName: string, tableNames: string[]): Promise<string> {
  if (tableNames.length === 0) return '';

  // 使用参数化查询
  const result = await query<{ indexdef: string }>(
    `SELECT indexdef FROM pg_indexes
     WHERE schemaname = $1
     AND tablename = ANY($2)
     AND indexname NOT LIKE '%_pkey'`,
    [schemaName, tableNames]
  );

  return result.map(r => r.indexdef + ';').join('\n');
}

/**
 * 格式化 SQL 值
 */
function formatSqlValue(value: unknown): string {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'number') return String(value);
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
  if (value instanceof Date) return format('%L', value.toISOString());
  if (typeof value === 'object') return format('%L', JSON.stringify(value));
  return format('%L', String(value));
}

/**
 * 分割 SQL 语句
 */
function splitSqlStatements(sql: string): string[] {
  const statements: string[] = [];
  let current = '';
  let inString = false;
  let stringChar = '';
  let dollarQuoteTag: string | null = null;

  for (let i = 0; i < sql.length; i++) {
    const char = sql[i];
    const prevChar = sql[i - 1];

    if (dollarQuoteTag) {
      if (sql.startsWith(dollarQuoteTag, i)) {
        current += dollarQuoteTag;
        i += dollarQuoteTag.length - 1;
        dollarQuoteTag = null;
      } else {
        current += char;
      }
      continue;
    }

    if (!inString && char === '$') {
      const match = sql.slice(i).match(/^(\$\$|\$[A-Za-z_][A-Za-z0-9_]*\$)/);
      if (match) {
        dollarQuoteTag = match[1];
        current += dollarQuoteTag;
        i += dollarQuoteTag.length - 1;
        continue;
      }
    }

    // 处理字符串开始/结束
    if ((char === "'" || char === '"') && prevChar !== '\\') {
      if (!inString) {
        inString = true;
        stringChar = char;
      } else if (char === stringChar) {
        inString = false;
      }
    }

    // 分号结束语句
    if (char === ';' && !inString) {
      statements.push(current.trim());
      current = '';
    } else {
      current += char;
    }
  }

  // 处理最后一条语句
  if (current.trim()) {
    statements.push(current.trim());
  }

  return statements;
}
