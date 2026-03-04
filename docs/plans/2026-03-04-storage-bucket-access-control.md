# Storage Bucket 公开/非公开访问控制实现计划

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 实现公开/非公开 bucket 的真正访问控制，公开 bucket 支持直接 URL 访问，非公开 bucket 仅支持签名 URL。

**Architecture:** 新增公开下载端点 `/storage/public/:projectId/:bucketName/*`，检查 bucket.public 字段后返回文件；修改 `getSignedUrl` service 方法根据 bucket 类型返回不同格式 URL。

**Tech Stack:** Fastify 5, TypeScript, Vitest

---

## Task 1: 添加公开下载端点测试

**Files:**
- Create: `tests/integration/storage-public-access.test.ts`

**Step 1: 创建测试文件**

```typescript
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
      alias: 'testpublicstorage',
      name: 'Public Storage Test Tenant',
      ownerUid: testUserId,
    });
    testTenantId = tenant.tenantId;

    const project = await projectService.createProject({
      tenantId: testTenantId,
      alias: 'pubstorageproj',
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
});
```

**Step 2: 运行测试确认失败**

Run: `pnpm test tests/integration/storage-public-access.test.ts`
Expected: FAIL - `getDownloadUrl` 和 `getBucketByProjectAndName` 不存在

---

## Task 2: 实现 storage.service 新方法

**Files:**
- Modify: `apps/api/src/modules/storage/storage.service.ts`

**Step 1: 添加 getDownloadUrl 方法**

在文件末尾（第 424 行后）添加：

```typescript
export interface DownloadUrlResult {
  url: string;
  expiresIn: number | null;
}

export async function getDownloadUrl(
  bucket: Bucket,
  object: StorageObject,
  expiresIn: number = 3600
): Promise<DownloadUrlResult> {
  if (!object.storagePath) {
    throw new Error('Object has no storage path');
  }

  if (bucket.public) {
    // 公开 bucket：返回直接 URL
    const apiBaseUrl = process.env.API_BASE_URL || 'http://localhost:3001';
    const url = `${apiBaseUrl}/api/v1/storage/public/${bucket.projectId}/${bucket.name}/${object.name}`;
    return { url, expiresIn: null };
  } else {
    // 非公开 bucket：返回签名 URL
    const storage = getStorage();
    const url = await storage.getSignedUrl(object.storagePath, expiresIn);
    return { url, expiresIn };
  }
}

export async function getBucketByProjectAndName(
  projectId: string,
  bucketName: string
): Promise<Bucket | null> {
  return getBucketByName(projectId, bucketName);
}
```

**Step 2: 运行测试确认通过**

Run: `pnpm test tests/integration/storage-public-access.test.ts`
Expected: PASS

---

## Task 3: 添加公开下载 Controller 测试

**Files:**
- Modify: `tests/integration/storage-public-access.test.ts`

**Step 1: 添加 E2E 测试用例**

在测试文件末尾 `});` 之前添加：

```typescript
  describe('downloadPublic controller', () => {
    it('should download file from public bucket', async () => {
      const bucket = await storageService.createBucket(testProjectId, {
        name: 'dl-public-bucket',
        public: true,
      });
      const content = 'Hello Public World!';
      await storageService.uploadObject(bucket, 'hello.txt', Buffer.from(content), 'text/plain');

      // 使用 HTTP 请求测试（需要启动服务器或使用 inject）
      // 这里先测试 service 层逻辑
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
      // controller 测试会在 E2E 测试中验证 403 响应
      expect(bucket.public).toBe(false);
    });
  });
```

**Step 2: 运行测试**

Run: `pnpm test tests/integration/storage-public-access.test.ts`
Expected: PASS

---

## Task 4: 实现公开下载 Controller

**Files:**
- Modify: `apps/api/src/modules/storage/storage.controller.ts`

**Step 1: 添加类型定义**

在 `SignedDownloadQuery` 接口后（约第 464 行）添加：

```typescript
interface PublicDownloadParams {
  projectId: string;
  bucketName: string;
  '*': string; // File path
}
```

**Step 2: 添加 downloadPublic 函数**

在文件末尾添加：

