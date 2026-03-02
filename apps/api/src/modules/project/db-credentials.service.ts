import { pool, queryOne } from '../../db/index.js';
import bcrypt from 'bcrypt';
import crypto from 'crypto';
import { config } from '../../config/index.js';

const SALT_ROUNDS = 10;

// 生成安全的随机密码
function generatePassword(length = 24): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  const bytes = crypto.randomBytes(length);
  let password = '';
  for (let i = 0; i < length; i++) {
    password += chars[bytes[i] % chars.length];
  }
  return password;
}

// 生成数据库用户名（基于 schema 名称）
function generateDbUsername(schemaName: string): string {
  // 用户名格式: dru_{schema}_user，最大 63 字符
  const base = schemaName.replace(/^dru_/, '');
  return `dru_${base}_user`.substring(0, 63);
}

export interface DbCredentials {
  username: string;
  password: string;
  host: string;
  port: number;
  database: string;
  schemaName: string;
}

// 为项目创建数据库用户
export async function createProjectDbUser(
  projectId: string,
  schemaName: string
): Promise<DbCredentials> {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    await client.query('SET TRANSACTION ISOLATION LEVEL SERIALIZABLE');

    const username = generateDbUsername(schemaName);
    const password = generatePassword();
    const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);

    // 检查角色是否存在
    const roleExists = await client.query(
      'SELECT 1 FROM pg_roles WHERE rolname = $1',
      [username]
    );

    if (roleExists.rows.length === 0) {
      // 使用 format 函数安全创建角色
      const createRoleSql = await client.query(
        `SELECT format('CREATE ROLE %I WITH LOGIN PASSWORD %L', $1::text, $2::text) as sql`,
        [username, password]
      );
      await client.query(createRoleSql.rows[0].sql);
    } else {
      // 更新密码
      const alterRoleSql = await client.query(
        `SELECT format('ALTER ROLE %I WITH PASSWORD %L', $1::text, $2::text) as sql`,
        [username, password]
      );
      await client.query(alterRoleSql.rows[0].sql);
    }

    // 使用 format 函数安全授予权限（最小权限原则）
    const grantUsage = await client.query(
      `SELECT format('GRANT USAGE, CREATE ON SCHEMA %I TO %I', $1::text, $2::text) as sql`,
      [schemaName, username]
    );
    await client.query(grantUsage.rows[0].sql);

    const grantTables = await client.query(
      `SELECT format('GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA %I TO %I', $1::text, $2::text) as sql`,
      [schemaName, username]
    );
    await client.query(grantTables.rows[0].sql);

    const grantSeqs = await client.query(
      `SELECT format('GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA %I TO %I', $1::text, $2::text) as sql`,
      [schemaName, username]
    );
    await client.query(grantSeqs.rows[0].sql);

    const grantFuncs = await client.query(
      `SELECT format('GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA %I TO %I', $1::text, $2::text) as sql`,
      [schemaName, username]
    );
    await client.query(grantFuncs.rows[0].sql);

    // 设置默认权限（最小权限原则）
    const defTables = await client.query(
      `SELECT format('ALTER DEFAULT PRIVILEGES IN SCHEMA %I GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO %I', $1::text, $2::text) as sql`,
      [schemaName, username]
    );
    await client.query(defTables.rows[0].sql);

    const defSeqs = await client.query(
      `SELECT format('ALTER DEFAULT PRIVILEGES IN SCHEMA %I GRANT USAGE, SELECT ON SEQUENCES TO %I', $1::text, $2::text) as sql`,
      [schemaName, username]
    );
    await client.query(defSeqs.rows[0].sql);

    const defFuncs = await client.query(
      `SELECT format('ALTER DEFAULT PRIVILEGES IN SCHEMA %I GRANT EXECUTE ON FUNCTIONS TO %I', $1::text, $2::text) as sql`,
      [schemaName, username]
    );
    await client.query(defFuncs.rows[0].sql);

    // 设置 search_path
    const setPath = await client.query(
      `SELECT format('ALTER ROLE %I SET search_path TO %I', $1::text, $2::text) as sql`,
      [username, schemaName]
    );
    await client.query(setPath.rows[0].sql);

    // 更新项目记录
    await client.query(
      `UPDATE druvia_projects
       SET db_user = $1, db_password_hash = $2, db_created_at = NOW()
       WHERE project_id = $3`,
      [username, passwordHash, projectId]
    );

    await client.query('COMMIT');

    return {
      username,
      password,
      host: config.database.host,
      port: config.database.port,
      database: config.database.database,
      schemaName,
    };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

