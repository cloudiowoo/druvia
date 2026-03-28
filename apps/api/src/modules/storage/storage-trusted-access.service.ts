import jwt from 'jsonwebtoken';
import { queryOne } from '../../db/index.js';
import { config } from '../../config/index.js';
import * as projectService from '../project/project.service.js';
import { getBucketByName, type Bucket } from './storage.service.js';

const DEFAULT_TICKET_TTL_SECONDS = 300;

type TrustedStorageTicketPurpose = 'upload' | 'remove';
type TrustedStorageTicketTokenType = 'storage_trusted_ticket';

type BaseTrustedStorageTicketPayload = {
  purpose: TrustedStorageTicketPurpose;
  projectId: string;
  projectUserId: string;
  bucket: string;
  issuedBy: string;
  issuedVia: 'trusted_storage_ticket';
  iat?: number;
  exp?: number;
};

type SignedTrustedStorageUploadTicketPayload = TrustedStorageUploadTicketPayload & {
  tokenType: TrustedStorageTicketTokenType;
};

type SignedTrustedStorageRemoveTicketPayload = TrustedStorageRemoveTicketPayload & {
  tokenType: TrustedStorageTicketTokenType;
};

export type TrustedStorageUploadTicketPayload = BaseTrustedStorageTicketPayload & {
  purpose: 'upload';
  pathPrefix: string;
  contentTypes?: string[];
  maxBytes?: number;
};

export type TrustedStorageRemoveTicketPayload = BaseTrustedStorageTicketPayload & {
  purpose: 'remove';
  path: string;
};

export class StorageTrustedAccessError extends Error {
  constructor(
    public code: string,
    message: string,
    public statusCode = 400
  ) {
    super(message);
    this.name = 'StorageTrustedAccessError';
  }
}

export interface IssueUploadTicketInput {
  projectId: string;
  userId: string;
  bucket: string;
  pathPrefix: string;
  contentTypes?: string[];
  maxBytes?: number;
  expiresIn?: number;
  issuedBy: string;
}

export interface IssueRemoveTicketInput {
  projectId: string;
  userId: string;
  bucket: string;
  path: string;
  expiresIn?: number;
  issuedBy: string;
}

export interface TrustedStorageTicketResult<TPayload> {
  ticket: string;
  expiresIn: number;
  expiresAt: string;
  payload: TPayload;
}

function validateSchemaName(schemaName: string): void {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(schemaName)) {
    throw new StorageTrustedAccessError('INVALID_SCHEMA', 'Invalid project schema', 500);
  }
}

function sanitizeObjectPath(path: string): string | null {
  if (!path || path.length > 1024) return null;
  if (path.includes('..') || path.includes('\0')) return null;
  const normalized = path.replace(/\\/g, '/').replace(/^\/+/, '');
  return normalized || null;
}

function normalizePathPrefix(pathPrefix: string): string {
  const sanitized = sanitizeObjectPath(pathPrefix);
  if (!sanitized) {
    throw new StorageTrustedAccessError('INVALID_PATH_PREFIX', 'Invalid pathPrefix', 400);
  }

  return sanitized.endsWith('/') ? sanitized : `${sanitized}/`;
}

function normalizeObjectPath(path: string): string {
  const sanitized = sanitizeObjectPath(path);
  if (!sanitized) {
    throw new StorageTrustedAccessError('INVALID_PATH', 'Invalid path', 400);
  }

  return sanitized;
}

function getTrustedTicketSecret(): string {
  const secret = config.storage.trustedTicketSecret;
  if (!secret) {
    throw new StorageTrustedAccessError(
      'SERVER_MISCONFIGURED',
      'STORAGE_TRUSTED_TICKET_SECRET must be configured',
      500
    );
  }

  return secret;
}

