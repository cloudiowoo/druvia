import { query, queryOne, pool } from '../../db/index.js';
import { decryptSecret, encryptSecret } from '../../lib/secret-encryption.js';
import {
  acquireProjectAuthProjectLock,
  assertProjectAuthUserDeletionAllowed,
  assertAppleProviderDeletionAllowed,
  cleanupTerminalProjectAuthUserState,
  withProjectAuthProjectLock,
} from '../project-auth/project-identity.repository.js';
import {
  AppleProviderConfigError,
  validateAppleProjectAuthSchema,
  validateAppleProviderConfiguration,
} from './apple-provider-config.js';

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
  hasCredentials: boolean;
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
    hasCredentials: Boolean(row.client_secret_encrypted),
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

async function assertAppleProjectSchemaCompatible(projectId: string): Promise<void> {
  const project = await queryOne<{ schema_name: string | null }>(
    'SELECT schema_name FROM druvia_projects WHERE project_id = $1',
    [projectId],
  );
  if (!project?.schema_name || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(project.schema_name)) {
    throw new AppleProviderConfigError(
      'APPLE_PROJECT_SCHEMA_INCOMPATIBLE',
      'Project schema is required before enabling Apple Auth',
    );
  }
  const columns = await query<{ column_name: string; is_nullable: string }>(
    `SELECT column_name, is_nullable
     FROM information_schema.columns
     WHERE table_schema = $1 AND table_name = 'users'`,
    [project.schema_name],
  );
  validateAppleProjectAuthSchema(columns);
}

async function withAppleProviderMutationLock<T>(
  projectId: string,
  callback: () => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    return await withProjectAuthProjectLock(client, projectId, callback);
  } finally {
    client.release();
  }
}

async function createProviderUnlocked(
  projectId: string,
  input: CreateProviderInput,
): Promise<AuthProvider> {
  let providerConfig = input.config || {};
  if (input.provider === 'apple') {
    providerConfig = await validateAppleProviderConfiguration({
      clientId: input.clientId ?? '',
      privateKeyPem: input.clientSecret ?? '',
      config: providerConfig,
    });
    if (input.enabled ?? true) {
      await assertAppleProjectSchemaCompatible(projectId);
    }
  }
  const clientSecretEncrypted = input.clientSecret
    ? encryptSecret(input.clientSecret, { requireDedicatedKey: input.provider === 'apple' })
    : null;

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
      providerConfig,
    ]
  );

  if (!row) {
    throw new Error('Failed to create provider');
  }

  return toProvider(row);
}

export async function createProvider(
  projectId: string,
  input: CreateProviderInput,
): Promise<AuthProvider> {
  if (input.provider === 'apple') {
    return withAppleProviderMutationLock(
      projectId,
      () => createProviderUnlocked(projectId, input),
    );
  }
  return createProviderUnlocked(projectId, input);
}

async function updateProviderUnlocked(
  projectId: string,
  provider: string,
  input: UpdateProviderInput
): Promise<AuthProvider | null> {
  let normalizedInput = input;
  if (provider === 'apple') {
    if (input.clientSecret === '') {
      throw new AppleProviderConfigError(
        'APPLE_PRIVATE_KEY_INVALID',
        'Apple private key cannot be cleared; decommission and remove the provider instead',
      );
    }
    const existing = await getProvider(projectId, provider);
    if (!existing) return null;
    const privateKeyPem = input.clientSecret
      || await getProviderSecret(projectId, provider, { requireDedicatedKey: true })
      || '';
    const config = await validateAppleProviderConfiguration({
      clientId: input.clientId ?? existing.clientId ?? '',
      privateKeyPem,
      config: input.config ?? existing.config,
    });
    normalizedInput = { ...input, config };
    if (input.enabled ?? existing.enabled) {
      await assertAppleProjectSchemaCompatible(projectId);
    }
  }
  const setClauses: string[] = [];
  const values: unknown[] = [];
  let paramIndex = 3;

  if (normalizedInput.enabled !== undefined) {
    setClauses.push(`enabled = $${paramIndex++}`);
    values.push(normalizedInput.enabled);
  }
  if (normalizedInput.clientId !== undefined) {
    setClauses.push(`client_id = $${paramIndex++}`);
    values.push(normalizedInput.clientId);
  }
  if (normalizedInput.clientSecret !== undefined) {
    setClauses.push(`client_secret_encrypted = $${paramIndex++}`);
    values.push(normalizedInput.clientSecret
      ? encryptSecret(normalizedInput.clientSecret, { requireDedicatedKey: provider === 'apple' })
      : null);
  }
  if (normalizedInput.config !== undefined) {
    setClauses.push(`config = $${paramIndex++}`);
    values.push(normalizedInput.config);
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

export async function updateProvider(
  projectId: string,
  provider: string,
  input: UpdateProviderInput,
): Promise<AuthProvider | null> {
  if (provider === 'apple') {
    return withAppleProviderMutationLock(
      projectId,
      () => updateProviderUnlocked(projectId, provider, input),
    );
  }
  return updateProviderUnlocked(projectId, provider, input);
}

export async function deleteProvider(projectId: string, provider: string): Promise<boolean> {
  if (provider !== 'apple') {
    const rows = await query<{ id: number }>(
      'DELETE FROM druvia_project_auth_providers WHERE project_id = $1 AND provider = $2 RETURNING id',
      [projectId, provider]
    );
    return rows.length > 0;
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await acquireProjectAuthProjectLock(client, projectId);
    await assertAppleProviderDeletionAllowed(projectId);
    const result = await client.query<{ id: number }>(
      'DELETE FROM druvia_project_auth_providers WHERE project_id = $1 AND provider = $2 RETURNING id',
      [projectId, provider],
    );
    await client.query('COMMIT');
    return result.rows.length > 0;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

// 获取解密后的 client_secret（内部使用）
export async function getProviderSecret(
  projectId: string,
  provider: string,
  options: { requireDedicatedKey?: boolean } = {},
): Promise<string | null> {
  const row = await queryOne<{ client_secret_encrypted: string | null }>(
    'SELECT client_secret_encrypted FROM druvia_project_auth_providers WHERE project_id = $1 AND provider = $2',
    [projectId, provider]
  );
  if (!row?.client_secret_encrypted) return null;
  return decryptSecret(row.client_secret_encrypted, options);
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

export async function deleteProjectUser(
  projectId: string,
  schemaName: string,
  userId: string,
): Promise<boolean> {
  validateSchemaName(schemaName);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await acquireProjectAuthProjectLock(client, projectId);
    await client.query(
      'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
      [`project-auth-user:${projectId}:${userId}`],
    );
    await assertProjectAuthUserDeletionAllowed(client, projectId, userId);
    await cleanupTerminalProjectAuthUserState(client, projectId, userId);
    const result = await client.query<{ id: string }>(
      `DELETE FROM ${schemaName}.users WHERE id = $1 RETURNING id`,
      [userId],
    );
    await client.query('COMMIT');
    return result.rows.length > 0;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
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
  { id: 'apple', name: 'Sign in with Apple', type: 'oauth' },
  { id: 'dingtalk', name: '钉钉', type: 'oauth' },
  { id: 'feishu', name: '飞书', type: 'oauth' },
] as const;

export function getSupportedProviders() {
  return SUPPORTED_PROVIDERS;
}
