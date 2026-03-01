import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { pool } from '../../apps/api/src/db/index.js';
import * as tenantService from '../../apps/api/src/modules/tenant/tenant.service.js';
import * as projectService from '../../apps/api/src/modules/project/project.service.js';

describe('TenantUsage Integration', () => {
  let testUserId: number;
  let testTenantId: string;

  beforeAll(async () => {
    // 清理可能残留的测试数据
    await pool.query('DELETE FROM druvia_tenants WHERE alias = $1', ['usagetenant']);
    await pool.query('DELETE FROM druvia_users WHERE user_id = $1', ['user_usage_test']);

    // 创建测试用户
    const userResult = await pool.query(
      `INSERT INTO druvia_users (user_id, email, username, status)
       VALUES ('user_usage_test', 'usage-test@test.com', 'usage_tester', 'active')
       RETURNING id`
    );
    testUserId = userResult.rows[0].id;

    // 创建测试租户
    const tenant = await tenantService.createTenant({
      alias: 'usagetenant',
      name: 'Usage Test Tenant',
      ownerUid: testUserId,
    });
    testTenantId = tenant.tenantId;
  });

  afterAll(async () => {
    // 清理测试数据
    await pool.query('DELETE FROM druvia_projects WHERE tenant_id = $1', [testTenantId]);
    await pool.query('DELETE FROM druvia_schema_registry WHERE tenant_id = $1', [testTenantId]);
    await pool.query('DELETE FROM druvia_tenants WHERE tenant_id = $1', [testTenantId]);
    await pool.query('DELETE FROM druvia_users WHERE user_id = $1', ['user_usage_test']);
  });

  describe('getTenantUsage', () => {
    it('should return usage with zero projects initially', async () => {
      const usage = await tenantService.getTenantUsage(testTenantId);

      expect(usage).toBeDefined();
      expect(usage?.projects.used).toBe(0);
      expect(usage?.projects.limit).toBeGreaterThan(0);
      expect(usage?.storage.used).toBe(0);
      expect(usage?.storage.limit).toBeGreaterThan(0);
    });

    it('should return updated project count after creating project', async () => {
      // 创建项目
      await projectService.createProject({
        tenantId: testTenantId,
        alias: 'usageproj1',
        name: 'Usage Project 1',
      });

      const usage = await tenantService.getTenantUsage(testTenantId);

      expect(usage?.projects.used).toBe(1);
    });

    it('should return null for non-existent tenant', async () => {
      const usage = await tenantService.getTenantUsage('tenant_nonexistent');
      expect(usage).toBeNull();
    });
  });
});
