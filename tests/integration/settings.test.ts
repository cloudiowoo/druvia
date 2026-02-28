import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { pool } from '../../apps/api/src/db/index.js';
import * as settingsService from '../../apps/api/src/modules/settings/settings.service.js';

describe('SettingsService Integration', () => {
  beforeAll(async () => {
    // 确保测试数据存在
    await pool.query(`
      INSERT INTO druvia_settings (key, value) VALUES
        ('default_plan', '"free"'),
        ('default_storage_limit', '1073741824'),
        ('default_project_limit', '5'),
        ('default_user_limit', '10'),
        ('backup_retention_days', '30'),
        ('backup_max_count', '10')
      ON CONFLICT (key) DO NOTHING
    `);
  });

  afterAll(async () => {
    // 恢复默认值
    await pool.query(`
      UPDATE druvia_settings SET value = '"free"' WHERE key = 'default_plan';
      UPDATE druvia_settings SET value = '5' WHERE key = 'default_project_limit';
    `);
  });

  describe('getSettings', () => {
    it('should return all platform settings', async () => {
      const settings = await settingsService.getSettings();

      expect(settings).toBeDefined();
      expect(settings.defaultPlan).toBeDefined();
      expect(settings.defaultStorageLimit).toBeDefined();
      expect(settings.defaultProjectLimit).toBeDefined();
      expect(settings.defaultUserLimit).toBeDefined();
      expect(settings.backupRetentionDays).toBeDefined();
      expect(settings.backupMaxCount).toBeDefined();
    });
  });

  describe('getSetting', () => {
    it('should return a single setting by key', async () => {
      const value = await settingsService.getSetting('defaultPlan');
      expect(value).toBe('free');
    });

    it('should return null for non-existent key', async () => {
      const value = await settingsService.getSetting('nonExistentKey' as never);
      expect(value).toBeNull();
    });
  });

  describe('updateSettings', () => {
    it('should update single setting', async () => {
      const updated = await settingsService.updateSettings({
        defaultProjectLimit: 10,
      });

      expect(updated.defaultProjectLimit).toBe(10);
    });

    it('should update multiple settings', async () => {
      const updated = await settingsService.updateSettings({
        defaultPlan: 'pro',
        defaultProjectLimit: 15,
      });

      expect(updated.defaultPlan).toBe('pro');
      expect(updated.defaultProjectLimit).toBe(15);
    });

    it('should ignore invalid keys', async () => {
      const before = await settingsService.getSettings();
      await settingsService.updateSettings({
        invalidKey: 'value',
      } as never);
      const after = await settingsService.getSettings();

      expect(after).toEqual(before);
    });
  });
});
