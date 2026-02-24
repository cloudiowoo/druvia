import { query, queryOne } from '../../db/index.js';
import { generateFileId } from '@druvia/shared';
import { getDefaultStorageAdapter, type StorageAdapter, type UploadOptions } from '../../adapters/storage/index.js';

// Database row type
interface FileRow {
  id: number;
  file_id: string;
  tenant_id: string;
  project_id: string | null;
  bucket: string;
  path: string;
  filename: string;
  content_type: string | null;
  size_bytes: number;
  storage_provider: string;
  storage_key: string | null;
  metadata: Record<string, unknown>;
  created_by: number | null;
  created_at: Date;
  updated_at: Date;
}

export interface FileMetadata {
  id: number;
  fileId: string;
  tenantId: string;
  projectId: string | null;
  bucket: string;
  path: string;
  filename: string;
  contentType: string | null;
  sizeBytes: number;
  storageProvider: string;
  storageKey: string | null;
  metadata: Record<string, unknown>;
  createdBy: number | null;
  createdAt: Date;
  updatedAt: Date;
  url?: string;
}

function toFileMetadata(row: FileRow): FileMetadata {
  return {
    id: row.id,
    fileId: row.file_id,
    tenantId: row.tenant_id,
    projectId: row.project_id,
    bucket: row.bucket,
    path: row.path,
    filename: row.filename,
    contentType: row.content_type,
    sizeBytes: row.size_bytes,
    storageProvider: row.storage_provider,
    storageKey: row.storage_key,
    metadata: row.metadata,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export interface UploadInput {
  tenantId: string;
  projectId?: string;
  bucket: string;
  filename: string;
  contentType?: string;
  createdBy?: number;
  metadata?: Record<string, unknown>;
}

let storageAdapter: StorageAdapter | null = null;

function getStorage(): StorageAdapter {
  if (!storageAdapter) {
    storageAdapter = getDefaultStorageAdapter();
  }
  return storageAdapter;
}

export async function uploadFile(
  file: Buffer,
  input: UploadInput
): Promise<FileMetadata> {
  const fileId = generateFileId();
  const storage = getStorage();

  // 构建存储路径: tenant_id/bucket/filename
  const storagePath = input.projectId
    ? `${input.tenantId}/${input.projectId}/${input.bucket}/${fileId}_${input.filename}`
    : `${input.tenantId}/${input.bucket}/${fileId}_${input.filename}`;

  // 上传到存储
  const uploadOptions: UploadOptions = {
    contentType: input.contentType,
  };
  const result = await storage.upload(file, storagePath, uploadOptions);

  // 保存元数据到数据库
  const row = await queryOne<FileRow>(
    `INSERT INTO druvia_files
     (file_id, tenant_id, project_id, bucket, path, filename, content_type, size_bytes, storage_provider, storage_key, metadata, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
     RETURNING *`,
    [
      fileId,
      input.tenantId,
      input.projectId || null,
      input.bucket,
      storagePath,
      input.filename,
      input.contentType || null,
      file.length,
      storage.name,
      result.etag || null,
      input.metadata || {},
      input.createdBy || null,
    ]
  );

  if (!row) {
    throw new Error('Failed to save file metadata');
  }

  const metadata = toFileMetadata(row);
  metadata.url = result.url;
  return metadata;
}

export async function getFileById(fileId: string): Promise<FileMetadata | null> {
  const row = await queryOne<FileRow>(
    'SELECT * FROM druvia_files WHERE file_id = $1',
    [fileId]
  );

  if (!row) return null;

  const metadata = toFileMetadata(row);
  metadata.url = getStorage().getPublicUrl(row.path);
  return metadata;
}

export async function listFiles(
  tenantId: string,
  bucket?: string,
  projectId?: string,
  limit = 50,
  offset = 0
): Promise<FileMetadata[]> {
  let sql = 'SELECT * FROM druvia_files WHERE tenant_id = $1';
  const params: unknown[] = [tenantId];
  let paramIndex = 2;

  if (bucket) {
    sql += ` AND bucket = $${paramIndex++}`;
    params.push(bucket);
  }
  if (projectId) {
    sql += ` AND project_id = $${paramIndex++}`;
    params.push(projectId);
  }

  sql += ` ORDER BY created_at DESC LIMIT $${paramIndex++} OFFSET $${paramIndex}`;
  params.push(limit, offset);

  const rows = await query<FileRow>(sql, params);
  const storage = getStorage();

  return rows.map(row => {
    const metadata = toFileMetadata(row);
    metadata.url = storage.getPublicUrl(row.path);
    return metadata;
  });
}

export async function deleteFile(fileId: string): Promise<boolean> {
  const file = await getFileById(fileId);
  if (!file) return false;

  // 从存储删除
  const storage = getStorage();
  await storage.delete(file.path);

  // 从数据库删除
  const rows = await query<{ file_id: string }>(
    'DELETE FROM druvia_files WHERE file_id = $1 RETURNING file_id',
    [fileId]
  );

  return rows.length > 0;
}

export async function getSignedUrl(fileId: string, expiresIn = 3600): Promise<string | null> {
  const file = await getFileById(fileId);
  if (!file) return null;

  const storage = getStorage();
  return storage.getSignedUrl(file.path, expiresIn);
}
