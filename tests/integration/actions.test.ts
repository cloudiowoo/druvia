import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { pool } from '../../apps/api/src/db/index.js';
import Fastify from 'fastify';
import { actionsRoutes } from '../../apps/api/src/modules/actions/actions.routes.js';

describe('Actions Integration', () => {
  const app = Fastify();
  const testEmail = `actions-test-${Date.now()}@test.com`;

  beforeAll(async () => {
    // Register routes without Hasura secret verification for testing
    app.register(actionsRoutes, { prefix: '/api/v1' });
    await app.ready();

    // Clean up test users
    await pool.query('DELETE FROM druvia_users WHERE email LIKE $1', ['actions-test-%@test.com']);
  });

  afterAll(async () => {
    await pool.query('DELETE FROM druvia_users WHERE email LIKE $1', ['actions-test-%@test.com']);
    await app.close();
  });

  beforeEach(async () => {
    await pool.query('DELETE FROM druvia_users WHERE email = $1', [testEmail]);
  });

  describe('POST /actions/register', () => {
    it('should register a new user', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/actions/register',
        payload: {
          action: { name: 'register' },
          input: {
            email: testEmail,
            password: 'password123',
            username: 'testuser',
          },
          session_variables: {},
        },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.user_id).toMatch(/^user_/);
      expect(body.email).toBe(testEmail);
      expect(body.token).toBeDefined();
    });

    it('should reject short password', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/actions/register',
        payload: {
          action: { name: 'register' },
          input: {
            email: testEmail,
            password: 'short',
          },
          session_variables: {},
        },
      });

      expect(response.statusCode).toBe(400);
      const body = JSON.parse(response.body);
      expect(body.code).toBe('INVALID_INPUT');
    });

    it('should reject duplicate email', async () => {
      // First registration
      await app.inject({
        method: 'POST',
        url: '/api/v1/actions/register',
        payload: {
          action: { name: 'register' },
          input: { email: testEmail, password: 'password123' },
          session_variables: {},
        },
      });

      // Second registration with same email
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/actions/register',
        payload: {
          action: { name: 'register' },
          input: { email: testEmail, password: 'password456' },
          session_variables: {},
        },
      });

      expect(response.statusCode).toBe(409);
      const body = JSON.parse(response.body);
      expect(body.code).toBe('CONFLICT');
    });
  });

  describe('POST /actions/login', () => {
    beforeEach(async () => {
      // Create test user
      await app.inject({
        method: 'POST',
        url: '/api/v1/actions/register',
        payload: {
          action: { name: 'register' },
          input: { email: testEmail, password: 'correctpassword' },
          session_variables: {},
        },
      });
    });

    it('should login with correct credentials', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/actions/login',
        payload: {
          action: { name: 'login' },
          input: { email: testEmail, password: 'correctpassword' },
          session_variables: {},
        },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.email).toBe(testEmail);
      expect(body.token).toBeDefined();
    });

    it('should reject wrong password', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/actions/login',
        payload: {
          action: { name: 'login' },
          input: { email: testEmail, password: 'wrongpassword' },
          session_variables: {},
        },
      });

      expect(response.statusCode).toBe(401);
      const body = JSON.parse(response.body);
      expect(body.code).toBe('UNAUTHORIZED');
    });

    it('should reject non-existent user', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/actions/login',
        payload: {
          action: { name: 'login' },
          input: { email: 'nonexistent@test.com', password: 'anypassword' },
          session_variables: {},
        },
      });

      expect(response.statusCode).toBe(401);
    });
  });

  describe('POST /actions/me', () => {
    let testUserId: string;

    beforeEach(async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/actions/register',
        payload: {
          action: { name: 'register' },
          input: { email: testEmail, password: 'password123', username: 'metest' },
          session_variables: {},
        },
      });
      testUserId = JSON.parse(response.body).user_id;
    });

    it('should return current user info', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/actions/me',
        payload: {
          action: { name: 'me' },
          input: {},
          session_variables: {
            'x-hasura-user-id': testUserId,
            'x-hasura-role': 'user',
          },
        },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.user_id).toBe(testUserId);
      expect(body.email).toBe(testEmail);
      expect(body.username).toBe('metest');
    });

    it('should reject unauthenticated request', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/actions/me',
        payload: {
          action: { name: 'me' },
          input: {},
          session_variables: {},
        },
      });

      expect(response.statusCode).toBe(401);
    });
  });

  describe('POST /actions/create-tenant', () => {
    let testUserId: string;

    beforeEach(async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/actions/register',
        payload: {
          action: { name: 'register' },
          input: { email: testEmail, password: 'password123' },
          session_variables: {},
        },
      });
      testUserId = JSON.parse(response.body).user_id;
    });

    afterEach(async () => {
      // Clean up tenants created by test user
      await pool.query(
        `DELETE FROM druvia_tenants WHERE owner_uid = (SELECT id FROM druvia_users WHERE user_id = $1)`,
        [testUserId]
      );
    });

    it('should create tenant for authenticated user', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/actions/create-tenant',
        payload: {
          action: { name: 'createTenant' },
          input: {
            alias: 'action_test_tenant',
            name: 'Action Test Tenant',
          },
          session_variables: {
            'x-hasura-user-id': testUserId,
            'x-hasura-role': 'user',
          },
        },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.tenant_id).toMatch(/^tenant_/);
      expect(body.alias).toBe('action_test_tenant');
      expect(body.status).toBe('active');
    });

    it('should reject unauthenticated request', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/actions/create-tenant',
        payload: {
          action: { name: 'createTenant' },
          input: { alias: 'test', name: 'Test' },
          session_variables: {},
        },
      });

      expect(response.statusCode).toBe(401);
    });
  });
});
