import crypto from 'crypto';
import { pool } from '../../db/index.js';

const TRUSTED_BACKEND_KEY_PREFIX = 'drutb_';
const TRUSTED_BACKEND_KEY_PREFIX_LENGTH = 16;

export const TRUSTED_BACKEND_KEY_SCOPES = [
  'project_session:issue',
  'storage_ticket:issue',
] as const;

export type TrustedBackendKeyScope = typeof TRUSTED_BACKEND_KEY_SCOPES[number];

export interface TrustedBackendKey {
  id: number;
  projectId: string;
  keyPrefix: string;
  name: string | null;
  scopes: TrustedBackendKeyScope[];
  createdBy: string | null;
  createdAt: Date;
  lastUsedAt: Date | null;
}

export interface CreateTrustedBackendKeyInput {
  name?: string;
  scopes?: TrustedBackendKeyScope[];
  createdBy?: string;
}

export interface CreateTrustedBackendKeyResult {
  key: string;
  trustedBackendKey: TrustedBackendKey;
}

export interface ValidateTrustedBackendKeyResult {
  valid: boolean;
  reason?: 'invalid' | 'scope_missing' | 'project_mismatch';
  projectId?: string;
  scopes?: TrustedBackendKeyScope[];
  keyPrefix?: string;
}

export interface ValidateTrustedBackendKeyOptions {
  requiredScope?: TrustedBackendKeyScope;
  requiredProjectId?: string;
}

function generateTrustedBackendKey(): string {
  const randomBytes = crypto.randomBytes(24);
  return `${TRUSTED_BACKEND_KEY_PREFIX}${randomBytes.toString('base64url')}`;
}

function hashTrustedBackendKey(key: string): string {
  return crypto.createHash('sha256').update(key).digest('hex');
}

function normalizeScopes(scopes?: TrustedBackendKeyScope[]): TrustedBackendKeyScope[] {
  if (!scopes || scopes.length === 0) {
    return [...TRUSTED_BACKEND_KEY_SCOPES];
  }

  const allowedScopes = new Set<string>(TRUSTED_BACKEND_KEY_SCOPES);
  const normalized = Array.from(new Set(scopes));

  for (const scope of normalized) {
    if (!allowedScopes.has(scope)) {
      throw new Error(`INVALID_SCOPE:${scope}`);
    }
  }

  return normalized;
}

function toTrustedBackendKey(row: {
  id: number;
  project_id: string;
  key_prefix: string;
  name: string | null;
  scopes: TrustedBackendKeyScope[];
  created_by: string | null;
  created_at: Date;
  last_used_at: Date | null;
}): TrustedBackendKey {
  return {
    id: row.id,
    projectId: row.project_id,
    keyPrefix: row.key_prefix,
    name: row.name,
    scopes: row.scopes,
    createdBy: row.created_by,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
  };
}

export async function createTrustedBackendKey(
  projectId: string,
  input: CreateTrustedBackendKeyInput = {}
): Promise<CreateTrustedBackendKeyResult> {
  const key = generateTrustedBackendKey();
  const keyHash = hashTrustedBackendKey(key);
  const keyPrefix = key.substring(0, TRUSTED_BACKEND_KEY_PREFIX_LENGTH);
  const scopes = normalizeScopes(input.scopes);

  const result = await pool.query(
    `INSERT INTO druvia_trusted_backend_keys (project_id, key_hash, key_prefix, name, scopes, created_by)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id, project_id, key_prefix, name, scopes, created_by, created_at, last_used_at`,
    [projectId, keyHash, keyPrefix, input.name || null, scopes, input.createdBy || null]
  );

  return {
    key,
    trustedBackendKey: toTrustedBackendKey(result.rows[0]),
  };
}

export async function listTrustedBackendKeys(projectId: string): Promise<TrustedBackendKey[]> {
  const result = await pool.query(
    `SELECT id, project_id, key_prefix, name, scopes, created_by, created_at, last_used_at
     FROM druvia_trusted_backend_keys
     WHERE project_id = $1
     ORDER BY created_at DESC`,
    [projectId]
  );

  return result.rows.map(toTrustedBackendKey);
}

export async function deleteTrustedBackendKey(id: number, projectId: string): Promise<boolean> {
  const result = await pool.query(
    `DELETE FROM druvia_trusted_backend_keys
     WHERE id = $1 AND project_id = $2`,
    [id, projectId]
  );
  return (result.rowCount ?? 0) > 0;
}

export async function validateTrustedBackendKey(
  key: string,
  options: ValidateTrustedBackendKeyOptions = {}
): Promise<ValidateTrustedBackendKeyResult> {
  if (!key.startsWith(TRUSTED_BACKEND_KEY_PREFIX)) {
    return { valid: false, reason: 'invalid' };
  }

  const keyHash = hashTrustedBackendKey(key);
  const result = await pool.query(
    `SELECT project_id, scopes, key_prefix
     FROM druvia_trusted_backend_keys
     WHERE key_hash = $1`,
    [keyHash]
  );

  if (result.rows.length === 0) {
    return { valid: false, reason: 'invalid' };
  }

  const row = result.rows[0] as {
    project_id: string;
    scopes: TrustedBackendKeyScope[];
    key_prefix: string;
  };

  if (options.requiredScope && !row.scopes.includes(options.requiredScope)) {
    return {
      valid: false,
      reason: 'scope_missing',
      projectId: row.project_id,
      scopes: row.scopes,
      keyPrefix: row.key_prefix,
    };
  }

  if (options.requiredProjectId && row.project_id !== options.requiredProjectId) {
    return {
      valid: false,
      reason: 'project_mismatch',
      projectId: row.project_id,
      scopes: row.scopes,
      keyPrefix: row.key_prefix,
    };
  }

  await pool.query(
    `UPDATE druvia_trusted_backend_keys
     SET last_used_at = NOW()
     WHERE key_hash = $1`,
    [keyHash]
  );

  return {
    valid: true,
    projectId: row.project_id,
    scopes: row.scopes,
    keyPrefix: row.key_prefix,
  };
}