function resolveTicketTtl(expiresIn?: number): number {
  const ttl = expiresIn ?? DEFAULT_TICKET_TTL_SECONDS;

  if (!Number.isInteger(ttl) || ttl <= 0) {
    throw new StorageTrustedAccessError('INVALID_TTL', 'expiresIn must be a positive integer', 400);
  }

  if (ttl > config.storage.trustedTicketMaxTtlSeconds) {
    throw new StorageTrustedAccessError(
      'TTL_TOO_LARGE',
      `expiresIn exceeds maximum of ${config.storage.trustedTicketMaxTtlSeconds} seconds`,
      400
    );
  }

  return ttl;
}

function normalizeContentTypes(bucket: Bucket, contentTypes?: string[]): string[] | undefined {
  const bucketAllowed = bucket.allowedMimeTypes ?? undefined;

  if (!contentTypes || contentTypes.length === 0) {
    return bucketAllowed;
  }

  const normalized = Array.from(new Set(contentTypes.filter((value): value is string => typeof value === 'string' && value.length > 0)));
  if (normalized.length === 0) {
    return bucketAllowed;
  }

  if (bucketAllowed && normalized.some((contentType) => !bucketAllowed.includes(contentType))) {
    throw new StorageTrustedAccessError(
      'INVALID_CONTENT_TYPES',
      'Requested contentTypes exceed bucket restrictions',
      400
    );
  }

  return normalized;
}

function resolveMaxBytes(bucket: Bucket, maxBytes?: number): number | undefined {
  if (maxBytes !== undefined && (!Number.isInteger(maxBytes) || maxBytes <= 0)) {
    throw new StorageTrustedAccessError('INVALID_MAX_BYTES', 'maxBytes must be a positive integer', 400);
  }

  if (bucket.fileSizeLimit && maxBytes) {
    return Math.min(bucket.fileSizeLimit, maxBytes);
  }

  return maxBytes ?? bucket.fileSizeLimit ?? undefined;
}

async function getProjectSchemaName(projectId: string): Promise<string> {
  const project = await projectService.getProjectById(projectId);
  if (!project?.schemaName) {
    throw new StorageTrustedAccessError('PROJECT_NOT_FOUND', 'Project not found', 404);
  }

  validateSchemaName(project.schemaName);
  return project.schemaName;
}

async function ensureProjectUserExists(projectId: string, userId: string): Promise<void> {
  const schemaName = await getProjectSchemaName(projectId);
  const hasStatusColumn = await queryOne<{ column_name: string }>(
    `SELECT column_name
     FROM information_schema.columns
     WHERE table_schema = $1
       AND table_name = 'users'
       AND column_name = 'status'
     LIMIT 1`,
    [schemaName]
  );
  const statusCondition = hasStatusColumn ? ` AND status = 'active'` : '';
  const user = await queryOne<{ id: string }>(
    `SELECT id FROM ${schemaName}.users WHERE id = $1${statusCondition} LIMIT 1`,
    [userId]
  );

  if (!user) {
    throw new StorageTrustedAccessError('USER_NOT_FOUND', 'Project user not found', 404);
  }
}

async function ensureBucketExists(projectId: string, bucketName: string): Promise<Bucket> {
  const bucket = await getBucketByName(projectId, bucketName);
  if (!bucket) {
    throw new StorageTrustedAccessError('BUCKET_NOT_FOUND', 'Bucket not found', 404);
  }

  return bucket;
}

function signTrustedStorageTicket<TPayload extends TrustedStorageUploadTicketPayload | TrustedStorageRemoveTicketPayload>(
  payload: TPayload,
  expiresIn: number
): TrustedStorageTicketResult<TPayload> {
  const signedPayload = {
    ...payload,
    tokenType: 'storage_trusted_ticket' as const,
  };
  const ticket = jwt.sign(signedPayload, getTrustedTicketSecret(), { expiresIn });

  return {
    ticket,
    expiresIn,
    expiresAt: new Date(Date.now() + expiresIn * 1000).toISOString(),
    payload,
  };
}

