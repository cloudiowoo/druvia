import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { pool } from '../../apps/api/src/db/index.js';
import Fastify from 'fastify';
import { tenantRoutes } from '../../apps/api/src/modules/tenant/tenant.routes.js';
import { projectRoutes } from '../../apps/api/src/modules/project/project.routes.js';
import { actionsRoutes } from '../../apps/api/src/modules/actions/actions.routes.js';

describe('Admin Pages E2E', () => {
  const app = Fastify();
  const testEmail = `e2e-admin-${Date.now()}@test.com`;
  let authToken: string;
  let testUserId: string;
  let testTenantId: string;
  let testProjectId: string;
  let testSchemaName: string;

  beforeAll(async () => {
    // Register routes
    app.register(actionsRoutes, { prefix: '/api/v1' });
    app.register(tenantRoutes, { prefix: '/api/v1' });
    app.register(projectRoutes, { prefix: '/api/v1' });
    await app.ready();

    // Clean up
    await pool.query('DELETE FROM druvia_users WHERE email LIKE $1', ['e2e-admin-%@test.com']);

    // Register test user
    const registerRes = await app.inject({
      method: 'POST',
      url: '/api/v1/actions/register',
      payload: {
        action: { name: 'register' },
        input: { email: testEmail, password: 'password123', username: 'e2e_admin' },
        session_variables: {},
      },
    });
    const registerBody = JSON.parse(registerRes.body);
    authToken = registerBody.token;
    testUserId = registerBody.user_id;

    // Create test tenant
    const tenantRes = await app.inject({
      method: 'POST',
      url: '/api/v1/tenants',
      headers: { Authorization: `Bearer ${authToken}` },
      payload: { alias: 'e2etenant', name: 'E2E Test Tenant' },
    });
    testTenantId = JSON.parse(tenantRes.body).data.tenantId;

    // Create test project
    const projectRes = await app.inject({
      method: 'POST',
      url: `/api/v1/tenants/${testTenantId}/projects`,
      headers: { Authorization: `Bearer ${authToken}` },
      payload: { alias: 'e2eproj', name: 'E2E Test Project' },
    });
    const projectBody = JSON.parse(projectRes.body).data;
    testProjectId = projectBody.projectId;
    testSchemaName = projectBody.schemaName;

    // Create test table
    await pool.query(`CREATE TABLE IF NOT EXISTS ${testSchemaName}.e2e_items (
      id SERIAL PRIMARY KEY,
      title VARCHAR(200) NOT NULL,
      created_at TIMESTAMP DEFAULT NOW()
    )`);
    await pool.query(`INSERT INTO ${testSchemaName}.e2e_items (title) VALUES ('E2E Item 1'), ('E2E Item 2')`);
  });

  afterAll(async () => {
    await pool.query('DELETE FROM druvia_projects WHERE tenant_id = $1', [testTenantId]);
    await pool.query('DELETE FROM druvia_schema_registry WHERE tenant_id = $1', [testTenantId]);
    await pool.query('DELETE FROM druvia_tenants WHERE tenant_id = $1', [testTenantId]);
    await pool.query('DELETE FROM druvia_users WHERE email LIKE $1', ['e2e-admin-%@test.com']);
    await app.close();
  });

  describe('Tenant Settings API', () => {
    it('GET /tenants/:tenantId - should return tenant details', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/tenants/${testTenantId}`,
        headers: { Authorization: `Bearer ${authToken}` },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      expect(body.data.tenantId).toBe(testTenantId);
      expect(body.data.alias).toBe('e2etenant');
    });

    it('PATCH /tenants/:tenantId - should update tenant name', async () => {
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/v1/tenants/${testTenantId}`,
        headers: { Authorization: `Bearer ${authToken}` },
        payload: { name: 'Updated E2E Tenant' },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.data.name).toBe('Updated E2E Tenant');
    });

    it('GET /tenants/:tenantId/usage - should return usage stats', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/tenants/${testTenantId}/usage`,
        headers: { Authorization: `Bearer ${authToken}` },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      expect(body.data.projects.used).toBe(1);
      expect(body.data.projects.limit).toBeGreaterThan(0);
      expect(body.data.storage).toBeDefined();
      expect(body.data.users).toBeDefined();
    });
  });

  describe('Project Settings API', () => {
    it('GET /projects/:projectId - should return project details', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/projects/${testProjectId}`,
        headers: { Authorization: `Bearer ${authToken}` },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.data.projectId).toBe(testProjectId);
      expect(body.data.schemaName).toBe(testSchemaName);
    });

    it('PATCH /projects/:projectId - should update project name', async () => {
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/v1/projects/${testProjectId}`,
        headers: { Authorization: `Bearer ${authToken}` },
        payload: { name: 'Updated E2E Project' },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.data.name).toBe('Updated E2E Project');
    });
  });

  describe('Project Query API', () => {
    beforeEach(async () => {
      await pool.query(`TRUNCATE ${testSchemaName}.e2e_items RESTART IDENTITY`);
      await pool.query(`INSERT INTO ${testSchemaName}.e2e_items (title) VALUES ('Item A'), ('Item B')`);
    });

    it('POST /projects/:projectId/query - should execute SELECT query', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/projects/${testProjectId}/query`,
        headers: { Authorization: `Bearer ${authToken}` },
        payload: { sql: 'SELECT * FROM e2e_items ORDER BY id' },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      expect(body.data.rows.length).toBe(2);
      expect(body.data.rows[0].title).toBe('Item A');
      expect(body.data.columns.length).toBeGreaterThan(0);
    });

    it('POST /projects/:projectId/query - should reject DELETE query', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/projects/${testProjectId}/query`,
        headers: { Authorization: `Bearer ${authToken}` },
        payload: { sql: 'DELETE FROM e2e_items' },
      });

      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.body);
      expect(body.error.code).toBe('INVALID_QUERY');
    });

    it('POST /projects/:projectId/query - should handle SQL errors', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/projects/${testProjectId}/query`,
        headers: { Authorization: `Bearer ${authToken}` },
        payload: { sql: 'SELECT * FROM nonexistent_table' },
      });

      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.body);
      expect(body.error.code).toBe('QUERY_ERROR');
    });
  });

  describe('Authentication', () => {
    it('should reject requests without token', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/tenants/${testTenantId}`,
      });

      expect(res.statusCode).toBe(401);
    });

    it('should reject requests with invalid token', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/tenants/${testTenantId}`,
        headers: { Authorization: 'Bearer invalid-token' },
      });

      expect(res.statusCode).toBe(401);
    });
  });
});