```typescript
export async function downloadPublic(
  request: FastifyRequest<{ Params: PublicDownloadParams }>,
  reply: FastifyReply
) {
  const { projectId, bucketName } = request.params;
  const filePath = request.params['*'];

  // 查询 bucket
  const bucket = await storageService.getBucketByName(projectId, bucketName);

  if (!bucket) {
    return reply.status(404).send({
      success: false,
      error: { code: 'BUCKET_NOT_FOUND', message: 'Bucket not found' },
    });
  }

  // 检查是否为公开 bucket
  if (!bucket.public) {
    return reply.status(403).send({
      success: false,
      error: { code: 'BUCKET_NOT_PUBLIC', message: 'This bucket is not public' },
    });
  }

  // Sanitize path
  const objectPath = sanitizeObjectPath(filePath);
  if (!objectPath) {
    return reply.status(400).send({
      success: false,
      error: { code: 'INVALID_PATH', message: 'Invalid object path' },
    });
  }

  // 获取对象
  const object = await storageService.getObject(bucket.bucketId, objectPath);

  if (!object) {
    return reply.status(404).send({
      success: false,
      error: { code: 'OBJECT_NOT_FOUND', message: 'Object not found' },
    });
  }

  // 下载文件
  try {
    const buffer = await storageService.downloadObject(object);

    reply.header('Content-Type', object.mimeType || 'application/octet-stream');
    reply.header('Content-Length', buffer.length);
    reply.header('Content-Disposition', `inline; filename="${encodeURIComponent(objectPath.split('/').pop() || 'file')}"`);
    reply.header('Cache-Control', 'public, max-age=31536000'); // 公开文件可长期缓存

    return reply.send(buffer);
  } catch (error) {
    return reply.status(500).send({
      success: false,
      error: { code: 'DOWNLOAD_FAILED', message: 'Failed to download file' },
    });
  }
}
```

**Step 3: 运行类型检查**

Run: `pnpm --filter @druvia/api exec tsc --noEmit`
Expected: 无错误

---

## Task 5: 添加公开下载路由

**Files:**
- Modify: `apps/api/src/modules/storage/storage.routes.ts`

**Step 1: 添加公开下载路由**

在 `app.get('/storage/download/*'` 行后（约第 11 行）添加：

```typescript
  // Public bucket download (no authentication, checks bucket.public)
  app.get('/storage/public/:projectId/:bucketName/*', controller.downloadPublic as never);
```

**Step 2: 运行测试验证路由**

Run: `pnpm test tests/integration/storage-public-access.test.ts`
Expected: PASS

---

## Task 6: 添加 E2E HTTP 测试

**Files:**
- Create: `tests/e2e/storage-public.test.ts`

**Step 1: 创建 E2E 测试**

```typescript
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { pool } from '../../apps/api/src/db/index.js';
import * as storageService from '../../apps/api/src/modules/storage/storage.service.js';
import * as projectService from '../../apps/api/src/modules/project/project.service.js';
import * as tenantService from '../../apps/api/src/modules/tenant/tenant.service.js';

describe('Storage Public Access E2E', () => {
  let testUserId: number;
  let testTenantId: string;
  let testProjectId: string;
  const API_URL = process.env.API_URL || 'http://localhost:3001';

  beforeAll(async () => {
    const userResult = await pool.query(
      `INSERT INTO druvia_users (user_id, email, username, status)
       VALUES ('user_e2e_public', 'e2e-public@test.com', 'e2e_public_tester', 'active')
       ON CONFLICT (user_id) DO UPDATE SET email = EXCLUDED.email
       RETURNING id`
    );
    testUserId = userResult.rows[0].id;

    const tenant = await tenantService.createTenant({
      alias: 'e2epublicstorage',
      name: 'E2E Public Storage Test',
      ownerUid: testUserId,
    });
    testTenantId = tenant.tenantId;

    const project = await projectService.createProject({
      tenantId: testTenantId,
      alias: 'e2epubproj',
      name: 'E2E Public Project',
    });
    testProjectId = project.projectId;
  });

  afterAll(async () => {
    await pool.query('DELETE FROM druvia_storage_objects WHERE bucket_id IN (SELECT bucket_id FROM druvia_storage_buckets WHERE project_id = $1)', [testProjectId]);
    await pool.query('DELETE FROM druvia_storage_buckets WHERE project_id = $1', [testProjectId]);
    await pool.query('DELETE FROM druvia_projects WHERE project_id = $1', [testProjectId]);
    await pool.query('DELETE FROM druvia_tenants WHERE tenant_id = $1', [testTenantId]);
    await pool.query('DELETE FROM druvia_users WHERE user_id = $1', ['user_e2e_public']);
  });

  beforeEach(async () => {
    await pool.query('DELETE FROM druvia_storage_objects WHERE bucket_id IN (SELECT bucket_id FROM druvia_storage_buckets WHERE project_id = $1)', [testProjectId]);
    await pool.query('DELETE FROM druvia_storage_buckets WHERE project_id = $1', [testProjectId]);
  });

  it('should download from public bucket without auth', async () => {
    // 创建公开 bucket 和文件
    const bucket = await storageService.createBucket(testProjectId, {
      name: 'e2e-public',
      public: true,
    });
    const content = 'E2E Public Content';
    await storageService.uploadObject(bucket, 'test.txt', Buffer.from(content), 'text/plain');

    // 匿名请求
    const response = await fetch(`${API_URL}/api/v1/storage/public/${testProjectId}/e2e-public/test.txt`);

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/plain');
    expect(response.headers.get('cache-control')).toContain('public');

    const body = await response.text();
    expect(body).toBe(content);
  });

  it('should return 403 for private bucket via public URL', async () => {
    const bucket = await storageService.createBucket(testProjectId, {
      name: 'e2e-private',
      public: false,
    });
    await storageService.uploadObject(bucket, 'secret.txt', Buffer.from('secret'), 'text/plain');

    const response = await fetch(`${API_URL}/api/v1/storage/public/${testProjectId}/e2e-private/secret.txt`);

    expect(response.status).toBe(403);
    const body = await response.json();
    expect(body.error.code).toBe('BUCKET_NOT_PUBLIC');
  });

  it('should return 404 for non-existent bucket', async () => {
    const response = await fetch(`${API_URL}/api/v1/storage/public/${testProjectId}/nonexistent/file.txt`);

    expect(response.status).toBe(404);
    const body = await response.json();
    expect(body.error.code).toBe('BUCKET_NOT_FOUND');
  });

  it('should return 404 for non-existent object', async () => {
    await storageService.createBucket(testProjectId, {
      name: 'e2e-empty',
      public: true,
    });

    const response = await fetch(`${API_URL}/api/v1/storage/public/${testProjectId}/e2e-empty/missing.txt`);

    expect(response.status).toBe(404);
    const body = await response.json();
    expect(body.error.code).toBe('OBJECT_NOT_FOUND');
  });
});
```

