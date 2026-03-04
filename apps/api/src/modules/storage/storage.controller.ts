import type { FastifyRequest, FastifyReply } from 'fastify';
import type { MultipartFile } from '@fastify/multipart';
import * as storageService from './storage.service.js';
import { checkProjectAccess } from '../../lib/access.js';

// ============================================
// Parameter/Query Types
// ============================================

interface ProjectParams {
  projectId: string;
}

interface BucketParams extends ProjectParams {
  bucketName: string;
}

interface ObjectParams extends BucketParams {
  '*': string; // Wildcard path for object name
}

interface CreateBucketBody {
  name: string;
  public?: boolean;
  fileSizeLimit?: number;
  allowedMimeTypes?: string[];
}

interface UpdateBucketBody {
  public?: boolean;
  fileSizeLimit?: number | null;
  allowedMimeTypes?: string[] | null;
  corsConfig?: Record<string, unknown> | null;
}

interface ListObjectsQuery {
  prefix?: string;
  limit?: string;
  offset?: string;
}

interface SignedUrlBody {
  objectPath: string;
  expiresIn?: number;
}

interface MultipartRequest extends FastifyRequest<{ Params: BucketParams }> {
  file(): Promise<MultipartFile | undefined>;
}

// ============================================
// Validation Helpers
// ============================================

// S3-compatible bucket naming: 3-63 chars, lowercase alphanumeric and hyphens
const BUCKET_NAME_REGEX = /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/;

function validateBucketName(name: string): boolean {
  return BUCKET_NAME_REGEX.test(name) && !name.includes('--');
}

// Sanitize object path to prevent path traversal
function sanitizeObjectPath(path: string): string | null {
  if (!path || path.length > 1024) return null;
  // Reject path traversal attempts
  if (path.includes('..') || path.includes('\0')) return null;
  // Normalize path separators and remove leading slashes
  const normalized = path.replace(/\\/g, '/').replace(/^\/+/, '');
  return normalized || null;
}

// ============================================
// Access Control Helper
// ============================================

async function verifyProjectAccess(
  request: FastifyRequest<{ Params: ProjectParams }>,
  reply: FastifyReply
): Promise<boolean> {
  const userId = request.user?.userId;
  if (!userId) {
    reply.status(401).send({
      success: false,
      error: { code: 'UNAUTHORIZED', message: 'Authentication required' },
    });
    return false;
  }

  const hasAccess = await checkProjectAccess(userId, request.params.projectId);
  if (!hasAccess) {
    reply.status(403).send({
      success: false,
      error: { code: 'FORBIDDEN', message: 'No access to this project' },
    });
    return false;
  }

  return true;
}

// ============================================
// Bucket Controllers
// ============================================

export async function listBuckets(
  request: FastifyRequest<{ Params: ProjectParams }>,
  reply: FastifyReply
) {
  if (!(await verifyProjectAccess(request, reply))) return;

  const buckets = await storageService.listBuckets(request.params.projectId);
  return reply.send({ success: true, data: buckets });
}

export async function createBucket(
  request: FastifyRequest<{ Params: ProjectParams; Body: CreateBucketBody }>,
  reply: FastifyReply
) {
  if (!(await verifyProjectAccess(request, reply))) return;

  // Validate bucket name
  if (!validateBucketName(request.body.name)) {
    return reply.status(400).send({
      success: false,
      error: {
        code: 'INVALID_BUCKET_NAME',
        message: 'Bucket name must be 3-63 characters, lowercase alphanumeric and hyphens only',
      },
    });
  }

  try {
    const bucket = await storageService.createBucket(request.params.projectId, request.body);
    return reply.status(201).send({ success: true, data: bucket });
  } catch (error) {
    const err = error as Error;
    if (err.message.includes('duplicate key') || err.message.includes('unique constraint')) {
      return reply.status(409).send({
        success: false,
        error: { code: 'BUCKET_EXISTS', message: 'Bucket already exists' },
      });
    }
    throw error;
  }
}

export async function getBucket(
  request: FastifyRequest<{ Params: BucketParams }>,
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

  return reply.send({ success: true, data: bucket });
}

export async function updateBucket(
  request: FastifyRequest<{ Params: BucketParams; Body: UpdateBucketBody }>,
  reply: FastifyReply
) {
  if (!(await verifyProjectAccess(request, reply))) return;

  const bucket = await storageService.updateBucket(
    request.params.projectId,
    request.params.bucketName,
    request.body
  );

  if (!bucket) {
    return reply.status(404).send({
      success: false,
      error: { code: 'NOT_FOUND', message: 'Bucket not found' },
    });
  }

  return reply.send({ success: true, data: bucket });
}

export async function deleteBucket(
  request: FastifyRequest<{ Params: BucketParams }>,
  reply: FastifyReply
) {
  if (!(await verifyProjectAccess(request, reply))) return;

  try {
    const deleted = await storageService.deleteBucket(
      request.params.projectId,
      request.params.bucketName
    );

    if (!deleted) {
      return reply.status(404).send({
        success: false,
        error: { code: 'NOT_FOUND', message: 'Bucket not found' },
      });
    }

    return reply.status(204).send();
  } catch (error) {
    const err = error as Error;
    if (err.message.includes('not empty')) {
      return reply.status(409).send({
        success: false,
        error: { code: 'BUCKET_NOT_EMPTY', message: 'Bucket is not empty' },
      });
    }
    throw error;
  }
}

// ============================================
// Object Controllers
// ============================================

