import { query, queryOne, pool } from '../../db/index.js';
import { generateBucketId, generateObjectId } from '@druvia/shared';
import { getDefaultStorageAdapter, type StorageAdapter, type UploadOptions } from '../../adapters/storage/index.js';
import {
  assertStorageActorProject,
  decideStorageObjectAccess,
  normalizeStorageProjectUserAccess,
  StorageAccessError,
  storageOwnerFilter,
  type StorageActor,
  type StorageProjectUserAccess,
} from './storage-access.service.js';
import {
  encodeStorageObjectPath,
  normalizeStorageObjectPath,
  normalizeStoragePathPrefix,
  storageLikePrefix,
} from './storage-path.js';
import {
  MAX_STORAGE_OBJECT_BYTES,
  normalizeAllowedStorageMimeTypes,
  normalizeStorageFileSizeLimit,
  normalizeStorageMimeType,
} from './storage-validation.js';

// Database row types
interface BucketRow {
  id: number;
  bucket_id: string;
  project_id: string;
  name: string;
  public: boolean;
  project_user_access: StorageProjectUserAccess;
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
  owner_project_user_id: string | null;
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
  projectUserAccess: StorageProjectUserAccess;
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
  ownerProjectUserId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateBucketInput {
  name: string;
  public?: boolean;
  fileSizeLimit?: number | null;
  allowedMimeTypes?: string[] | null;
  projectUserAccess?: StorageProjectUserAccess;
}

export interface UpdateBucketInput {
  public?: boolean;
  fileSizeLimit?: number | null;
  allowedMimeTypes?: string[] | null;
  corsConfig?: Record<string, unknown> | null;
  projectUserAccess?: StorageProjectUserAccess;
}

export interface ListObjectsOptions {
  prefix?: string;
  limit?: number;
  offset?: number;
  ownerProjectUserId?: string;
}

export interface StorageUploadAuditContext {
  createdByType?: 'platform_user' | 'project_user' | 'apikey' | 'trusted_backend_project_user';
  platformUserId?: string;
  projectUserId?: string;
  sourceFunction?: string;
  issuedBy?: string;
  issuedVia?: 'trusted_storage_ticket';
}

// Helper functions
function toBucket(row: BucketRow): Bucket {
  return {
    id: row.id,
    bucketId: row.bucket_id,
    projectId: row.project_id,
    name: row.name,
    public: row.public,
    projectUserAccess: row.project_user_access,
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
    ownerProjectUserId: row.owner_project_user_id,
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
  const fileSizeLimit = input.fileSizeLimit === undefined
    ? null
    : normalizeStorageFileSizeLimit(input.fileSizeLimit);
  const allowedMimeTypes = input.allowedMimeTypes === undefined
    ? null
    : normalizeAllowedStorageMimeTypes(input.allowedMimeTypes);

  const row = await queryOne<BucketRow>(
    `INSERT INTO druvia_storage_buckets
       (bucket_id, project_id, name, public, file_size_limit, allowed_mime_types, project_user_access)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING *`,
    [
      bucketId,
      projectId,
      input.name,
      input.public || false,
      fileSizeLimit,
      allowedMimeTypes,
      normalizeStorageProjectUserAccess(input.projectUserAccess ?? 'admin_only'),
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
    values.push(normalizeStorageFileSizeLimit(input.fileSizeLimit));
  }
  if (input.allowedMimeTypes !== undefined) {
    setClauses.push(`allowed_mime_types = $${paramIndex++}`);
    values.push(normalizeAllowedStorageMimeTypes(input.allowedMimeTypes));
  }
  if (input.corsConfig !== undefined) {
    setClauses.push(`cors_config = $${paramIndex++}`);
    values.push(input.corsConfig ? JSON.stringify(input.corsConfig) : null);
  }
  if (input.projectUserAccess !== undefined) {
    setClauses.push(`project_user_access = $${paramIndex++}`);
    values.push(normalizeStorageProjectUserAccess(input.projectUserAccess));
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
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const bucketResult = await client.query<BucketRow>(
      `SELECT * FROM druvia_storage_buckets
       WHERE project_id = $1 AND name = $2 FOR UPDATE`,
      [projectId, bucketName]
    );
    const bucket = bucketResult.rows[0];
    if (!bucket) {
      await client.query('ROLLBACK');
      return false;
    }
    const countResult = await client.query<{ count: string }>(
      'SELECT COUNT(*) AS count FROM druvia_storage_objects WHERE bucket_id = $1',
      [bucket.bucket_id]
    );
    if (Number(countResult.rows[0]?.count ?? 0) > 0) {
      throw new Error('Bucket is not empty');
    }
    const result = await client.query(
      'DELETE FROM druvia_storage_buckets WHERE bucket_id = $1',
      [bucket.bucket_id]
    );
    await client.query('COMMIT');
    return (result.rowCount ?? 0) > 0;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
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

  if (options?.prefix !== undefined && options.prefix !== '') {
    whereClause += ` AND name LIKE $${paramIndex++} ESCAPE '\\'`;
    values.push(storageLikePrefix(options.prefix));
  }
  if (options?.ownerProjectUserId) {
    whereClause += ` AND owner_project_user_id = $${paramIndex++}`;
    values.push(options.ownerProjectUserId);
  }

  const countResult = await queryOne<{ count: string }>(
    `SELECT COUNT(*) as count FROM druvia_storage_objects ${whereClause}`,
    values
  );

  let queryText = `SELECT * FROM druvia_storage_objects ${whereClause} ORDER BY name`;
  const queryValues = [...values];

  if (options?.limit !== undefined) {
    queryText += ` LIMIT $${paramIndex++}`;
    queryValues.push(options.limit);
  }
  if (options?.offset !== undefined && options.offset > 0) {
    queryText += ` OFFSET $${paramIndex++}`;
    queryValues.push(options.offset);
  }

  const rows = await query<ObjectRow>(queryText, queryValues);

  return {
    objects: rows.map(toStorageObject),
    total: parseInt(countResult?.count || '0'),
  };
}

export async function listObjectsForActor(
  bucket: Bucket,
  actor: StorageActor,
  options?: Omit<ListObjectsOptions, 'ownerProjectUserId'>
): Promise<{ objects: StorageObject[]; total: number }> {
  const limit = options?.limit ?? 50;
  const offset = options?.offset ?? 0;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100
    || !Number.isInteger(offset) || offset < 0 || offset > 1_000_000) {
    throw new StorageAccessError(
      'INVALID_STORAGE_REQUEST',
      'limit must be 1-100 and offset 0-1000000',
      400
    );
  }
  const prefix = options?.prefix === undefined
    ? undefined
    : normalizeStoragePathPrefix(options.prefix);
  assertStorageActorProject(actor, bucket.projectId);
  const currentBucket = await getBucketById(bucket.bucketId);
  if (!currentBucket) {
    throw new StorageAccessError('OBJECT_NOT_FOUND', 'Storage bucket not found', 404);
  }
  assertStorageActorProject(actor, currentBucket.projectId);
  const ownerProjectUserId = storageOwnerFilter(currentBucket.projectUserAccess, actor);

  return listObjects(currentBucket.bucketId, { prefix, limit, offset, ownerProjectUserId });
}

export async function uploadObject(
  bucket: Bucket,
  name: string,
  file: Buffer,
  mimeType: string,
  auditContext?: StorageUploadAuditContext,
  actor?: StorageActor
): Promise<StorageObject> {
  if (file.length > MAX_STORAGE_OBJECT_BYTES) {
    throw new Error(`File size exceeds service limit of ${MAX_STORAGE_OBJECT_BYTES} bytes`);
  }
  const normalizedMimeType = normalizeStorageMimeType(mimeType);
  const storage = getStorage();
  const normalizedName = normalizeStorageObjectPath(name);
  const objectId = generateObjectId();
  const metadata = {
    ...(auditContext?.createdByType
      ? { created_by_type: auditContext.createdByType }
      : {}),
    ...(auditContext?.platformUserId
      ? { created_by_platform_user_id: auditContext.platformUserId }
      : {}),
    ...(auditContext?.projectUserId
      ? { created_by_project_user_id: auditContext.projectUserId }
      : {}),
    ...(auditContext?.sourceFunction
      ? { source_function: auditContext.sourceFunction }
      : {}),
    ...(auditContext?.issuedBy
      ? { issued_by: auditContext.issuedBy }
      : {}),
    ...(auditContext?.issuedVia
      ? { issued_via: auditContext.issuedVia }
      : {}),
  } satisfies Record<string, unknown>;
  const createdBy = auditContext?.platformUserId ?? null;

  const client = await pool.connect();
  let storagePath: string | null = null;
  let generatedNewStoragePath = false;
  try {
    await client.query('BEGIN');

    const bucketResult = await client.query<BucketRow>(
      'SELECT * FROM druvia_storage_buckets WHERE bucket_id = $1 FOR SHARE',
      [bucket.bucketId]
    );
    const lockedBucketRow = bucketResult.rows[0];
    if (!lockedBucketRow) throw new Error('Bucket not found');
    const lockedBucket = toBucket(lockedBucketRow);
    if (actor) assertStorageActorProject(actor, lockedBucket.projectId);
    if (lockedBucket.fileSizeLimit && file.length > lockedBucket.fileSizeLimit) {
      throw new Error(`File size exceeds limit of ${lockedBucket.fileSizeLimit} bytes`);
    }
    if (lockedBucket.allowedMimeTypes?.length
      && !lockedBucket.allowedMimeTypes.includes(normalizedMimeType)) {
      throw new Error(`MIME type ${normalizedMimeType} is not allowed`);
    }
    await client.query(
      'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
      [`${bucket.bucketId.length}:${bucket.bucketId}${normalizedName}`]
    );
    const existingResult = await client.query<ObjectRow>(
      `SELECT * FROM druvia_storage_objects
       WHERE bucket_id = $1 AND name = $2 FOR UPDATE`,
      [bucket.bucketId, normalizedName]
    );
    const existing = existingResult.rows[0] ? toStorageObject(existingResult.rows[0]) : null;
    let ownerProjectUserId = existing?.ownerProjectUserId ?? null;
    if (actor) {
      const decision = decideStorageObjectAccess({
        preset: lockedBucket.projectUserAccess,
        actor,
        operation: 'write',
        objectExists: Boolean(existing),
        objectOwnerProjectUserId: ownerProjectUserId,
      });
      if (actor.actorType === 'project_user') ownerProjectUserId = decision.ownerProjectUserId ?? null;
    } else if (
      auditContext?.projectUserId
      && (auditContext.createdByType === 'project_user'
        || auditContext.createdByType === 'trusted_backend_project_user')
    ) {
      ownerProjectUserId = auditContext.projectUserId;
    }

    const persistedObjectId = existing?.objectId ?? objectId;
    const reusableStoragePath = existing?.storagePath?.trim() || null;
    storagePath = reusableStoragePath
      ?? `${lockedBucket.projectId}/${lockedBucket.bucketId}/objects/${persistedObjectId}`;
    generatedNewStoragePath = reusableStoragePath === null;

    // Upload to storage first
    const uploadOptions: UploadOptions = { contentType: normalizedMimeType };
    const uploadResult = await storage.upload(file, storagePath, uploadOptions);

    // Save metadata
    const result = await client.query<ObjectRow>(
      `INSERT INTO druvia_storage_objects
       (object_id, bucket_id, name, size, mime_type, etag, storage_provider, storage_path, metadata, created_by,
        owner_project_user_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11)
       ON CONFLICT (bucket_id, name) DO UPDATE SET
         size = $4,
         mime_type = $5,
         etag = $6,
         storage_path = $8,
         metadata = $9::jsonb,
         created_by = $10,
         owner_project_user_id = $11,
         updated_at = NOW()
       RETURNING *`,
      [
        objectId,
        bucket.bucketId,
        normalizedName,
        file.length,
        normalizedMimeType,
        uploadResult.etag || null,
        storage.name,
        storagePath,
        JSON.stringify(metadata),
        createdBy,
        ownerProjectUserId,
      ]
    );

    await client.query('COMMIT');
    return toStorageObject(result.rows[0]);
  } catch (error) {
    await client.query('ROLLBACK');
    // Try to clean up uploaded file
    if (generatedNewStoragePath && storagePath) {
      try {
        await storage.delete(storagePath);
      } catch {
        // A failed cleanup is reconciled operationally; never mask the database error.
      }
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

export async function getObjectForActor(
  bucket: Bucket,
  name: string,
  actor: StorageActor
): Promise<StorageObject | null> {
  assertStorageActorProject(actor, bucket.projectId);
  const currentBucket = await getBucketById(bucket.bucketId);
  if (!currentBucket) return null;
  assertStorageActorProject(actor, currentBucket.projectId);
  const object = await getObject(currentBucket.bucketId, normalizeStorageObjectPath(name));
  if (!object) return null;
  decideStorageObjectAccess({
    preset: currentBucket.projectUserAccess,
    actor,
    operation: 'read',
    objectExists: true,
    objectOwnerProjectUserId: object.ownerProjectUserId,
  });
  return object;
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

export async function deleteObject(
  bucketId: string,
  name: string,
  actor?: StorageActor
): Promise<boolean> {
  const normalizedName = normalizeStorageObjectPath(name);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const bucketResult = await client.query<BucketRow>(
      'SELECT * FROM druvia_storage_buckets WHERE bucket_id = $1 FOR SHARE',
      [bucketId]
    );
    const bucketRow = bucketResult.rows[0];
    if (!bucketRow) {
      await client.query('ROLLBACK');
      return false;
    }
    if (actor) assertStorageActorProject(actor, bucketRow.project_id);
    await client.query(
      'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
      [`${bucketId.length}:${bucketId}${normalizedName}`]
    );
    const objectResult = await client.query<ObjectRow>(
      `SELECT * FROM druvia_storage_objects
       WHERE bucket_id = $1 AND name = $2 FOR UPDATE`,
      [bucketId, normalizedName]
    );
    const object = objectResult.rows[0] ? toStorageObject(objectResult.rows[0]) : null;
    if (!object) {
      await client.query('ROLLBACK');
      return false;
    }
    if (actor) {
      decideStorageObjectAccess({
        preset: toBucket(bucketRow).projectUserAccess,
        actor,
        operation: 'delete',
        objectExists: true,
        objectOwnerProjectUserId: object.ownerProjectUserId,
      });
    }

    // Delete metadata first
    const result = await client.query(
      'DELETE FROM druvia_storage_objects WHERE bucket_id = $1 AND name = $2',
      [bucketId, normalizedName]
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
  return storage.getSignedUrl(object.storagePath, expiresIn, {
    logicalName: object.name,
    contentType: object.mimeType || 'application/octet-stream',
  });
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
    const url = `${apiBaseUrl}/api/v1/storage/public/${encodeURIComponent(bucket.projectId)}/${encodeURIComponent(bucket.name)}/${encodeStorageObjectPath(object.name)}`;
    return { url, expiresIn: null };
  } else {
    // 非公开 bucket：返回签名 URL
    const storage = getStorage();
    const url = await storage.getSignedUrl(object.storagePath, expiresIn, {
      logicalName: object.name,
      contentType: object.mimeType || 'application/octet-stream',
    });
    return { url, expiresIn };
  }
}

export async function getBucketByProjectAndName(
  projectId: string,
  bucketName: string
): Promise<Bucket | null> {
  return getBucketByName(projectId, bucketName);
}
