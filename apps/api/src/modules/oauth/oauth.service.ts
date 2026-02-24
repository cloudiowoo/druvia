import { query, queryOne } from '../../db/index.js';
import { createAuthAdapter, type AuthProviderConfig, type AuthResult } from '../../adapters/auth/index.js';
import { signToken } from '../../middleware/auth.js';
import { generateUserId } from '@druvia/shared';

// User provider binding row
interface UserProviderRow {
  id: number;
  user_id: string;
  provider: string;
  provider_id: string;
  provider_data: Record<string, unknown>;
  created_at: Date;
}

// Get tenant auth provider config
async function getTenantAuthConfig(
  tenantId: string,
  provider: string
): Promise<AuthProviderConfig | null> {
  const row = await queryOne<{
    provider: string;
    config: Record<string, unknown>;
    enabled: boolean;
  }>(
    'SELECT provider, config, enabled FROM druvia_tenant_auth_providers WHERE tenant_id = $1 AND provider = $2',
    [tenantId, provider]
  );

  if (!row || !row.enabled) return null;

  return {
    provider: row.provider,
    config: row.config,
  } as unknown as AuthProviderConfig;
}

// Find user by provider
async function findUserByProvider(
  provider: string,
  providerId: string
): Promise<{ userId: string; uid: number } | null> {
  const row = await queryOne<{ user_id: string }>(
    `SELECT up.user_id FROM druvia_user_providers up
     JOIN druvia_users u ON u.user_id = up.user_id
     WHERE up.provider = $1 AND up.provider_id = $2 AND u.status = 'active'`,
    [provider, providerId]
  );

  if (!row) return null;

  const user = await queryOne<{ id: number }>(
    'SELECT id FROM druvia_users WHERE user_id = $1',
    [row.user_id]
  );

  return user ? { userId: row.user_id, uid: user.id } : null;
}

// Create user from OAuth result
async function createUserFromOAuth(authResult: AuthResult): Promise<{ userId: string; uid: number }> {
  const userId = generateUserId();

  // Create user
  const userRow = await queryOne<{ id: number }>(
    `INSERT INTO druvia_users (user_id, email, username, avatar_url, status)
     VALUES ($1, $2, $3, $4, 'active')
     RETURNING id`,
    [userId, authResult.user.email || null, authResult.user.nickname || null, authResult.user.avatar || null]
  );

  if (!userRow) {
    throw new Error('Failed to create user');
  }

  // Bind provider
  await query(
    `INSERT INTO druvia_user_providers (user_id, provider, provider_id, provider_data)
     VALUES ($1, $2, $3, $4)`,
    [userId, authResult.user.provider, authResult.user.providerId, authResult.user.raw]
  );

  return { userId, uid: userRow.id };
}

// Bind provider to existing user
async function bindProviderToUser(
  userId: string,
  authResult: AuthResult
): Promise<void> {
  await query(
    `INSERT INTO druvia_user_providers (user_id, provider, provider_id, provider_data)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (provider, provider_id) DO UPDATE SET provider_data = $4`,
    [userId, authResult.user.provider, authResult.user.providerId, authResult.user.raw]
  );
}

export interface OAuthLoginResult {
  user: {
    userId: string;
    uid: number;
    isNew: boolean;
  };
  token: string;
  provider: {
    name: string;
    providerId: string;
  };
}

// Get OAuth authorization URL
export async function getAuthUrl(
  tenantId: string,
  provider: string,
  redirectUri: string,
  state?: string
): Promise<string> {
  const config = await getTenantAuthConfig(tenantId, provider);
  if (!config) {
    throw new Error(`Provider ${provider} not configured for tenant`);
  }

  const adapter = createAuthAdapter(config);
  if (!adapter.getAuthUrl) {
    throw new Error(`Provider ${provider} does not support OAuth URL`);
  }

  return adapter.getAuthUrl(redirectUri, state);
}

// Handle OAuth callback
export async function handleOAuthCallback(
  tenantId: string,
  provider: string,
  code: string,
  state?: string
): Promise<OAuthLoginResult> {
  const config = await getTenantAuthConfig(tenantId, provider);
  if (!config) {
    throw new Error(`Provider ${provider} not configured for tenant`);
  }

  const adapter = createAuthAdapter(config);
  const authResult = await adapter.exchangeCode(code, state);

  // Find existing user
  let userInfo = await findUserByProvider(provider, authResult.user.providerId);
  let isNew = false;

  if (!userInfo) {
    // Create new user
    userInfo = await createUserFromOAuth(authResult);
    isNew = true;
  }

  // Generate JWT
  const token = signToken({
    userId: userInfo.userId,
    uid: userInfo.uid,
    tenantId,
  });

  return {
    user: {
      userId: userInfo.userId,
      uid: userInfo.uid,
      isNew,
    },
    token,
    provider: {
      name: provider,
      providerId: authResult.user.providerId,
    },
  };
}

// Bind OAuth provider to current user
export async function bindOAuthProvider(
  userId: string,
  tenantId: string,
  provider: string,
  code: string
): Promise<void> {
  const config = await getTenantAuthConfig(tenantId, provider);
  if (!config) {
    throw new Error(`Provider ${provider} not configured for tenant`);
  }

  const adapter = createAuthAdapter(config);
  const authResult = await adapter.exchangeCode(code);

  // Check if provider already bound to another user
  const existing = await findUserByProvider(provider, authResult.user.providerId);
  if (existing && existing.userId !== userId) {
    throw new Error('This account is already bound to another user');
  }

  await bindProviderToUser(userId, authResult);
}

// List user's bound providers
export async function listUserProviders(userId: string): Promise<Array<{
  provider: string;
  providerId: string;
  boundAt: Date;
}>> {
  const rows = await query<UserProviderRow>(
    'SELECT provider, provider_id, created_at FROM druvia_user_providers WHERE user_id = $1',
    [userId]
  );

  return rows.map(row => ({
    provider: row.provider,
    providerId: row.provider_id,
    boundAt: row.created_at,
  }));
}

// Unbind provider from user
export async function unbindProvider(userId: string, provider: string): Promise<boolean> {
  const rows = await query<{ id: number }>(
    'DELETE FROM druvia_user_providers WHERE user_id = $1 AND provider = $2 RETURNING id',
    [userId, provider]
  );
  return rows.length > 0;
}
