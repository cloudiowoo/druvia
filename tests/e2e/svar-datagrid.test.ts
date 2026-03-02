import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { pool } from '../../apps/api/src/db/index.js';
import Fastify from 'fastify';
import { tenantRoutes } from '../../apps/api/src/modules/tenant/tenant.routes.js';
import { projectRoutes } from '../../apps/api/src/modules/project/project.routes.js';
import { actionsRoutes } from '../../apps/api/src/modules/actions/actions.routes.js';
import { dataRoutes } from '../../apps/api/src/modules/data/data.routes.js';
import { tableRoutes } from '../../apps/api/src/modules/table/table.routes.js';

/**
 * Phase 1 E2E 测试 - SVAR DataGrid API
 *
 * 测试 DruviaDataProvider 依赖的完整 HTTP API 流程：
 * - GET /schemas/:schema/tables/:table/rows (分页、排序、筛选)
 * - POST /schemas/:schema/tables/:table/rows (新增行)
 * - PATCH /schemas/:schema/tables/:table/rows (更新行)
 * - DELETE /schemas/:schema/tables/:table/rows (删除单行)
 * - DELETE /schemas/:schema/tables/:table/rows/batch (批量删除)
 */
describe('SVAR DataGrid E2E - Row CRUD API', () => {
  const app = Fastify();
  const testEmail = `e2e-svar-${Date.now()}@test.com`;
  let authToken: string;
  let testTenantId: string;
  let testSchemaName: string;
  const testTable = 'grid_items';

  beforeAll(async () => {
    // Register routes
    app.register(actionsRoutes, { prefix: '/api/v1' });
    app.register(tenantRoutes, { prefix: '/api/v1' });
    app.register(projectRoutes, { prefix: '/api/v1' });
    app.register(dataRoutes, { prefix: '/api/v1' });
    app.register(tableRoutes, { prefix: '/api/v1' });
    await app.ready();

    // Clean up old test data
    await pool.query('DELETE FROM druvia_users WHERE email LIKE $1', ['e2e-svar-%@test.com']);

    // Register test user
    const registerRes = await app.inject({
      method: 'POST',
      url: '/api/v1/actions/register',
      payload: {
        action: { name: 'register' },
        input: { email: testEmail, password: 'password123', username: 'e2e_svar' },
        session_variables: {},
      },
    });
    const registerBody = JSON.parse(registerRes.body);
    authToken = registerBody.token;
    // Create test tenant
    const tenantRes = await app.inject({
      method: 'POST',
      url: '/api/v1/tenants',
      headers: { Authorization: `Bearer ${authToken}` },
      payload: { alias: 'svartenant', name: 'SVAR Test Tenant' },
    });
    testTenantId = JSON.parse(tenantRes.body).data.tenantId;

    // Create test project
    const projectRes = await app.inject({
      method: 'POST',
      url: `/api/v1/tenants/${testTenantId}/projects`,
      headers: { Authorization: `Bearer ${authToken}` },
      payload: { alias: 'svarproj', name: 'SVAR Test Project' },
    });
    testSchemaName = JSON.parse(projectRes.body).data.schemaName;

    // Create test table with various column types
    await pool.query(`
      CREATE TABLE IF NOT EXISTS "${testSchemaName}"."${testTable}" (
        id SERIAL PRIMARY KEY,
        title VARCHAR(255) NOT NULL,
        description TEXT,
        price INTEGER DEFAULT 0,
        is_active BOOLEAN DEFAULT true,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    // Register table in _meta_tables
    await pool.query(`
      INSERT INTO "${testSchemaName}"._meta_tables (table_name, description)
      VALUES ($1, 'Test table for SVAR DataGrid')
      ON CONFLICT (table_name) DO NOTHING
    `, [testTable]);
  });

  afterAll(async () => {
    // Clean up
    await pool.query('DELETE FROM druvia_projects WHERE tenant_id = $1', [testTenantId]);
    await pool.query('DELETE FROM druvia_schema_registry WHERE tenant_id = $1', [testTenantId]);
    await pool.query('DELETE FROM druvia_tenants WHERE tenant_id = $1', [testTenantId]);
    await pool.query('DELETE FROM druvia_users WHERE email LIKE $1', ['e2e-svar-%@test.com']);
    await app.close();
  });

  beforeEach(async () => {
    // Reset test data before each test
    await pool.query(`TRUNCATE "${testSchemaName}"."${testTable}" RESTART IDENTITY`);
    await pool.query(`
      INSERT INTO "${testSchemaName}"."${testTable}" (title, description, price, is_active)
      VALUES
        ('Item A', 'Description A', 100, true),
        ('Item B', 'Description B', 200, false),
        ('Item C', 'Description C', 150, true),
        ('Item D', NULL, 300, true),
        ('Item E', 'Description E', 50, false)
    `);
  });

  describe('GET /rows - 列表查询', () => {
    it('should return paginated results', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/schemas/${testSchemaName}/tables/${testTable}/rows`,
        headers: { Authorization: `Bearer ${authToken}` },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      expect(body.data.rows.length).toBe(5);
      expect(body.data.total).toBe(5);
      expect(body.data.columns.length).toBeGreaterThan(0);
    });

    it('should respect limit and offset', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/schemas/${testSchemaName}/tables/${testTable}/rows?limit=2&offset=1`,
        headers: { Authorization: `Bearer ${authToken}` },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.data.rows.length).toBe(2);
      expect(body.data.total).toBe(5);
      expect(body.data.rows[0].title).toBe('Item B');
    });

    it('should sort by column ascending', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/schemas/${testSchemaName}/tables/${testTable}/rows?order_by=price&order_dir=asc`,
        headers: { Authorization: `Bearer ${authToken}` },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.data.rows[0].price).toBe(50);
      expect(body.data.rows[4].price).toBe(300);
    });

    it('should sort by column descending', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/schemas/${testSchemaName}/tables/${testTable}/rows?order_by=price&order_dir=desc`,
        headers: { Authorization: `Bearer ${authToken}` },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.data.rows[0].price).toBe(300);
      expect(body.data.rows[4].price).toBe(50);
    });

    it('should filter with eq operator', async () => {
      const filters = JSON.stringify([{ column: 'is_active', operator: 'eq', value: true }]);
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/schemas/${testSchemaName}/tables/${testTable}/rows?filters=${encodeURIComponent(filters)}`,
        headers: { Authorization: `Bearer ${authToken}` },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.data.rows.length).toBe(3);
      expect(body.data.rows.every((r: { is_active: boolean }) => r.is_active === true)).toBe(true);
    });

    it('should filter with gt operator', async () => {
      const filters = JSON.stringify([{ column: 'price', operator: 'gt', value: 150 }]);
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/schemas/${testSchemaName}/tables/${testTable}/rows?filters=${encodeURIComponent(filters)}`,
        headers: { Authorization: `Bearer ${authToken}` },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.data.rows.length).toBe(2);
    });

    it('should filter with like operator', async () => {
      const filters = JSON.stringify([{ column: 'title', operator: 'like', value: '%A%' }]);
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/schemas/${testSchemaName}/tables/${testTable}/rows?filters=${encodeURIComponent(filters)}`,
        headers: { Authorization: `Bearer ${authToken}` },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.data.rows.length).toBe(1);
      expect(body.data.rows[0].title).toBe('Item A');
    });

    it('should combine multiple filters', async () => {
      const filters = JSON.stringify([
        { column: 'is_active', operator: 'eq', value: true },
        { column: 'price', operator: 'gte', value: 100 },
      ]);
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/schemas/${testSchemaName}/tables/${testTable}/rows?filters=${encodeURIComponent(filters)}`,
        headers: { Authorization: `Bearer ${authToken}` },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.data.rows.length).toBe(3); // Item A (100), Item C (150), Item D (300)
    });
  });

  describe('POST /rows - 新增行', () => {
    it('should create a new row', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/schemas/${testSchemaName}/tables/${testTable}/rows`,
        headers: { Authorization: `Bearer ${authToken}` },
        payload: {
          title: 'New Item',
          description: 'New Description',
          price: 999,
        },
      });

      expect(res.statusCode).toBe(201);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      expect(body.data.id).toBeDefined();
      expect(body.data.title).toBe('New Item');
      expect(body.data.price).toBe(999);
    });

    it('should use default values', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/schemas/${testSchemaName}/tables/${testTable}/rows`,
        headers: { Authorization: `Bearer ${authToken}` },
        payload: { title: 'Default Test' },
      });

      expect(res.statusCode).toBe(201);
      const body = JSON.parse(res.body);
      expect(body.data.price).toBe(0);
      expect(body.data.is_active).toBe(true);
      expect(body.data.created_at).toBeDefined();
    });

    it('should reject missing required fields', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/schemas/${testSchemaName}/tables/${testTable}/rows`,
        headers: { Authorization: `Bearer ${authToken}` },
        payload: { description: 'No title' },
      });

      expect(res.statusCode).toBe(400);
    });
  });

  describe('PATCH /rows - 更新行', () => {
    it('should update row by primary key', async () => {
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/v1/schemas/${testSchemaName}/tables/${testTable}/rows`,
        headers: { Authorization: `Bearer ${authToken}` },
        payload: {
          primaryKey: { id: 1 },
          data: { title: 'Updated Title', price: 999 },
        },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.data.title).toBe('Updated Title');
      expect(body.data.price).toBe(999);
    });

    it('should only update specified fields', async () => {
      // Get original
      const originalRes = await app.inject({
        method: 'GET',
        url: `/api/v1/schemas/${testSchemaName}/tables/${testTable}/rows?filters=${encodeURIComponent(JSON.stringify([{ column: 'id', operator: 'eq', value: 1 }]))}`,
        headers: { Authorization: `Bearer ${authToken}` },
      });
      const originalDesc = JSON.parse(originalRes.body).data.rows[0].description;

      // Update only title
      await app.inject({
        method: 'PATCH',
        url: `/api/v1/schemas/${testSchemaName}/tables/${testTable}/rows`,
        headers: { Authorization: `Bearer ${authToken}` },
        payload: {
          primaryKey: { id: 1 },
          data: { title: 'Only Title Changed' },
        },
      });

      // Verify
      const verifyRes = await app.inject({
        method: 'GET',
        url: `/api/v1/schemas/${testSchemaName}/tables/${testTable}/rows?filters=${encodeURIComponent(JSON.stringify([{ column: 'id', operator: 'eq', value: 1 }]))}`,
        headers: { Authorization: `Bearer ${authToken}` },
      });
      const row = JSON.parse(verifyRes.body).data.rows[0];
      expect(row.title).toBe('Only Title Changed');
      expect(row.description).toBe(originalDesc);
    });

    it('should return 404 for non-existent row', async () => {
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/v1/schemas/${testSchemaName}/tables/${testTable}/rows`,
        headers: { Authorization: `Bearer ${authToken}` },
        payload: {
          primaryKey: { id: 9999 },
          data: { title: 'Not Found' },
        },
      });

      expect(res.statusCode).toBe(404);
    });
  });

  describe('DELETE /rows - 删除单行', () => {
    it('should delete row by primary key', async () => {
      const res = await app.inject({
        method: 'DELETE',
        url: `/api/v1/schemas/${testSchemaName}/tables/${testTable}/rows`,
        headers: { Authorization: `Bearer ${authToken}` },
        payload: { primaryKey: { id: 1 } },
      });

      expect(res.statusCode).toBe(200);

      // Verify deletion
      const verifyRes = await app.inject({
        method: 'GET',
        url: `/api/v1/schemas/${testSchemaName}/tables/${testTable}/rows?filters=${encodeURIComponent(JSON.stringify([{ column: 'id', operator: 'eq', value: 1 }]))}`,
        headers: { Authorization: `Bearer ${authToken}` },
      });
      expect(JSON.parse(verifyRes.body).data.rows.length).toBe(0);
    });

    it('should return 404 for non-existent row', async () => {
      const res = await app.inject({
        method: 'DELETE',
        url: `/api/v1/schemas/${testSchemaName}/tables/${testTable}/rows`,
        headers: { Authorization: `Bearer ${authToken}` },
        payload: { primaryKey: { id: 9999 } },
      });

      expect(res.statusCode).toBe(404);
    });
  });

  describe('DELETE /rows/batch - 批量删除', () => {
    it('should delete multiple rows', async () => {
      const res = await app.inject({
        method: 'DELETE',
        url: `/api/v1/schemas/${testSchemaName}/tables/${testTable}/rows/batch`,
        headers: { Authorization: `Bearer ${authToken}` },
        payload: {
          primaryKeys: [{ id: 1 }, { id: 2 }, { id: 3 }],
        },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.data.deleted).toBe(3);

      // Verify remaining count
      const verifyRes = await app.inject({
        method: 'GET',
        url: `/api/v1/schemas/${testSchemaName}/tables/${testTable}/rows`,
        headers: { Authorization: `Bearer ${authToken}` },
      });
      expect(JSON.parse(verifyRes.body).data.total).toBe(2);
    });

    it('should return count of actually deleted rows', async () => {
      const res = await app.inject({
        method: 'DELETE',
        url: `/api/v1/schemas/${testSchemaName}/tables/${testTable}/rows/batch`,
        headers: { Authorization: `Bearer ${authToken}` },
        payload: {
          primaryKeys: [{ id: 1 }, { id: 9999 }], // One exists, one doesn't
        },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.data.deleted).toBe(1);
    });
  });

  describe('认证检查', () => {
    it('should reject requests without token', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/schemas/${testSchemaName}/tables/${testTable}/rows`,
      });

      expect(res.statusCode).toBe(401);
    });

    it('should reject requests with invalid token', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/schemas/${testSchemaName}/tables/${testTable}/rows`,
        headers: { Authorization: 'Bearer invalid-token' },
      });

      expect(res.statusCode).toBe(401);
    });
  });
});
