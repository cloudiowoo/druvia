import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { pool } from '../../apps/api/src/db/index.js';
import * as realtimeService from '../../apps/api/src/modules/realtime/realtime.service.js';
import * as projectService from '../../apps/api/src/modules/project/project.service.js';
import * as tenantService from '../../apps/api/src/modules/tenant/tenant.service.js';

describe('RealtimeService Integration', () => {
  let testUserId: number;
  let testTenantId: string;
  let testProjectId: string;
  let testSchemaName: string;

  beforeAll(async () => {
    // 创建测试用户
    const userResult = await pool.query(
      `INSERT INTO druvia_users (user_id, email, username, status)
       VALUES ('user_test_realtime', 'realtime-test@test.com', 'realtime_tester', 'active')
       ON CONFLICT (user_id) DO UPDATE SET email = EXCLUDED.email
       RETURNING id`
    );
    testUserId = userResult.rows[0].id;

    // 创建测试租户
    const tenant = await tenantService.createTenant({
      alias: 'testrealtime',
      name: 'Realtime Test Tenant',
      ownerUid: testUserId,
    });
    testTenantId = tenant.tenantId;

    // 创建测试项目
    const project = await projectService.createProject({
      tenantId: testTenantId,
      alias: 'realtimeproj',
      name: 'Realtime Test Project',
    });
    testProjectId = project.projectId;
    testSchemaName = project.schemaName;

    // 在测试 schema 中创建一个测试表
    await pool.query(`
      CREATE TABLE IF NOT EXISTS ${testSchemaName}.test_realtime_table (
        id SERIAL PRIMARY KEY,
        name TEXT,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);

    // Register test table in _meta_tables (required for realtime_enabled tracking)
    await pool.query(`
      INSERT INTO ${testSchemaName}._meta_tables (table_name, description)
      VALUES ('test_realtime_table', 'Test table for realtime')
      ON CONFLICT (table_name) DO NOTHING
    `);
  });

  afterAll(async () => {
    // 清理测试数据
    if (testSchemaName) {
      await pool.query(`DROP TABLE IF EXISTS ${testSchemaName}.test_realtime_table`);
    }
    await pool.query('DELETE FROM druvia_projects WHERE project_id = $1', [testProjectId]);
    await pool.query('DELETE FROM druvia_tenants WHERE tenant_id = $1', [testTenantId]);
    await pool.query('DELETE FROM druvia_users WHERE user_id = $1', ['user_test_realtime']);
  });

  describe('Input Validation', () => {
    it('should reject invalid schema name', async () => {
      await expect(
        realtimeService.getTableSubscriptions('invalid-schema!')
      ).rejects.toThrow('Invalid schema name format');
    });

    it('should reject schema name with SQL injection attempt', async () => {
      await expect(
        realtimeService.getTableSubscriptions("schema'; DROP TABLE users; --")
      ).rejects.toThrow('Invalid schema name format');
    });

    it('should reject invalid table name in generateSubscriptionExample', () => {
      expect(() =>
        realtimeService.generateSubscriptionExample(testSchemaName, 'invalid-table!')
      ).toThrow('Invalid table name format');
    });

    it('should reject table name with SQL injection attempt', () => {
      expect(() =>
        realtimeService.generateSubscriptionExample(testSchemaName, "table'; DROP--")
      ).toThrow('Invalid table name format');
    });

    it('should accept valid schema name format', async () => {
      // 这会调用 Hasura API，如果 Hasura 不可用会失败
      // 但不应该因为验证失败
      try {
        await realtimeService.getTableSubscriptions(testSchemaName);
      } catch (error) {
        // 如果是 Hasura 连接错误，忽略（验证通过了）
        const message = error instanceof Error ? error.message : '';
        if (!message.includes('Invalid schema name')) {
          // 验证通过，Hasura 可能不可用
          expect(true).toBe(true);
        } else {
          throw error;
        }
      }
    });
  });

  describe('getTablesInSchema', () => {
    it('should return tables in the test schema', async () => {
      const tables = await realtimeService.getTablesInSchema(testSchemaName);

      expect(Array.isArray(tables)).toBe(true);
      const tableNames = tables.map(t => t.tableName);
      expect(tableNames).toContain('test_realtime_table');
    });

    it('should return empty array for non-existent schema', async () => {
      const tables = await realtimeService.getTablesInSchema('nonexistent_schema_xyz');
      expect(tables).toEqual([]);
    });

    it('should include schemaName in returned objects', async () => {
      const tables = await realtimeService.getTablesInSchema(testSchemaName);

      for (const table of tables) {
        expect(table.schemaName).toBe(testSchemaName);
      }
    });
  });

  describe('getRealtimeConfig', () => {
    it('should return correct config structure', () => {
      const config = realtimeService.getRealtimeConfig(testSchemaName);

      expect(config).toHaveProperty('schemaName', testSchemaName);
      expect(config).toHaveProperty('websocketEndpoint');
      expect(config).toHaveProperty('graphqlEndpoint');
    });

    it('should generate correct websocket protocol for http', () => {
      const config = realtimeService.getRealtimeConfig(testSchemaName);

      // 本地测试环境使用 http
      expect(config.websocketEndpoint).toMatch(/^wss?:\/\//);
    });

    it('should include /v1/graphql path', () => {
      const config = realtimeService.getRealtimeConfig(testSchemaName);

      expect(config.websocketEndpoint).toContain('/v1/graphql');
      expect(config.graphqlEndpoint).toContain('/v1/graphql');
    });
  });

  describe('generateSubscriptionExample', () => {
    it('should generate GraphQL and JavaScript examples', () => {
      const examples = realtimeService.generateSubscriptionExample(
        testSchemaName,
        'test_realtime_table'
      );

      expect(examples).toHaveLength(2);

      const graphqlExample = examples.find(e => e.language === 'graphql');
      const jsExample = examples.find(e => e.language === 'javascript');

      expect(graphqlExample).toBeDefined();
      expect(jsExample).toBeDefined();
    });

    it('should include table name in generated code', () => {
      const examples = realtimeService.generateSubscriptionExample(
        testSchemaName,
        'test_realtime_table'
      );

      const fullTableName = `${testSchemaName}_test_realtime_table`;

      for (const example of examples) {
        expect(example.code).toContain(fullTableName);
      }
    });

    it('should include websocket endpoint in JavaScript example', () => {
      const examples = realtimeService.generateSubscriptionExample(
        testSchemaName,
        'test_realtime_table'
      );

      const jsExample = examples.find(e => e.language === 'javascript');
      expect(jsExample?.code).toContain('/v1/graphql');
    });
  });

  describe('checkHasuraConnection', () => {
    it('should return boolean', async () => {
      const result = await realtimeService.checkHasuraConnection();
      expect(typeof result).toBe('boolean');
    });
  });

  describe('realtime_enabled behavior', () => {
    it('getTableSubscriptions should return enabled=false by default', async () => {
      const subscriptions = await realtimeService.getTableSubscriptions(testSchemaName);
      const testTable = subscriptions.find(s => s.tableName === 'test_realtime_table');

      expect(testTable).toBeDefined();
      expect(testTable!.enabled).toBe(false);
    });

    it('configureTableSubscription should update _meta_tables.realtime_enabled', async () => {
      // Enable
      const result = await realtimeService.configureTableSubscription(
        testSchemaName,
        'test_realtime_table',
        true,
      );
      expect(result.enabled).toBe(true);

      // Verify in DB
      const dbResult = await pool.query(
        `SELECT realtime_enabled FROM ${testSchemaName}._meta_tables WHERE table_name = $1`,
        ['test_realtime_table']
      );
      expect(dbResult.rows[0].realtime_enabled).toBe(true);

      // Verify getTableSubscriptions reflects the change
      const subscriptions = await realtimeService.getTableSubscriptions(testSchemaName);
      const testTable = subscriptions.find(s => s.tableName === 'test_realtime_table');
      expect(testTable!.enabled).toBe(true);

      // Disable
      await realtimeService.configureTableSubscription(
        testSchemaName,
        'test_realtime_table',
        false,
      );

      const after = await pool.query(
        `SELECT realtime_enabled FROM ${testSchemaName}._meta_tables WHERE table_name = $1`,
        ['test_realtime_table']
      );
      expect(after.rows[0].realtime_enabled).toBe(false);
    });

    it('configureTableSubscription should upsert for unregistered tables', async () => {
      // Create a table not in _meta_tables
      await pool.query(`
        CREATE TABLE IF NOT EXISTS ${testSchemaName}.unregistered_table (
          id SERIAL PRIMARY KEY
        )
      `);

      // Should upsert into _meta_tables
      const result = await realtimeService.configureTableSubscription(
        testSchemaName,
        'unregistered_table',
        true,
      );
      expect(result.enabled).toBe(true);

      // Verify row was created in _meta_tables
      const dbResult = await pool.query(
        `SELECT realtime_enabled FROM ${testSchemaName}._meta_tables WHERE table_name = $1`,
        ['unregistered_table']
      );
      expect(dbResult.rows.length).toBe(1);
      expect(dbResult.rows[0].realtime_enabled).toBe(true);

      // Cleanup
      await pool.query(`DROP TABLE IF EXISTS ${testSchemaName}.unregistered_table`);
      await pool.query(
        `DELETE FROM ${testSchemaName}._meta_tables WHERE table_name = $1`,
        ['unregistered_table']
      );
    });
  });
});
