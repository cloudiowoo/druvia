import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { pool } from '../../apps/api/src/db/index.js';
import * as dashboardService from '../../apps/api/src/modules/dashboard/dashboard.service.js';
import * as activityService from '../../apps/api/src/modules/activity/activity.service.js';

describe('DashboardService Integration', () => {
  describe('getStats', () => {
    it('should return dashboard statistics', async () => {
      const stats = await dashboardService.getStats();

      expect(stats).toBeDefined();
      expect(stats.tenants).toBeDefined();
      expect(stats.tenants.total).toBeGreaterThanOrEqual(0);
      expect(stats.tenants.weekNew).toBeGreaterThanOrEqual(0);
      expect(stats.users).toBeDefined();
      expect(stats.users.total).toBeGreaterThanOrEqual(0);
      expect(stats.backups).toBeDefined();
      expect(stats.storage).toBeDefined();
      expect(stats.storage.used).toBeGreaterThanOrEqual(0);
      expect(stats.storage.total).toBeGreaterThanOrEqual(0);
    });
  });

  describe('getTrends', () => {
    it('should return 7 days of trend data by default', async () => {
      const trends = await dashboardService.getTrends();

      expect(trends).toHaveLength(7);
      trends.forEach((day) => {
        expect(day.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
        expect(day.tenants).toBeGreaterThanOrEqual(0);
        expect(day.users).toBeGreaterThanOrEqual(0);
        expect(day.backups).toBeGreaterThanOrEqual(0);
      });
    });

    it('should return specified number of days', async () => {
      const trends = await dashboardService.getTrends(3);
      expect(trends).toHaveLength(3);
    });
  });

  describe('getResourceUsage', () => {
    it('should return resource usage data', async () => {
      const resources = await dashboardService.getResourceUsage();

      expect(resources).toBeDefined();
      expect(Array.isArray(resources.topTenants)).toBe(true);
      expect(Array.isArray(resources.storageByTenant)).toBe(true);

      resources.topTenants.forEach((tenant) => {
        expect(tenant.name).toBeDefined();
        expect(tenant.size).toBeGreaterThanOrEqual(0);
      });
    });
  });
});

describe('ActivityService Integration', () => {
  // 使用 null 作为 user_id，因为外键允许 null
  const testUserId = null;

  afterAll(async () => {
    await pool.query('DELETE FROM druvia_activity_logs WHERE user_id IS NULL');
  });

  describe('logActivity', () => {
    it('should create activity log entry', async () => {
      const log = await activityService.logActivity(
        testUserId,
        'user.login',
        'user',
        'usr_test',
        { ip: '127.0.0.1' }
      );

      expect(log).toBeDefined();
      expect(log.id).toBeDefined();
      expect(log.userId).toBeNull();
      expect(log.action).toBe('user.login');
      expect(log.targetType).toBe('user');
      expect(log.targetId).toBe('usr_test');
      expect(log.details).toEqual({ ip: '127.0.0.1' });
    });

    it('should create activity log without optional fields', async () => {
      const log = await activityService.logActivity(testUserId, 'user.logout');

      expect(log).toBeDefined();
      expect(log.userId).toBeNull();
      expect(log.action).toBe('user.logout');
      expect(log.targetType).toBeNull();
      expect(log.targetId).toBeNull();
    });
  });

  describe('listActivities', () => {
    it('should list activities with pagination', async () => {
      // 创建一些测试数据
      await activityService.logActivity(testUserId, 'tenant.create', 'tenant', 'tnt_1');
      await activityService.logActivity(testUserId, 'tenant.update', 'tenant', 'tnt_1');

      const result = await activityService.listActivities(10, 0);

      expect(result).toBeDefined();
      expect(Array.isArray(result.activities)).toBe(true);
      expect(result.total).toBeGreaterThanOrEqual(2);
    });

    it('should respect limit parameter', async () => {
      const result = await activityService.listActivities(1, 0);
      expect(result.activities.length).toBeLessThanOrEqual(1);
    });
  });
});