// 重置项目数据库用户密码
export async function resetProjectDbPassword(projectId: string): Promise<DbCredentials | null> {
  // 获取项目信息
  const project = await queryOne<{
    project_id: string;
    schema_name: string;
    db_user: string;
  }>(
    'SELECT project_id, schema_name, db_user FROM druvia_projects WHERE project_id = $1',
    [projectId]
  );

  if (!project || !project.db_user || !project.schema_name) {
    return null;
  }

  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const password = generatePassword();
    const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);

    // 使用 format 函数安全地更新密码
    const alterSql = await client.query(
      `SELECT format('ALTER ROLE %I WITH PASSWORD %L', $1::text, $2::text) as sql`,
      [project.db_user, password]
    );
    await client.query(alterSql.rows[0].sql);

    // 更新项目记录
    await client.query(
      `UPDATE druvia_projects SET db_password_hash = $1 WHERE project_id = $2`,
      [passwordHash, projectId]
    );

    await client.query('COMMIT');

    return {
      username: project.db_user,
      password,
      host: config.database.host,
      port: config.database.port,
      database: config.database.database,
      schemaName: project.schema_name,
    };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

// 删除项目数据库用户
export async function dropProjectDbUser(projectId: string): Promise<boolean> {
  const project = await queryOne<{ db_user: string; schema_name: string }>(
    'SELECT db_user, schema_name FROM druvia_projects WHERE project_id = $1',
    [projectId]
  );

  if (!project?.db_user) {
    return false;
  }

  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // 先撤销默认权限
    if (project.schema_name) {
      const revokeDefTables = await client.query(
        `SELECT format('ALTER DEFAULT PRIVILEGES IN SCHEMA %I REVOKE ALL ON TABLES FROM %I', $1::text, $2::text) as sql`,
        [project.schema_name, project.db_user]
      );
      await client.query(revokeDefTables.rows[0].sql).catch((err) => {
        console.warn(`Failed to revoke default table privileges: ${err.message}`);
      });

      const revokeDefSeqs = await client.query(
        `SELECT format('ALTER DEFAULT PRIVILEGES IN SCHEMA %I REVOKE ALL ON SEQUENCES FROM %I', $1::text, $2::text) as sql`,
        [project.schema_name, project.db_user]
      );
      await client.query(revokeDefSeqs.rows[0].sql).catch((err) => {
        console.warn(`Failed to revoke default sequence privileges: ${err.message}`);
      });

      const revokeDefFuncs = await client.query(
        `SELECT format('ALTER DEFAULT PRIVILEGES IN SCHEMA %I REVOKE EXECUTE ON FUNCTIONS FROM %I', $1::text, $2::text) as sql`,
        [project.schema_name, project.db_user]
      );
      await client.query(revokeDefFuncs.rows[0].sql).catch((err) => {
        console.warn(`Failed to revoke default function privileges: ${err.message}`);
      });
    }

    // 将该用户拥有的对象转移给 postgres
    const reassignSql = await client.query(
      `SELECT format('REASSIGN OWNED BY %I TO postgres', $1::text) as sql`,
      [project.db_user]
    );
    await client.query(reassignSql.rows[0].sql).catch((err) => {
      console.warn(`Failed to reassign owned objects: ${err.message}`);
    });

    // 删除该用户拥有的权限
    const dropOwnedSql = await client.query(
      `SELECT format('DROP OWNED BY %I', $1::text) as sql`,
      [project.db_user]
    );
    await client.query(dropOwnedSql.rows[0].sql).catch((err) => {
      console.warn(`Failed to drop owned objects: ${err.message}`);
    });

    // 使用 format 函数安全地删除角色
    const dropSql = await client.query(
      `SELECT format('DROP ROLE IF EXISTS %I', $1::text) as sql`,
      [project.db_user]
    );
    await client.query(dropSql.rows[0].sql);

    // 清除项目记录中的凭证信息
    await client.query(
      `UPDATE druvia_projects
       SET db_user = NULL, db_password_hash = NULL, db_created_at = NULL
       WHERE project_id = $1`,
      [projectId]
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

// 获取项目数据库连接信息（不含密码）
export async function getProjectDbInfo(projectId: string): Promise<{
  username: string | null;
  host: string;
  port: number;
  database: string;
  schemaName: string | null;
  hasCredentials: boolean;
  createdAt: Date | null;
} | null> {
  const project = await queryOne<{
    schema_name: string | null;
    db_user: string | null;
    db_created_at: Date | null;
  }>(
    'SELECT schema_name, db_user, db_created_at FROM druvia_projects WHERE project_id = $1',
    [projectId]
  );

  if (!project) {
    return null;
  }

  return {
    username: project.db_user,
    host: config.database.host,
    port: config.database.port,
    database: config.database.database,
    schemaName: project.schema_name,
    hasCredentials: !!project.db_user,
    createdAt: project.db_created_at,
  };
}
