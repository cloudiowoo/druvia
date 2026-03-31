import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pool } from '../../apps/api/src/db/index.js';
import * as projectService from '../../apps/api/src/modules/project/project.service.js';
import * as tenantService from '../../apps/api/src/modules/tenant/tenant.service.js';
import * as environmentService from '../../apps/api/src/modules/environment/environment.service.js';
import * as apiKeysService from '../../apps/api/src/modules/api-keys/api-keys.service.js';
import * as dbCredentialsService from '../../apps/api/src/modules/project/db-credentials.service.js';
import * as tableService from '../../apps/api/src/modules/table/table.service.js';
import * as storageService from '../../apps/api/src/modules/storage/storage.service.js';

const TEST_STORAGE_PATH = path.resolve(process.cwd(), 'tests/.storage');

async function expectPathExists(targetPath: string): Promise<void> {
  await expect(fs.access(targetPath)).resolves.toBeUndefined();
}

async function expectPathMissing(targetPath: string): Promise<void> {
  await expect(fs.access(targetPath)).rejects.toMatchObject({ code: 'ENOENT' });
}

describe('Project Deletion Integration', () => {
  let testUserId: number;
  let testTenantId: string;
  let testProjectId: string;
  let testSchemaName: string;

  beforeAll(async () => {
    // 清理可能残留的测试数据
    await pool.query('DELETE FROM druvia_tenants WHERE alias = $1', ['deldemo']);
    await pool.query('DELETE FROM druvia_users WHERE user_id = $1', ['user_del_test']);

    // 创建测试用户
    const userResult = await pool.query(
      `INSERT INTO druvia_users (user_id, email, username, status)
       VALUES ('user_del_test', 'del-test@test.com', 'del_tester', 'active')
       RETURNING id`
    );
    testUserId = userResult.rows[0].id;

    // 创建测试租户
    const tenant = await tenantService.createTenant({
      alias: 'deldemo',
      name: 'Deletion Test Tenant',
      ownerUid: testUserId,
    });
    testTenantId = tenant.tenantId;
  });

  afterAll(async () => {
    // 清理测试数据
    await pool.query('DELETE FROM druvia_projects WHERE tenant_id = $1', [testTenantId]);
    await pool.query('DELETE FROM druvia_schema_registry WHERE tenant_id = $1', [testTenantId]);
    await pool.query('DELETE FROM druvia_tenants WHERE tenant_id = $1', [testTenantId]);
    await pool.query('DELETE FROM druvia_users WHERE user_id = $1', ['user_del_test']);
    await fs.rm(TEST_STORAGE_PATH, { recursive: true, force: true });
  });

  beforeEach(async () => {
    // 清理项目数据和 Schema
    const existingProjects = await pool.query(
      'SELECT project_id, schema_name FROM druvia_projects WHERE tenant_id = $1',
      [testTenantId]
    );

    for (const proj of existingProjects.rows) {
      // 删除项目的所有环境 Schema
      const envs = await pool.query(
        'SELECT schema_name FROM druvia_project_environments WHERE project_id = $1',
        [proj.project_id]
      );
      for (const env of envs.rows) {
        await pool.query(`DROP SCHEMA IF EXISTS "${env.schema_name}" CASCADE`);
      }

      // 删除主 Schema
      if (proj.schema_name) {
        await pool.query(`DROP SCHEMA IF EXISTS "${proj.schema_name}" CASCADE`);
      }
    }

    await pool.query('DELETE FROM druvia_projects WHERE tenant_id = $1', [testTenantId]);
    await pool.query('DELETE FROM druvia_schema_registry WHERE tenant_id = $1', [testTenantId]);
    await fs.rm(TEST_STORAGE_PATH, { recursive: true, force: true });

    // 创建测试项目
    const project = await projectService.createProject({
      tenantId: testTenantId,
      alias: 'deltest',
      name: 'Deletion Test Project',
    });
    testProjectId = project.projectId;
    testSchemaName = project.schemaName!;
  });

  describe('Complete Project Deletion', () => {
    it('should delete project with multiple environments and schemas', async () => {
      // 创建 dev 环境
      const devEnv = await environmentService.createEnvironment(testProjectId, 'dev', false);
      expect(devEnv.envName).toBe('dev');
      expect(devEnv.schemaName).toBe(`${testSchemaName}_dev`);

      // 验证环境已创建
      const envsBefore = await environmentService.listEnvironments(testProjectId);
      expect(envsBefore.length).toBeGreaterThanOrEqual(1); // 至少有 dev

      // 验证 Schema 存在
      const prodSchemaExists = await pool.query(
        `SELECT schema_name FROM information_schema.schemata WHERE schema_name = $1`,
        [testSchemaName]
      );
      expect(prodSchemaExists.rows.length).toBe(1);

      const devSchemaExists = await pool.query(
        `SELECT schema_name FROM information_schema.schemata WHERE schema_name = $1`,
        [`${testSchemaName}_dev`]
      );
      expect(devSchemaExists.rows.length).toBe(1);

      // 删除项目
      const deleted = await projectService.deleteProject(testProjectId);
      expect(deleted).toBe(true);

      // 验证项目已删除
      const project = await projectService.getProjectById(testProjectId);
      expect(project).toBeNull();

      // 验证所有环境记录已删除
      const envsAfter = await environmentService.listEnvironments(testProjectId);
      expect(envsAfter.length).toBe(0);

      // 验证所有 Schema 已删除
      const prodSchemaAfter = await pool.query(
        `SELECT schema_name FROM information_schema.schemata WHERE schema_name = $1`,
        [testSchemaName]
      );
      expect(prodSchemaAfter.rows.length).toBe(0);

      const devSchemaAfter = await pool.query(
        `SELECT schema_name FROM information_schema.schemata WHERE schema_name = $1`,
        [`${testSchemaName}_dev`]
      );
      expect(devSchemaAfter.rows.length).toBe(0);
    });

    it('should delete project with API keys', async () => {
      // 创建 API 密钥
      const apiKey1 = await apiKeysService.createApiKey(testProjectId, 'Test Key 1');
      const apiKey2 = await apiKeysService.createApiKey(testProjectId, 'Test Key 2');

      expect(apiKey1.apiKey.projectId).toBe(testProjectId);
      expect(apiKey2.apiKey.projectId).toBe(testProjectId);

      // 验证 API 密钥已创建
      const keysBefore = await apiKeysService.listApiKeys(testProjectId);
      expect(keysBefore.length).toBe(2);

      // 删除项目
      const deleted = await projectService.deleteProject(testProjectId);
      expect(deleted).toBe(true);

      // 验证 API 密钥已级联删除
      const keysAfter = await apiKeysService.listApiKeys(testProjectId);
      expect(keysAfter.length).toBe(0);
    });

    it('should delete project with database user', async () => {
      // 创建数据库用户
      const credentials = await dbCredentialsService.createProjectDbUser(
        testProjectId,
        testSchemaName
      );

      expect(credentials.username).toBeDefined();
      expect(credentials.password).toBeDefined();

      // 验证数据库用户已创建
      const userExists = await pool.query(
        'SELECT 1 FROM pg_roles WHERE rolname = $1',
        [credentials.username]
      );
      expect(userExists.rows.length).toBe(1);

      // 删除项目
      const deleted = await projectService.deleteProject(testProjectId);
      expect(deleted).toBe(true);

      // 验证数据库用户已删除
      const userAfter = await pool.query(
        'SELECT 1 FROM pg_roles WHERE rolname = $1',
        [credentials.username]
      );
      expect(userAfter.rows.length).toBe(0);
    });

    it('should delete project with tables and data', async () => {
      // 在 prod 环境创建表
      await tableService.createTable(testSchemaName, {
        name: 'test_users',
        columns: [
          { name: 'id', type: 'serial', primaryKey: true },
          { name: 'name', type: 'varchar(100)', nullable: false },
          { name: 'email', type: 'varchar(255)', nullable: false, unique: true },
        ],
      });

      // 插入一些数据
      await pool.query(
        `INSERT INTO "${testSchemaName}"."test_users" (name, email) VALUES ($1, $2)`,
        ['Test User', 'test@example.com']
      );

      // 验证表和数据已创建
      const tableExists = await pool.query(
        `SELECT table_name FROM information_schema.tables
         WHERE table_schema = $1 AND table_name = $2`,
        [testSchemaName, 'test_users']
      );
      expect(tableExists.rows.length).toBe(1);

      const dataExists = await pool.query(
        `SELECT COUNT(*) as count FROM "${testSchemaName}"."test_users"`
      );
      expect(parseInt(dataExists.rows[0].count)).toBe(1);

      // 删除项目（会自动删除 Schema 及其所有表和数据）
      const deleted = await projectService.deleteProject(testProjectId);
      expect(deleted).toBe(true);

      // 验证 Schema 已删除
      const schemaAfter = await pool.query(
        `SELECT schema_name FROM information_schema.schemata WHERE schema_name = $1`,
        [testSchemaName]
      );
      expect(schemaAfter.rows.length).toBe(0);
    });

    it('should handle deletion when project has no environments', async () => {
      // 删除所有环境记录（模拟异常情况）
      await pool.query(
        'DELETE FROM druvia_project_environments WHERE project_id = $1',
        [testProjectId]
      );

      // 删除项目应该仍然成功
      const deleted = await projectService.deleteProject(testProjectId);
      expect(deleted).toBe(true);

      // 验证项目已删除
      const project = await projectService.getProjectById(testProjectId);
      expect(project).toBeNull();
    });

    it('should handle deletion when database user does not exist', async () => {
      // 不创建数据库用户，直接删除项目
      const deleted = await projectService.deleteProject(testProjectId);
      expect(deleted).toBe(true);

      // 验证项目已删除
      const project = await projectService.getProjectById(testProjectId);
      expect(project).toBeNull();
    });

    it('should delete project with complete cleanup', async () => {
      // 创建 dev 环境
      const devEnv = await environmentService.createEnvironment(testProjectId, 'dev', false);
      expect(devEnv.schemaName).toBe(`${testSchemaName}_dev`);

      // 在 prod 环境创建表
      await tableService.createTable(testSchemaName, {
        name: 'prod_table',
        columns: [
          { name: 'id', type: 'serial', primaryKey: true },
          { name: 'data', type: 'text' },
        ],
      });

      // 在 dev 环境创建表
      await tableService.createTable(`${testSchemaName}_dev`, {
        name: 'dev_table',
        columns: [
          { name: 'id', type: 'serial', primaryKey: true },
          { name: 'data', type: 'text' },
        ],
      });

      // 创建 API 密钥
      await apiKeysService.createApiKey(testProjectId, 'Test Key');

      // 创建数据库用户
      await dbCredentialsService.createProjectDbUser(testProjectId, testSchemaName);

      // 验证所有资源已创建
      const prodTableExists = await pool.query(
        `SELECT table_name FROM information_schema.tables
         WHERE table_schema = $1 AND table_name = $2`,
        [testSchemaName, 'prod_table']
      );
      expect(prodTableExists.rows.length).toBe(1);

      const devTableExists = await pool.query(
        `SELECT table_name FROM information_schema.tables
         WHERE table_schema = $1 AND table_name = $2`,
        [`${testSchemaName}_dev`, 'dev_table']
      );
      expect(devTableExists.rows.length).toBe(1);

      const apiKeys = await apiKeysService.listApiKeys(testProjectId);
      expect(apiKeys.length).toBe(1);

      // 删除项目
      const deleted = await projectService.deleteProject(testProjectId);
      expect(deleted).toBe(true);

      // 验证所有资源已删除
      const prodSchemaAfter = await pool.query(
        `SELECT schema_name FROM information_schema.schemata WHERE schema_name = $1`,
        [testSchemaName]
      );
      expect(prodSchemaAfter.rows.length).toBe(0);

      const devSchemaAfter = await pool.query(
        `SELECT schema_name FROM information_schema.schemata WHERE schema_name = $1`,
        [`${testSchemaName}_dev`]
      );
      expect(devSchemaAfter.rows.length).toBe(0);

      const apiKeysAfter = await apiKeysService.listApiKeys(testProjectId);
      expect(apiKeysAfter.length).toBe(0);
    });

    it('should delete physical storage objects, legacy project files and project backups', async () => {
      const bucket = await storageService.createBucket(testProjectId, {
        name: 'team-assets',
        public: true,
      });

      await storageService.uploadObject(
        bucket,
        'user-avatars/avatar.png',
        Buffer.from('avatar'),
        'image/png'
      );

      const objectPath = path.join(TEST_STORAGE_PATH, testProjectId, 'team-assets', 'user-avatars', 'avatar.png');
      await expectPathExists(objectPath);

      const legacyFilePath = path.join(TEST_STORAGE_PATH, testTenantId, testProjectId, 'legacy-assets', 'legacy.txt');
      await fs.mkdir(path.dirname(legacyFilePath), { recursive: true });
      await fs.writeFile(legacyFilePath, 'legacy-file');
      await pool.query(
        `INSERT INTO druvia_files
         (file_id, tenant_id, project_id, bucket, path, filename, content_type, size_bytes, storage_provider, storage_key, metadata)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb)`,
        [
          `file_${Date.now()}`,
          testTenantId,
          testProjectId,
          'legacy-assets',
          `${testTenantId}/${testProjectId}/legacy-assets/legacy.txt`,
          'legacy.txt',
          'text/plain',
          11,
          'local',
          null,
          '{}',
        ]
      );

      const backupId = `bkp_${Date.now()}`;
      const backupStorageKey = `backups/${testTenantId}/${backupId}.dump`;
      const backupPath = path.join(TEST_STORAGE_PATH, backupStorageKey);
      await fs.mkdir(path.dirname(backupPath), { recursive: true });
      await fs.writeFile(backupPath, 'backup');
      await pool.query(
        `INSERT INTO druvia_backups
         (backup_id, tenant_id, project_id, schema_name, storage_key, status)
         VALUES ($1, $2, $3, $4, $5, 'completed')`,
        [backupId, testTenantId, testProjectId, testSchemaName, backupStorageKey]
      );

      const deleted = await projectService.deleteProject(testProjectId);
      expect(deleted).toBe(true);

      const bucketsAfter = await pool.query(
        'SELECT 1 FROM druvia_storage_buckets WHERE project_id = $1',
        [testProjectId]
      );
      expect(bucketsAfter.rows.length).toBe(0);

      const objectsAfter = await pool.query(
        `SELECT 1
         FROM druvia_storage_objects o
         JOIN druvia_storage_buckets b ON b.bucket_id = o.bucket_id
         WHERE b.project_id = $1`,
        [testProjectId]
      );
      expect(objectsAfter.rows.length).toBe(0);

      const legacyFilesAfter = await pool.query(
        'SELECT 1 FROM druvia_files WHERE project_id = $1',
        [testProjectId]
      );
      expect(legacyFilesAfter.rows.length).toBe(0);

      const backupsAfter = await pool.query(
        'SELECT 1 FROM druvia_backups WHERE project_id = $1',
        [testProjectId]
      );
      expect(backupsAfter.rows.length).toBe(0);

      await expectPathMissing(objectPath);
      await expectPathMissing(legacyFilePath);
      await expectPathMissing(backupPath);
      await expectPathMissing(path.join(TEST_STORAGE_PATH, testProjectId));
      await expectPathMissing(path.join(TEST_STORAGE_PATH, testTenantId, testProjectId));
    });
  });

  describe('Edge Cases', () => {
    it('should return false when deleting non-existent project', async () => {
      const deleted = await projectService.deleteProject('proj_nonexistent');
      expect(deleted).toBe(false);
    });

    it('should not affect other projects when deleting one', async () => {
      // 创建另一个项目
      const otherProject = await projectService.createProject({
        tenantId: testTenantId,
        alias: 'other',
        name: 'Other Project',
      });

      // 删除测试项目
      const deleted = await projectService.deleteProject(testProjectId);
      expect(deleted).toBe(true);

      // 验证另一个项目仍然存在
      const other = await projectService.getProjectById(otherProject.projectId);
      expect(other).toBeDefined();
      expect(other?.projectId).toBe(otherProject.projectId);

      // 清理
      await projectService.deleteProject(otherProject.projectId);
    });
  });
});
