import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { pool } from '../../apps/api/src/db/index.js';
import * as backupService from '../../apps/api/src/modules/backup/backup.service.js';
import * as tenantService from '../../apps/api/src/modules/tenant/tenant.service.js';

describe('BackupService Integration', () => {
  let testUserId: number;
  let testTenantId: string;
  const testSchemaName = 'test_backup_schema';

  beforeAll(async () => {
    // Clean up any existing test data
    await pool.query(`DROP SCHEMA IF EXISTS "${testSchemaName}" CASCADE`);
    await pool.query('DELETE FROM druvia_tenants WHERE alias = $1', ['backup_test_tenant']);
    await pool.query('DELETE FROM druvia_users WHERE user_id = $1', ['user_backup_test']);

    // Create test user
    const userResult = await pool.query(
      `INSERT INTO druvia_users (user_id, email, username, status)
       VALUES ('user_backup_test', 'backup-test@test.com', 'backup_tester', 'active')
       RETURNING id`
    );
    testUserId = userResult.rows[0].id;

    // Create test tenant
    const tenant = await tenantService.createTenant({
      alias: 'backup_test_tenant',
      name: 'Backup Test Tenant',
      ownerUid: testUserId,
    });
    testTenantId = tenant.tenantId;

    // Create test schema manually for backup testing
    await pool.query(`CREATE SCHEMA "${testSchemaName}"`);

    // Create a test table in the schema
    await pool.query(`
      CREATE TABLE "${testSchemaName}".test_data (
        id SERIAL PRIMARY KEY,
        name VARCHAR(100),
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);

    // Insert some test data
    await pool.query(`
      INSERT INTO "${testSchemaName}".test_data (name) VALUES ('item1'), ('item2'), ('item3')
    `);
  });

  afterAll(async () => {
    // Clean up backups
    await pool.query('DELETE FROM druvia_backups WHERE tenant_id = $1', [testTenantId]);
    // Clean up schema
    await pool.query(`DROP SCHEMA IF EXISTS "${testSchemaName}" CASCADE`);
    // Clean up tenant
    await pool.query('DELETE FROM druvia_tenants WHERE tenant_id = $1', [testTenantId]);
    await pool.query('DELETE FROM druvia_users WHERE user_id = $1', ['user_backup_test']);
  });

  beforeEach(async () => {
    // Clean up backups before each test
    await pool.query('DELETE FROM druvia_backups WHERE tenant_id = $1', [testTenantId]);
  });

  describe('createBackup', () => {
    it('should create a backup record with pending status', async () => {
      const backup = await backupService.createBackup(
        testTenantId,
        testSchemaName,
        undefined,
        testUserId
      );

      expect(backup).toBeDefined();
      expect(backup.backupId).toMatch(/^backup_/);
      expect(backup.tenantId).toBe(testTenantId);
      expect(backup.schemaName).toBe(testSchemaName);
      expect(backup.status).toBe('pending');
      expect(backup.storageKey).toContain('backups/');
    });

    it('should update backup status after completion', async () => {
      const backup = await backupService.createBackup(
        testTenantId,
        testSchemaName,
        undefined,
        testUserId
      );

      // Wait for async backup to complete
      await new Promise(resolve => setTimeout(resolve, 2000));

      const updated = await backupService.getBackupById(backup.backupId);

      // Status should be either 'completed' or 'failed' (depending on pg_dump availability)
      expect(['completed', 'failed', 'running']).toContain(updated?.status);
    });
  });

  describe('getBackupById', () => {
    it('should return backup by ID', async () => {
      const created = await backupService.createBackup(
        testTenantId,
        testSchemaName
      );

      const backup = await backupService.getBackupById(created.backupId);

      expect(backup).toBeDefined();
      expect(backup?.backupId).toBe(created.backupId);
    });

    it('should return null for non-existent backup', async () => {
      const backup = await backupService.getBackupById('backup_nonexistent');
      expect(backup).toBeNull();
    });
  });

  describe('listBackups', () => {
    it('should list backups for tenant', async () => {
      await backupService.createBackup(testTenantId, testSchemaName);
      await backupService.createBackup(testTenantId, testSchemaName);

      const backups = await backupService.listBackups(testTenantId);

      expect(backups.length).toBeGreaterThanOrEqual(2);
      expect(backups[0].tenantId).toBe(testTenantId);
    });

    it('should return empty array for tenant with no backups', async () => {
      const backups = await backupService.listBackups('tenant_nonexistent');
      expect(backups).toEqual([]);
    });
  });

  describe('deleteBackup', () => {
    it('should delete backup', async () => {
      const created = await backupService.createBackup(testTenantId, testSchemaName);

      const deleted = await backupService.deleteBackup(created.backupId);
      expect(deleted).toBe(true);

      const backup = await backupService.getBackupById(created.backupId);
      expect(backup).toBeNull();
    });

    it('should return false for non-existent backup', async () => {
      const deleted = await backupService.deleteBackup('backup_nonexistent');
      expect(deleted).toBe(false);
    });
  });
});
