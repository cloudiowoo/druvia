import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { pool } from '../../apps/api/src/db/index.js';
import * as tenantService from '../../apps/api/src/modules/tenant/tenant.service.js';

describe('TenantService Integration', () => {
  let testUserId: number;

  beforeAll(async () => {
    // 创建测试用户
    const result = await pool.query(
      `INSERT INTO druvia_users (user_id, email, username, status)
       VALUES ('user_test_tenant', 'tenant-test@test.com', 'tenant_tester', 'active')
       ON CONFLICT (user_id) DO UPDATE SET email = EXCLUDED.email
       RETURNING id`
    );
    testUserId = result.rows[0].id;
  });

  afterAll(async () => {
    // 清理测试数据
    await pool.query('DELETE FROM druvia_tenants WHERE alias LIKE $1', ['test_%']);
    await pool.query('DELETE FROM druvia_users WHERE user_id = $1', ['user_test_tenant']);
    await pool.end();
  });

  beforeEach(async () => {
    // 每个测试前清理租户数据
    await pool.query('DELETE FROM druvia_tenants WHERE alias LIKE $1', ['test_%']);
  });

  describe('createTenant', () => {
    it('should create a tenant with valid input', async () => {
      const tenant = await tenantService.createTenant({
        alias: 'test_acme',
        name: 'ACME Corp',
        ownerUid: testUserId,
      });

      expect(tenant).toBeDefined();
      expect(tenant.tenantId).toMatch(/^tenant_/);
      expect(tenant.alias).toBe('test_acme');
      expect(tenant.name).toBe('ACME Corp');
      expect(tenant.ownerUid).toBe(testUserId);
      expect(tenant.plan).toBe('free');
      expect(tenant.status).toBe('active');
    });

    it('should throw error for duplicate alias', async () => {
      await tenantService.createTenant({
        alias: 'test_duplicate',
        name: 'First Tenant',
        ownerUid: testUserId,
      });

      await expect(
        tenantService.createTenant({
          alias: 'test_duplicate',
          name: 'Second Tenant',
          ownerUid: testUserId,
        })
      ).rejects.toThrow();
    });
  });

  describe('getTenantById', () => {
    it('should return tenant by ID', async () => {
      const created = await tenantService.createTenant({
        alias: 'test_getbyid',
        name: 'Get By ID Test',
        ownerUid: testUserId,
      });

      const tenant = await tenantService.getTenantById(created.tenantId);

      expect(tenant).toBeDefined();
      expect(tenant?.tenantId).toBe(created.tenantId);
      expect(tenant?.alias).toBe('test_getbyid');
    });

    it('should return null for non-existent ID', async () => {
      const tenant = await tenantService.getTenantById('tenant_nonexistent');
      expect(tenant).toBeNull();
    });
  });

  describe('getTenantByAlias', () => {
    it('should return tenant by alias', async () => {
      await tenantService.createTenant({
        alias: 'test_byalias',
        name: 'By Alias Test',
        ownerUid: testUserId,
      });

      const tenant = await tenantService.getTenantByAlias('test_byalias');

      expect(tenant).toBeDefined();
      expect(tenant?.alias).toBe('test_byalias');
    });
  });

  describe('listTenants', () => {
    it('should list all tenants', async () => {
      await tenantService.createTenant({
        alias: 'test_list1',
        name: 'List Test 1',
        ownerUid: testUserId,
      });
      await tenantService.createTenant({
        alias: 'test_list2',
        name: 'List Test 2',
        ownerUid: testUserId,
      });

      const tenants = await tenantService.listTenants(testUserId);

      expect(tenants.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe('updateTenant', () => {
    it('should update tenant name', async () => {
      const created = await tenantService.createTenant({
        alias: 'test_update',
        name: 'Original Name',
        ownerUid: testUserId,
      });

      const updated = await tenantService.updateTenant(created.tenantId, {
        name: 'Updated Name',
      });

      expect(updated?.name).toBe('Updated Name');
    });

    it('should update tenant plan', async () => {
      const created = await tenantService.createTenant({
        alias: 'test_plan',
        name: 'Plan Test',
        ownerUid: testUserId,
      });

      const updated = await tenantService.updateTenant(created.tenantId, {
        plan: 'pro',
      });

      expect(updated?.plan).toBe('pro');
    });
  });

  describe('deleteTenant', () => {
    it('should delete tenant', async () => {
      const created = await tenantService.createTenant({
        alias: 'test_delete',
        name: 'Delete Test',
        ownerUid: testUserId,
      });

      const deleted = await tenantService.deleteTenant(created.tenantId);
      expect(deleted).toBe(true);

      const tenant = await tenantService.getTenantById(created.tenantId);
      expect(tenant).toBeNull();
    });

    it('should return false for non-existent tenant', async () => {
      const deleted = await tenantService.deleteTenant('tenant_nonexistent');
      expect(deleted).toBe(false);
    });
  });
});
