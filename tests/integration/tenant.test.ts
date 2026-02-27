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
    // 清理测试数据 (不关闭 pool)
    await pool.query('DELETE FROM druvia_tenants WHERE alias LIKE $1', ['test%']);
    await pool.query('DELETE FROM druvia_users WHERE user_id = $1', ['user_test_tenant']);
  });

  beforeEach(async () => {
    // 每个测试前清理租户数据
    await pool.query('DELETE FROM druvia_tenants WHERE alias LIKE $1', ['test%']);
  });

  describe('createTenant', () => {
    it('should create a tenant with valid input', async () => {
      const tenant = await tenantService.createTenant({
        alias: 'testacme',
        name: 'ACME Corp',
        ownerUid: testUserId,
      });

      expect(tenant).toBeDefined();
      expect(tenant.tenantId).toMatch(/^tenant_/);
      expect(tenant.alias).toBe('testacme');
      expect(tenant.name).toBe('ACME Corp');
      expect(tenant.ownerUid).toBe(testUserId);
      expect(tenant.plan).toBe('free');
      expect(tenant.status).toBe('active');
    });

    it('should throw error for duplicate alias', async () => {
      await tenantService.createTenant({
        alias: 'testdup',
        name: 'First Tenant',
        ownerUid: testUserId,
      });

      await expect(
        tenantService.createTenant({
          alias: 'testdup',
          name: 'Second Tenant',
          ownerUid: testUserId,
        })
      ).rejects.toThrow();
    });
  });

  describe('getTenantById', () => {
    it('should return tenant by ID', async () => {
      const created = await tenantService.createTenant({
        alias: 'testgetid',
        name: 'Get By ID Test',
        ownerUid: testUserId,
      });

      const tenant = await tenantService.getTenantById(created.tenantId);

      expect(tenant).toBeDefined();
      expect(tenant?.tenantId).toBe(created.tenantId);
      expect(tenant?.alias).toBe('testgetid');
    });

    it('should return null for non-existent ID', async () => {
      const tenant = await tenantService.getTenantById('tenant_nonexistent');
      expect(tenant).toBeNull();
    });
  });

  describe('getTenantByAlias', () => {
    it('should return tenant by alias', async () => {
      await tenantService.createTenant({
        alias: 'testbyalias',
        name: 'By Alias Test',
        ownerUid: testUserId,
      });

      const tenant = await tenantService.getTenantByAlias('testbyalias');

      expect(tenant).toBeDefined();
      expect(tenant?.alias).toBe('testbyalias');
    });
  });

  describe('listTenants', () => {
    it('should list all tenants', async () => {
      await tenantService.createTenant({
        alias: 'testlist1',
        name: 'List Test 1',
        ownerUid: testUserId,
      });
      await tenantService.createTenant({
        alias: 'testlist2',
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
        alias: 'testupdate',
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
        alias: 'testplan',
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
        alias: 'testdelete',
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
