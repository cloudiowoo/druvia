import type { FastifyInstance } from 'fastify';
import * as storageService from '../storage/storage.service.js';
import { verifyInternalFunctionToken, type InternalFunctionTokenPayload } from './internal-token.js';

const INTERNAL_TOKEN_HEADER = 'x-druvia-internal-token';
const INTERNAL_STORAGE_BODY_LIMIT = 70 * 1024 * 1024;

interface InternalStorageUploadBody {
  bucket: string;
  path: string;
  contentType: string;
  dataBase64: string;
}

interface InternalStorageRemoveBody {
  bucket: string;
  path: string;
  ignoreMissing?: boolean;
}

function sanitizeObjectPath(path: string): string | null {
  if (!path || path.length > 1024) return null;
  if (path.includes('..') || path.includes('\0')) return null;
  const normalized = path.replace(/\\/g, '/').replace(/^\/+/, '');
  return normalized || null;
}

function toAuditContext(
  functionName: string,
  tokenPayload: InternalFunctionTokenPayload
): storageService.StorageUploadAuditContext {
  if (tokenPayload.authType === 'platform_user') {
    return {
      createdByType: 'platform_user',
      platformUserId: tokenPayload.userId,
      sourceFunction: functionName,
    };
  }

  if (tokenPayload.authType === 'project_user') {
    return {
      createdByType: 'project_user',
      projectUserId: tokenPayload.projectUserId,
      sourceFunction: functionName,
    };
  }

  return {
    createdByType: 'apikey',
    sourceFunction: functionName,
  };
}

function decodeBase64Strict(dataBase64: string): Buffer | null {
  const normalized = dataBase64.trim();
  if (!normalized) return null;
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(normalized) || normalized.length % 4 !== 0) {
    return null;
  }

  try {
    const file = Buffer.from(normalized, 'base64');
    if (file.length === 0) {
      return null;
    }

    const canonicalInput = normalized.replace(/=+$/, '');
    const canonicalOutput = file.toString('base64').replace(/=+$/, '');
    return canonicalInput === canonicalOutput ? file : null;
  } catch {
    return null;
  }
}

export async function internalFunctionsStorageRoutes(app: FastifyInstance) {
  app.post<{
    Body: InternalStorageUploadBody;
  }>(
    '/internal/functions/storage/upload',
    {
      bodyLimit: INTERNAL_STORAGE_BODY_LIMIT,
    },
    async (request, reply) => {
      const token = request.headers[INTERNAL_TOKEN_HEADER] as string | undefined;

      if (!token) {
        return reply.status(401).send({
          success: false,
          error: { code: 'UNAUTHORIZED', message: 'Missing internal token' },
        });
      }

      let tokenPayload;
      try {
        tokenPayload = verifyInternalFunctionToken(token);
      } catch (error) {
        return reply.status(401).send({
          success: false,
          error: {
            code: 'UNAUTHORIZED',
            message: error instanceof Error ? error.message : 'Invalid internal token',
          },
        });
      }

      const { bucket, path, contentType, dataBase64 } = request.body ?? {};
      if (!bucket || !path || !contentType || !dataBase64) {
        return reply.status(400).send({
          success: false,
          error: { code: 'BAD_REQUEST', message: 'bucket, path, contentType and dataBase64 are required' },
        });
      }

      const sanitizedPath = sanitizeObjectPath(path);
      if (!sanitizedPath) {
        return reply.status(400).send({
          success: false,
          error: { code: 'INVALID_OBJECT_PATH', message: 'Invalid object path' },
        });
      }

      const file = decodeBase64Strict(dataBase64);
      if (!file) {
        return reply.status(400).send({
          success: false,
          error: { code: 'BAD_REQUEST', message: 'Invalid base64 file payload' },
        });
      }

      const bucketRecord = await storageService.getBucketByName(tokenPayload.projectId, bucket);
      if (!bucketRecord) {
        return reply.status(404).send({
          success: false,
          error: { code: 'BUCKET_NOT_FOUND', message: 'Bucket not found' },
        });
      }

      try {
        const object = await storageService.uploadObject(
          bucketRecord,
          sanitizedPath,
          file,
          contentType,
          toAuditContext(tokenPayload.functionName, tokenPayload)
        );

        const publicUrl = bucketRecord.public
          ? (await storageService.getDownloadUrl(bucketRecord, object)).url
          : null;

        return reply.send({
          success: true,
          data: {
            path: sanitizedPath,
            publicUrl,
            object,
          },
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Upload failed';

        if (message.includes('exceeds limit')) {
          return reply.status(413).send({
            success: false,
            error: { code: 'FILE_TOO_LARGE', message },
          });
        }

        if (message.includes('not allowed')) {
          return reply.status(415).send({
            success: false,
            error: { code: 'INVALID_MIME_TYPE', message },
          });
        }

        return reply.status(500).send({
          success: false,
          error: { code: 'UPLOAD_FAILED', message },
        });
      }
    }
  );

  app.post<{
    Body: InternalStorageRemoveBody;
  }>('/internal/functions/storage/remove', async (request, reply) => {
    const token = request.headers[INTERNAL_TOKEN_HEADER] as string | undefined;

    if (!token) {
      return reply.status(401).send({
        success: false,
        error: { code: 'UNAUTHORIZED', message: 'Missing internal token' },
      });
    }

    let tokenPayload;
    try {
      tokenPayload = verifyInternalFunctionToken(token);
    } catch (error) {
      return reply.status(401).send({
        success: false,
        error: {
          code: 'UNAUTHORIZED',
          message: error instanceof Error ? error.message : 'Invalid internal token',
        },
      });
    }

    const { bucket, path, ignoreMissing = false } = request.body ?? {};
    if (!bucket || !path) {
      return reply.status(400).send({
        success: false,
        error: { code: 'BAD_REQUEST', message: 'bucket and path are required' },
      });
    }

    const sanitizedPath = sanitizeObjectPath(path);
    if (!sanitizedPath) {
      return reply.status(400).send({
        success: false,
        error: { code: 'INVALID_OBJECT_PATH', message: 'Invalid object path' },
      });
    }

    const bucketRecord = await storageService.getBucketByName(tokenPayload.projectId, bucket);
    if (!bucketRecord) {
      return reply.status(404).send({
        success: false,
        error: { code: 'BUCKET_NOT_FOUND', message: 'Bucket not found' },
      });
    }

    const deleted = await storageService.deleteObject(bucketRecord.bucketId, sanitizedPath);
    if (!deleted && !ignoreMissing) {
      return reply.status(404).send({
        success: false,
        error: { code: 'NOT_FOUND', message: 'Object not found' },
      });
    }

    return reply.send({
      success: true,
      data: {
        path: sanitizedPath,
        deleted,
      },
    });
  });
}
