import crypto from 'crypto';
import { generateUserId } from '@druvia/shared';
import { createAuthAdapter, type AuthProviderConfig, type AuthResult } from '../../adapters/auth/index.js';
import { query, queryOne } from '../../db/index.js';
import { signProjectUserToken } from '../../middleware/auth.js';
import * as authAdminService from '../auth-admin/auth-admin.service.js';
import * as projectService from '../project/project.service.js';

type ProjectUserRow = {
  id: string;
  email: string | null;
  username: string | null;
  avatar_url: string | null;
  provider: string | null;
  provider_id: string | null;
  status: 'active' | 'disabled' | null;
  last_login_at: Date | null;
  created_at: Date | null;
};

type ProjectUser = {
  id: string;
  email: string | null;
  username: string | null;
  avatarUrl: string | null;
  provider: string;
};

type SchemaCapabilities = {
  hasEmail: boolean;
  hasUsername: boolean;
  hasAvatarUrl: boolean;
  hasProvider: boolean;
  hasProviderId: boolean;
  hasStatus: boolean;
  hasLastLoginAt: boolean;
  hasWxOpenId: boolean;
  hasCreatedAt: boolean;
  hasUpdatedAt: boolean;
};

export interface ProjectSession {
  token: string;
  refreshToken: string;
  expiresIn: number;
  expiresAt: string;
  user: {
    id: string;
    email: string | null;
    username: string | null;
    avatarUrl: string | null;
    role: 'authenticated';
  };
}

export class ProjectAuthError extends Error {
  constructor(
    public code: string,
    message: string,
    public statusCode = 400
  ) {
    super(message);
    this.name = 'ProjectAuthError';
  }
}

function validateSchemaName(schemaName: string): void {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(schemaName)) {
    throw new Error('Invalid schema name format');
  }
}

function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function buildUserSelect(schemaName: string, capabilities: SchemaCapabilities): string {
  const columns = [
    'id',
    capabilities.hasEmail ? 'email' : 'NULL::text AS email',
    capabilities.hasUsername ? 'username' : 'NULL::text AS username',
    capabilities.hasAvatarUrl ? 'avatar_url' : 'NULL::text AS avatar_url',
    capabilities.hasProvider ? 'provider' : 'NULL::text AS provider',
    capabilities.hasProviderId ? 'provider_id' : 'NULL::text AS provider_id',
    capabilities.hasStatus ? 'status' : 'NULL::text AS status',
    capabilities.hasLastLoginAt ? 'last_login_at' : 'NULL::timestamptz AS last_login_at',
    capabilities.hasCreatedAt ? 'created_at' : 'NULL::timestamptz AS created_at',
  ];

  return `SELECT ${columns.join(', ')} FROM ${schemaName}.users`;
}

function toProjectUser(row: ProjectUserRow): ProjectUser {
  return {
    id: row.id,
    email: row.email,
    username: row.username,
    avatarUrl: row.avatar_url,
    provider: row.provider || 'wechat',
  };
}

async function getProjectContext(projectId: string) {
  const project = await projectService.getProjectById(projectId);
  if (!project?.schemaName) {
    throw new ProjectAuthError('PROJECT_NOT_FOUND', 'Project not found', 404);
  }

  const authConfig = await authAdminService.getAuthConfig(projectId);

  return {
    schemaName: project.schemaName,
    authConfig,
  };
}

function buildAuthProviderConfig(
  providerName: string,
  provider: NonNullable<Awaited<ReturnType<typeof authAdminService.getProvider>>>,
  clientSecret: string | null
): AuthProviderConfig {
  switch (providerName) {
    case 'wechat': {
      const type = typeof provider.config.type === 'string' ? provider.config.type : 'miniprogram';
      const appId = provider.clientId || (typeof provider.config.appId === 'string' ? provider.config.appId : '');
      const appSecret = clientSecret || (typeof provider.config.appSecret === 'string' ? provider.config.appSecret : '');

      if (!appId || !appSecret) {
        throw new ProjectAuthError('PROVIDER_NOT_CONFIGURED', 'WeChat auth provider credentials are incomplete', 400);
      }

      return {
        provider: 'wechat',
        config: {
          appId,
          appSecret,
          type: type === 'official' || type === 'web' ? type : 'miniprogram',
        },
      };
    }
    case 'oidc': {
      const name = typeof provider.config.name === 'string' ? provider.config.name : 'OIDC';
      const authorizationEndpoint = typeof provider.config.authorizationEndpoint === 'string' ? provider.config.authorizationEndpoint : '';
      const tokenEndpoint = typeof provider.config.tokenEndpoint === 'string' ? provider.config.tokenEndpoint : '';
      const userinfoEndpoint = typeof provider.config.userinfoEndpoint === 'string' ? provider.config.userinfoEndpoint : '';
      const redirectUri = typeof provider.config.redirectUri === 'string' ? provider.config.redirectUri : '';
      const clientId = provider.clientId || (typeof provider.config.clientId === 'string' ? provider.config.clientId : '');
      const secret = clientSecret || (typeof provider.config.clientSecret === 'string' ? provider.config.clientSecret : '');
      const scopes = Array.isArray(provider.config.scopes)
        ? provider.config.scopes.filter((scope): scope is string => typeof scope === 'string')
        : undefined;

      if (!authorizationEndpoint || !tokenEndpoint || !userinfoEndpoint || !redirectUri || !clientId || !secret) {
        throw new ProjectAuthError('PROVIDER_NOT_CONFIGURED', 'OIDC auth provider credentials are incomplete', 400);
      }

      return {
        provider: 'oidc',
        config: {
          name,
          clientId,
          clientSecret: secret,
          authorizationEndpoint,
          tokenEndpoint,
          userinfoEndpoint,
          redirectUri,
          scopes,
        },
      };
    }
    default:
      throw new ProjectAuthError('PROVIDER_UNSUPPORTED', `Provider "${providerName}" is not supported yet`, 400);
  }
}

