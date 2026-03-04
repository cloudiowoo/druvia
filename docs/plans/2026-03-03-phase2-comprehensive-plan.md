# Phase 2 综合实施计划

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 完成 Druvia MVP 核心功能，包括管理界面补充、计算能力和可视化增强

**相关文档:**
- [战略设计文档](./2026-03-03-druvia-strategy-design.md) - 产品定位和功能规划
- [开发者体验设计](./2026-03-02-developer-experience-design.md) - 技术方案详情
- [原 Phase 2 计划](./2026-03-02-phase2-implementation.md) - SQL 编辑器详细实现

**创建日期**: 2026-03-03
**状态**: 待实施

---

## 实施阶段概览

```
┌─────────────────────────────────────────────────────────────┐
│ Phase 2.1: 管理界面补充                                      │
│ ├── M18: Storage 管理界面 (含后端重构)                       │
│ ├── M17: Authentication 管理界面                             │
│ └── M20: Realtime 管理界面                                   │
├─────────────────────────────────────────────────────────────┤
│ Phase 2.2: SQL 编辑器 + 计算能力                             │
│ ├── M3: SQL 编辑器增强 (多标签、语法高亮)                    │
│ └── M19: Edge Functions (Deno Worker)                        │
├─────────────────────────────────────────────────────────────┤
│ Phase 2.3: 可视化增强                                        │
│ └── M7: ER 图可视化                                          │
└─────────────────────────────────────────────────────────────┘
```

---

## Phase 2.1: 管理界面补充

### M18: Storage 管理界面

**优先级**: 最高 (后端已有适配器，需重构数据模型)

#### 数据库迁移

**Files:**
- Create: `migrations/007_storage_redesign.sql`

```sql
-- Storage 重构迁移脚本
-- 采用 S3 模型：Buckets + Objects 分离

BEGIN;

-- 1. 创建新表结构
CREATE TABLE IF NOT EXISTS druvia_storage_buckets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID REFERENCES druvia_projects(id) ON DELETE CASCADE,
  name VARCHAR(255) NOT NULL,
  public BOOLEAN DEFAULT false,
  file_size_limit BIGINT,
  allowed_mime_types TEXT[],
  cors_config JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(project_id, name)
);

CREATE TABLE IF NOT EXISTS druvia_storage_objects (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  bucket_id UUID REFERENCES druvia_storage_buckets(id) ON DELETE CASCADE,
  name VARCHAR(1024) NOT NULL,
  size BIGINT NOT NULL,
  mime_type VARCHAR(255),
  etag VARCHAR(255),
  storage_provider VARCHAR(50),
  storage_path VARCHAR(1024),
  metadata JSONB DEFAULT '{}',
  created_by UUID,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(bucket_id, name)
);

-- 2. 创建索引
CREATE INDEX IF NOT EXISTS idx_storage_buckets_project ON druvia_storage_buckets(project_id);
CREATE INDEX IF NOT EXISTS idx_storage_objects_bucket ON druvia_storage_objects(bucket_id);
CREATE INDEX IF NOT EXISTS idx_storage_objects_created ON druvia_storage_objects(created_at DESC);

-- 3. 数据迁移 (从 druvia_files 迁移)
-- 注：需要先为每个 project 创建默认 bucket，再迁移文件

-- 3.1 为每个有文件的 project 创建默认 bucket
INSERT INTO druvia_storage_buckets (project_id, name, public, created_at)
SELECT DISTINCT f.project_id, 'default', false, NOW()
FROM druvia_files f
WHERE f.project_id IS NOT NULL
ON CONFLICT (project_id, name) DO NOTHING;

-- 3.2 迁移文件到 objects 表
INSERT INTO druvia_storage_objects (
  bucket_id, name, size, mime_type, storage_provider, storage_path, metadata, created_at
)
SELECT
  b.id,
  f.filename,
  f.size,
  f.mime_type,
  f.storage_provider,
  f.storage_key,
  COALESCE(f.metadata, '{}')::jsonb,
  f.created_at
FROM druvia_files f
JOIN druvia_storage_buckets b ON b.project_id = f.project_id AND b.name = 'default'
WHERE f.project_id IS NOT NULL;

-- 4. 保留旧表（后续手动删除）
-- ALTER TABLE druvia_files RENAME TO druvia_files_deprecated;

COMMIT;
```

#### 后端 API 实现

**Files:**
- Create: `apps/api/src/modules/storage/storage.service.ts`
- Create: `apps/api/src/modules/storage/storage.routes.ts`
- Create: `apps/api/src/modules/storage/storage.controller.ts`
- Modify: `apps/api/src/routes.ts` (注册路由)

**Task M18-1: Storage Service**

