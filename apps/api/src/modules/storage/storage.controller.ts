import type { FastifyRequest, FastifyReply } from 'fastify';
import type { MultipartFile } from '@fastify/multipart';
import * as storageService from './storage.service.js';
import { checkProjectAccess } from '../../lib/access.js';
import {
  ProjectActorRequiredError,
  ProjectActorScopeError,
  resolvePlatformProjectActor,
  resolveScopedProjectActor,
} from '../../lib/project-actor.js';
import { validateTrustedBackendKey } from '../trusted-backend-keys/trusted-backend-keys.service.js';
import {
  issueRemoveTicket,
  issueUploadTicket,
  StorageTrustedAccessError,
  verifyRemoveTicket,
  verifyUploadTicket,
} from './storage-trusted-access.service.js';
import type { StorageActor, StorageProjectUserAccess } from './storage-access.service.js';
import { decideStorageObjectAccess, StorageAccessError } from './storage-access.service.js';
import { normalizeStorageObjectPath, normalizeStoragePathPrefix, StoragePathError } from './storage-path.js';
import { toStorageObjectResponse } from './storage-response.js';
import { applyStorageDeliveryHeaders } from './storage-delivery.js';
import { normalizeStorageMimeType, StorageValidationError } from './storage-validation.js';

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
  fileSizeLimit?: number | null;
  allowedMimeTypes?: string[] | null;
  projectUserAccess?: StorageProjectUserAccess;
}

