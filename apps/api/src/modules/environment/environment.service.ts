// apps/api/src/modules/environment/environment.service.ts
import { pool } from '../../db/index.js';
import { trackTableInHasura } from '../table/table.service.js';
import { hasuraMetadataRequest } from '../realtime/realtime.service.js';
import format from 'pg-format';

export interface ProjectEnvironment {
  id: number;
  projectId: string;
  envName: string;
  schemaName: string;
  createdAt: Date;
}

export function resolveSchemaName(baseSchema: string, env?: string): string {
  if (!env || env === 'prod') {
    return baseSchema;
  }
  return `${baseSchema}_${env}`;
}

export async function listEnvironments(projectId: string): Promise<ProjectEnvironment[]> {
  const result = await pool.query(
    `SELECT id, project_id, env_name, schema_name, created_at
     FROM druvia_project_environments
     WHERE project_id = $1
     ORDER BY env_name`,
    [projectId]
  );

  return result.rows.map(row => ({
    id: row.id,
    projectId: row.project_id,
    envName: row.env_name,
    schemaName: row.schema_name,
    createdAt: row.created_at,
  }));
}

export async function createEnvironment(
  projectId: string,
  envName: string,
  cloneData: boolean = false
): Promise<ProjectEnvironment> {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // Get base schema
    const projectResult = await client.query(
      'SELECT schema_name FROM druvia_projects WHERE project_id = $1',
      [projectId]
    );

    if (projectResult.rows.length === 0) {
      throw new Error('Project not found');
    }

    const baseSchema = projectResult.rows[0].schema_name;
    const newSchema = resolveSchemaName(baseSchema, envName);

    // Clone schema structure (use pg-format for safe identifier interpolation)
    await client.query(format('CREATE SCHEMA IF NOT EXISTS %I', newSchema));

    // Get all tables from base schema
    const tablesResult = await client.query(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = $1 AND table_type = 'BASE TABLE'`,
      [baseSchema]
    );

    // Clone each table (excluding foreign keys to avoid cross-schema references)
    const clonedTables: string[] = [];
    for (const row of tablesResult.rows) {
      const tableName = row.table_name;
      if (cloneData) {
        // CREATE TABLE AS SELECT copies data but not constraints
        await client.query(
          format(
            'CREATE TABLE %I.%I AS SELECT * FROM %I.%I',
            newSchema, tableName, baseSchema, tableName
          )
        );
      } else {
        // Use INCLUDING ALL EXCLUDING CONSTRAINTS to avoid copying foreign keys
        // that reference the base schema, then recreate non-FK constraints
        await client.query(
          format(
            'CREATE TABLE %I.%I (LIKE %I.%I INCLUDING DEFAULTS INCLUDING INDEXES INCLUDING STORAGE INCLUDING COMMENTS)',
            newSchema, tableName, baseSchema, tableName
          )
        );
      }
      clonedTables.push(tableName);
    }

    // When cloneData=true, we need to recreate primary keys and unique constraints
    // before adding foreign keys (FK requires referenced column to have unique constraint)
    if (cloneData) {
      for (const tableName of clonedTables) {
        // Get primary key constraints
        const pkResult = await client.query(
          `SELECT kcu.column_name
           FROM information_schema.table_constraints tc
           JOIN information_schema.key_column_usage kcu
             ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
           WHERE tc.constraint_type = 'PRIMARY KEY'
             AND tc.table_schema = $1
             AND tc.table_name = $2
           ORDER BY kcu.ordinal_position`,
          [baseSchema, tableName]
        );

        if (pkResult.rows.length > 0) {
          const pkColumns = pkResult.rows.map(r => r.column_name);
          const pkColumnsSql = pkColumns.map(c => format('%I', c)).join(', ');
          await client.query(
            format('ALTER TABLE %I.%I ADD PRIMARY KEY (' + pkColumnsSql + ')', newSchema, tableName)
          );
        }

        // Get unique constraints (excluding primary key)
        const uniqueResult = await client.query(
          `SELECT tc.constraint_name, kcu.column_name, kcu.ordinal_position
           FROM information_schema.table_constraints tc
           JOIN information_schema.key_column_usage kcu
             ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
           WHERE tc.constraint_type = 'UNIQUE'
             AND tc.table_schema = $1
             AND tc.table_name = $2
           ORDER BY tc.constraint_name, kcu.ordinal_position`,
          [baseSchema, tableName]
        );

        // Group columns by constraint name
        const uniqueConstraints = new Map<string, string[]>();
        for (const row of uniqueResult.rows) {
          const cols = uniqueConstraints.get(row.constraint_name) || [];
          cols.push(row.column_name);
          uniqueConstraints.set(row.constraint_name, cols);
        }

        for (const [constraintName, columns] of uniqueConstraints) {
          const uqColumnsSql = columns.map((c: string) => format('%I', c)).join(', ');
          await client.query(
            format('ALTER TABLE %I.%I ADD CONSTRAINT %I UNIQUE (' + uqColumnsSql + ')',
              newSchema, tableName, `${constraintName}_clone`)
          );
        }
      }
    }

    // Recreate foreign keys with corrected schema references
    for (const tableName of clonedTables) {
      const fkResult = await client.query(
        `SELECT
           tc.constraint_name,
           kcu.column_name,
           ccu.table_name AS foreign_table_name,
           ccu.column_name AS foreign_column_name
         FROM information_schema.table_constraints AS tc
         JOIN information_schema.key_column_usage AS kcu
           ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
         JOIN information_schema.constraint_column_usage AS ccu
           ON ccu.constraint_name = tc.constraint_name AND ccu.table_schema = tc.table_schema
         WHERE tc.constraint_type = 'FOREIGN KEY'
           AND tc.table_schema = $1
           AND tc.table_name = $2`,
        [baseSchema, tableName]
      );

      for (const fk of fkResult.rows) {
        // Only recreate FK if the referenced table exists in the new schema
        if (clonedTables.includes(fk.foreign_table_name)) {
          await client.query(
            format(
              'ALTER TABLE %I.%I ADD CONSTRAINT %I FOREIGN KEY (%I) REFERENCES %I.%I(%I)',
              newSchema, tableName, `${fk.constraint_name}_clone`,
              fk.column_name, newSchema, fk.foreign_table_name, fk.foreign_column_name
            )
          );
        }
      }
    }

    // Insert environment record
    const result = await client.query(
      `INSERT INTO druvia_project_environments (project_id, env_name, schema_name)
       VALUES ($1, $2, $3)
       RETURNING id, project_id, env_name, schema_name, created_at`,
      [projectId, envName, newSchema]
    );

    // Grant permissions to project's database user if exists
    const dbUserResult = await client.query(
      'SELECT db_user FROM druvia_projects WHERE project_id = $1 AND db_user IS NOT NULL',
      [projectId]
    );

    if (dbUserResult.rows.length > 0 && dbUserResult.rows[0].db_user) {
      const dbUser = dbUserResult.rows[0].db_user;

      // Grant schema usage and create
      await client.query(
        format('GRANT USAGE, CREATE ON SCHEMA %I TO %I', newSchema, dbUser)
      );

      // Grant table permissions
      await client.query(
        format('GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA %I TO %I', newSchema, dbUser)
      );

      // Grant sequence permissions
      await client.query(
        format('GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA %I TO %I', newSchema, dbUser)
      );

      // Grant function permissions
      await client.query(
        format('GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA %I TO %I', newSchema, dbUser)
      );

      // Set default privileges for future objects
      await client.query(
        format('ALTER DEFAULT PRIVILEGES IN SCHEMA %I GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO %I', newSchema, dbUser)
      );

      await client.query(
        format('ALTER DEFAULT PRIVILEGES IN SCHEMA %I GRANT USAGE, SELECT ON SEQUENCES TO %I', newSchema, dbUser)
      );

      await client.query(
        format('ALTER DEFAULT PRIVILEGES IN SCHEMA %I GRANT EXECUTE ON FUNCTIONS TO %I', newSchema, dbUser)
      );
    }

    await client.query('COMMIT');

    // Track cloned tables in Hasura for GraphQL access (outside transaction)
    for (const tableName of clonedTables) {
      await trackTableInHasura(newSchema, tableName);
    }

    return {
      id: result.rows[0].id,
      projectId: result.rows[0].project_id,
      envName: result.rows[0].env_name,
      schemaName: result.rows[0].schema_name,
      createdAt: result.rows[0].created_at,
    };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function deleteEnvironment(projectId: string, envName: string): Promise<boolean> {
  if (envName === 'prod') {
    throw new Error('Cannot delete production environment');
  }

  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // Get schema name
    const envResult = await client.query(
      `SELECT schema_name FROM druvia_project_environments
       WHERE project_id = $1 AND env_name = $2`,
      [projectId, envName]
    );

    if (envResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return false;
    }

    const schemaName = envResult.rows[0].schema_name;

    // Untrack all tables from Hasura before dropping schema
    await untrackSchemaTablesFromHasura(schemaName);

    // Drop schema (use pg-format for safe identifier interpolation)
    await client.query(format('DROP SCHEMA IF EXISTS %I CASCADE', schemaName));

    // Delete record
    await client.query(
      `DELETE FROM druvia_project_environments WHERE project_id = $1 AND env_name = $2`,
      [projectId, envName]
    );

    await client.query('COMMIT');
    return true;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

// 从 Hasura 中 untrack Schema 的所有表
async function untrackSchemaTablesFromHasura(schemaName: string): Promise<void> {
  try {
    // 获取 Schema 中的所有表
    const tablesResult = await pool.query(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = $1 AND table_type = 'BASE TABLE'
       AND table_name NOT LIKE '_meta_%'`,
      [schemaName]
    );

    // Untrack 每个表
    for (const row of tablesResult.rows) {
      try {
        await hasuraMetadataRequest('pg_untrack_table', {
          source: 'default',
          table: { schema: schemaName, name: row.table_name },
          cascade: true,
        });
      } catch (error) {
        // 忽略表未被追踪的错误
        const errorMsg = error instanceof Error ? error.message : String(error);
        if (!errorMsg.includes('not tracked') && !errorMsg.includes('does not exist')) {
          console.warn(`Failed to untrack table ${schemaName}.${row.table_name}:`, errorMsg);
        }
      }
    }
  } catch (error) {
    console.warn(`Failed to untrack tables from schema ${schemaName}:`, error);
  }
}