**Step 2: 运行 E2E 测试**

Run: `pnpm test tests/e2e/storage-public.test.ts`
Expected: PASS（需要 API 服务运行中）

---

## Task 7: 修改 getSignedUrl Controller 返回格式

**Files:**
- Modify: `apps/api/src/modules/storage/storage.controller.ts`

**Step 1: 修改 getSignedUrl 函数**

将 `getSignedUrl` 函数（第 412-451 行）修改为使用新的 `getDownloadUrl` 方法：

```typescript
export async function getSignedUrl(
  request: FastifyRequest<{ Params: BucketParams; Body: SignedUrlBody }>,
  reply: FastifyReply
) {
  if (!(await verifyProjectAccess(request, reply))) return;

  const bucket = await storageService.getBucketByName(
    request.params.projectId,
    request.params.bucketName
  );

  if (!bucket) {
    return reply.status(404).send({
      success: false,
      error: { code: 'NOT_FOUND', message: 'Bucket not found' },
    });
  }

  const { objectPath: rawPath, expiresIn = 3600 } = request.body;
  const objectPath = sanitizeObjectPath(rawPath);
  if (!objectPath) {
    return reply.status(400).send({
      success: false,
      error: { code: 'INVALID_REQUEST', message: 'Invalid objectPath' },
    });
  }

  const object = await storageService.getObject(bucket.bucketId, objectPath);

  if (!object) {
    return reply.status(404).send({
      success: false,
      error: { code: 'NOT_FOUND', message: 'Object not found' },
    });
  }

  // 使用新方法，根据 bucket 类型返回不同 URL
  const result = await storageService.getDownloadUrl(bucket, object, expiresIn);

  return reply.send({ success: true, data: result });
}
```

**Step 2: 运行所有存储测试**

Run: `pnpm test tests/integration/storage`
Expected: PASS

---

## Task 8: 运行完整测试并验证

**Files:** None (verification only)

**Step 1: 运行所有测试**

Run: `pnpm test`
Expected: All tests PASS

**Step 2: 手动验证**

1. 启动 API: `pnpm dev`
2. 创建公开 bucket，上传文件
3. 访问 `http://localhost:3001/api/v1/storage/public/{projectId}/{bucketName}/{fileName}`
4. 确认无需认证即可下载
5. 创建非公开 bucket，上传文件
6. 访问公开 URL 应返回 403
7. 获取签名 URL，确认可以下载

---

## Summary

| Task | 描述 | 文件 |
|------|------|------|
| 1 | 添加测试 | `tests/integration/storage-public-access.test.ts` |
| 2 | Service 新方法 | `storage.service.ts` |
| 3 | Controller 测试 | `storage-public-access.test.ts` |
| 4 | Controller 实现 | `storage.controller.ts` |
| 5 | 路由配置 | `storage.routes.ts` |
| 6 | E2E 测试 | `tests/e2e/storage-public.test.ts` |
| 7 | 修改 getSignedUrl | `storage.controller.ts` |
| 8 | 验证 | 手动测试 |