```typescript
// apps/api/src/modules/storage/storage.service.ts
import { pool } from '@/lib/db';
import { createStorageAdapter } from '@/adapters/storage';
import type { StorageAdapter } from '@/adapters/storage/types';

export interface Bucket {
  id: string;
  projectId: string;
  name: string;
  public: boolean;
  fileSizeLimit: number | null;
  allowedMimeTypes: string[] | null;
  corsConfig: Record<string, unknown> | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface StorageObject {
  id: string;
  bucketId: string;
  name: string;
  size: number;
  mimeType: string | null;
  etag: string | null;
  storageProvider: string | null;
  storagePath: string | null;
  metadata: Record<string, unknown>;
  createdBy: string | null;
  createdAt: Date;
  updatedAt: Date;
}

// Bucket CRUD
export async function listBuckets(projectId: string): Promise<Bucket[]> {
  const result = await pool.query(
    `SELECT * FROM druvia_storage_buckets WHERE project_id = $1 ORDER BY name`,
    [projectId]
  );
  return result.rows.map(mapBucketRow);
}

export async function createBucket(
  projectId: string,
  data: { name: string; public?: boolean; fileSizeLimit?: number; allowedMimeTypes?: string[] }
): Promise<Bucket> {
  const result = await pool.query(
    `INSERT INTO druvia_storage_buckets (project_id, name, public, file_size_limit, allowed_mime_types)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING *`,
    [projectId, data.name, data.public || false, data.fileSizeLimit, data.allowedMimeTypes]
  );
  return mapBucketRow(result.rows[0]);
}

export async function getBucket(projectId: string, bucketName: string): Promise<Bucket | null> {
  const result = await pool.query(
    `SELECT * FROM druvia_storage_buckets WHERE project_id = $1 AND name = $2`,
    [projectId, bucketName]
  );
  return result.rows[0] ? mapBucketRow(result.rows[0]) : null;
}

export async function updateBucket(
  projectId: string,
  bucketName: string,
  data: Partial<{ public: boolean; fileSizeLimit: number; allowedMimeTypes: string[]; corsConfig: Record<string, unknown> }>
): Promise<Bucket | null> {
  const setClauses: string[] = [];
  const values: unknown[] = [];
  let paramIndex = 3;

  if (data.public !== undefined) {
    setClauses.push(`public = $${paramIndex++}`);
    values.push(data.public);
  }
  if (data.fileSizeLimit !== undefined) {
    setClauses.push(`file_size_limit = $${paramIndex++}`);
    values.push(data.fileSizeLimit);
  }
  if (data.allowedMimeTypes !== undefined) {
    setClauses.push(`allowed_mime_types = $${paramIndex++}`);
    values.push(data.allowedMimeTypes);
  }
  if (data.corsConfig !== undefined) {
    setClauses.push(`cors_config = $${paramIndex++}`);
    values.push(JSON.stringify(data.corsConfig));
  }

  if (setClauses.length === 0) return getBucket(projectId, bucketName);

  setClauses.push(`updated_at = NOW()`);

  const result = await pool.query(
    `UPDATE druvia_storage_buckets SET ${setClauses.join(', ')}
     WHERE project_id = $1 AND name = $2 RETURNING *`,
    [projectId, bucketName, ...values]
  );
  return result.rows[0] ? mapBucketRow(result.rows[0]) : null;
}

export async function deleteBucket(projectId: string, bucketName: string): Promise<boolean> {
  // 检查桶是否为空
  const bucket = await getBucket(projectId, bucketName);
  if (!bucket) return false;

  const countResult = await pool.query(
    `SELECT COUNT(*) FROM druvia_storage_objects WHERE bucket_id = $1`,
    [bucket.id]
  );
  if (parseInt(countResult.rows[0].count) > 0) {
    throw new Error('Bucket is not empty');
  }

  const result = await pool.query(
    `DELETE FROM druvia_storage_buckets WHERE project_id = $1 AND name = $2`,
    [projectId, bucketName]
  );
  return result.rowCount > 0;
}

// Object CRUD
export async function listObjects(
  bucketId: string,
  options?: { prefix?: string; limit?: number; offset?: number }
): Promise<{ objects: StorageObject[]; total: number }> {
  let whereClause = 'WHERE bucket_id = $1';
  const values: unknown[] = [bucketId];
  let paramIndex = 2;

  if (options?.prefix) {
    whereClause += ` AND name LIKE $${paramIndex++}`;
    values.push(`${options.prefix}%`);
  }

  const countResult = await pool.query(
    `SELECT COUNT(*) FROM druvia_storage_objects ${whereClause}`,
    values
  );

  let query = `SELECT * FROM druvia_storage_objects ${whereClause} ORDER BY name`;
  if (options?.limit) {
    query += ` LIMIT $${paramIndex++}`;
    values.push(options.limit);
  }
  if (options?.offset) {
    query += ` OFFSET $${paramIndex++}`;
    values.push(options.offset);
  }

  const result = await pool.query(query, values);
  return {
    objects: result.rows.map(mapObjectRow),
    total: parseInt(countResult.rows[0].count),
  };
}

export async function uploadObject(
  bucket: Bucket,
  name: string,
  file: Buffer,
  mimeType: string,
  userId?: string
): Promise<StorageObject> {
  // 验证文件大小
  if (bucket.fileSizeLimit && file.length > bucket.fileSizeLimit) {
    throw new Error(`File size exceeds limit of ${bucket.fileSizeLimit} bytes`);
  }

  // 验证 MIME 类型
  if (bucket.allowedMimeTypes && bucket.allowedMimeTypes.length > 0) {
    if (!bucket.allowedMimeTypes.includes(mimeType)) {
      throw new Error(`MIME type ${mimeType} is not allowed`);
    }
  }

  const adapter = createStorageAdapter();
  const storagePath = `${bucket.projectId}/${bucket.name}/${name}`;
  const etag = `"${file.length}-${Date.now()}"`;

  // 使用事务保护：先保存元数据，再上传文件
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // 先保存元数据
    const result = await client.query(
      `INSERT INTO druvia_storage_objects
       (bucket_id, name, size, mime_type, etag, storage_provider, storage_path, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (bucket_id, name) DO UPDATE SET
         size = $3, mime_type = $4, etag = $5, storage_path = $7, updated_at = NOW()
       RETURNING *`,
      [bucket.id, name, file.length, mimeType, etag, adapter.type, storagePath, userId]
    );

    // 上传到存储后端
    await adapter.upload(file, storagePath, mimeType);

    await client.query('COMMIT');
    return mapObjectRow(result.rows[0]);
  } catch (error) {
    await client.query('ROLLBACK');
    // 尝试清理可能已上传的文件
    try { await adapter.delete(storagePath); } catch {}
    throw error;
  } finally {
    client.release();
  }
}

export async function getObject(bucketId: string, name: string): Promise<StorageObject | null> {
  const result = await pool.query(
    `SELECT * FROM druvia_storage_objects WHERE bucket_id = $1 AND name = $2`,
    [bucketId, name]
  );
  return result.rows[0] ? mapObjectRow(result.rows[0]) : null;
}

export async function downloadObject(object: StorageObject): Promise<Buffer> {
  const adapter = createStorageAdapter();
  return adapter.download(object.storagePath!);
}

export async function deleteObject(bucketId: string, name: string): Promise<boolean> {
  const object = await getObject(bucketId, name);
  if (!object) return false;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // 先删除元数据
    const result = await client.query(
      `DELETE FROM druvia_storage_objects WHERE bucket_id = $1 AND name = $2`,
      [bucketId, name]
    );

    if (result.rowCount === 0) {
      await client.query('ROLLBACK');
      return false;
    }

    // 再从存储后端删除
    const adapter = createStorageAdapter();
    await adapter.delete(object.storagePath!);

    await client.query('COMMIT');
    return true;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function getSignedUrl(object: StorageObject, expiresIn: number = 3600): Promise<string> {
  const adapter = createStorageAdapter();
  return adapter.getSignedUrl(object.storagePath!, expiresIn);
}

// Helper functions
function mapBucketRow(row: Record<string, unknown>): Bucket {
  return {
    id: row.id as string,
    projectId: row.project_id as string,
    name: row.name as string,
    public: row.public as boolean,
    fileSizeLimit: row.file_size_limit as number | null,
    allowedMimeTypes: row.allowed_mime_types as string[] | null,
    corsConfig: row.cors_config as Record<string, unknown> | null,
    createdAt: row.created_at as Date,
    updatedAt: row.updated_at as Date,
  };
}

function mapObjectRow(row: Record<string, unknown>): StorageObject {
  return {
    id: row.id as string,
    bucketId: row.bucket_id as string,
    name: row.name as string,
    size: Number(row.size),
    mimeType: row.mime_type as string | null,
    etag: row.etag as string | null,
    storageProvider: row.storage_provider as string | null,
    storagePath: row.storage_path as string | null,
    metadata: (row.metadata as Record<string, unknown>) || {},
    createdBy: row.created_by as string | null,
    createdAt: row.created_at as Date,
    updatedAt: row.updated_at as Date,
  };
}
```

**Task M18-2: Storage Routes**

API 端点:
```
GET        /api/v1/projects/:id/storage/buckets                            # 列出所有桶
POST       /api/v1/projects/:id/storage/buckets                            # 创建桶
GET        /api/v1/projects/:id/storage/buckets/:name                      # 获取桶详情
PATCH      /api/v1/projects/:id/storage/buckets/:name                      # 更新桶配置
DELETE     /api/v1/projects/:id/storage/buckets/:name                      # 删除桶
GET        /api/v1/projects/:id/storage/buckets/:name/objects              # 列出对象
POST       /api/v1/projects/:id/storage/buckets/:name/objects              # 上传对象
GET        /api/v1/projects/:id/storage/buckets/:name/objects/:path(*)     # 下载对象
DELETE     /api/v1/projects/:id/storage/buckets/:name/objects/:path(*)     # 删除对象
POST       /api/v1/projects/:id/storage/buckets/:name/objects/:path(*)/url # 获取签名 URL
```

**Task M18-2b: Storage Controller**

```typescript
// apps/api/src/modules/storage/storage.controller.ts
import { FastifyRequest, FastifyReply } from 'fastify';
import * as storageService from './storage.service';

export class StorageController {
  async listBuckets(
    request: FastifyRequest<{ Params: { projectId: string } }>,
    reply: FastifyReply
  ) {
    const { projectId } = request.params;
    const buckets = await storageService.listBuckets(projectId);
    return reply.send({ success: true, data: buckets });
  }

  async createBucket(
    request: FastifyRequest<{
      Params: { projectId: string };
      Body: { name: string; public?: boolean; fileSizeLimit?: number; allowedMimeTypes?: string[] };
    }>,
    reply: FastifyReply
  ) {
    const { projectId } = request.params;
    const bucket = await storageService.createBucket(projectId, request.body);
    return reply.status(201).send({ success: true, data: bucket });
  }

  async uploadObject(
    request: FastifyRequest<{
      Params: { projectId: string; bucketName: string };
    }>,
    reply: FastifyReply
  ) {
    const { projectId, bucketName } = request.params;
    const bucket = await storageService.getBucket(projectId, bucketName);
    if (!bucket) {
      return reply.status(404).send({ success: false, error: { message: 'Bucket not found' } });
    }

    const data = await request.file();
    if (!data) {
      return reply.status(400).send({ success: false, error: { message: 'No file uploaded' } });
    }

    const buffer = await data.toBuffer();
    const object = await storageService.uploadObject(
      bucket,
      data.filename,
      buffer,
      data.mimetype,
      request.user?.id
    );
    return reply.status(201).send({ success: true, data: object });
  }

  async downloadObject(
    request: FastifyRequest<{
      Params: { projectId: string; bucketName: string; '*': string };
    }>,
    reply: FastifyReply
  ) {
    const { projectId, bucketName } = request.params;
    const objectPath = request.params['*'];

    const bucket = await storageService.getBucket(projectId, bucketName);
    if (!bucket) {
      return reply.status(404).send({ success: false, error: { message: 'Bucket not found' } });
    }

    const object = await storageService.getObject(bucket.id, objectPath);
    if (!object) {
      return reply.status(404).send({ success: false, error: { message: 'Object not found' } });
    }

    const buffer = await storageService.downloadObject(object);
    reply.header('Content-Type', object.mimeType || 'application/octet-stream');
    reply.header('Content-Disposition', `attachment; filename="${objectPath.split('/').pop()}"`);
    return reply.send(buffer);
  }
}
```

**Task M18-2c: 前端 API 方法**

```typescript
// apps/admin/src/lib/api.ts 新增

// Storage Buckets
async listBuckets(projectId: string): Promise<ApiResponse<Bucket[]>> {
  return this.request('GET', `/api/v1/projects/${projectId}/storage/buckets`);
}

async createBucket(
  projectId: string,
  data: { name: string; public?: boolean; fileSizeLimit?: number }
): Promise<ApiResponse<Bucket>> {
  return this.request('POST', `/api/v1/projects/${projectId}/storage/buckets`, data);
}

async updateBucket(
  projectId: string,
  bucketName: string,
  data: Partial<{ public: boolean; fileSizeLimit: number; corsConfig: object }>
): Promise<ApiResponse<Bucket>> {
  return this.request('PATCH', `/api/v1/projects/${projectId}/storage/buckets/${bucketName}`, data);
}

async deleteBucket(projectId: string, bucketName: string): Promise<ApiResponse<void>> {
  return this.request('DELETE', `/api/v1/projects/${projectId}/storage/buckets/${bucketName}`);
}

// Storage Objects
async listObjects(
  projectId: string,
  bucketName: string,
  options?: { prefix?: string; limit?: number; offset?: number }
): Promise<ApiResponse<{ objects: StorageObject[]; total: number }>> {
  const params = new URLSearchParams();
  if (options?.prefix) params.set('prefix', options.prefix);
  if (options?.limit) params.set('limit', String(options.limit));
  if (options?.offset) params.set('offset', String(options.offset));
  const query = params.toString() ? `?${params}` : '';
  return this.request('GET', `/api/v1/projects/${projectId}/storage/buckets/${bucketName}/objects${query}`);
}

async uploadObject(projectId: string, bucketName: string, file: File): Promise<ApiResponse<StorageObject>> {
  const formData = new FormData();
  formData.append('file', file);
  return this.uploadFile(`/api/v1/projects/${projectId}/storage/buckets/${bucketName}/objects`, formData);
}

async deleteObject(projectId: string, bucketName: string, objectPath: string): Promise<ApiResponse<void>> {
  return this.request('DELETE', `/api/v1/projects/${projectId}/storage/buckets/${bucketName}/objects/${objectPath}`);
}

async getSignedUrl(projectId: string, bucketName: string, objectPath: string): Promise<ApiResponse<{ url: string }>> {
  return this.request('POST', `/api/v1/projects/${projectId}/storage/buckets/${bucketName}/objects/${objectPath}/url`);
}
```

**Task M18-3: Storage 前端页面**

**Files:**
- Create: `apps/admin/src/app/t/[tenantId]/p/[projectId]/storage/page.tsx`
- Create: `apps/admin/src/components/storage/BucketList.tsx`
- Create: `apps/admin/src/components/storage/ObjectList.tsx`
- Create: `apps/admin/src/components/storage/UploadDialog.tsx`

页面结构:
```
├── Buckets 列表 (左侧边栏)
│   ├── 创建桶按钮
│   └── 桶列表（可选择）
├── Objects 列表 (主区域)
│   ├── 面包屑导航
│   ├── 上传按钮 + 新建文件夹
│   ├── 文件表格
│   │   ├── 复选框
│   │   ├── 文件名/图标
│   │   ├── 大小
│   │   ├── 类型
│   │   ├── 修改时间
│   │   └── 操作（下载/删除/获取URL）
│   └── 批量操作栏
└── 桶设置 (右侧抽屉)
    ├── 公开/私有
    ├── 文件大小限制
    ├── 允许的 MIME 类型
    └── CORS 配置
```

#### 验收标准

- [ ] 数据库迁移脚本执行成功
- [ ] 旧 druvia_files 数据迁移到新表
- [ ] 可创建/删除存储桶
- [ ] 可设置桶的公开/私有属性
- [ ] 可配置文件大小限制
- [ ] 可上传文件（支持拖拽）
- [ ] 可预览图片/文档
- [ ] 可下载文件
- [ ] 可删除文件（单个/批量）
- [ ] 可获取签名 URL

---

### M17: Authentication 管理界面

**优先级**: 高 (后端部分存在，需扩展)

**现有数据库表**: `druvia_tenant_auth_providers` (租户级) + 新建 `druvia_project_auth_providers` (项目级)

> **设计说明**: 租户级配置 (`druvia_tenant_auth_providers`) 作为默认值，项目可通过 `druvia_project_auth_providers` 覆盖。如果项目没有配置，则回退到租户级配置。

需要扩展:
- 添加 `config` JSONB 字段存储额外配置（如回调 URL、scope 等）
- 新增 `druvia_project_auth_config` 表存储项目级配置

#### 数据库扩展

```sql
-- 扩展现有租户级表
ALTER TABLE druvia_tenant_auth_providers
ADD COLUMN IF NOT EXISTS config JSONB DEFAULT '{}',
ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW();

-- 项目级认证提供商配置（覆盖租户级）
CREATE TABLE IF NOT EXISTS druvia_project_auth_providers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID REFERENCES druvia_projects(id) ON DELETE CASCADE,
  provider VARCHAR(50) NOT NULL,          -- google, github, wechat, dingtalk, feishu
  enabled BOOLEAN DEFAULT true,
  client_id VARCHAR(255),
  client_secret_encrypted TEXT,
  config JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(project_id, provider)
);

-- 项目认证配置表
CREATE TABLE IF NOT EXISTS druvia_project_auth_config (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID UNIQUE REFERENCES druvia_projects(id) ON DELETE CASCADE,
  jwt_expires_in INTEGER DEFAULT 3600,           -- JWT 过期时间（秒）
  refresh_token_expires_in INTEGER DEFAULT 604800, -- Refresh Token 过期（7天）
  password_min_length INTEGER DEFAULT 8,
  require_email_verification BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
```

#### 后端 API 扩展

**Files:**
- Create: `apps/api/src/modules/auth-admin/auth-admin.service.ts`
- Create: `apps/api/src/modules/auth-admin/auth-admin.routes.ts`

**Task M17-1: Auth Admin Service**

```typescript
// apps/api/src/modules/auth-admin/auth-admin.service.ts

export interface AuthProvider {
  id: string;
  projectId: string;
  provider: string; // google, github, wechat, dingtalk, feishu
  enabled: boolean;
  clientId: string;
  clientSecretEncrypted: string;
  config: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}

export interface ProjectUser {
  id: string;
  email: string;
  username: string | null;
  avatarUrl: string | null;
  provider: string;
  providerId: string | null;
  status: 'active' | 'disabled';
  lastLoginAt: Date | null;
  createdAt: Date;
}

export interface AuthConfig {
  jwtExpiresIn: number; // seconds
  refreshTokenExpiresIn: number;
  passwordMinLength: number;
  requireEmailVerification: boolean;
}

// Provider CRUD
export async function listProviders(projectId: string): Promise<AuthProvider[]>;
export async function createProvider(projectId: string, data: Partial<AuthProvider>): Promise<AuthProvider>;
export async function updateProvider(projectId: string, provider: string, data: Partial<AuthProvider>): Promise<AuthProvider>;
export async function deleteProvider(projectId: string, provider: string): Promise<boolean>;

// User management
export async function listProjectUsers(schemaName: string, options?: { limit?: number; offset?: number; status?: string }): Promise<{ users: ProjectUser[]; total: number }>;
export async function getProjectUser(schemaName: string, userId: string): Promise<ProjectUser | null>;
export async function updateProjectUser(schemaName: string, userId: string, data: { status?: string }): Promise<ProjectUser>;
export async function deleteProjectUser(schemaName: string, userId: string): Promise<boolean>;

// Config management
export async function getAuthConfig(projectId: string): Promise<AuthConfig>;
export async function updateAuthConfig(projectId: string, config: Partial<AuthConfig>): Promise<AuthConfig>;
```

**Task M17-2: Auth Admin Routes**

API 端点:
```
GET/POST   /api/v1/projects/:id/auth/providers
GET/PATCH  /api/v1/projects/:id/auth/providers/:provider
DELETE     /api/v1/projects/:id/auth/providers/:provider
GET        /api/v1/projects/:id/auth/users
GET        /api/v1/projects/:id/auth/users/:userId
PATCH      /api/v1/projects/:id/auth/users/:userId
DELETE     /api/v1/projects/:id/auth/users/:userId
GET/PUT    /api/v1/projects/:id/auth/config
```

**Task M17-3: Auth 前端页面**

**Files:**
- Create: `apps/admin/src/app/t/[tenantId]/p/[projectId]/auth/page.tsx`
- Create: `apps/admin/src/components/auth/ProviderList.tsx`
- Create: `apps/admin/src/components/auth/ProviderConfigDialog.tsx`
- Create: `apps/admin/src/components/auth/UserList.tsx`
- Create: `apps/admin/src/components/auth/AuthConfigForm.tsx`

页面结构:
```
Tabs:
├── Providers (认证方式)
│   ├── Email/Password (内置，只能启用/禁用)
│   ├── OAuth Providers
│   │   ├── Google (配置 Client ID/Secret)
│   │   ├── GitHub
│   │   ├── Microsoft
│   │   ├── Discord
│   │   ├── WeChat (微信)
│   │   ├── DingTalk (钉钉)
│   │   └── Feishu (飞书)
│   └── 每个 Provider: 启用/禁用开关 + 配置按钮
├── Users (用户列表)
│   ├── 搜索框
│   ├── 状态筛选
│   ├── 用户表格
│   │   ├── 头像
│   │   ├── 邮箱/用户名
│   │   ├── 认证方式
│   │   ├── 状态
│   │   ├── 最后登录
│   │   └── 操作 (禁用/删除)
│   └── 分页
└── Configuration (配置)
    ├── JWT 过期时间
    ├── Refresh Token 过期时间
    ├── 密码最小长度
    └── 是否要求邮箱验证
```

#### 验收标准

- [ ] 可查看已配置的 OAuth 提供商
- [ ] 可配置 Google/GitHub/Microsoft OAuth
- [ ] 可配置微信/钉钉/飞书 OAuth
- [ ] 可启用/禁用各认证方式
- [ ] 可查看项目用户列表
- [ ] 可搜索用户
- [ ] 可禁用/恢复用户
- [ ] 可删除用户
- [ ] 可配置 JWT 过期时间
- [ ] 可配置密码策略

---

### M20: Realtime 管理界面

**优先级**: 中 (基于 Hasura Subscriptions，封装即可)

#### 后端 API

**Files:**
- Create: `apps/api/src/modules/realtime/realtime.service.ts`
- Create: `apps/api/src/modules/realtime/realtime.routes.ts`

**Task M20-1: Realtime Service**

```typescript
// apps/api/src/modules/realtime/realtime.service.ts
import { pool } from '@/lib/db';
import { hasuraAdminRequest } from '@/lib/hasura';

export interface TableSubscription {
  tableName: string;
  enabled: boolean;
  operations: ('INSERT' | 'UPDATE' | 'DELETE')[];
}

export interface ActiveSubscription {
  id: string;
  table: string;
  operation: string;
  subscriberCount: number;
  createdAt: Date;
}

export interface RealtimeEvent {
  id: string;
  table: string;
  operation: string;
  oldData: Record<string, unknown> | null;
  newData: Record<string, unknown> | null;
  timestamp: Date;
}

// Hasura Metadata API 调用封装
const HASURA_METADATA_URL = `${process.env.HASURA_GRAPHQL_URL}/v1/metadata`;

async function hasuraMetadata(type: string, args: Record<string, unknown>) {
  const response = await fetch(HASURA_METADATA_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Hasura-Admin-Secret': process.env.HASURA_ADMIN_SECRET!,
    },
    body: JSON.stringify({ type, args }),
  });
  return response.json();
}

// 获取表级订阅配置（从 Hasura Metadata 读取）
export async function getTableSubscriptions(schemaName: string): Promise<TableSubscription[]> {
  // 获取 schema 下所有表
  const metadata = await hasuraMetadata('export_metadata', { version: 2 });
  const source = metadata.metadata?.sources?.find((s: any) => s.name === 'default');
  const tables = source?.tables?.filter((t: any) => t.table.schema === schemaName) || [];

  return tables.map((t: any) => ({
    tableName: t.table.name,
    enabled: !!t.select_permissions?.length, // 有权限即表示可订阅
    operations: ['INSERT', 'UPDATE', 'DELETE'], // Hasura 默认支持所有操作
  }));
}

// 配置表订阅（通过 Hasura 权限配置）
export async function configureTableSubscription(
  schemaName: string,
  tableName: string,
  config: { enabled: boolean; operations: string[] }
): Promise<TableSubscription> {
  if (config.enabled) {
    // 添加 select 权限以启用订阅
    await hasuraMetadata('pg_create_select_permission', {
      source: 'default',
      table: { schema: schemaName, name: tableName },
      role: 'user',
      permission: {
        columns: '*',
        filter: {},
        allow_aggregations: false,
      },
    });
  } else {
    // 删除权限以禁用订阅
    await hasuraMetadata('pg_drop_select_permission', {
      source: 'default',
      table: { schema: schemaName, name: tableName },
      role: 'user',
    });
  }

  return { tableName, enabled: config.enabled, operations: config.operations as any };
}

// 获取事件日志（从 hdb_catalog.event_log 读取）
export async function getRealtimeEvents(
  schemaName: string,
  options?: { table?: string; limit?: number; since?: Date }
): Promise<RealtimeEvent[]> {
  const limit = options?.limit || 50;

  // 注：需要启用 Hasura Event Triggers 才有事件日志
  // 这里从 hdb_catalog.event_log 表读取
  const result = await pool.query(`
    SELECT id, table_name, operation, old_payload, new_payload, created_at
    FROM hdb_catalog.event_log
    WHERE schema_name = $1
    ${options?.table ? 'AND table_name = $2' : ''}
    ${options?.since ? `AND created_at > $${options?.table ? 3 : 2}` : ''}
    ORDER BY created_at DESC
    LIMIT $${options?.table ? (options?.since ? 4 : 3) : (options?.since ? 3 : 2)}
  `, [schemaName, ...(options?.table ? [options.table] : []), ...(options?.since ? [options.since] : []), limit]);

  return result.rows.map(row => ({
    id: row.id,
    table: row.table_name,
    operation: row.operation,
    oldData: row.old_payload,
    newData: row.new_payload,
    timestamp: row.created_at,
  }));
}
```

**Task M20-2: Realtime Routes**

API 端点:
```
GET        /api/v1/projects/:id/realtime/subscriptions
POST       /api/v1/projects/:id/realtime/subscriptions/:table
GET        /api/v1/projects/:id/realtime/events
```

**Task M20-3: Realtime 前端页面**

**Files:**
- Create: `apps/admin/src/app/t/[tenantId]/p/[projectId]/realtime/page.tsx`
- Create: `apps/admin/src/components/realtime/SubscriptionConfig.tsx`
- Create: `apps/admin/src/components/realtime/EventLog.tsx`
- Create: `apps/admin/src/components/realtime/SubscriptionTester.tsx`

页面结构:
```
Tabs:
├── Subscriptions (订阅配置)
│   ├── 表列表
│   │   ├── 表名
│   │   ├── 启用开关
│   │   ├── 操作类型选择 (INSERT/UPDATE/DELETE)
│   │   └── 订阅者数量
│   └── 批量启用/禁用
├── Events (事件日志)
│   ├── 实时事件流 (WebSocket)
│   ├── 事件表格
│   │   ├── 时间
│   │   ├── 表名
│   │   ├── 操作
│   │   └── 数据预览
│   └── 筛选 (按表/操作)
└── Test (测试)
    ├── 订阅测试区
    │   ├── 选择表
    │   ├── 连接按钮
    │   └── 实时消息显示
    └── 使用说明
```

#### 验收标准

- [ ] 可查看所有表的订阅配置
- [ ] 可启用/禁用表订阅
- [ ] 可选择订阅的操作类型
- [ ] 可查看实时事件日志
- [ ] 可测试订阅功能（实时接收变更）
- [ ] 事件日志正常刷新

---

## Phase 2.2: SQL 编辑器 + 计算能力

### M3: SQL 编辑器增强

**详细实现方案**: 参见 [原 Phase 2 计划](./2026-03-02-phase2-implementation.md) Task 1-8

**核心任务:**
1. 安装 CodeMirror 依赖
2. 创建 SqlEditor 组件
3. 创建 Schema 元数据 API
4. 更新数据库页面使用 SqlEditor
5. 添加多标签支持 (新增)
6. 创建 SQL 导入导出 API
7. 前端导入导出 UI
8. 端到端测试

**Task M3-5: 多标签支持 (新增)**

```tsx
// apps/admin/src/components/SqlTabBar.tsx
'use client';

import { useState, useEffect } from 'react';
import { Loader2, X, Plus } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { SqlEditor } from './SqlEditor';
import { ResultPanel, QueryResult } from './ResultPanel';

interface SqlTab {
  id: string;
  name: string;
  query: string;
  result?: QueryResult;
  status?: 'idle' | 'running' | 'success' | 'error';
}

interface SqlTabBarProps {
  projectId: string;
  onExecute: (query: string) => Promise<QueryResult>;
}

export function SqlTabBar({ projectId, onExecute }: SqlTabBarProps) {
  // 状态管理（带 localStorage 持久化）
  const [tabs, setTabs] = useState<SqlTab[]>(() => {
  if (typeof window !== 'undefined') {
    const saved = localStorage.getItem(`sql-tabs-${projectId}`);
    return saved ? JSON.parse(saved) : [{ id: '1', name: '查询 1', query: '' }];
  }
  return [{ id: '1', name: '查询 1', query: '' }];
});
  const [activeTabId, setActiveTabId] = useState('1');

  // 持久化到 localStorage
  useEffect(() => {
    localStorage.setItem(`sql-tabs-${projectId}`, JSON.stringify(tabs));
  }, [tabs, projectId]);

  // 辅助函数
  const activeTab = tabs.find(t => t.id === activeTabId) || tabs[0];

  const addNewTab = () => {
    const newId = String(Date.now());
    setTabs([...tabs, { id: newId, name: `查询 ${tabs.length + 1}`, query: '' }]);
    setActiveTabId(newId);
  };

  const closeTab = (id: string) => {
    if (tabs.length === 1) return; // 至少保留一个标签
    const newTabs = tabs.filter(t => t.id !== id);
    setTabs(newTabs);
    if (activeTabId === id) {
      setActiveTabId(newTabs[0].id);
    }
  };

  const updateTabQuery = (id: string, query: string) => {
    setTabs(tabs.map(t => t.id === id ? { ...t, query } : t));
  };

  const executeQuery = async (id: string) => {
    const tab = tabs.find(t => t.id === id);
    if (!tab) return;

    setTabs(tabs.map(t => t.id === id ? { ...t, status: 'running' } : t));

    try {
      const result = await onExecute(tab.query);
      setTabs(tabs.map(t => t.id === id ? { ...t, result, status: 'success' } : t));
    } catch (error) {
      setTabs(tabs.map(t => t.id === id ? { ...t, status: 'error' } : t));
    }
  };

  // UI
  return (
    <div className="flex flex-col h-full">
      {/* 标签栏 */}
      <div className="flex items-center border-b">
        {tabs.map(tab => (
          <div
            key={tab.id}
            className={cn(
              "px-4 py-2 border-r cursor-pointer flex items-center gap-2",
              activeTabId === tab.id && "bg-muted"
            )}
            onClick={() => setActiveTabId(tab.id)}
          >
            <span>{tab.name}</span>
            {tab.status === 'running' && <Loader2 className="h-3 w-3 animate-spin" />}
            <X
              className="h-3 w-3 hover:text-destructive"
              onClick={(e) => { e.stopPropagation(); closeTab(tab.id); }}
            />
          </div>
        ))}
        <Button variant="ghost" size="sm" onClick={addNewTab}>
          <Plus className="h-4 w-4" />
        </Button>
      </div>

      {/* 编辑器 */}
      <SqlEditor
        value={activeTab.query}
        onChange={(q) => updateTabQuery(activeTabId, q)}
        onExecute={() => executeQuery(activeTabId)}
      />

      {/* 结果面板 */}
      <ResultPanel result={activeTab.result} status={activeTab.status} />
    </div>
  );
}
```

#### 验收标准

- [ ] SQL 语法高亮 (PostgreSQL)
- [ ] 表名/字段名自动完成
- [ ] Cmd/Ctrl + Enter 执行
- [ ] Cmd/Ctrl + Shift + F 格式化
- [ ] 多标签支持
- [ ] 标签可重命名
- [ ] 标签可关闭
- [ ] 可导出 SQL 文件
- [ ] 可导入 SQL 文件

---

### M19: Edge Functions

**优先级**: 最复杂 (需要新增 Deno 容器)

#### Docker 配置

**Files:**
- Modify: `docker/docker-compose.yml`

```yaml
services:
  druvia-deno:
    image: denoland/deno:alpine-2.0.6
    container_name: druvia-deno
    ports:
      - "7133:7133"
    volumes:
      - ./deno-worker:/app
      - deno-cache:/deno-dir
    environment:
      - DENO_DIR=/deno-dir
      - DRUVIA_API_URL=http://host.docker.internal:3001
      - POSTGRES_URL=${DATABASE_URL}
    working_dir: /app
    # 限制权限：只允许网络、环境变量和 /tmp 读写
    command: ["run", "--allow-net", "--allow-env", "--allow-read=/tmp,/app", "--allow-write=/tmp", "main.ts"]
    # 资源限制
    deploy:
      resources:
        limits:
          cpus: '1'
          memory: 512M
        reservations:
          memory: 128M
    depends_on:
      - druvia-postgres
    restart: unless-stopped

volumes:
  deno-cache:
```

#### Deno Worker 实现

**Files:**
- Create: `docker/deno-worker/main.ts`
- Create: `docker/deno-worker/executor.ts`

**Task M19-1: Deno Worker Server**

```typescript
// docker/deno-worker/main.ts
import { serve } from "https://deno.land/std@0.208.0/http/server.ts";

interface ExecuteRequest {
  code: string;
  functionName: string;
  secrets?: Record<string, string>;
  timeout?: number;
  memoryLimit?: number;
}

serve(async (req: Request) => {
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  const { code, functionName, secrets, timeout = 30000 } = await req.json() as ExecuteRequest;

  try {
    const result = await executeFunction(code, secrets, timeout);
    return Response.json({ success: true, data: result });
  } catch (error) {
    return Response.json({
      success: false,
      error: { message: error.message }
    }, { status: 500 });
  }
}, { port: 7133 });

async function executeFunction(
  code: string,
  secrets: Record<string, string> = {},
  timeout: number
): Promise<unknown> {
  // 创建隔离的 Worker，限制权限
  const worker = new Worker(
    new URL("./executor.ts", import.meta.url).href,
    {
      type: "module",
      deno: {
        permissions: {
          net: true,          // 允许网络请求
          env: true,          // 允许环境变量（用于 secrets）
          read: ["/tmp"],     // 只读 /tmp
          write: ["/tmp"],    // 只写 /tmp
          run: false,         // 禁止运行子进程
          ffi: false,         // 禁止 FFI
          hrtime: false,      // 禁止高精度时间
        }
      }
    }
  );

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      worker.terminate();
      reject(new Error(`Function timeout after ${timeout}ms`));
    }, timeout);

    worker.onmessage = (e) => {
      clearTimeout(timer);
      worker.terminate();
      if (e.data.error) {
        reject(new Error(e.data.error));
      } else {
        resolve(e.data.result);
      }
    };

    worker.onerror = (e) => {
      clearTimeout(timer);
      worker.terminate();
      reject(new Error(e.message));
    };

    worker.postMessage({ code, secrets });
  });
}
```

```typescript
// docker/deno-worker/executor.ts
self.onmessage = async (e: MessageEvent) => {
  const { code, secrets } = e.data;

  try {
    // 注入 secrets 到环境
    for (const [key, value] of Object.entries(secrets)) {
      Deno.env.set(key, value as string);
    }

    // 动态执行代码
    const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
    const fn = new AsyncFunction("Deno", code);
    const result = await fn(Deno);

    self.postMessage({ result });
  } catch (error) {
    self.postMessage({ error: error.message });
  }
};
```

#### 数据库设计

```sql
-- Edge Functions 表（参见战略设计文档）
CREATE TABLE IF NOT EXISTS druvia_functions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID REFERENCES druvia_projects(id) ON DELETE CASCADE,
  name VARCHAR(255) NOT NULL,
  code TEXT NOT NULL,
  runtime VARCHAR(50) DEFAULT 'deno',
  status VARCHAR(50) DEFAULT 'active',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(project_id, name)
);

CREATE TABLE IF NOT EXISTS druvia_function_secrets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID REFERENCES druvia_projects(id) ON DELETE CASCADE,
  key VARCHAR(255) NOT NULL,
  value_encrypted TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(project_id, key)
);

CREATE TABLE IF NOT EXISTS druvia_function_schedules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  function_id UUID REFERENCES druvia_functions(id) ON DELETE CASCADE,
  cron_expression VARCHAR(100) NOT NULL,
  enabled BOOLEAN DEFAULT true,
  last_run_at TIMESTAMPTZ,
  next_run_at TIMESTAMPTZ
);

-- 函数执行日志表（新增）
CREATE TABLE IF NOT EXISTS druvia_function_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  function_id UUID REFERENCES druvia_functions(id) ON DELETE CASCADE,
  execution_id UUID NOT NULL,               -- 每次执行的唯一 ID
  level VARCHAR(20) DEFAULT 'info',         -- info, warn, error
  message TEXT,
  metadata JSONB DEFAULT '{}',              -- 额外信息（耗时、内存等）
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_function_logs_function ON druvia_function_logs(function_id, created_at DESC);
CREATE INDEX idx_function_logs_execution ON druvia_function_logs(execution_id);
```

#### 后端 API

**Files:**
- Create: `apps/api/src/modules/functions/functions.service.ts`
- Create: `apps/api/src/modules/functions/functions.routes.ts`

**Task M19-2: Functions Service**

```typescript
// apps/api/src/modules/functions/functions.service.ts
import { pool } from '@/lib/db';
import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';

export interface EdgeFunction {
  id: string;
  projectId: string;
  name: string;
  code: string;
  runtime: string;
  status: 'active' | 'disabled';
  createdAt: Date;
  updatedAt: Date;
}

export interface FunctionSecret {
  id: string;
  projectId: string;
  key: string;
  // value 不返回给前端
  createdAt: Date;
}

export interface FunctionSchedule {
  id: string;
  functionId: string;
  cronExpression: string;
  enabled: boolean;
  lastRunAt: Date | null;
  nextRunAt: Date | null;
}

export interface InvokeResult {
  success: boolean;
  data?: unknown;
  error?: { message: string };
  duration: number;
}

// Function CRUD
export async function listFunctions(projectId: string): Promise<EdgeFunction[]>;
export async function createFunction(projectId: string, data: { name: string; code: string }): Promise<EdgeFunction>;
export async function getFunction(projectId: string, name: string): Promise<EdgeFunction | null>;
export async function updateFunction(projectId: string, name: string, data: Partial<EdgeFunction>): Promise<EdgeFunction>;
export async function deleteFunction(projectId: string, name: string): Promise<boolean>;

// Invoke
export async function invokeFunction(
  projectId: string,
  name: string,
  payload?: Record<string, unknown>
): Promise<InvokeResult> {
  const func = await getFunction(projectId, name);
  if (!func) throw new Error('Function not found');
  if (func.status !== 'active') throw new Error('Function is disabled');

  // 获取 secrets
  const secrets = await getSecretsDecrypted(projectId);

  const startTime = Date.now();

  // 调用 Deno Worker
  const response = await fetch('http://localhost:7133/execute', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      code: func.code,
      functionName: func.name,
      secrets,
      timeout: 30000,
    }),
  });

  const result = await response.json();
  const duration = Date.now() - startTime;

  return { ...result, duration };
}

// Secrets CRUD
export async function listSecrets(projectId: string): Promise<FunctionSecret[]>;
export async function createSecret(projectId: string, key: string, value: string): Promise<FunctionSecret>;
export async function deleteSecret(projectId: string, key: string): Promise<boolean>;

// 获取解密后的 secrets（内部使用）
async function getSecretsDecrypted(projectId: string): Promise<Record<string, string>> {
  const result = await pool.query(
    `SELECT key, value_encrypted FROM druvia_function_secrets WHERE project_id = $1`,
    [projectId]
  );

  const secrets: Record<string, string> = {};
  for (const row of result.rows) {
    // 使用 AES-256-GCM 解密，密钥从环境变量获取
    secrets[row.key] = decrypt(row.value_encrypted, process.env.SECRETS_ENCRYPTION_KEY!);
  }
  return secrets;
}

// 加密/解密辅助函数（crypto 已在文件顶部导入）
function encrypt(text: string, key: string): string {
  const iv = randomBytes(16);
  const cipher = createCipheriv('aes-256-gcm', Buffer.from(key, 'hex'), iv);
  let encrypted = cipher.update(text, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  const authTag = cipher.getAuthTag();
  return iv.toString('hex') + ':' + authTag.toString('hex') + ':' + encrypted;
}

function decrypt(encrypted: string, key: string): string {
  const [ivHex, authTagHex, encryptedText] = encrypted.split(':');
  const decipher = createDecipheriv('aes-256-gcm', Buffer.from(key, 'hex'), Buffer.from(ivHex, 'hex'));
  decipher.setAuthTag(Buffer.from(authTagHex, 'hex'));
  let decrypted = decipher.update(encryptedText, 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  return decrypted;
}

// Schedules CRUD
export async function listSchedules(functionId: string): Promise<FunctionSchedule[]>;
export async function createSchedule(functionId: string, cronExpression: string): Promise<FunctionSchedule>;
export async function updateSchedule(scheduleId: string, data: Partial<FunctionSchedule>): Promise<FunctionSchedule>;
export async function deleteSchedule(scheduleId: string): Promise<boolean>;
```

**Task M19-3: Functions Routes**

API 端点:
```
GET/POST   /api/v1/projects/:id/functions
GET/PUT    /api/v1/projects/:id/functions/:name
DELETE     /api/v1/projects/:id/functions/:name
POST       /api/v1/projects/:id/functions/:name/invoke
GET        /api/v1/projects/:id/functions/:name/logs        # 获取函数执行日志
GET/POST   /api/v1/projects/:id/functions/secrets
DELETE     /api/v1/projects/:id/functions/secrets/:key
GET/POST   /api/v1/projects/:id/functions/:name/schedules
PATCH      /api/v1/projects/:id/functions/schedules/:scheduleId
DELETE     /api/v1/projects/:id/functions/schedules/:scheduleId
```

**Task M19-4: Functions 前端页面**

**Files:**
- Create: `apps/admin/src/app/t/[tenantId]/p/[projectId]/functions/page.tsx`
- Create: `apps/admin/src/components/functions/FunctionList.tsx`
- Create: `apps/admin/src/components/functions/FunctionEditor.tsx`
- Create: `apps/admin/src/components/functions/FunctionLogs.tsx`
- Create: `apps/admin/src/components/functions/SecretsManager.tsx`
- Create: `apps/admin/src/components/functions/ScheduleConfig.tsx`

页面结构:
```
├── Functions 列表 (左侧边栏)
│   ├── 创建函数按钮
│   └── 函数列表
│       ├── 函数名
│       ├── 状态指示
│       └── 最后更新时间
├── 函数编辑器 (主区域)
│   ├── 工具栏
│   │   ├── 保存
│   │   ├── 运行
│   │   └── 部署
│   ├── 代码编辑器 (CodeMirror + TypeScript)
│   └── 输出面板
│       ├── 控制台
│       └── 执行结果
├── Secrets Tab
│   ├── 添加 Secret
│   └── Secret 列表 (Key + 操作)
└── Schedules Tab
    ├── 添加定时任务
    └── 任务列表
        ├── Cron 表达式
        ├── 启用开关
        ├── 上次执行
        └── 下次执行
```

#### 安全设计

| 维度 | 限制 | 实现方式 |
|------|------|---------|
| 执行超时 | 30s 默认，最大 300s | Deno Worker timeout |
| 内存限制 | 128MB 默认，最大 512MB | Docker 容器限制 |
| CPU 限制 | 单核 | Docker 容器限制 |
| 网络访问 | 允许外部请求 | Deno permissions |
| 文件系统 | 只读（除 /tmp） | Deno permissions |
| 代码隔离 | 每次执行独立 Worker | Deno Worker API |

#### 验收标准

- [ ] Deno Worker 容器正常运行
- [ ] 可创建函数
- [ ] 代码编辑器有语法高亮
- [ ] 可保存/更新函数代码
- [ ] 可运行函数并查看结果
- [ ] 函数执行超时正确处理
- [ ] Secrets 加密存储
- [ ] Secrets 可在函数中通过 Deno.env 访问
- [ ] 定时任务可配置
- [ ] 定时任务按时触发

---

## Phase 2.3: 可视化增强

### M7: ER 图可视化

**优先级**: 独立功能，最后完善

#### 依赖安装

```bash
cd apps/admin && pnpm add reactflow
```

#### 实现

**Files:**
- Create: `apps/admin/src/components/tables/ERDiagram.tsx`
- Modify: `apps/admin/src/app/t/[tenantId]/p/[projectId]/tables/page.tsx`

**Task M7-1: ER 图组件**

```tsx
// apps/admin/src/components/tables/ERDiagram.tsx
import { useMemo } from 'react';
import ReactFlow, {
  Background,
  Controls,
  MiniMap,
  Node,
  Edge,
  useNodesState,
  useEdgesState,
} from 'reactflow';
import 'reactflow/dist/style.css';
import { KeyRound } from 'lucide-react';

interface TableInfo {
  name: string;
  columns: { name: string; type: string; isPrimaryKey: boolean }[];
}

interface ForeignKey {
  fromTable: string;
  fromColumn: string;
  toTable: string;
  toColumn: string;
}

interface ERDiagramProps {
  tables: TableInfo[];
  foreignKeys: ForeignKey[];
  onTableClick?: (tableName: string) => void;
}

// 自定义表节点
const TableNode = ({ data }: { data: TableInfo }) => (
  <div className="bg-white border rounded-lg shadow-md min-w-[200px]">
    <div className="px-4 py-2 bg-primary text-primary-foreground font-medium rounded-t-lg">
      {data.name}
    </div>
    <div className="p-2 text-sm">
      {data.columns.map(col => (
        <div key={col.name} className="flex items-center gap-2 py-1">
          {col.isPrimaryKey && <KeyRound className="h-3 w-3 text-amber-500" />}
          <span className="font-mono">{col.name}</span>
          <span className="text-muted-foreground">{col.type}</span>
        </div>
      ))}
    </div>
  </div>
);

export function ERDiagram({ tables, foreignKeys, onTableClick }: ERDiagramProps) {
  // 生成节点（简单网格布局，后续可改用 dagre 自动布局）
  const initialNodes: Node[] = tables.map((table, i) => ({
    id: table.name,
    type: 'tableNode',
    position: { x: (i % 4) * 300, y: Math.floor(i / 4) * 250 },
    data: table,
  }));

  // 生成边（外键关系）
  const initialEdges: Edge[] = foreignKeys.map((fk, i) => ({
    id: `fk-${i}`,
    source: fk.fromTable,
    target: fk.toTable,
    sourceHandle: fk.fromColumn,
    targetHandle: fk.toColumn,
    label: `${fk.fromColumn} → ${fk.toColumn}`,
    animated: true,
    style: { stroke: '#6366f1' },
  }));

  const [nodes, setNodes, onNodesChange] = useNodesState(initialNodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(initialEdges);

  const nodeTypes = useMemo(() => ({ tableNode: TableNode }), []);

  return (
    <div className="h-[600px] border rounded-lg">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onNodeClick={(_, node) => onTableClick?.(node.id)}
        nodeTypes={nodeTypes}
        fitView
      >
        <Background />
        <Controls />
        <MiniMap />
      </ReactFlow>
    </div>
  );
}
```

**Task M7-2: 获取外键 API**

```typescript
// apps/api/src/modules/table/table.service.ts
export async function getForeignKeys(schemaName: string): Promise<ForeignKey[]> {
  const result = await pool.query(`
    SELECT
      tc.table_name as from_table,
      kcu.column_name as from_column,
      ccu.table_name as to_table,
      ccu.column_name as to_column
    FROM information_schema.table_constraints tc
    JOIN information_schema.key_column_usage kcu
      ON tc.constraint_name = kcu.constraint_name
      AND tc.table_schema = kcu.table_schema
    JOIN information_schema.constraint_column_usage ccu
      ON ccu.constraint_name = tc.constraint_name
      AND ccu.table_schema = tc.table_schema
    WHERE tc.constraint_type = 'FOREIGN KEY'
      AND tc.table_schema = $1
  `, [schemaName]);

  return result.rows.map(row => ({
    fromTable: row.from_table,
    fromColumn: row.from_column,
    toTable: row.to_table,
    toColumn: row.to_column,
  }));
}
```

**Task M7-3: 集成到表页面**

在 `/tables` 页面添加 "关系图" Tab:

```tsx
<Tabs defaultValue="list">
  <TabsList>
    <TabsTrigger value="list">表列表</TabsTrigger>
    <TabsTrigger value="er">关系图</TabsTrigger>
  </TabsList>

  <TabsContent value="list">
    <TableList tables={tables} />
  </TabsContent>

  <TabsContent value="er">
    <ERDiagram
      tables={tablesWithColumns}
      foreignKeys={foreignKeys}
      onTableClick={(name) => router.push(`.../${name}`)}
    />
  </TabsContent>
</Tabs>
```

#### 验收标准

- [ ] 自动从外键生成关系图
- [ ] 表节点显示表名和字段
- [ ] 主键字段有图标标识
- [ ] 关系线显示外键关联
- [ ] 可拖拽调整布局
- [ ] 可缩放/平移画布
- [ ] 有 MiniMap 导航
- [ ] 点击表节点跳转到表详情

---

## 依赖清单

| 功能 | 包/技术 | 版本 | 状态 |
|------|---------|------|------|
| SQL 编辑器 | @uiw/react-codemirror | ^4.25.5 | 待安装 |
| SQL 语法 | @codemirror/lang-sql | ^6.10.0 | 待安装 |
| SQL 格式化 | sql-formatter | ^15.0.0 | 待安装 |
| ER 图 | reactflow | ^11.11.4 | 待安装 |
| Edge Functions | denoland/deno:alpine | 2.x | Docker |

---

## 开发顺序建议

| 顺序 | 模块 | 理由 | 预估复杂度 |
|------|------|------|-----------|
| 1 | M18: Storage | 后端适配器已有，主要是数据模型重构和 UI | 中 |
| 2 | M17: Authentication | 后端部分存在，扩展 API + UI | 中 |
| 3 | M20: Realtime | 基于 Hasura，封装 API + UI | 低 |
| 4 | M3: SQL 编辑器 | 独立功能，已有详细计划 | 中 |
| 5 | M19: Edge Functions | 最复杂，新增 Deno 容器 | 高 |
| 6 | M7: ER 图 | 独立功能，可随时完善 | 低 |

---

## 风险与缓解

| 风险 | 影响 | 缓解措施 |
|------|------|----------|
| Storage 迁移数据丢失 | 现有文件丢失 | 先备份，保留旧表，分步迁移 |
| Deno Worker 集成复杂 | 延期 | 参考 InsForge 实现，简化初版 |
| Hasura Subscriptions 权限复杂 | 用户困惑 | 封装简化界面，隐藏复杂度 |
| CodeMirror 包体积大 | 首屏加载慢 | 动态导入，代码分割 |

---

## 通用实现要求

### 导航菜单更新

在项目侧边栏添加新页面入口:

**Files:**
- Modify: `apps/admin/src/components/layout/ProjectSidebar.tsx`

```tsx
const projectNavItems = [
  { href: 'tables', label: '数据表', icon: Table2 },
  { href: 'database', label: '数据库', icon: Database },
  { href: 'storage', label: '存储', icon: HardDrive },     // 新增
  { href: 'auth', label: '认证', icon: Users },           // 新增
  { href: 'functions', label: '函数', icon: Code },       // 新增
  { href: 'realtime', label: '实时', icon: Radio },       // 新增
  { href: 'settings', label: '设置', icon: Settings },
];
```

### 权限控制

所有新模块 API 需要检查用户权限:

```typescript
// apps/api/src/lib/access.ts - 权限检查辅助函数
import { pool } from '@/lib/db';

export async function checkProjectAccess(userId: string, projectId: string): Promise<boolean> {
  // 检查用户是否属于项目所属的租户
  const result = await pool.query(`
    SELECT 1 FROM druvia_projects p
    JOIN druvia_tenant_users tu ON tu.tenant_id = p.tenant_id
    WHERE p.id = $1 AND tu.user_id = $2
  `, [projectId, userId]);
  return result.rowCount > 0;
}
```

```typescript
// 在 Controller 中使用权限检查
import { checkProjectAccess } from '@/lib/access';

async listBuckets(request: FastifyRequest, reply: FastifyReply) {
  const { projectId } = request.params;

  // 检查用户是否有权访问该项目
  const hasAccess = await checkProjectAccess(request.user.id, projectId);
  if (!hasAccess) {
    return reply.status(403).send({
      success: false,
      error: { code: 'FORBIDDEN', message: 'No access to this project' }
    });
  }

  // ... 业务逻辑
}
```

### 测试计划

每个模块需要编写以下测试:

| 模块 | 单元测试 | 集成测试 | E2E 测试 |
|------|---------|---------|---------|
| M18 Storage | Service 方法 | API 端点 | 上传/下载流程 |
| M17 Auth | Provider CRUD | 用户管理 | OAuth 配置 |
| M20 Realtime | Hasura 调用 | 订阅配置 | 实时事件 |
| M3 SQL | 编辑器组件 | 执行 API | 多标签流程 |
| M19 Functions | Deno 调用 | CRUD API | 执行+日志 |
| M7 ER 图 | 节点生成 | 外键 API | 交互操作 |

测试文件位置:
- 单元测试: `tests/unit/modules/<module>/`
- 集成测试: `tests/integration/modules/<module>/`
- E2E 测试: `tests/e2e/<module>/`

---

**创建日期**: 2026-03-03
**更新日期**: 2026-03-03
**状态**: 待实施
**下一步**: 从 M18 Storage 开始实施

---

## 审查修订记录

| 日期 | 修订内容 |
|------|----------|
| 2026-03-03 | 初始版本 |
| 2026-03-03 | 审查修正 R1: (1) M20 添加 pool 导入 (2) deleteObject 添加事务保护 (3) M17 澄清项目级 vs 租户级配置 (4) M19 添加 getSecretsDecrypted 实现 (5) Docker Deno 配置收紧权限 (6) M3 SQL 多标签补全导入和函数 (7) M19 Functions Service 添加 pool 导入 |
| 2026-03-03 | 审查修正 R2: (1) crypto import 移至文件顶部 (2) 添加 checkProjectAccess 函数定义 (3) ER 图布局添加改进说明 |