interface UpdateBucketBody {
  public?: boolean;
  fileSizeLimit?: number | null;
  allowedMimeTypes?: string[] | null;
  corsConfig?: Record<string, unknown> | null;
  projectUserAccess?: StorageProjectUserAccess;
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

interface MultipartRequest extends FastifyRequest<{ Params: BucketParams; Querystring: { path?: string } }> {
  file(): Promise<MultipartFile | undefined>;
}

interface TrustedUploadTicketBody {
  userId?: string;
  bucket?: string;
  pathPrefix?: string;
  contentTypes?: string[];
  maxBytes?: number;
  expiresIn?: number;
}

interface TrustedRemoveTicketBody {
  userId?: string;
  bucket?: string;
  path?: string;
  expiresIn?: number;
}

interface TrustedRemoveConsumeBody {
  path?: string;
}

interface TrustedTicketMultipartRequest extends FastifyRequest<{ Querystring: { path?: string } }> {
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
  try {
    return normalizeStorageObjectPath(path);
  } catch {
    return null;
  }
}

function isPathWithinPrefix(path: string, pathPrefix: string): boolean {
  return path.startsWith(pathPrefix);
}

function sendTrustedStorageError(reply: FastifyReply, error: unknown) {
  if (error instanceof StorageTrustedAccessError) {
    return reply.status(error.statusCode).send({
      success: false,
      error: { code: error.code, message: error.message },
    });
  }

  throw error;
}

async function verifyTrustedStorageIssuerAccess(
  request: FastifyRequest<{ Params: ProjectParams }>,
  reply: FastifyReply
): Promise<{ trustedKeyPrefix: string } | null> {
  const trustedBackendKey = request.headers['x-druvia-trusted-backend-key'];
  const rawTrustedBackendKey = Array.isArray(trustedBackendKey) ? trustedBackendKey[0] : trustedBackendKey;

  if (!rawTrustedBackendKey) {
    reply.status(401).send({
      success: false,
      error: { code: 'UNAUTHORIZED', message: 'Trusted backend key required' },
    });
    return null;
  }

  const validation = await validateTrustedBackendKey(rawTrustedBackendKey, {
    requiredScope: 'storage_ticket:issue',
    requiredProjectId: request.params.projectId,
  });
  if (!validation.valid) {
    const statusCode = validation.reason === 'invalid' ? 401 : 403;
    const errorCode = validation.reason === 'invalid' ? 'UNAUTHORIZED' : 'FORBIDDEN';
    const message = validation.reason === 'scope_missing'
      ? 'Trusted backend key is missing required scope'
      : validation.reason === 'project_mismatch'
        ? 'No access to this project'
        : 'Invalid trusted backend key';
    reply.status(statusCode).send({
      success: false,
      error: { code: errorCode, message },
    });
    return null;
  }

  return { trustedKeyPrefix: validation.keyPrefix ?? 'unknown' };
}

function getStorageTicketHeader(request: FastifyRequest): string | null {
  const ticket = request.headers['x-druvia-storage-ticket'];
  const rawTicket = Array.isArray(ticket) ? ticket[0] : ticket;
  return rawTicket || null;
}

// ============================================
// Access Control Helper
// ============================================

async function verifyProjectAccess(
  request: FastifyRequest<{ Params: ProjectParams }>,
  reply: FastifyReply
): Promise<boolean> {
  if (request.user?.kind !== 'platform_user') {
    reply.status(403).send({
      success: false,
      error: { code: 'PLATFORM_USER_REQUIRED', message: 'A platform administrator is required' },
    });
    return false;
  }

  const hasAccess = await checkProjectAccess(request.user.userId, request.params.projectId);
  if (!hasAccess) {
    reply.status(403).send({
      success: false,
      error: { code: 'FORBIDDEN', message: 'No access to this project' },
    });
    return false;
  }

  return true;
}

async function resolveObjectActor(
  request: FastifyRequest<{ Params: ProjectParams }>,
  reply: FastifyReply
): Promise<StorageActor | null> {
  const user = request.user;
  if (!user) {
    reply.status(401).send({ success: false, error: { code: 'UNAUTHORIZED', message: 'Authentication required' } });
    return null;
  }
  if (user.kind === 'platform_user') {
    if (!(await checkProjectAccess(user.userId, request.params.projectId))) {
      reply.status(403).send({ success: false, error: { code: 'FORBIDDEN', message: 'No access to this project' } });
      return null;
    }
    try {
      const actor = resolvePlatformProjectActor(user, request.params.projectId);
      return {
        actorType: 'platform_user',
        projectId: actor.projectId,
        platformUserId: actor.platformUserId,
      };
    } catch (error) {
      if (!(error instanceof ProjectActorRequiredError)) throw error;
      reply.status(401).send({
        success: false,
        error: { code: 'UNAUTHORIZED', message: 'Authentication required' },
      });
      return null;
    }
  }

  try {
    const actor = resolveScopedProjectActor(user, request.params.projectId);
    if (actor.actorType === 'apikey') {
      reply.status(403).send({
        success: false,
        error: { code: 'PROJECT_ACTOR_REQUIRED', message: 'A Project User session is required for protected storage objects' },
      });
      return null;
    }
    return {
      actorType: 'project_user',
      projectId: actor.projectId,
      projectUserId: actor.projectUserId,
    };
  } catch (error) {
    if (error instanceof ProjectActorScopeError) {
      reply.status(403).send({
        success: false,
        error: { code: 'PROJECT_SCOPE_MISMATCH', message: 'Project credential belongs to another project' },
      });
      return null;
    }
    if (error instanceof ProjectActorRequiredError) {
      reply.status(401).send({
        success: false,
        error: { code: 'UNAUTHORIZED', message: 'Authentication required' },
      });
      return null;
    }
    throw error;
  }
}

function sendObjectAccessError(reply: FastifyReply, error: unknown) {
  if (error instanceof StorageAccessError) {
    return reply.status(error.statusCode).send({
      success: false,
      error: { code: error.code, message: error.message },
    });
  }
  if (error instanceof StoragePathError) {
    return reply.status(400).send({
      success: false,
      error: { code: 'INVALID_OBJECT_PATH', message: error.message },
    });
  }
  if (error instanceof StorageValidationError) {
    return reply.status(415).send({
      success: false,
      error: { code: 'INVALID_MIME_TYPE', message: error.message },
    });
  }
  throw error;
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

export async function issueTrustedUploadTicket(
  request: FastifyRequest<{ Params: ProjectParams; Body: TrustedUploadTicketBody }>,
  reply: FastifyReply
) {
  const access = await verifyTrustedStorageIssuerAccess(request, reply);
  if (!access) return;

  if (!request.body?.userId || !request.body.bucket || !request.body.pathPrefix) {
    return reply.status(400).send({
      success: false,
      error: { code: 'INVALID_INPUT', message: 'userId, bucket and pathPrefix are required' },
    });
  }

  try {
    const ticket = await issueUploadTicket({
      projectId: request.params.projectId,
      userId: request.body.userId,
      bucket: request.body.bucket,
      pathPrefix: request.body.pathPrefix,
      contentTypes: request.body.contentTypes,
      maxBytes: request.body.maxBytes,
      expiresIn: request.body.expiresIn,
      issuedBy: access.trustedKeyPrefix,
    });

    request.log.info({
      projectId: request.params.projectId,
      trustedKeyPrefix: access.trustedKeyPrefix,
      issuerScope: 'storage_ticket:issue',
      projectUserId: request.body.userId,
      bucket: request.body.bucket,
      pathPrefix: request.body.pathPrefix,
      issuedAt: new Date().toISOString(),
      sourceIp: request.ip,
      userAgent: request.headers['user-agent'] ?? null,
    }, 'trusted storage upload ticket issued');

    return reply.send({ success: true, data: ticket });
  } catch (error) {
    return sendTrustedStorageError(reply, error);
  }
}

export async function issueTrustedRemoveTicket(
  request: FastifyRequest<{ Params: ProjectParams; Body: TrustedRemoveTicketBody }>,
  reply: FastifyReply
) {
  const access = await verifyTrustedStorageIssuerAccess(request, reply);
  if (!access) return;

  if (!request.body?.userId || !request.body.bucket || !request.body.path) {
    return reply.status(400).send({
      success: false,
      error: { code: 'INVALID_INPUT', message: 'userId, bucket and path are required' },
    });
  }

  try {
    const ticket = await issueRemoveTicket({
      projectId: request.params.projectId,
      userId: request.body.userId,
      bucket: request.body.bucket,
      path: request.body.path,
      expiresIn: request.body.expiresIn,
      issuedBy: access.trustedKeyPrefix,
    });

    request.log.info({
      projectId: request.params.projectId,
      trustedKeyPrefix: access.trustedKeyPrefix,
      issuerScope: 'storage_ticket:issue',
      projectUserId: request.body.userId,
      bucket: request.body.bucket,
      path: request.body.path,
      issuedAt: new Date().toISOString(),
      sourceIp: request.ip,
      userAgent: request.headers['user-agent'] ?? null,
    }, 'trusted storage remove ticket issued');

    return reply.send({ success: true, data: ticket });
  } catch (error) {
    return sendTrustedStorageError(reply, error);
  }
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
    if (error instanceof StorageValidationError) {
      return reply.status(400).send({
        success: false,
        error: { code: 'INVALID_STORAGE_LIMIT', message: error.message },
      });
    }
    if (error instanceof StorageAccessError) {
      return sendObjectAccessError(reply, error);
    }
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

  let bucket;
  try {
    bucket = await storageService.updateBucket(
      request.params.projectId,
      request.params.bucketName,
      request.body
    );
  } catch (error) {
    if (error instanceof StorageValidationError) {
      return reply.status(400).send({
        success: false,
        error: { code: 'INVALID_STORAGE_LIMIT', message: error.message },
      });
    }
    return sendObjectAccessError(reply, error);
  }

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
  const actor = await resolveObjectActor(request, reply);
  if (!actor) return;

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

  const limit = Number(request.query.limit ?? 50);
  const offset = Number(request.query.offset ?? 0);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100
    || !Number.isInteger(offset) || offset < 0 || offset > 1_000_000) {
    return reply.status(400).send({
      success: false,
      error: { code: 'INVALID_STORAGE_REQUEST', message: 'limit must be 1-100 and offset 0-1000000' },
    });
  }
  let prefix: string | undefined;
  try {
    prefix = request.query.prefix === undefined
      ? undefined
      : normalizeStoragePathPrefix(request.query.prefix);
  } catch (error) {
    return sendObjectAccessError(reply, error);
  }

  let result;
  try {
    result = await storageService.listObjectsForActor(bucket, actor, { prefix, limit, offset });
  } catch (error) {
    return sendObjectAccessError(reply, error);
  }

  return reply.send({
    success: true,
    data: result.objects.map(toStorageObjectResponse),
    pagination: { limit, offset, total: result.total },
  });
}

export async function uploadObject(
  request: MultipartRequest,
  reply: FastifyReply
) {
  const actor = await resolveObjectActor(request as FastifyRequest<{ Params: ProjectParams }>, reply);
  if (!actor) return;

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

  try {
    decideStorageObjectAccess({
      preset: bucket.projectUserAccess,
      actor,
      operation: 'write',
      objectExists: false,
    });
  } catch (error) {
    return sendObjectAccessError(reply, error);
  }

  const data = await request.file();
  if (!data) {
    return reply.status(400).send({
      success: false,
      error: { code: 'NO_FILE', message: 'No file uploaded' },
    });
  }

  // Validate filename — prefer ?path= query param, fallback to multipart filename
  const rawName = (request.query.path || data.filename);
  const sanitizedName = sanitizeObjectPath(rawName);
  if (!sanitizedName) {
    return reply.status(400).send({
      success: false,
      error: { code: 'INVALID_OBJECT_PATH', message: 'Invalid filename' },
    });
  }

  try {
    const buffer = await data.toBuffer();
    if (buffer.length > 50 * 1024 * 1024) {
      return reply.status(413).send({
        success: false,
        error: { code: 'FILE_TOO_LARGE', message: 'File size exceeds the 50 MB service limit' },
      });
    }
    const object = await storageService.uploadObject(
      bucket,
      sanitizedName,
      buffer,
      data.mimetype,
      {
        createdByType: actor.actorType,
        ...(actor.actorType === 'platform_user' ? { platformUserId: actor.platformUserId } : {}),
        ...(actor.actorType === 'project_user' ? { projectUserId: actor.projectUserId } : {}),
      },
      actor
    );

    return reply.status(201).send({ success: true, data: toStorageObjectResponse(object) });
  } catch (error) {
    const err = error as Error;
    if (err.message.includes('exceeds limit')) {
      return reply.status(413).send({
        success: false,
        error: { code: 'FILE_TOO_LARGE', message: err.message },
      });
    }
    if (err.message.includes('not allowed') || err.message.includes('Invalid MIME')) {
      return reply.status(415).send({
        success: false,
        error: { code: 'INVALID_MIME_TYPE', message: err.message },
      });
    }
    return sendObjectAccessError(reply, error);
  }
}

export async function uploadWithTicket(
  request: TrustedTicketMultipartRequest,
  reply: FastifyReply
) {
  const rawTicket = getStorageTicketHeader(request);
  if (!rawTicket) {
    return reply.status(401).send({
      success: false,
      error: { code: 'UNAUTHORIZED', message: 'Storage ticket required' },
    });
  }

  let ticket;
  try {
    ticket = verifyUploadTicket(rawTicket);
  } catch (error) {
    request.log.warn({
      ticketType: 'upload',
      sourceIp: request.ip,
      userAgent: request.headers['user-agent'] ?? null,
      reason: error instanceof Error ? error.message : 'invalid ticket',
    }, 'trusted storage upload rejected');
    return sendTrustedStorageError(reply, error);
  }

  const objectPath = request.query.path ? sanitizeObjectPath(request.query.path) : null;
  if (!objectPath) {
    return reply.status(400).send({
      success: false,
      error: { code: 'INVALID_OBJECT_PATH', message: 'Invalid path' },
    });
  }

  if (!isPathWithinPrefix(objectPath, ticket.pathPrefix)) {
    request.log.warn({
      projectId: ticket.projectId,
      projectUserId: ticket.projectUserId,
      bucket: ticket.bucket,
      objectPath,
      issuedBy: ticket.issuedBy,
      issuedVia: ticket.issuedVia,
      usedAt: new Date().toISOString(),
    }, 'trusted storage upload rejected');
    return reply.status(403).send({
      success: false,
      error: { code: 'FORBIDDEN', message: 'Path is outside the authorized prefix' },
    });
  }

  const bucket = await storageService.getBucketByName(ticket.projectId, ticket.bucket);
  if (!bucket) {
    return reply.status(404).send({
      success: false,
      error: { code: 'BUCKET_NOT_FOUND', message: 'Bucket not found' },
    });
  }

  const data = await request.file();
  if (!data) {
    return reply.status(400).send({
      success: false,
      error: { code: 'NO_FILE', message: 'No file uploaded' },
    });
  }

  const buffer = await data.toBuffer();
  if (ticket.maxBytes && buffer.length > ticket.maxBytes) {
    request.log.warn({
      projectId: ticket.projectId,
      projectUserId: ticket.projectUserId,
      bucket: ticket.bucket,
      objectPath,
      issuedBy: ticket.issuedBy,
      issuedVia: ticket.issuedVia,
      usedAt: new Date().toISOString(),
    }, 'trusted storage upload rejected');
    return reply.status(413).send({
      success: false,
      error: { code: 'FILE_TOO_LARGE', message: `File size exceeds limit of ${ticket.maxBytes} bytes` },
    });
  }

  let normalizedMimeType: string;
  try {
    normalizedMimeType = normalizeStorageMimeType(data.mimetype);
  } catch (error) {
    return sendObjectAccessError(reply, error);
  }

  if (ticket.contentTypes?.length && !ticket.contentTypes.includes(normalizedMimeType)) {
    request.log.warn({
      projectId: ticket.projectId,
      projectUserId: ticket.projectUserId,
      bucket: ticket.bucket,
      objectPath,
      issuedBy: ticket.issuedBy,
      issuedVia: ticket.issuedVia,
      usedAt: new Date().toISOString(),
    }, 'trusted storage upload rejected');
    return reply.status(415).send({
      success: false,
      error: { code: 'INVALID_MIME_TYPE', message: `MIME type ${normalizedMimeType} is not allowed` },
    });
  }

  try {
    const object = await storageService.uploadObject(
      bucket,
      objectPath,
      buffer,
      normalizedMimeType,
      {
        createdByType: 'trusted_backend_project_user',
        projectUserId: ticket.projectUserId,
        issuedBy: ticket.issuedBy,
        issuedVia: ticket.issuedVia,
      }
    );
    const download = await storageService.getDownloadUrl(bucket, object, 3600);
    const publicUrl = bucket.public ? download.url : null;

    request.log.info({
      projectId: ticket.projectId,
      projectUserId: ticket.projectUserId,
      bucket: ticket.bucket,
      objectPath,
      issuedBy: ticket.issuedBy,
      issuedVia: ticket.issuedVia,
      usedAt: new Date().toISOString(),
    }, 'trusted storage upload succeeded');

    return reply.status(201).send({
      success: true,
      data: {
        path: objectPath,
        publicUrl,
        object: toStorageObjectResponse(object),
      },
    });
  } catch (error) {
    const err = error as Error;
    if (err.message.includes('exceeds limit')) {
      return reply.status(413).send({
        success: false,
        error: { code: 'FILE_TOO_LARGE', message: err.message },
      });
    }
    if (err.message.includes('not allowed') || err.message.includes('Invalid MIME')) {
      return reply.status(415).send({
        success: false,
        error: { code: 'INVALID_MIME_TYPE', message: err.message },
      });
    }
    throw error;
  }
}

export async function removeWithTicket(
  request: FastifyRequest<{ Body: TrustedRemoveConsumeBody }>,
  reply: FastifyReply
) {
  const rawTicket = getStorageTicketHeader(request);
  if (!rawTicket) {
    return reply.status(401).send({
      success: false,
      error: { code: 'UNAUTHORIZED', message: 'Storage ticket required' },
    });
  }

  let ticket;
  try {
    ticket = verifyRemoveTicket(rawTicket);
  } catch (error) {
    request.log.warn({
      ticketType: 'remove',
      sourceIp: request.ip,
      userAgent: request.headers['user-agent'] ?? null,
      reason: error instanceof Error ? error.message : 'invalid ticket',
    }, 'trusted storage remove rejected');
    return sendTrustedStorageError(reply, error);
  }

  const objectPath = request.body?.path ? sanitizeObjectPath(request.body.path) : null;
  if (!objectPath) {
    return reply.status(400).send({
      success: false,
      error: { code: 'INVALID_OBJECT_PATH', message: 'Invalid path' },
    });
  }

  if (objectPath !== ticket.path) {
    request.log.warn({
      projectId: ticket.projectId,
      projectUserId: ticket.projectUserId,
      bucket: ticket.bucket,
      objectPath,
      issuedBy: ticket.issuedBy,
      issuedVia: ticket.issuedVia,
      usedAt: new Date().toISOString(),
    }, 'trusted storage remove rejected');
    return reply.status(403).send({
      success: false,
      error: { code: 'FORBIDDEN', message: 'Path does not match the authorized object' },
    });
  }

  const bucket = await storageService.getBucketByName(ticket.projectId, ticket.bucket);
  if (!bucket) {
    return reply.status(404).send({
      success: false,
      error: { code: 'BUCKET_NOT_FOUND', message: 'Bucket not found' },
    });
  }

  const deleted = await storageService.deleteObject(bucket.bucketId, objectPath);
  if (!deleted) {
    return reply.status(404).send({
      success: false,
      error: { code: 'NOT_FOUND', message: 'Object not found' },
    });
  }

  request.log.info({
    projectId: ticket.projectId,
    projectUserId: ticket.projectUserId,
    bucket: ticket.bucket,
    objectPath,
    issuedBy: ticket.issuedBy,
    issuedVia: ticket.issuedVia,
    usedAt: new Date().toISOString(),
  }, 'trusted storage remove succeeded');

  return reply.send({
    success: true,
    data: { removed: true },
  });
}

export async function downloadObject(
  request: FastifyRequest<{ Params: ObjectParams }>,
  reply: FastifyReply
) {
  const actor = await resolveObjectActor(request, reply);
  if (!actor) return;

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
      error: { code: 'INVALID_OBJECT_PATH', message: 'Invalid object path' },
    });
  }

  let object;
  try {
    object = await storageService.getObjectForActor(bucket, objectPath, actor);
  } catch (error) {
    return sendObjectAccessError(reply, error);
  }
  if (!object) {
    return reply.status(404).send({
      success: false,
      error: { code: 'OBJECT_NOT_FOUND', message: 'Object not found' },
    });
  }

  try {
    const buffer = await storageService.downloadObject(object);
    applyStorageDeliveryHeaders(reply, { mimeType: object.mimeType, logicalName: object.name, public: false });
    reply.header('Content-Length', buffer.length);
    return reply.send(buffer);
  } catch (error) {
    return reply.status(500).send({
      success: false,
      error: { code: 'DOWNLOAD_FAILED', message: 'Failed to download file' },
    });
  }
}