function verifyTrustedStorageTicket(token: string): TrustedStorageUploadTicketPayload | TrustedStorageRemoveTicketPayload {
  try {
    const payload = jwt.verify(token, getTrustedTicketSecret()) as
      | SignedTrustedStorageUploadTicketPayload
      | SignedTrustedStorageRemoveTicketPayload;

    if (payload.tokenType !== 'storage_trusted_ticket') {
      throw new StorageTrustedAccessError('INVALID_TICKET', 'Invalid storage ticket', 401);
    }

    return payload.purpose === 'upload'
      ? {
          purpose: 'upload',
          projectId: payload.projectId,
          projectUserId: payload.projectUserId,
          bucket: payload.bucket,
          pathPrefix: payload.pathPrefix,
          contentTypes: payload.contentTypes,
          maxBytes: payload.maxBytes,
          issuedBy: payload.issuedBy,
          issuedVia: payload.issuedVia,
          iat: payload.iat,
          exp: payload.exp,
        }
      : {
          purpose: 'remove',
          projectId: payload.projectId,
          projectUserId: payload.projectUserId,
          bucket: payload.bucket,
          path: payload.path,
          issuedBy: payload.issuedBy,
          issuedVia: payload.issuedVia,
          iat: payload.iat,
          exp: payload.exp,
        };
  } catch (error) {
    if (error instanceof jwt.TokenExpiredError) {
      throw new StorageTrustedAccessError('INVALID_TICKET', 'Storage ticket expired', 401);
    }

    if (error instanceof StorageTrustedAccessError) {
      throw error;
    }

    throw new StorageTrustedAccessError('INVALID_TICKET', 'Invalid storage ticket', 401);
  }
}

export async function issueUploadTicket(
  input: IssueUploadTicketInput
): Promise<TrustedStorageTicketResult<TrustedStorageUploadTicketPayload>> {
  await ensureProjectUserExists(input.projectId, input.userId);
  const bucket = await ensureBucketExists(input.projectId, input.bucket);
  const expiresIn = resolveTicketTtl(input.expiresIn);

  const payload: TrustedStorageUploadTicketPayload = {
    purpose: 'upload',
    projectId: input.projectId,
    projectUserId: input.userId,
    bucket: bucket.name,
    pathPrefix: normalizePathPrefix(input.pathPrefix),
    contentTypes: normalizeContentTypes(bucket, input.contentTypes),
    maxBytes: resolveMaxBytes(bucket, input.maxBytes),
    issuedBy: input.issuedBy,
    issuedVia: 'trusted_storage_ticket',
  };

  return signTrustedStorageTicket(payload, expiresIn);
}

export async function issueRemoveTicket(
  input: IssueRemoveTicketInput
): Promise<TrustedStorageTicketResult<TrustedStorageRemoveTicketPayload>> {
  await ensureProjectUserExists(input.projectId, input.userId);
  const bucket = await ensureBucketExists(input.projectId, input.bucket);
  const expiresIn = resolveTicketTtl(input.expiresIn);

  const payload: TrustedStorageRemoveTicketPayload = {
    purpose: 'remove',
    projectId: input.projectId,
    projectUserId: input.userId,
    bucket: bucket.name,
    path: normalizeObjectPath(input.path),
    issuedBy: input.issuedBy,
    issuedVia: 'trusted_storage_ticket',
  };

  return signTrustedStorageTicket(payload, expiresIn);
}

export function verifyUploadTicket(token: string): TrustedStorageUploadTicketPayload {
  const payload = verifyTrustedStorageTicket(token);
  if (payload.purpose !== 'upload' || !('pathPrefix' in payload)) {
    throw new StorageTrustedAccessError('INVALID_TICKET', 'Storage ticket purpose mismatch', 401);
  }

  return {
    ...payload,
    pathPrefix: normalizePathPrefix(payload.pathPrefix),
  };
}

export function verifyRemoveTicket(token: string): TrustedStorageRemoveTicketPayload {
  const payload = verifyTrustedStorageTicket(token);
  if (payload.purpose !== 'remove' || !('path' in payload)) {
    throw new StorageTrustedAccessError('INVALID_TICKET', 'Storage ticket purpose mismatch', 401);
  }

  return {
    ...payload,
    path: normalizeObjectPath(payload.path),
  };
}
