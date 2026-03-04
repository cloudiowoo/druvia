import { query, queryOne, pool } from '../../db/index.js';
import { createCipheriv, createDecipheriv, randomBytes, createHash } from 'crypto';
import { config } from '../../config/index.js';

// ============================================
// Types
// ============================================

// Database row types
interface ProviderRow {
  id: number;
  project_id: string;
  provider: string;
  enabled: boolean;
  client_id: string | null;
  client_secret_encrypted: string | null;
  config: Record<string, unknown>;
  created_at: Date;
  updated_at: Date;
}

interface AuthConfigRow {
  id: number;
  project_id: string;
  jwt_expires_in: number;
  refresh_token_expires_in: number;
  password_min_length: number;
  require_email_verification: boolean;
  allow_signup: boolean;
  created_at: Date;
  updated_at: Date;
}

// Public interfaces
export interface AuthProvider {
  id: number;
  projectId: string;
  provider: string;
  enabled: boolean;
  clientId: string | null;
  // clientSecret 不返回给前端
  config: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}

export interface AuthConfig {
  projectId: string;
  jwtExpiresIn: number;
  refreshTokenExpiresIn: number;
  passwordMinLength: number;
  requireEmailVerification: boolean;
  allowSignup: boolean;
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

export interface CreateProviderInput {
  provider: string;
  enabled?: boolean;
  clientId?: string;
  clientSecret?: string;
  config?: Record<string, unknown>;
}

export interface UpdateProviderInput {
  enabled?: boolean;
  clientId?: string;
  clientSecret?: string;
  config?: Record<string, unknown>;
}

export interface UpdateAuthConfigInput {
  jwtExpiresIn?: number;
  refreshTokenExpiresIn?: number;
  passwordMinLength?: number;
  requireEmailVerification?: boolean;
  allowSignup?: boolean;
}

export interface ListUsersOptions {
  limit?: number;
  offset?: number;
  status?: string;
  search?: string;
}

// ============================================
// Helper functions
// ============================================

function toProvider(row: ProviderRow): AuthProvider {
  return {
    id: row.id,
    projectId: row.project_id,
    provider: row.provider,
    enabled: row.enabled,
    clientId: row.client_id,
    config: row.config || {},
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toAuthConfig(row: AuthConfigRow): AuthConfig {
  return {
    projectId: row.project_id,
    jwtExpiresIn: row.jwt_expires_in,
    refreshTokenExpiresIn: row.refresh_token_expires_in,
    passwordMinLength: row.password_min_length,
    requireEmailVerification: row.require_email_verification,
    allowSignup: row.allow_signup,
  };
}

// 获取加密密钥（32 bytes for AES-256）
function getEncryptionKey(): Buffer {
  const key = process.env.SECRETS_ENCRYPTION_KEY || config.jwt.secret;
  if (!key) {
    throw new Error('SECRETS_ENCRYPTION_KEY or JWT_SECRET must be set');
  }
  // 使用 SHA-256 确保密钥长度正确
  return createHash('sha256').update(key).digest();
}

// AES-256-GCM 加密
function encrypt(text: string): string {
  const key = getEncryptionKey();
  const iv = randomBytes(16);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  let encrypted = cipher.update(text, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  const authTag = cipher.getAuthTag();
  return iv.toString('hex') + ':' + authTag.toString('hex') + ':' + encrypted;
}

// AES-256-GCM 解密
function decrypt(encrypted: string): string {
  const key = getEncryptionKey();
  const [ivHex, authTagHex, encryptedText] = encrypted.split(':');
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(ivHex, 'hex'));
  decipher.setAuthTag(Buffer.from(authTagHex, 'hex'));
  let decrypted = decipher.update(encryptedText, 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  return decrypted;
}

// ============================================
// Provider CRUD
// ============================================

export async function listProviders(projectId: string): Promise<AuthProvider[]> {
  const rows = await query<ProviderRow>(
    'SELECT * FROM druvia_project_auth_providers WHERE project_id = $1 ORDER BY provider',
    [projectId]
  );
  return rows.map(toProvider);
}

export async function getProvider(projectId: string, provider: string): Promise<AuthProvider | null> {
  const row = await queryOne<ProviderRow>(
    'SELECT * FROM druvia_project_auth_providers WHERE project_id = $1 AND provider = $2',
    [projectId, provider]
  );
  return row ? toProvider(row) : null;
}

export async function createProvider(projectId: string, input: CreateProviderInput): Promise<AuthProvider> {
  const clientSecretEncrypted = input.clientSecret ? encrypt(input.clientSecret) : null;

  const row = await queryOne<ProviderRow>(
    `INSERT INTO druvia_project_auth_providers (project_id, provider, enabled, client_id, client_secret_encrypted, config)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING *`,
    [
      projectId,
      input.provider,
      input.enabled ?? true,
      input.clientId || null,
      clientSecretEncrypted,
      input.config || {},
    ]
  );

  if (!row) {
    throw new Error('Failed to create provider');
  }

  return toProvider(row);
}

export async function updateProvider(
  projectId: string,
  provider: string,
  input: UpdateProviderInput
): Promise<AuthProvider | null> {
  const setClauses: string[] = [];
  const values: unknown[] = [];
  let paramIndex = 3;

  if (input.enabled !== undefined) {
    setClauses.push(`enabled = $${paramIndex++}`);
    values.push(input.enabled);
  }
  if (input.clientId !== undefined) {
    setClauses.push(`client_id = $${paramIndex++}`);
    values.push(input.clientId);
  }
  if (input.clientSecret !== undefined) {
    setClauses.push(`client_secret_encrypted = $${paramIndex++}`);
    values.push(input.clientSecret ? encrypt(input.clientSecret) : null);
  }
  if (input.config !== undefined) {
    setClauses.push(`config = $${paramIndex++}`);
    values.push(input.config);
  }

  if (setClauses.length === 0) {
    return getProvider(projectId, provider);
  }

  const row = await queryOne<ProviderRow>(
    `UPDATE druvia_project_auth_providers SET ${setClauses.join(', ')}
     WHERE project_id = $1 AND provider = $2 RETURNING *`,
    [projectId, provider, ...values]
  );

  return row ? toProvider(row) : null;
}

export async function deleteProvider(projectId: string, provider: string): Promise<boolean> {
  const rows = await query<{ id: number }>(
    'DELETE FROM druvia_project_auth_providers WHERE project_id = $1 AND provider = $2 RETURNING id',
    [projectId, provider]
  );
  return rows.length > 0;
}

// 获取解密后的 client_secret（内部使用）
export async function getProviderSecret(projectId: string, provider: string): Promise<string | null> {
  const row = await queryOne<{ client_secret_encrypted: string | null }>(
    'SELECT client_secret_encrypted FROM druvia_project_auth_providers WHERE project_id = $1 AND provider = $2',
    [projectId, provider]
  );
  if (!row?.client_secret_encrypted) return null;
  return decrypt(row.client_secret_encrypted);
}

// ============================================
// Auth Config
// ============================================

export async function getAuthConfig(projectId: string): Promise<AuthConfig> {
  let row = await queryOne<AuthConfigRow>(
    'SELECT * FROM druvia_project_auth_config WHERE project_id = $1',
    [projectId]
  );

  // 如果不存在，创建默认配置
  if (!row) {
    row = await queryOne<AuthConfigRow>(
      `INSERT INTO druvia_project_auth_config (project_id)
       VALUES ($1)
       RETURNING *`,
      [projectId]
    );
  }

  if (!row) {
    throw new Error('Failed to get or create auth config');
  }

  return toAuthConfig(row);
}

export async function updateAuthConfig(
  projectId: string,
  input: UpdateAuthConfigInput
): Promise<AuthConfig> {
  // 确保配置存在
  await getAuthConfig(projectId);

  const setClauses: string[] = [];
  const values: unknown[] = [];
  let paramIndex = 2;

  if (input.jwtExpiresIn !== undefined) {
    setClauses.push(`jwt_expires_in = $${paramIndex++}`);
    values.push(input.jwtExpiresIn);
  }
  if (input.refreshTokenExpiresIn !== undefined) {
    setClauses.push(`refresh_token_expires_in = $${paramIndex++}`);
    values.push(input.refreshTokenExpiresIn);
  }
  if (input.passwordMinLength !== undefined) {
    setClauses.push(`password_min_length = $${paramIndex++}`);
    values.push(input.passwordMinLength);
  }
  if (input.requireEmailVerification !== undefined) {
    setClauses.push(`require_email_verification = $${paramIndex++}`);
    values.push(input.requireEmailVerification);
  }
  if (input.allowSignup !== undefined) {
    setClauses.push(`allow_signup = $${paramIndex++}`);
    values.push(input.allowSignup);
  }

  if (setClauses.length === 0) {
    return getAuthConfig(projectId);
  }

  const row = await queryOne<AuthConfigRow>(
    `UPDATE druvia_project_auth_config SET ${setClauses.join(', ')}
     WHERE project_id = $1 RETURNING *`,
    [projectId, ...values]
  );

  if (!row) {
    throw new Error('Failed to update auth config');
  }

  return toAuthConfig(row);
}

// ============================================
// Project Users (in tenant schema)
// ============================================

// 验证 schema 名称格式，防止 SQL 注入
function validateSchemaName(schemaName: string): void {
  // Schema 名称应只包含字母、数字、下划线，且以字母或下划线开头
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(schemaName)) {
    throw new Error('Invalid schema name format');
  }
}

interface UserRow {
  id: string;
  email: string;
  username: string | null;
  avatar_url: string | null;
  provider: string;
  provider_id: string | null;
  status: 'active' | 'disabled';
  last_login_at: Date | null;
  created_at: Date;
}

function toProjectUser(row: UserRow): ProjectUser {
  return {
    id: row.id,
    email: row.email,
    username: row.username,
    avatarUrl: row.avatar_url,
    provider: row.provider,
    providerId: row.provider_id,
    status: row.status,
    lastLoginAt: row.last_login_at,
    createdAt: row.created_at,
  };
}

export async function listProjectUsers(
  schemaName: string,
  options?: ListUsersOptions
): Promise<{ users: ProjectUser[]; total: number }> {
  validateSchemaName(schemaName);

  let whereClause = '';
  const values: unknown[] = [];
  let paramIndex = 1;

  const conditions: string[] = [];
  if (options?.status) {
    conditions.push(`status = $${paramIndex++}`);
    values.push(options.status);
  }
  if (options?.search) {
    conditions.push(`(email ILIKE $${paramIndex} OR username ILIKE $${paramIndex})`);
    values.push(`%${options.search}%`);
    paramIndex++;
  }

  if (conditions.length > 0) {
    whereClause = 'WHERE ' + conditions.join(' AND ');
  }

  const countResult = await queryOne<{ count: string }>(
    `SELECT COUNT(*) as count FROM ${schemaName}.users ${whereClause}`,
    values
  );

  let queryText = `SELECT id, email, username, avatar_url, provider, provider_id, status, last_login_at, created_at
                   FROM ${schemaName}.users ${whereClause} ORDER BY created_at DESC`;
  const queryValues = [...values];

  if (options?.limit) {
    queryText += ` LIMIT $${paramIndex++}`;
    queryValues.push(options.limit);
  }
  if (options?.offset) {
    queryText += ` OFFSET $${paramIndex++}`;
    queryValues.push(options.offset);
  }

  const rows = await query<UserRow>(queryText, queryValues);

  return {
    users: rows.map(toProjectUser),
    total: parseInt(countResult?.count || '0'),
  };
}

export async function getProjectUser(schemaName: string, userId: string): Promise<ProjectUser | null> {
  validateSchemaName(schemaName);

  const row = await queryOne<UserRow>(
    `SELECT id, email, username, avatar_url, provider, provider_id, status, last_login_at, created_at
     FROM ${schemaName}.users WHERE id = $1`,
    [userId]
  );
  return row ? toProjectUser(row) : null;
}

export async function updateProjectUser(
  schemaName: string,
  userId: string,
  data: { status?: 'active' | 'disabled' }
): Promise<ProjectUser | null> {
  validateSchemaName(schemaName);

  if (!data.status) {
    return getProjectUser(schemaName, userId);
  }

  const row = await queryOne<UserRow>(
    `UPDATE ${schemaName}.users SET status = $1, updated_at = NOW()
     WHERE id = $2
     RETURNING id, email, username, avatar_url, provider, provider_id, status, last_login_at, created_at`,
    [data.status, userId]
  );

  return row ? toProjectUser(row) : null;
}

export async function deleteProjectUser(schemaName: string, userId: string): Promise<boolean> {
  validateSchemaName(schemaName);

  const rows = await query<{ id: string }>(
    `DELETE FROM ${schemaName}.users WHERE id = $1 RETURNING id`,
    [userId]
  );
  return rows.length > 0;
}

// ============================================
// Supported Providers
// ============================================

export const SUPPORTED_PROVIDERS = [
  { id: 'email', name: 'Email/Password', type: 'builtin' },
  { id: 'google', name: 'Google', type: 'oauth' },
  { id: 'github', name: 'GitHub', type: 'oauth' },
  { id: 'microsoft', name: 'Microsoft', type: 'oauth' },
  { id: 'discord', name: 'Discord', type: 'oauth' },
  { id: 'wechat', name: '微信', type: 'oauth' },
  { id: 'dingtalk', name: '钉钉', type: 'oauth' },
  { id: 'feishu', name: '飞书', type: 'oauth' },
] as const;

export function getSupportedProviders() {
  return SUPPORTED_PROVIDERS;
}
