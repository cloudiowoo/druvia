import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { pool } from '../../apps/api/src/db/index.js';
import * as storageService from '../../apps/api/src/modules/storage/storage.service.js';
import * as projectService from '../../apps/api/src/modules/project/project.service.js';
import * as tenantService from '../../apps/api/src/modules/tenant/tenant.service.js';

describe('StorageService Integration', () => {
  let testUserId: number;
  let testTenantId: string;
  let testProjectId: string;

  beforeAll(async () => {
    // 创建测试用户
    const userResult = await pool.query(
      `INSERT INTO druvia_users (user_id, email, username, status)
       VALUES ('user_test_storage', 'storage-test@test.com', 'storage_tester', 'active')
       ON CONFLICT (user_id) DO UPDATE SET email = EXCLUDED.email
       RETURNING id`
    );
    testUserId = userResult.rows[0].id;

    // 创建测试租户
    const tenant = await tenantService.createTenant({
      alias: 'teststorage',
      name: 'Storage Test Tenant',
      ownerUid: testUserId,
    });
    testTenantId = tenant.tenantId;

    // 创建测试项目
    const project = await projectService.createProject({
      tenantId: testTenantId,
      alias: 'storageproj',
      name: 'Storage Test Project',
    });
    testProjectId = project.projectId;
  });

  afterAll(async () => {
    // 清理测试数据
    await pool.query('DELETE FROM druvia_storage_objects WHERE bucket_id IN (SELECT bucket_id FROM druvia_storage_buckets WHERE project_id = $1)', [testProjectId]);
    await pool.query('DELETE FROM druvia_storage_buckets WHERE project_id = $1', [testProjectId]);
    await pool.query('DELETE FROM druvia_projects WHERE project_id = $1', [testProjectId]);
    await pool.query('DELETE FROM druvia_tenants WHERE tenant_id = $1', [testTenantId]);
    await pool.query('DELETE FROM druvia_users WHERE user_id = $1', ['user_test_storage']);
  });

  beforeEach(async () => {
    // 每个测试前清理 bucket 数据
    await pool.query('DELETE FROM druvia_storage_objects WHERE bucket_id IN (SELECT bucket_id FROM druvia_storage_buckets WHERE project_id = $1)', [testProjectId]);
    await pool.query('DELETE FROM druvia_storage_buckets WHERE project_id = $1', [testProjectId]);
  });

  describe('Bucket CRUD', () => {
    it('should create a bucket', async () => {
      const bucket = await storageService.createBucket(testProjectId, {
        name: 'test-bucket',
        public: false,
      });

      expect(bucket).toBeDefined();
      expect(bucket.bucketId).toMatch(/^bucket_/);
      expect(bucket.name).toBe('test-bucket');
      expect(bucket.projectId).toBe(testProjectId);
      expect(bucket.public).toBe(false);
    });

    it('should list buckets', async () => {
      await storageService.createBucket(testProjectId, { name: 'bucket-1' });
      await storageService.createBucket(testProjectId, { name: 'bucket-2' });

      const buckets = await storageService.listBuckets(testProjectId);

      expect(buckets).toHaveLength(2);
      expect(buckets.map(b => b.name).sort()).toEqual(['bucket-1', 'bucket-2']);
    });

    it('should get bucket by name', async () => {
      await storageService.createBucket(testProjectId, { name: 'find-me' });

      const bucket = await storageService.getBucketByName(testProjectId, 'find-me');

      expect(bucket).toBeDefined();
      expect(bucket?.name).toBe('find-me');
    });

    it('should return null for non-existent bucket', async () => {
      const bucket = await storageService.getBucketByName(testProjectId, 'does-not-exist');
      expect(bucket).toBeNull();
    });

    it('should update bucket', async () => {
      await storageService.createBucket(testProjectId, { name: 'update-me', public: false });

      const updated = await storageService.updateBucket(testProjectId, 'update-me', {
        public: true,
        fileSizeLimit: 1024 * 1024,
      });

      expect(updated?.public).toBe(true);
      expect(updated?.fileSizeLimit).toBe(1024 * 1024);
    });

    it('should delete empty bucket', async () => {
      await storageService.createBucket(testProjectId, { name: 'delete-me' });

      const deleted = await storageService.deleteBucket(testProjectId, 'delete-me');

      expect(deleted).toBe(true);
      const bucket = await storageService.getBucketByName(testProjectId, 'delete-me');
      expect(bucket).toBeNull();
    });

    it('should reject deleting non-empty bucket', async () => {
      const bucket = await storageService.createBucket(testProjectId, { name: 'has-objects' });

      // 直接插入对象记录来模拟非空桶
      await pool.query(
        `INSERT INTO druvia_storage_objects (object_id, bucket_id, name, size, mime_type)
         VALUES ('obj_test', $1, 'test.txt', 100, 'text/plain')`,
        [bucket.bucketId]
      );

      await expect(storageService.deleteBucket(testProjectId, 'has-objects'))
        .rejects.toThrow('not empty');
    });

    it('should reject duplicate bucket names', async () => {
      await storageService.createBucket(testProjectId, { name: 'unique-bucket' });

      await expect(storageService.createBucket(testProjectId, { name: 'unique-bucket' }))
        .rejects.toThrow();
    });
  });

  describe('Object CRUD', () => {
    let testBucket: Awaited<ReturnType<typeof storageService.createBucket>>;

    beforeEach(async () => {
      testBucket = await storageService.createBucket(testProjectId, { name: 'objects-bucket' });
    });

    it('should upload object', async () => {
      const file = Buffer.from('Hello, World!');
      const object = await storageService.uploadObject(
        testBucket,
        'hello.txt',
        file,
        'text/plain',
        {
          createdByType: 'platform_user',
          platformUserId: 'user_test_storage',
        }
      );

      expect(object).toBeDefined();
      expect(object.objectId).toMatch(/^obj_/);
      expect(object.name).toBe('hello.txt');
      expect(object.size).toBe(13);
      expect(object.mimeType).toBe('text/plain');
    });

    it('should persist upload audit metadata and refresh it on same-path re-upload', async () => {
      await storageService.uploadObject(
        testBucket,
        'avatars/user-1.png',
        Buffer.from('version 1'),
        'image/png',
        {
          createdByType: 'platform_user',
          platformUserId: 'user_test_storage',
          sourceFunction: 'upload-avatar',
        }
      );

      const firstObject = await storageService.getObject(testBucket.bucketId, 'avatars/user-1.png');
      expect(firstObject?.metadata).toMatchObject({
        created_by_type: 'platform_user',
        created_by_platform_user_id: 'user_test_storage',
        source_function: 'upload-avatar',
      });
      expect(firstObject?.metadata.created_by_project_user_id).toBeUndefined();

      await storageService.uploadObject(
        testBucket,
        'avatars/user-1.png',
        Buffer.from('version 2'),
        'image/png',
        {
          createdByType: 'project_user',
          projectUserId: 'pu_123',
          sourceFunction: 'upload-team-logo',
        }
      );

      const secondObject = await storageService.getObject(testBucket.bucketId, 'avatars/user-1.png');
      expect(secondObject?.metadata).toMatchObject({
        created_by_type: 'project_user',
        created_by_project_user_id: 'pu_123',
        source_function: 'upload-team-logo',
      });
      expect(secondObject?.metadata.created_by_platform_user_id).toBeUndefined();

      const content = await storageService.downloadObject(secondObject!);
      expect(content.toString()).toBe('version 2');
    });

    it('should persist trusted storage ticket audit metadata on upload', async () => {
      await storageService.uploadObject(
        testBucket,
        'user-avatars/user-1.png',
        Buffer.from('ticket upload'),
        'image/png',
        {
          createdByType: 'trusted_backend_project_user',
          projectUserId: 'usr_proj_1',
          issuedBy: 'drutb_123',
          issuedVia: 'trusted_storage_ticket',
        }
      );

      const object = await storageService.getObject(testBucket.bucketId, 'user-avatars/user-1.png');
      expect(object?.metadata).toMatchObject({
        created_by_type: 'trusted_backend_project_user',
        created_by_project_user_id: 'usr_proj_1',
        issued_by: 'drutb_123',
        issued_via: 'trusted_storage_ticket',
      });
      expect(object?.metadata.created_by_platform_user_id).toBeUndefined();
    });

    it('should list objects', async () => {
      await storageService.uploadObject(testBucket, 'file1.txt', Buffer.from('1'), 'text/plain');
      await storageService.uploadObject(testBucket, 'file2.txt', Buffer.from('2'), 'text/plain');

      const result = await storageService.listObjects(testBucket.bucketId);

      expect(result.objects).toHaveLength(2);
      expect(result.total).toBe(2);
    });

    it('should list objects with prefix', async () => {
      await storageService.uploadObject(testBucket, 'docs/readme.txt', Buffer.from('1'), 'text/plain');
      await storageService.uploadObject(testBucket, 'docs/guide.txt', Buffer.from('2'), 'text/plain');
      await storageService.uploadObject(testBucket, 'images/logo.png', Buffer.from('3'), 'image/png');

      const result = await storageService.listObjects(testBucket.bucketId, { prefix: 'docs/' });

      expect(result.objects).toHaveLength(2);
      expect(result.objects.every(o => o.name.startsWith('docs/'))).toBe(true);
    });

    it('should get object', async () => {
      await storageService.uploadObject(testBucket, 'get-me.txt', Buffer.from('content'), 'text/plain');

      const object = await storageService.getObject(testBucket.bucketId, 'get-me.txt');

      expect(object).toBeDefined();
      expect(object?.name).toBe('get-me.txt');
    });

    it('should download object', async () => {
      const content = 'Download test content';
      await storageService.uploadObject(testBucket, 'download.txt', Buffer.from(content), 'text/plain');

      const object = await storageService.getObject(testBucket.bucketId, 'download.txt');
      const buffer = await storageService.downloadObject(object!);

      expect(buffer.toString()).toBe(content);
    });

    it('should delete object', async () => {
      await storageService.uploadObject(testBucket, 'delete-me.txt', Buffer.from('bye'), 'text/plain');

      const deleted = await storageService.deleteObject(testBucket.bucketId, 'delete-me.txt');

      expect(deleted).toBe(true);
      const object = await storageService.getObject(testBucket.bucketId, 'delete-me.txt');
      expect(object).toBeNull();
    });

    it('should respect file size limit', async () => {
      const limitedBucket = await storageService.createBucket(testProjectId, {
        name: 'limited-bucket',
        fileSizeLimit: 10, // 10 bytes limit
      });

      const largeFile = Buffer.alloc(100); // 100 bytes

      await expect(storageService.uploadObject(limitedBucket, 'large.bin', largeFile, 'application/octet-stream'))
        .rejects.toThrow('exceeds limit');
    });

    it('should respect allowed mime types', async () => {
      const imageBucket = await storageService.createBucket(testProjectId, {
        name: 'images-only',
        allowedMimeTypes: ['image/png', 'image/jpeg'],
      });

      await expect(storageService.uploadObject(imageBucket, 'doc.txt', Buffer.from('text'), 'text/plain'))
        .rejects.toThrow('not allowed');

      // But images should work
      const image = await storageService.uploadObject(imageBucket, 'pic.png', Buffer.from('fake png'), 'image/png');
      expect(image).toBeDefined();
    });

    it('should replace existing object on re-upload', async () => {
      await storageService.uploadObject(testBucket, 'replace.txt', Buffer.from('version 1'), 'text/plain');
      await storageService.uploadObject(testBucket, 'replace.txt', Buffer.from('version 2'), 'text/plain');

      const object = await storageService.getObject(testBucket.bucketId, 'replace.txt');
      const content = await storageService.downloadObject(object!);

      expect(content.toString()).toBe('version 2');

      // Should still only have one object with that name
      const result = await storageService.listObjects(testBucket.bucketId);
      const replaceObjects = result.objects.filter(o => o.name === 'replace.txt');
      expect(replaceObjects).toHaveLength(1);
    });
  });
});
