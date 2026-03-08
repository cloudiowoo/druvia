import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { pool } from '../../apps/api/src/db/index.js';
import * as apiKeysService from '../../apps/api/src/modules/api-keys/api-keys.service.js';
import * as projectService from '../../apps/api/src/modules/project/project.service.js';
import * as tenantService from '../../apps/api/src/modules/tenant/tenant.service.js';

describe('ApiKeysService Integration', () => {
  let testUserId: number;
  let testTenantId: string;
  let testProjectId: string;

  beforeAll(async () => {
    // 清理可能残留的测试数据
    await pool.query('DELETE FROM druvia_tenants WHERE alias = $1', ['apikeytenant']);
    await pool.query('DELETE FROM druvia_users WHERE user_id = $1', ['user_apikey_test']);

    // 创建测试用户
    const userResult = await pool.query(
      `INSERT INTO druvia_users (user_id, email, username, status)
       VALUES ('user_apikey_test', 'apikey-test@test.com', 'apikey_tester', 'active')
       RETURNING id`
    );
    testUserId = userResult.rows[0].id;

    // 创建测试租户
    const tenant = await tenantService.createTenant({
      alias: 'apikeytenant',
      name: 'API Key Test Tenant',
      ownerUid: testUserId,
    });
    testTenantId = tenant.tenantId;

    // 创建测试项目
    const project = await projectService.createProject({
      tenantId: testTenantId,
      alias: 'apikeyproj',
      name: 'API Key Test Project',
    });
    testProjectId = project.projectId;
  });

  afterAll(async () => {
    await pool.query('DELETE FROM druvia_api_keys WHERE project_id = $1', [testProjectId]);
    await pool.query('DELETE FROM druvia_projects WHERE tenant_id = $1', [testTenantId]);
    await pool.query('DELETE FROM druvia_schema_registry WHERE tenant_id = $1', [testTenantId]);
    await pool.query('DELETE FROM druvia_tenants WHERE tenant_id = $1', [testTenantId]);
    await pool.query('DELETE FROM druvia_users WHERE user_id = $1', ['user_apikey_test']);
  });

  beforeEach(async () => {
    await pool.query('DELETE FROM druvia_api_keys WHERE project_id = $1', [testProjectId]);
  });

  describe('createApiKey', () => {
    it('should create an API key with prefix dru_', async () => {
      const result = await apiKeysService.createApiKey(testProjectId, 'Test Key');

      expect(result).toBeDefined();
      expect(result.key).toMatch(/^dru_[A-Za-z0-9_-]+$/);
      expect(result.apiKey.keyPrefix).toBe(result.key.substring(0, 12));
      expect(result.apiKey.name).toBe('Test Key');
    });

    it('should create API key without name', async () => {
      const result = await apiKeysService.createApiKey(testProjectId);

      expect(result).toBeDefined();
      expect(result.key).toMatch(/^dru_/);
      expect(result.apiKey.name).toBeNull();
    });
  });

  describe('validateApiKey', () => {
    it('should validate a valid API key', async () => {
      const created = await apiKeysService.createApiKey(testProjectId, 'Validate Test');

      const result = await apiKeysService.validateApiKey(created.key);

      expect(result.valid).toBe(true);
      expect(result.projectId).toBe(testProjectId);
    });

    it('should reject invalid API key', async () => {
      const result = await apiKeysService.validateApiKey('dru_invalid_key_12345');

      expect(result.valid).toBe(false);
      expect(result.projectId).toBeUndefined();
    });

    it('should update last_used_at on validation', async () => {
      const created = await apiKeysService.createApiKey(testProjectId, 'LastUsed Test');

      // 验证前 last_used_at 应为 null
      const beforeResult = await pool.query(
        'SELECT last_used_at FROM druvia_api_keys WHERE key_prefix = $1',
        [created.apiKey.keyPrefix]
      );
      expect(beforeResult.rows[0].last_used_at).toBeNull();

      // 验证 API key
      await apiKeysService.validateApiKey(created.key);

      // 验证后 last_used_at 应有值
      const afterResult = await pool.query(
        'SELECT last_used_at FROM druvia_api_keys WHERE key_prefix = $1',
        [created.apiKey.keyPrefix]
      );
      expect(afterResult.rows[0].last_used_at).not.toBeNull();
    });
  });

  describe('listApiKeys', () => {
    it('should list all API keys for a project', async () => {
      await apiKeysService.createApiKey(testProjectId, 'Key 1');
      await apiKeysService.createApiKey(testProjectId, 'Key 2');

      const keys = await apiKeysService.listApiKeys(testProjectId);

      expect(keys.length).toBe(2);
      expect(keys[0].keyPrefix).toMatch(/^dru_/);
      // 不应返回完整 key
      expect(keys[0]).not.toHaveProperty('key');
    });

    it('should return empty array for project without keys', async () => {
      const keys = await apiKeysService.listApiKeys(testProjectId);

      expect(keys).toEqual([]);
    });
  });

  describe('deleteApiKey', () => {
    it('should delete an API key', async () => {
      const created = await apiKeysService.createApiKey(testProjectId, 'Delete Test');
      const keys = await apiKeysService.listApiKeys(testProjectId);
      const keyId = keys[0].id;

      const deleted = await apiKeysService.deleteApiKey(keyId, testProjectId);

      expect(deleted).toBe(true);

      const keysAfter = await apiKeysService.listApiKeys(testProjectId);
      expect(keysAfter.length).toBe(0);
    });

    it('should return false for non-existent key', async () => {
      const deleted = await apiKeysService.deleteApiKey(99999, testProjectId);

      expect(deleted).toBe(false);
    });

    it('should not delete key from different project', async () => {
      const created = await apiKeysService.createApiKey(testProjectId, 'Wrong Project');
      const keys = await apiKeysService.listApiKeys(testProjectId);
      const keyId = keys[0].id;

      const deleted = await apiKeysService.deleteApiKey(keyId, 'wrong_project_id');

      expect(deleted).toBe(false);
    });
  });
});