export async function listObjects(
  request: FastifyRequest<{ Params: BucketParams; Querystring: ListObjectsQuery }>,
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

  const limit = parseInt(request.query.limit || '50', 10);
  const offset = parseInt(request.query.offset || '0', 10);

  const result = await storageService.listObjects(bucket.bucketId, {
    prefix: request.query.prefix,
    limit,
    offset,
  });

  return reply.send({
    success: true,
    data: result.objects,
    pagination: { limit, offset, total: result.total },
  });
}

export async function uploadObject(
  request: MultipartRequest,
  reply: FastifyReply
) {
  if (!(await verifyProjectAccess(request as FastifyRequest<{ Params: ProjectParams }>, reply))) return;

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

  const data = await request.file();
  if (!data) {
    return reply.status(400).send({
      success: false,
      error: { code: 'NO_FILE', message: 'No file uploaded' },
    });
  }

  // Validate filename
  const sanitizedName = sanitizeObjectPath(data.filename);
  if (!sanitizedName) {
    return reply.status(400).send({
      success: false,
      error: { code: 'INVALID_FILENAME', message: 'Invalid filename' },
    });
  }

  try {
    const buffer = await data.toBuffer();
    const object = await storageService.uploadObject(
      bucket,
      sanitizedName,
      buffer,
      data.mimetype,
      request.user?.userId
    );

    return reply.status(201).send({ success: true, data: object });
  } catch (error) {
    const err = error as Error;
    if (err.message.includes('exceeds limit')) {
      return reply.status(413).send({
        success: false,
        error: { code: 'FILE_TOO_LARGE', message: err.message },
      });
    }
    if (err.message.includes('not allowed')) {
      return reply.status(415).send({
        success: false,
        error: { code: 'INVALID_MIME_TYPE', message: err.message },
      });
    }
    throw error;
  }
}

export async function downloadObject(
  request: FastifyRequest<{ Params: ObjectParams }>,
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

  const objectPath = sanitizeObjectPath(request.params['*']);
  if (!objectPath) {
    return reply.status(400).send({
      success: false,
      error: { code: 'INVALID_PATH', message: 'Invalid object path' },
    });
  }

  const object = await storageService.getObject(bucket.bucketId, objectPath);

  if (!object) {
    return reply.status(404).send({
      success: false,
      error: { code: 'NOT_FOUND', message: 'Object not found' },
    });
  }

  try {
    const buffer = await storageService.downloadObject(object);
    reply.header('Content-Type', object.mimeType || 'application/octet-stream');
    reply.header('Content-Length', buffer.length);
    reply.header('Content-Disposition', `attachment; filename="${encodeURIComponent(objectPath.split('/').pop() || 'file')}"`);
    return reply.send(buffer);
  } catch (error) {
    const err = error as Error;
    return reply.status(500).send({
      success: false,
      error: { code: 'DOWNLOAD_FAILED', message: err.message },
    });
  }
}

export async function deleteObject(
  request: FastifyRequest<{ Params: ObjectParams }>,
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

  const objectPath = sanitizeObjectPath(request.params['*']);
  if (!objectPath) {
    return reply.status(400).send({
      success: false,
      error: { code: 'INVALID_PATH', message: 'Invalid object path' },
    });
  }

  const deleted = await storageService.deleteObject(bucket.bucketId, objectPath);

  if (!deleted) {
    return reply.status(404).send({
      success: false,
      error: { code: 'NOT_FOUND', message: 'Object not found' },
    });
  }

  return reply.status(204).send();
}

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

// ============================================
// Public signed URL download (no auth required)
// ============================================

interface SignedDownloadParams {
  '*': string; // File path
}

interface SignedDownloadQuery {
  expires: string;
  signature: string;
}

interface PublicDownloadParams {
  projectId: string;
  bucketName: string;
  '*': string; // File path
}

export async function downloadSignedUrl(
  request: FastifyRequest<{ Params: SignedDownloadParams; Querystring: SignedDownloadQuery }>,
  reply: FastifyReply
) {
  const filePath = request.params['*'];
  const { expires, signature } = request.query;

  if (!expires || !signature) {
    return reply.status(400).send({
      success: false,
      error: { code: 'INVALID_REQUEST', message: 'Missing expires or signature' },
    });
  }

  // Import LocalAdapter for signature verification
  const { LocalAdapter } = await import('../../adapters/storage/local.adapter.js');

  if (!LocalAdapter.verifySignature(filePath, expires, signature)) {
    return reply.status(403).send({
      success: false,
      error: { code: 'FORBIDDEN', message: 'Invalid or expired signature' },
    });
  }

  // Get file from storage
  const { getDefaultStorageAdapter } = await import('../../adapters/storage/index.js');
  const storage = getDefaultStorageAdapter();

  try {
    const buffer = await storage.download(filePath);

    // Determine mime type from extension
    const ext = filePath.split('.').pop()?.toLowerCase();
    const mimeTypes: Record<string, string> = {
      jpg: 'image/jpeg',
      jpeg: 'image/jpeg',
      png: 'image/png',
      gif: 'image/gif',
      webp: 'image/webp',
      pdf: 'application/pdf',
      txt: 'text/plain',
      json: 'application/json',
      html: 'text/html',
      css: 'text/css',
      js: 'application/javascript',
    };
    const mimeType = mimeTypes[ext || ''] || 'application/octet-stream';
    const filename = filePath.split('/').pop() || 'file';

    reply.header('Content-Type', mimeType);
    reply.header('Content-Length', buffer.length);
    reply.header('Content-Disposition', `inline; filename="${encodeURIComponent(filename)}"`);
    reply.header('Cache-Control', 'private, max-age=3600');

    return reply.send(buffer);
  } catch (error) {
    return reply.status(404).send({
      success: false,
      error: { code: 'NOT_FOUND', message: 'File not found' },
    });
  }
}

// ============================================
// Public bucket download (no auth required)
// ============================================

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
