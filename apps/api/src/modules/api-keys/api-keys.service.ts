// apps/api/src/modules/api-keys/api-keys.service.ts
import { pool } from '../../db/index.js';
import crypto from 'crypto';

export interface ApiKey {
  id: number;
  projectId: string;
  keyPrefix: string;
  name: string | null;
  createdAt: Date;
  lastUsedAt: Date | null;
}

export interface CreateApiKeyResult {
  key: string; // Full key, only returned once
  apiKey: ApiKey;
}

function generateApiKey(): string {
  const randomBytes = crypto.randomBytes(24);
  return `dru_${randomBytes.toString('base64url')}`;
}

function hashApiKey(key: string): string {
  return crypto.createHash('sha256').update(key).digest('hex');
}

export async function createApiKey(projectId: string, name?: string): Promise<CreateApiKeyResult> {
  const key = generateApiKey();
  const keyHash = hashApiKey(key);
  const keyPrefix = key.substring(0, 12);

  const result = await pool.query(
    `INSERT INTO druvia_api_keys (project_id, key_hash, key_prefix, name)
     VALUES ($1, $2, $3, $4)
     RETURNING id, project_id, key_prefix, name, created_at, last_used_at`,
    [projectId, keyHash, keyPrefix, name || null]
  );

  return {
    key,
    apiKey: {
      id: result.rows[0].id,
      projectId: result.rows[0].project_id,
      keyPrefix: result.rows[0].key_prefix,
      name: result.rows[0].name,
      createdAt: result.rows[0].created_at,
      lastUsedAt: result.rows[0].last_used_at,
    },
  };
}

export async function listApiKeys(projectId: string): Promise<ApiKey[]> {
  const result = await pool.query(
    `SELECT id, project_id, key_prefix, name, created_at, last_used_at
     FROM druvia_api_keys
     WHERE project_id = $1
     ORDER BY created_at DESC`,
    [projectId]
  );

  return result.rows.map(row => ({
    id: row.id,
    projectId: row.project_id,
    keyPrefix: row.key_prefix,
    name: row.name,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
  }));
}

export async function deleteApiKey(id: number, projectId: string): Promise<boolean> {
  const result = await pool.query(
    `DELETE FROM druvia_api_keys WHERE id = $1 AND project_id = $2`,
    [id, projectId]
  );
  return (result.rowCount ?? 0) > 0;
}

export async function validateApiKey(key: string): Promise<{ valid: boolean; projectId?: string }> {
  const keyHash = hashApiKey(key);

  const result = await pool.query(
    `UPDATE druvia_api_keys
     SET last_used_at = NOW()
     WHERE key_hash = $1
     RETURNING project_id`,
    [keyHash]
  );

  if (result.rows.length === 0) {
    return { valid: false };
  }

  return { valid: true, projectId: result.rows[0].project_id };
}
