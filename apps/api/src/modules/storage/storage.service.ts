import { query, queryOne, pool } from '../../db/index.js';
import { generateBucketId, generateObjectId } from '@druvia/shared';
import { getDefaultStorageAdapter, type StorageAdapter, type UploadOptions } from '../../adapters/storage/index.js';

// Database row types
interface BucketRow {
  id: number;
  bucket_id: string;
  project_id: string;
  name: string;
  public: boolean;
  file_size_limit: number | null;
  allowed_mime_types: string[] | null;
  cors_config: Record<string, unknown> | null;
  created_at: Date;
  updated_at: Date;
}

interface ObjectRow {
  id: number;
  object_id: string;
  bucket_id: string;
  name: string;
  size: number;
  mime_type: string | null;
  etag: string | null;
  storage_provider: string | null;
  storage_path: string | null;
  metadata: Record<string, unknown>;
  created_by: string | null;
  created_at: Date;
  updated_at: Date;
}

// Public interfaces
export interface Bucket {
  id: number;
  bucketId: string;
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
  id: number;
  objectId: string;
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

export interface CreateBucketInput {
  name: string;
  public?: boolean;
  fileSizeLimit?: number;
  allowedMimeTypes?: string[];
}

export interface UpdateBucketInput {
  public?: boolean;
  fileSizeLimit?: number | null;
  allowedMimeTypes?: string[] | null;
  corsConfig?: Record<string, unknown> | null;
}

export interface ListObjectsOptions {
  prefix?: string;
  limit?: number;
  offset?: number;
}

// Helper functions
function toBucket(row: BucketRow): Bucket {
  return {
    id: row.id,
    bucketId: row.bucket_id,
    projectId: row.project_id,
    name: row.name,
    public: row.public,
    fileSizeLimit: row.file_size_limit ? Number(row.file_size_limit) : null,
    allowedMimeTypes: row.allowed_mime_types,
    corsConfig: row.cors_config,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toStorageObject(row: ObjectRow): StorageObject {
  return {
    id: row.id,
    objectId: row.object_id,
    bucketId: row.bucket_id,
    name: row.name,
    size: Number(row.size),
    mimeType: row.mime_type,
    etag: row.etag,
    storageProvider: row.storage_provider,
    storagePath: row.storage_path,
    metadata: row.metadata || {},
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

let storageAdapter: StorageAdapter | null = null;

function getStorage(): StorageAdapter {
  if (!storageAdapter) {
    storageAdapter = getDefaultStorageAdapter();
  }
  return storageAdapter;
}

// ============================================
// Bucket CRUD
// ============================================

export async function listBuckets(projectId: string): Promise<Bucket[]> {
  const rows = await query<BucketRow>(
    'SELECT * FROM druvia_storage_buckets WHERE project_id = $1 ORDER BY name',
    [projectId]
  );
  return rows.map(toBucket);
}

export async function createBucket(projectId: string, input: CreateBucketInput): Promise<Bucket> {
  const bucketId = generateBucketId();

  const row = await queryOne<BucketRow>(
    `INSERT INTO druvia_storage_buckets (bucket_id, project_id, name, public, file_size_limit, allowed_mime_types)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING *`,
    [
      bucketId,
      projectId,
      input.name,
      input.public || false,
      input.fileSizeLimit || null,
      input.allowedMimeTypes || null,
    ]
  );

  if (!row) {
    throw new Error('Failed to create bucket');
  }

  return toBucket(row);
}

export async function getBucketByName(projectId: string, bucketName: string): Promise<Bucket | null> {
  const row = await queryOne<BucketRow>(
    'SELECT * FROM druvia_storage_buckets WHERE project_id = $1 AND name = $2',
    [projectId, bucketName]
  );
  return row ? toBucket(row) : null;
}

export async function getBucketById(bucketId: string): Promise<Bucket | null> {
  const row = await queryOne<BucketRow>(
    'SELECT * FROM druvia_storage_buckets WHERE bucket_id = $1',
    [bucketId]
  );
  return row ? toBucket(row) : null;
}

export async function updateBucket(
  projectId: string,
  bucketName: string,
  input: UpdateBucketInput
): Promise<Bucket | null> {
  const setClauses: string[] = [];
  const values: unknown[] = [];
  let paramIndex = 3;

  if (input.public !== undefined) {
    setClauses.push(`public = $${paramIndex++}`);
    values.push(input.public);
  }
  if (input.fileSizeLimit !== undefined) {
    setClauses.push(`file_size_limit = $${paramIndex++}`);
    values.push(input.fileSizeLimit);
  }
  if (input.allowedMimeTypes !== undefined) {
    setClauses.push(`allowed_mime_types = $${paramIndex++}`);
    values.push(input.allowedMimeTypes);
  }
  if (input.corsConfig !== undefined) {
    setClauses.push(`cors_config = $${paramIndex++}`);
    values.push(input.corsConfig ? JSON.stringify(input.corsConfig) : null);
  }

  if (setClauses.length === 0) {
    return getBucketByName(projectId, bucketName);
  }

  const row = await queryOne<BucketRow>(
    `UPDATE druvia_storage_buckets SET ${setClauses.join(', ')}
     WHERE project_id = $1 AND name = $2 RETURNING *`,
    [projectId, bucketName, ...values]
  );

  return row ? toBucket(row) : null;
}

export async function deleteBucket(projectId: string, bucketName: string): Promise<boolean> {
  const bucket = await getBucketByName(projectId, bucketName);
  if (!bucket) return false;

  // Check if bucket is empty
  const countResult = await queryOne<{ count: string }>(
    'SELECT COUNT(*) as count FROM druvia_storage_objects WHERE bucket_id = $1',
    [bucket.bucketId]
  );
  if (countResult && parseInt(countResult.count) > 0) {
    throw new Error('Bucket is not empty');
  }

  const rows = await query<{ bucket_id: string }>(
    'DELETE FROM druvia_storage_buckets WHERE project_id = $1 AND name = $2 RETURNING bucket_id',
    [projectId, bucketName]
  );

  return rows.length > 0;
}

// ============================================
// Object CRUD
// ============================================

export async function listObjects(
  bucketId: string,
  options?: ListObjectsOptions
): Promise<{ objects: StorageObject[]; total: number }> {
  let whereClause = 'WHERE bucket_id = $1';
  const values: unknown[] = [bucketId];
  let paramIndex = 2;

  if (options?.prefix) {
    whereClause += ` AND name LIKE $${paramIndex++}`;
    values.push(`${options.prefix}%`);
  }

  const countResult = await queryOne<{ count: string }>(
    `SELECT COUNT(*) as count FROM druvia_storage_objects ${whereClause}`,
    values
  );

  let queryText = `SELECT * FROM druvia_storage_objects ${whereClause} ORDER BY name`;
  const queryValues = [...values];

  if (options?.limit) {
    queryText += ` LIMIT $${paramIndex++}`;
    queryValues.push(options.limit);
  }
  if (options?.offset) {
    queryText += ` OFFSET $${paramIndex++}`;
    queryValues.push(options.offset);
  }

  const rows = await query<ObjectRow>(queryText, queryValues);

  return {
    objects: rows.map(toStorageObject),
    total: parseInt(countResult?.count || '0'),
  };
}

export async function uploadObject(
  bucket: Bucket,
  name: string,
  file: Buffer,
  mimeType: string,
  userId?: string
): Promise<StorageObject> {
  // Validate file size
  if (bucket.fileSizeLimit && file.length > bucket.fileSizeLimit) {
    throw new Error(`File size exceeds limit of ${bucket.fileSizeLimit} bytes`);
  }

  // Validate MIME type
  if (bucket.allowedMimeTypes && bucket.allowedMimeTypes.length > 0) {
    if (!bucket.allowedMimeTypes.includes(mimeType)) {
      throw new Error(`MIME type ${mimeType} is not allowed`);
    }
  }

  const storage = getStorage();
  const objectId = generateObjectId();
  const storagePath = `${bucket.projectId}/${bucket.name}/${name}`;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Upload to storage first
    const uploadOptions: UploadOptions = { contentType: mimeType };
    const uploadResult = await storage.upload(file, storagePath, uploadOptions);

    // Save metadata
    const result = await client.query<ObjectRow>(
      `INSERT INTO druvia_storage_objects
       (object_id, bucket_id, name, size, mime_type, etag, storage_provider, storage_path, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (bucket_id, name) DO UPDATE SET
         size = $4, mime_type = $5, etag = $6, storage_path = $8, updated_at = NOW()
       RETURNING *`,
      [
        objectId,
        bucket.bucketId,
        name,
        file.length,
        mimeType,
        uploadResult.etag || null,
        storage.name,
        storagePath,
        userId || null,
      ]
    );

    await client.query('COMMIT');
    return toStorageObject(result.rows[0]);
  } catch (error) {
    await client.query('ROLLBACK');
    // Try to clean up uploaded file
    try {
      await storage.delete(storagePath);
    } catch {
      // Ignore cleanup errors
    }
    throw error;
  } finally {
    client.release();
  }
}

export async function getObject(bucketId: string, name: string): Promise<StorageObject | null> {
  const row = await queryOne<ObjectRow>(
    'SELECT * FROM druvia_storage_objects WHERE bucket_id = $1 AND name = $2',
    [bucketId, name]
  );
  return row ? toStorageObject(row) : null;
}

export async function getObjectById(objectId: string): Promise<StorageObject | null> {
  const row = await queryOne<ObjectRow>(
    'SELECT * FROM druvia_storage_objects WHERE object_id = $1',
    [objectId]
  );
  return row ? toStorageObject(row) : null;
}

export async function downloadObject(object: StorageObject): Promise<Buffer> {
  if (!object.storagePath) {
    throw new Error('Object has no storage path');
  }

  const storage = getStorage();
  return storage.download(object.storagePath);
}

export async function deleteObject(bucketId: string, name: string): Promise<boolean> {
  const object = await getObject(bucketId, name);
  if (!object) return false;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Delete metadata first
    const result = await client.query(
      'DELETE FROM druvia_storage_objects WHERE bucket_id = $1 AND name = $2',
      [bucketId, name]
    );

    if (result.rowCount === 0) {
      await client.query('ROLLBACK');
      return false;
    }

    // Delete from storage
    if (object.storagePath) {
      const storage = getStorage();
      await storage.delete(object.storagePath);
    }

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
  if (!object.storagePath) {
    throw new Error('Object has no storage path');
  }
  const storage = getStorage();
  return storage.getSignedUrl(object.storagePath, expiresIn);
}

export async function getPublicUrl(object: StorageObject): Promise<string> {
  if (!object.storagePath) {
    throw new Error('Object has no storage path');
  }
  const storage = getStorage();
  return storage.getPublicUrl(object.storagePath);
}

// ============================================
// Download URL (Public/Signed)
// ============================================

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