async function getAuthAdapter(projectId: string, providerName: string) {
  const provider = await authAdminService.getProvider(projectId, providerName);
  if (!provider?.enabled) {
    throw new ProjectAuthError('PROVIDER_NOT_CONFIGURED', `${providerName} auth provider is not configured`, 400);
  }

  const clientSecret = await authAdminService.getProviderSecret(projectId, providerName);
  return createAuthAdapter(buildAuthProviderConfig(providerName, provider, clientSecret));
}

async function getSchemaCapabilities(schemaName: string): Promise<SchemaCapabilities> {
  validateSchemaName(schemaName);

  const columns = await query<{ column_name: string }>(
    `SELECT column_name
     FROM information_schema.columns
     WHERE table_schema = $1 AND table_name = 'users'`,
    [schemaName]
  );
  const names = new Set(columns.map((column) => column.column_name));

  return {
    hasEmail: names.has('email'),
    hasUsername: names.has('username'),
    hasAvatarUrl: names.has('avatar_url'),
    hasProvider: names.has('provider'),
    hasProviderId: names.has('provider_id'),
    hasStatus: names.has('status'),
    hasLastLoginAt: names.has('last_login_at'),
    hasWxOpenId: names.has('wx_open_id'),
    hasCreatedAt: names.has('created_at'),
    hasUpdatedAt: names.has('updated_at'),
  };
}

async function findProjectUserByProvider(
  schemaName: string,
  capabilities: SchemaCapabilities,
  provider: string,
  providerId: string
): Promise<ProjectUserRow | null> {
  validateSchemaName(schemaName);

  const select = buildUserSelect(schemaName, capabilities);
  const statusCondition = capabilities.hasStatus ? ` AND status = 'active'` : '';

  if (capabilities.hasProvider && capabilities.hasProviderId) {
    const user = await queryOne<ProjectUserRow>(
      `${select} WHERE provider = $1 AND provider_id = $2${statusCondition} LIMIT 1`,
      [provider, providerId]
    );
    if (user) return user;
  }

  if (provider === 'wechat' && capabilities.hasWxOpenId) {
    return queryOne<ProjectUserRow>(
      `${select} WHERE wx_open_id = $1${statusCondition} LIMIT 1`,
      [providerId]
    );
  }

  return null;
}

async function getProjectUserById(
  schemaName: string,
  capabilities: SchemaCapabilities,
  userId: string
): Promise<ProjectUserRow | null> {
  validateSchemaName(schemaName);

  const statusCondition = capabilities.hasStatus ? ` AND status = 'active'` : '';
  return queryOne<ProjectUserRow>(
    `${buildUserSelect(schemaName, capabilities)} WHERE id = $1${statusCondition} LIMIT 1`,
    [userId]
  );
}

async function touchProjectUserLastLoginAt(
  schemaName: string,
  capabilities: SchemaCapabilities,
  userId: string
): Promise<ProjectUserRow | null> {
  validateSchemaName(schemaName);

  if (!capabilities.hasLastLoginAt) {
    return getProjectUserById(schemaName, capabilities, userId);
  }

  return queryOne<ProjectUserRow>(
    `UPDATE ${schemaName}.users
     SET last_login_at = NOW()
     WHERE id = $1
     RETURNING id,
               ${capabilities.hasEmail ? 'email' : 'NULL::text AS email'},
               ${capabilities.hasUsername ? 'username' : 'NULL::text AS username'},
               ${capabilities.hasAvatarUrl ? 'avatar_url' : 'NULL::text AS avatar_url'},
               ${capabilities.hasProvider ? 'provider' : 'NULL::text AS provider'},
               ${capabilities.hasProviderId ? 'provider_id' : 'NULL::text AS provider_id'},
               ${capabilities.hasStatus ? 'status' : 'NULL::text AS status'},
               last_login_at,
               ${capabilities.hasCreatedAt ? 'created_at' : 'NULL::timestamptz AS created_at'}`,
    [userId]
  );
}

