import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { pool } from '../../apps/api/src/db/index.js';
import * as tenantService from '../../apps/api/src/modules/tenant/tenant.service.js';
import * as projectService from '../../apps/api/src/modules/project/project.service.js';

describe('ProjectQuery Integration', () => {
  let testUserId: number;
  let testTenantId: string;
  let testProjectId: string;
  let testSchemaName: string;

  beforeAll(async () => {
    // 清理可能残留的测试数据
    await pool.query('DELETE FROM druvia_tenants WHERE alias = $1', ['querytenant']);
    await pool.query('DELETE FROM druvia_users WHERE user_id = $1', ['user_query_test']);

    // 创建测试用户
    const userResult = await pool.query(
      `INSERT INTO druvia_users (user_id, email, username, status)
       VALUES ('user_query_test', 'query-test@test.com', 'query_tester', 'active')
       RETURNING id`
    );
    testUserId = userResult.rows[0].id;

    // 创建测试租户
    const tenant = await tenantService.createTenant({
      alias: 'querytenant',
      name: 'Query Test Tenant',
      ownerUid: testUserId,
    });
    testTenantId = tenant.tenantId;

    // 创建测试项目
    const project = await projectService.createProject({
      tenantId: testTenantId,
      alias: 'queryproj',
      name: 'Query Test Project',
    });
    testProjectId = project.projectId;
    testSchemaName = project.schemaName!;

    // 在项目 schema 中创建测试表
    await pool.query(`CREATE TABLE IF NOT EXISTS ${testSchemaName}.test_items (
      id SERIAL PRIMARY KEY,
      name VARCHAR(100) NOT NULL,
      created_at TIMESTAMP DEFAULT NOW()
    )`);
  });

  beforeEach(async () => {
    // 每个测试前清空并重新插入数据
    await pool.query(`TRUNCATE ${testSchemaName}.test_items RESTART IDENTITY`);
    await pool.query(`INSERT INTO ${testSchemaName}.test_items (name) VALUES ('Item 1'), ('Item 2')`);
  });

  afterAll(async () => {
    // 清理测试数据
    await pool.query('DELETE FROM druvia_projects WHERE tenant_id = $1', [testTenantId]);
    await pool.query('DELETE FROM druvia_schema_registry WHERE tenant_id = $1', [testTenantId]);
    await pool.query('DELETE FROM druvia_tenants WHERE tenant_id = $1', [testTenantId]);
    await pool.query('DELETE FROM druvia_users WHERE user_id = $1', ['user_query_test']);
  });

  describe('executeQuery', () => {
    it('should execute SELECT query and return results', async () => {
      const result = await projectService.executeQuery(
        testProjectId,
        'SELECT * FROM test_items ORDER BY id'
      );

      expect(result).toBeDefined();
      expect(result.rows.length).toBe(2);
      expect(result.columns.length).toBeGreaterThan(0);
      expect(result.rowCount).toBe(2);
      expect(result.rows[0]).toHaveProperty('name', 'Item 1');
    });

    it('should execute SELECT with WHERE clause', async () => {
      const result = await projectService.executeQuery(
        testProjectId,
        "SELECT * FROM test_items WHERE name = 'Item 1'"
      );

      expect(result.rows.length).toBe(1);
      expect(result.rows[0]).toHaveProperty('name', 'Item 1');
    });

    it('should reject non-SELECT queries', async () => {
      await expect(
        projectService.executeQuery(testProjectId, 'DELETE FROM test_items')
      ).rejects.toThrow('Only SELECT queries are allowed');

      await expect(
        projectService.executeQuery(testProjectId, 'INSERT INTO test_items (name) VALUES (\'x\')')
      ).rejects.toThrow('Only SELECT queries are allowed');

      await expect(
        projectService.executeQuery(testProjectId, 'UPDATE test_items SET name = \'x\'')
      ).rejects.toThrow('Only SELECT queries are allowed');
    });

    it('should throw error for non-existent project', async () => {
      await expect(
        projectService.executeQuery('proj_nonexistent', 'SELECT 1')
      ).rejects.toThrow('Project not found');
    });

    it('should handle SQL syntax errors', async () => {
      await expect(
        projectService.executeQuery(testProjectId, 'SELECT * FORM test_items')
      ).rejects.toThrow();
    });
  });
});
