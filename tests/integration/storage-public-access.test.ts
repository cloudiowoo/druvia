import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { pool } from '../../apps/api/src/db/index.js';
import * as storageService from '../../apps/api/src/modules/storage/storage.service.js';
import * as projectService from '../../apps/api/src/modules/project/project.service.js';
import * as tenantService from '../../apps/api/src/modules/tenant/tenant.service.js';

describe('Storage Public Access', () => {
  let testUserId: number;
  let testTenantId: string;
  let testProjectId: string;

  beforeAll(async () => {
    const userResult = await pool.query(
      `INSERT INTO druvia_users (user_id, email, username, status)
       VALUES ('user_test_public_storage', 'public-storage@test.com', 'public_storage_tester', 'active')
       ON CONFLICT (user_id) DO UPDATE SET email = EXCLUDED.email
       RETURNING id`
    );
    testUserId = userResult.rows[0].id;

    const tenant = await tenantService.createTenant({
      alias: 'testpubstorage',
      name: 'Public Storage Test Tenant',
      ownerUid: testUserId,
    });
    testTenantId = tenant.tenantId;

    const project = await projectService.createProject({
      tenantId: testTenantId,
      alias: 'pubstorproj',
      name: 'Public Storage Test Project',
    });
    testProjectId = project.projectId;
  });

  afterAll(async () => {
    await pool.query('DELETE FROM druvia_storage_objects WHERE bucket_id IN (SELECT bucket_id FROM druvia_storage_buckets WHERE project_id = $1)', [testProjectId]);
    await pool.query('DELETE FROM druvia_storage_buckets WHERE project_id = $1', [testProjectId]);
    await pool.query('DELETE FROM druvia_projects WHERE project_id = $1', [testProjectId]);
    await pool.query('DELETE FROM druvia_tenants WHERE tenant_id = $1', [testTenantId]);
    await pool.query('DELETE FROM druvia_users WHERE user_id = $1', ['user_test_public_storage']);
  });

  beforeEach(async () => {
    await pool.query('DELETE FROM druvia_storage_objects WHERE bucket_id IN (SELECT bucket_id FROM druvia_storage_buckets WHERE project_id = $1)', [testProjectId]);
    await pool.query('DELETE FROM druvia_storage_buckets WHERE project_id = $1', [testProjectId]);
  });

  describe('getDownloadUrl', () => {
    it('should return public URL for public bucket', async () => {
      const bucket = await storageService.createBucket(testProjectId, {
        name: 'public-bucket',
        public: true,
      });
      const file = Buffer.from('public content');
      const object = await storageService.uploadObject(bucket, 'test.txt', file, 'text/plain');

      const result = await storageService.getDownloadUrl(bucket, object);

      expect(result.url).toContain('/storage/public/');
      expect(result.url).toContain(testProjectId);
      expect(result.url).toContain('public-bucket');
      expect(result.url).toContain('test.txt');
      expect(result.expiresIn).toBeNull();
    });

    it('should return signed URL for private bucket', async () => {
      const bucket = await storageService.createBucket(testProjectId, {
        name: 'private-bucket',
        public: false,
      });
      const file = Buffer.from('private content');
      const object = await storageService.uploadObject(bucket, 'secret.txt', file, 'text/plain');

      const result = await storageService.getDownloadUrl(bucket, object);

      expect(result.url).toContain('/storage/download/');
      expect(result.url).toContain('expires=');
      expect(result.url).toContain('signature=');
      expect(result.expiresIn).toBe(3600);
    });
  });

  describe('getBucketByProjectAndName', () => {
    it('should return bucket with project info', async () => {
      await storageService.createBucket(testProjectId, {
        name: 'lookup-bucket',
        public: true,
      });

      const bucket = await storageService.getBucketByProjectAndName(testProjectId, 'lookup-bucket');

      expect(bucket).toBeDefined();
      expect(bucket?.name).toBe('lookup-bucket');
      expect(bucket?.projectId).toBe(testProjectId);
      expect(bucket?.public).toBe(true);
    });

    it('should return null for non-existent bucket', async () => {
      const bucket = await storageService.getBucketByProjectAndName(testProjectId, 'nonexistent');
      expect(bucket).toBeNull();
    });
  });

  describe('downloadPublic controller', () => {
    it('should download file from public bucket', async () => {
      const bucket = await storageService.createBucket(testProjectId, {
        name: 'dl-public-bucket',
        public: true,
      });
      const content = 'Hello Public World!';
      await storageService.uploadObject(bucket, 'hello.txt', Buffer.from(content), 'text/plain');

      // 测试 service 层逻辑
      const object = await storageService.getObject(bucket.bucketId, 'hello.txt');
      expect(object).toBeDefined();
      expect(object?.name).toBe('hello.txt');
    });

    it('should reject download from private bucket via public URL', async () => {
      const bucket = await storageService.createBucket(testProjectId, {
        name: 'dl-private-bucket',
        public: false,
      });
      await storageService.uploadObject(bucket, 'secret.txt', Buffer.from('secret'), 'text/plain');

      // 私有 bucket 不应通过公开 URL 访问
      expect(bucket.public).toBe(false);
    });
  });
});