async function createProjectUser(
  schemaName: string,
  capabilities: SchemaCapabilities,
  provider: string,
  providerId: string,
  authUser: AuthResult['user'],
  userInfo?: {
    nickName?: string;
    avatarUrl?: string;
  }
): Promise<ProjectUserRow> {
  validateSchemaName(schemaName);

  const columns: string[] = ['id'];
  const values: unknown[] = [generateUserId()];
  const placeholders = ['$1'];
  let paramIndex = 2;

  if (capabilities.hasEmail) {
    columns.push('email');
    values.push(authUser.email || `${providerId}@${provider}.druvia.local`);
    placeholders.push(`$${paramIndex++}`);
  }
  if (capabilities.hasUsername) {
    columns.push('username');
    values.push(userInfo?.nickName || authUser.nickname || null);
    placeholders.push(`$${paramIndex++}`);
  }
  if (capabilities.hasAvatarUrl) {
    columns.push('avatar_url');
    values.push(userInfo?.avatarUrl || authUser.avatar || null);
    placeholders.push(`$${paramIndex++}`);
  }
  if (capabilities.hasProvider) {
    columns.push('provider');
    values.push(provider);
    placeholders.push(`$${paramIndex++}`);
  }
  if (capabilities.hasProviderId) {
    columns.push('provider_id');
    values.push(providerId);
    placeholders.push(`$${paramIndex++}`);
  }
  if (capabilities.hasStatus) {
    columns.push('status');
    values.push('active');
    placeholders.push(`$${paramIndex++}`);
  }
  if (provider === 'wechat' && capabilities.hasWxOpenId) {
    columns.push('wx_open_id');
    values.push(providerId);
    placeholders.push(`$${paramIndex++}`);
  }
  if (capabilities.hasLastLoginAt) {
    columns.push('last_login_at');
    placeholders.push('NOW()');
  }
  if (capabilities.hasCreatedAt) {
    columns.push('created_at');
    placeholders.push('NOW()');
  }
  if (capabilities.hasUpdatedAt) {
    columns.push('updated_at');
    placeholders.push('NOW()');
  }

  const created = await queryOne<ProjectUserRow>(
    `INSERT INTO ${schemaName}.users (${columns.join(', ')})
     VALUES (${placeholders.join(', ')})
     RETURNING id,
               ${capabilities.hasEmail ? 'email' : 'NULL::text AS email'},
               ${capabilities.hasUsername ? 'username' : 'NULL::text AS username'},
               ${capabilities.hasAvatarUrl ? 'avatar_url' : 'NULL::text AS avatar_url'},
               ${capabilities.hasProvider ? 'provider' : `'${provider}'::text AS provider`},
               ${capabilities.hasProviderId ? 'provider_id' : 'NULL::text AS provider_id'},
               ${capabilities.hasStatus ? 'status' : "'active'::text AS status"},
               ${capabilities.hasLastLoginAt ? 'last_login_at' : 'NULL::timestamptz AS last_login_at'},
               ${capabilities.hasCreatedAt ? 'created_at' : 'NOW() AS created_at'}`,
    values
  );

  if (!created) {
    throw new Error('Failed to create project user');
  }

  return created;
}

export async function createProjectRefreshToken(
  projectId: string,
  userId: string,
  provider: string,
  ttlSeconds: number
): Promise<string> {
  const rawToken = crypto.randomBytes(32).toString('base64url');
  const tokenHash = hashToken(rawToken);
  const expiresAt = new Date(Date.now() + ttlSeconds * 1000);

  await query(
    `INSERT INTO druvia_project_refresh_tokens (project_id, user_id, provider, token_hash, expires_at)
     VALUES ($1, $2, $3, $4, $5)`,
    [projectId, userId, provider, tokenHash, expiresAt]
  );

  return rawToken;
}

export async function consumeProjectRefreshToken(
  projectId: string,
  rawToken: string
): Promise<{ userId: string; provider: string }> {
  const tokenHash = hashToken(rawToken);

  const token = await queryOne<{ user_id: string; provider: string }>(
    `UPDATE druvia_project_refresh_tokens
     SET revoked = true
     WHERE project_id = $1
       AND token_hash = $2
       AND revoked = false
       AND expires_at > NOW()
     RETURNING user_id, provider`,
    [projectId, tokenHash]
  );

  if (!token) {
    throw new ProjectAuthError('INVALID_TOKEN', 'Invalid or expired refresh token', 401);
  }

  return {
    userId: token.user_id,
    provider: token.provider,
  };
}

