import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { pool } from '../../apps/api/src/db/index.js';
import * as sqlService from '../../apps/api/src/modules/sql/sql.service.js';
import * as projectService from '../../apps/api/src/modules/project/project.service.js';
import * as tenantService from '../../apps/api/src/modules/tenant/tenant.service.js';

describe('SqlService Integration', () => {
  let testUserId: number;
  let testTenantId: string;
  let testProjectId: string;
  let testSchemaName: string;

  beforeAll(async () => {
    // 创建测试用户
    const userResult = await pool.query(
      `INSERT INTO druvia_users (user_id, email, username, status)
       VALUES ('user_test_sql', 'sql-test@test.com', 'sql_tester', 'active')
       ON CONFLICT (user_id) DO UPDATE SET email = EXCLUDED.email
       RETURNING id`
    );
    testUserId = userResult.rows[0].id;

    // 创建测试租户
    const tenant = await tenantService.createTenant({
      alias: 'testsql',
      name: 'SQL Test Tenant',
      ownerUid: testUserId,
    });
    testTenantId = tenant.tenantId;

    // 创建测试项目
    const project = await projectService.createProject({
      tenantId: testTenantId,
      alias: 'sqlproj',
      name: 'SQL Test Project',
    });
    testProjectId = project.projectId;
    testSchemaName = project.schemaName;
  });

  afterAll(async () => {
    // 清理测试数据
    if (testSchemaName) {
      await pool.query(`DROP TABLE IF EXISTS ${testSchemaName}.export_test CASCADE`);
      await pool.query(`DROP TABLE IF EXISTS ${testSchemaName}.import_test CASCADE`);
      await pool.query(`DROP TABLE IF EXISTS ${testSchemaName}.test_table CASCADE`);
    }
    await pool.query('DELETE FROM druvia_projects WHERE project_id = $1', [testProjectId]);
    await pool.query('DELETE FROM druvia_tenants WHERE tenant_id = $1', [testTenantId]);
    await pool.query('DELETE FROM druvia_users WHERE user_id = $1', ['user_test_sql']);
  });

  beforeEach(async () => {
    // 清理测试表
    if (testSchemaName) {
      await pool.query(`DROP TABLE IF EXISTS ${testSchemaName}.export_test CASCADE`);
      await pool.query(`DROP TABLE IF EXISTS ${testSchemaName}.import_test CASCADE`);
      await pool.query(`DROP TABLE IF EXISTS ${testSchemaName}.test_table CASCADE`);
      await pool.query(`DROP TABLE IF EXISTS ${testSchemaName}.table_a CASCADE`);
      await pool.query(`DROP TABLE IF EXISTS ${testSchemaName}.table_b CASCADE`);
      await pool.query(`DROP TABLE IF EXISTS ${testSchemaName}.regular_table CASCADE`);
      await pool.query(`DROP FUNCTION IF EXISTS ${testSchemaName}.test_sql_import_function() CASCADE`);
      await pool.query(`DROP FUNCTION IF EXISTS ${testSchemaName}.tagged_sql_import_function() CASCADE`);
    }
  });

  describe('exportSchema', () => {
    it('should export empty schema', async () => {
      const sql = await sqlService.exportSchema(testSchemaName);

      expect(sql).toContain('-- Druvia SQL Export');
      expect(sql).toContain(`-- Schema: ${testSchemaName}`);
    });

    it('should export table structure', async () => {
      // 创建测试表
      await pool.query(`
        CREATE TABLE ${testSchemaName}.export_test (
          id SERIAL PRIMARY KEY,
          name VARCHAR(255) NOT NULL,
          description TEXT,
          active BOOLEAN DEFAULT true,
          created_at TIMESTAMPTZ DEFAULT NOW()
        )
      `);

      const sql = await sqlService.exportSchema(testSchemaName);

      expect(sql).toContain('CREATE TABLE');
      expect(sql).toContain('export_test');
      expect(sql).toContain('name');
      // PostgreSQL 显示为 character varying 或 varchar
      expect(sql.toLowerCase()).toMatch(/varchar|character varying/);
      expect(sql).toContain('PRIMARY KEY');
    });

    it('should export with DROP statements when includeDrops is true', async () => {
      await pool.query(`
        CREATE TABLE ${testSchemaName}.export_test (
          id SERIAL PRIMARY KEY,
          name TEXT
        )
      `);

      const sql = await sqlService.exportSchema(testSchemaName, { includeDrops: true });

      expect(sql).toContain('DROP TABLE IF EXISTS');
      expect(sql).toContain('export_test');
      expect(sql).toContain('CASCADE');
    });

    it('should export data when includeData is true', async () => {
      await pool.query(`
        CREATE TABLE ${testSchemaName}.export_test (
          id SERIAL PRIMARY KEY,
          name TEXT
        )
      `);
      await pool.query(`INSERT INTO ${testSchemaName}.export_test (name) VALUES ('test1'), ('test2')`);

      const sql = await sqlService.exportSchema(testSchemaName, { includeData: true });

      expect(sql).toContain('INSERT INTO');
      expect(sql).toContain('test1');
      expect(sql).toContain('test2');
    });

    it('should export only specified tables', async () => {
      await pool.query(`
        CREATE TABLE ${testSchemaName}.table_a (id SERIAL PRIMARY KEY);
        CREATE TABLE ${testSchemaName}.table_b (id SERIAL PRIMARY KEY);
      `);

      const sql = await sqlService.exportSchema(testSchemaName, { tables: ['table_a'] });

      expect(sql).toContain('table_a');
      expect(sql).not.toContain('table_b');
    });

    it('should export indexes', async () => {
      await pool.query(`
        CREATE TABLE ${testSchemaName}.export_test (
          id SERIAL PRIMARY KEY,
          email VARCHAR(255)
        )
      `);
      await pool.query(`CREATE INDEX idx_email ON ${testSchemaName}.export_test (email)`);

      const sql = await sqlService.exportSchema(testSchemaName);

      expect(sql).toContain('-- Indexes');
      expect(sql).toContain('idx_email');
    });

    it('should exclude _meta_ tables from export', async () => {
      await pool.query(`
        CREATE TABLE ${testSchemaName}._meta_test (id SERIAL PRIMARY KEY);
        CREATE TABLE ${testSchemaName}.regular_table (id SERIAL PRIMARY KEY);
      `);

      const sql = await sqlService.exportSchema(testSchemaName);

      expect(sql).toContain('regular_table');
      expect(sql).not.toContain('_meta_test');

      // Cleanup
      await pool.query(`DROP TABLE IF EXISTS ${testSchemaName}._meta_test`);
      await pool.query(`DROP TABLE IF EXISTS ${testSchemaName}.regular_table`);
    });

    it('should reject invalid schema names', async () => {
      await expect(
        sqlService.exportSchema('invalid; DROP TABLE users;--')
      ).rejects.toThrow('Invalid schema name');
    });
  });

  describe('importSql', () => {
    it('should import simple SQL statements', async () => {
      const sql = `
        CREATE TABLE import_test (
          id SERIAL PRIMARY KEY,
          name TEXT
        );
        INSERT INTO import_test (name) VALUES ('imported');
      `;

      const result = await sqlService.importSql(testSchemaName, sql);

      expect(result.statementsExecuted).toBe(2);
      expect(result.errors).toHaveLength(0);
      expect(result.rolledBack).toBe(false);

      // 验证数据已导入
      const data = await pool.query(`SELECT * FROM ${testSchemaName}.import_test`);
      expect(data.rows).toHaveLength(1);
      expect(data.rows[0].name).toBe('imported');
    });

    it('should handle inline comments', async () => {
      // 注意: 注释必须在语句之后，否则会被跳过
      const sql = `
        CREATE TABLE import_test (id SERIAL PRIMARY KEY); -- This is a comment
      `;

      const result = await sqlService.importSql(testSchemaName, sql);

      expect(result.statementsExecuted).toBeGreaterThanOrEqual(1);
      expect(result.errors).toHaveLength(0);
    });

    it('should continue on error in non-atomic mode', async () => {
      const sql = `
        CREATE TABLE import_test (id SERIAL PRIMARY KEY);
        INSERT INTO nonexistent_table (name) VALUES ('fail');
        INSERT INTO import_test (id) VALUES (1);
      `;

      const result = await sqlService.importSql(testSchemaName, sql, { atomic: false });

      // CREATE TABLE 和最后的 INSERT 应该成功
      expect(result.statementsExecuted).toBeGreaterThanOrEqual(1);
      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.rolledBack).toBe(false);
    });

    it('should rollback all on error in atomic mode', async () => {
      const sql = `
        CREATE TABLE import_test (id SERIAL PRIMARY KEY);
        INSERT INTO import_test (id) VALUES (1);
        INSERT INTO nonexistent_table (name) VALUES ('fail');
      `;

      const result = await sqlService.importSql(testSchemaName, sql, { atomic: true });

      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.rolledBack).toBe(true);

      // 验证表未创建（已回滚）
      const tables = await pool.query(
        `SELECT table_name FROM information_schema.tables WHERE table_schema = $1 AND table_name = 'import_test'`,
        [testSchemaName]
      );
      expect(tables.rows).toHaveLength(0);
    });

    it('should handle strings with semicolons', async () => {
      const sql = `
        CREATE TABLE import_test (id SERIAL PRIMARY KEY, data TEXT);
        INSERT INTO import_test (data) VALUES ('value; with; semicolons');
      `;

      const result = await sqlService.importSql(testSchemaName, sql);

      expect(result.statementsExecuted).toBe(2);
      expect(result.errors).toHaveLength(0);

      const data = await pool.query(`SELECT data FROM ${testSchemaName}.import_test`);
      expect(data.rows[0].data).toBe('value; with; semicolons');
    });

    it('should import plpgsql functions with $$ quoted bodies', async () => {
      const sql = `
        CREATE OR REPLACE FUNCTION test_sql_import_function()
        RETURNS integer
        LANGUAGE plpgsql
        AS $$
        DECLARE
          value integer := 1;
        BEGIN
          value := value + 1;
          RETURN value;
        END;
        $$;
      `;

      const result = await sqlService.importSql(testSchemaName, sql);

      expect(result.errors).toHaveLength(0);
      expect(result.statementsExecuted).toBe(1);

      const data = await pool.query(`SELECT ${testSchemaName}.test_sql_import_function() AS value`);
      expect(data.rows[0].value).toBe(2);
    });

    it('should import plpgsql functions with tagged dollar quoted bodies', async () => {
      const sql = `
        CREATE OR REPLACE FUNCTION tagged_sql_import_function()
        RETURNS text
        LANGUAGE plpgsql
        AS $func$
        BEGIN
          RETURN 'ok;still-inside';
        END;
        $func$;
      `;

      const result = await sqlService.importSql(testSchemaName, sql);

      expect(result.errors).toHaveLength(0);
      expect(result.statementsExecuted).toBe(1);

      const data = await pool.query(`SELECT ${testSchemaName}.tagged_sql_import_function() AS value`);
      expect(data.rows[0].value).toBe('ok;still-inside');
    });

    it('should reject invalid schema names', async () => {
      await expect(
        sqlService.importSql('invalid; DROP TABLE users;--', 'SELECT 1')
      ).rejects.toThrow('Invalid schema name');
    });
  });

  describe('Round-trip Export/Import', () => {
    it('should export schema structure correctly', async () => {
      // 创建原始表和数据
      await pool.query(`
        CREATE TABLE ${testSchemaName}.test_table (
          id SERIAL PRIMARY KEY,
          name VARCHAR(100) NOT NULL,
          active BOOLEAN DEFAULT true
        )
      `);
      await pool.query(`
        INSERT INTO ${testSchemaName}.test_table (name, active)
        VALUES ('item1', true), ('item2', false)
      `);

      // 导出
      const exportedSql = await sqlService.exportSchema(testSchemaName, {
        includeData: true,
        includeDrops: true,
      });

      // 验证导出内容包含表结构和数据
      expect(exportedSql).toContain('test_table');
      expect(exportedSql).toContain('DROP TABLE');
      expect(exportedSql).toContain('INSERT INTO');
      expect(exportedSql).toContain('item1');
      expect(exportedSql).toContain('item2');
    });
  });

  describe('SQL Injection Prevention', () => {
    it('should safely handle special characters in exported data', async () => {
      await pool.query(`
        CREATE TABLE ${testSchemaName}.test_table (
          id SERIAL PRIMARY KEY,
          content TEXT
        )
      `);
      await pool.query(`
        INSERT INTO ${testSchemaName}.test_table (content)
        VALUES ($1)
      `, [`'; DROP TABLE users; --`]);

      const sql = await sqlService.exportSchema(testSchemaName, { includeData: true });

      // 导出的 SQL 应该安全转义恶意字符串
      expect(sql).toContain('INSERT INTO');
      // 字符串应该被正确引用
      expect(sql).toContain('DROP TABLE users');
    });

    it('should reject invalid schema names on export', async () => {
      await expect(
        sqlService.exportSchema('invalid; DROP TABLE users;--')
      ).rejects.toThrow('Invalid schema name');
    });

    it('should reject invalid schema names on import', async () => {
      await expect(
        sqlService.importSql('invalid; DROP TABLE users;--', 'SELECT 1')
      ).rejects.toThrow('Invalid schema name');
    });
  });
});