export async function deleteObject(
  request: FastifyRequest<{ Params: ObjectParams }>,
  reply: FastifyReply
) {
  const actor = await resolveObjectActor(request, reply);
  if (!actor) return;

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
      error: { code: 'INVALID_OBJECT_PATH', message: 'Invalid object path' },
    });
  }

  let deleted;
  try {
    deleted = await storageService.deleteObject(bucket.bucketId, objectPath, actor);
  } catch (error) {
    return sendObjectAccessError(reply, error);
  }

  if (!deleted) {
    return reply.status(404).send({
      success: false,
      error: { code: 'OBJECT_NOT_FOUND', message: 'Object not found' },
    });
  }

  return reply.status(204).send();
}

export async function getSignedUrl(
  request: FastifyRequest<{ Params: BucketParams; Body: SignedUrlBody }>,
  reply: FastifyReply
) {
  const actor = await resolveObjectActor(request, reply);
  if (!actor) return;

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
  if (!Number.isInteger(expiresIn) || expiresIn < 1 || expiresIn > 86400) {
    return reply.status(400).send({
      success: false,
      error: { code: 'INVALID_STORAGE_REQUEST', message: 'expiresIn must be an integer from 1 to 86400' },
    });
  }
  const objectPath = sanitizeObjectPath(rawPath);
  if (!objectPath) {
    return reply.status(400).send({
      success: false,
      error: { code: 'INVALID_OBJECT_PATH', message: 'Invalid objectPath' },
    });
  }

  let object;
  try {
    object = await storageService.getObjectForActor(bucket, objectPath, actor);
  } catch (error) {
    return sendObjectAccessError(reply, error);
  }
  if (!object) {
    return reply.status(404).send({
      success: false,
      error: { code: 'OBJECT_NOT_FOUND', message: 'Object not found' },
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
  filename?: string;
  contentType?: string;
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
  const { expires, signature, filename, contentType } = request.query;

  if (!expires || !signature) {
    return reply.status(400).send({
      success: false,
      error: { code: 'INVALID_REQUEST', message: 'Missing expires or signature' },
    });
  }

  // Import LocalAdapter for signature verification
  const { LocalAdapter } = await import('../../adapters/storage/local.adapter.js');

  const signedOptions = filename !== undefined && contentType !== undefined
    ? { logicalName: filename, contentType }
    : undefined;
  if ((filename === undefined) !== (contentType === undefined)
    || !LocalAdapter.verifySignature(filePath, expires, signature, signedOptions)) {
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

    applyStorageDeliveryHeaders(reply, {
      mimeType: signedOptions?.contentType ?? 'application/octet-stream',
      logicalName: signedOptions?.logicalName ?? 'download',
      public: false,
    });
    reply.header('Content-Length', buffer.length);

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
      error: { code: 'INVALID_OBJECT_PATH', message: 'Invalid object path' },
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

    applyStorageDeliveryHeaders(reply, { mimeType: object.mimeType, logicalName: object.name, public: true });
    reply.header('Content-Length', buffer.length);

    return reply.send(buffer);
  } catch (error) {
    return reply.status(500).send({
      success: false,
      error: { code: 'DOWNLOAD_FAILED', message: 'Failed to download file' },
    });
  }
}