export async function revokeProjectRefreshTokens(projectId: string, userId: string): Promise<void> {
  await query(
    `UPDATE druvia_project_refresh_tokens
     SET revoked = true
     WHERE project_id = $1 AND user_id = $2 AND revoked = false`,
    [projectId, userId]
  );
}

export async function issueProjectSession(
  projectId: string,
  user: ProjectUser,
  provider: string,
  authConfig: Awaited<ReturnType<typeof authAdminService.getAuthConfig>>
): Promise<ProjectSession> {
  const expiresIn = authConfig.jwtExpiresIn;
  const expiresAt = new Date(Date.now() + expiresIn * 1000).toISOString();
  const token = signProjectUserToken({
    sub: user.id,
    projectId,
    authType: 'project_user',
    role: 'authenticated',
    provider,
  }, expiresIn);
  const refreshToken = await createProjectRefreshToken(
    projectId,
    user.id,
    provider,
    authConfig.refreshTokenExpiresIn
  );

  return {
    token,
    refreshToken,
    expiresIn,
    expiresAt,
    user: {
      id: user.id,
      email: user.email,
      username: user.username,
      avatarUrl: user.avatarUrl,
      role: 'authenticated',
    },
  };
}

async function exchangeProviderCode(projectId: string, provider: string, code: string) {
  const adapter = await getAuthAdapter(projectId, provider);

  try {
    return await adapter.exchangeCode(code);
  } catch (error) {
    const message = error instanceof Error ? error.message : `${provider} exchange failed`;
    throw new ProjectAuthError('PROVIDER_EXCHANGE_FAILED', message, 502);
  }
}

export async function providerSilentLogin(
  projectId: string,
  provider: string,
  input: { code: string }
): Promise<ProjectSession> {
  const { schemaName, authConfig } = await getProjectContext(projectId);
  const capabilities = await getSchemaCapabilities(schemaName);
  const authResult = await exchangeProviderCode(projectId, provider, input.code);
  const providerId = authResult.user.providerId;
  const existingUser = await findProjectUserByProvider(schemaName, capabilities, provider, providerId);

  if (!existingUser) {
    throw new ProjectAuthError('USER_NOT_FOUND', 'Project user not found', 404);
  }

  return issueProjectSession(projectId, toProjectUser(existingUser), provider, authConfig);
}

export async function providerLogin(
  projectId: string,
  provider: string,
  input: {
    code: string;
    userInfo?: {
      nickName?: string;
      avatarUrl?: string;
    };
  }
): Promise<ProjectSession> {
  const { schemaName, authConfig } = await getProjectContext(projectId);
  const capabilities = await getSchemaCapabilities(schemaName);
  const authResult = await exchangeProviderCode(projectId, provider, input.code);
  const providerId = authResult.user.providerId;

  let user = await findProjectUserByProvider(schemaName, capabilities, provider, providerId);
  if (!user) {
    if (!authConfig.allowSignup) {
      throw new ProjectAuthError('SIGNUP_DISABLED', 'Project signup is disabled', 403);
    }
    user = await createProjectUser(schemaName, capabilities, provider, providerId, authResult.user, input.userInfo);
  } else {
    user = await touchProjectUserLastLoginAt(schemaName, capabilities, user.id) ?? user;
  }

  return issueProjectSession(projectId, toProjectUser(user), provider, authConfig);
}

export async function wechatSilentLogin(
  projectId: string,
  input: { code: string }
): Promise<ProjectSession> {
  return providerSilentLogin(projectId, 'wechat', input);
}

export async function wechatLogin(
  projectId: string,
  input: {
    code: string;
    userInfo?: {
      nickName?: string;
      avatarUrl?: string;
    };
  }
): Promise<ProjectSession> {
  return providerLogin(projectId, 'wechat', input);
}

export async function refreshProjectSession(
  projectId: string,
  refreshToken: string
): Promise<ProjectSession> {
  const { schemaName, authConfig } = await getProjectContext(projectId);
  const capabilities = await getSchemaCapabilities(schemaName);
  const token = await consumeProjectRefreshToken(projectId, refreshToken);
  const user = await getProjectUserById(schemaName, capabilities, token.userId);

  if (!user) {
    throw new ProjectAuthError('USER_NOT_FOUND', 'Project user not found', 404);
  }

  return issueProjectSession(projectId, toProjectUser(user), token.provider, authConfig);
}

export async function logoutProjectUser(projectId: string, userId: string): Promise<void> {
  await revokeProjectRefreshTokens(projectId, userId);
}
