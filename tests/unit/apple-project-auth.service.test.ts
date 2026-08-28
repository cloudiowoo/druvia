import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PoolClient } from 'pg';

const { client } = vi.hoisted(() => ({
  client: {
    query: vi.fn(),
    release: vi.fn(),
  },
}));

vi.mock('../../apps/api/src/db/index.js', () => ({
  query: vi.fn(),
  queryOne: vi.fn(),
  pool: { connect: vi.fn().mockResolvedValue(client) },
}));

vi.mock('../../apps/api/src/modules/project/project.service.js', () => ({
  getProjectById: vi.fn(),
}));

vi.mock('../../apps/api/src/modules/auth-admin/auth-admin.service.js', () => ({
  getAuthConfig: vi.fn(),
  getProvider: vi.fn(),
  getProviderSecret: vi.fn(),
}));

vi.mock('../../apps/api/src/adapters/auth/index.js', () => ({
  createAuthAdapter: vi.fn(),
  createAppleAuthAdapter: vi.fn(),
  AppleAdapterError: class AppleAdapterError extends Error {
    constructor(
      public reason: string,
      public retryable: boolean,
      public upstreamStatus?: number,
    ) {
      super(reason);
    }
  },
}));

vi.mock('../../apps/api/src/lib/secret-encryption.js', () => ({
  encryptSecret: vi.fn(() => 'encrypted-apple-refresh-token'),
  decryptSecret: vi.fn(() => 'decrypted-apple-refresh-token'),
  SecretEncryptionConfigError: class SecretEncryptionConfigError extends Error {},
}));

vi.mock('../../apps/api/src/modules/project-auth/project-identity.repository.js', () => ({
  acquireProjectAuthProjectLock: vi.fn(),
  acquireProjectAuthIdentityLock: vi.fn(),
  acquireProjectAuthIdentityIdLock: vi.fn(),
  findProjectAuthIdentity: vi.fn(),
  createProjectAuthIdentity: vi.fn(),
  reactivateProjectAuthIdentity: vi.fn(),
  upsertProjectAuthProviderToken: vi.fn(),
  markProjectAuthIdentityRevokePending: vi.fn(),
  markProjectAuthIdentityRevoked: vi.fn(),
  deleteProjectAuthProviderTokens: vi.fn(),
}));

import { query } from '../../apps/api/src/db/index.js';
import { AppleAdapterError, createAppleAuthAdapter } from '../../apps/api/src/adapters/auth/index.js';
import { getProjectById } from '../../apps/api/src/modules/project/project.service.js';
import {
  getAuthConfig,
  getProvider,
  getProviderSecret,
} from '../../apps/api/src/modules/auth-admin/auth-admin.service.js';
import {
  acquireProjectAuthProjectLock,
  createProjectAuthIdentity,
  findProjectAuthIdentity,
  markProjectAuthIdentityRevokePending,
  reactivateProjectAuthIdentity,
  upsertProjectAuthProviderToken,
} from '../../apps/api/src/modules/project-auth/project-identity.repository.js';
import {
  ProjectAuthError,
  appleLogin,
  refreshProjectSession,
} from '../../apps/api/src/modules/project-auth/project-auth.service.js';

const adapter = {
  provider: 'apple' as const,
  authenticateNative: vi.fn(),
  revoke: vi.fn(),
  validateRefreshToken: vi.fn(),
};

const credential = {
  authorizationCode: 'authorization-code',
  identityToken: 'identity-token',
  rawNonce: 'a'.repeat(43),
  profile: { givenName: 'Ada', familyName: 'Lovelace' },
};

function mockCapabilities(options: { emailNullable?: boolean } = {}) {
  vi.mocked(query).mockResolvedValue([
    { column_name: 'id', data_type: 'uuid', is_nullable: 'NO' },
    { column_name: 'email', data_type: 'character varying', is_nullable: options.emailNullable === false ? 'NO' : 'YES' },
    { column_name: 'username', data_type: 'character varying', is_nullable: 'YES' },
    { column_name: 'provider', data_type: 'character varying', is_nullable: 'YES' },
    { column_name: 'provider_id', data_type: 'character varying', is_nullable: 'YES' },
    { column_name: 'status', data_type: 'character varying', is_nullable: 'YES' },
    { column_name: 'last_login_at', data_type: 'timestamp with time zone', is_nullable: 'YES' },
    { column_name: 'created_at', data_type: 'timestamp with time zone', is_nullable: 'YES' },
    { column_name: 'updated_at', data_type: 'timestamp with time zone', is_nullable: 'YES' },
  ] as never);
}

describe('Apple Project Auth service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getProjectById).mockResolvedValue({
      projectId: 'proj_123',
      schemaName: 'dru_default_pitchetch',
    } as never);
    vi.mocked(getAuthConfig).mockResolvedValue({
      projectId: 'proj_123',
      jwtExpiresIn: 7_200,
      refreshTokenExpiresIn: 86_400,
      passwordMinLength: 8,
      requireEmailVerification: false,
      allowSignup: true,
    });
    vi.mocked(getProvider).mockResolvedValue({
      id: 1,
      projectId: 'proj_123',
      provider: 'apple',
      enabled: true,
      clientId: 'com.example.pitchetch',
      config: {
        teamId: 'TEAMID1234',
        keyId: 'KEYID12345',
        allowedAudiences: ['com.example.pitchetch'],
        flow: 'native',
      },
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    vi.mocked(getProviderSecret).mockResolvedValue('-----BEGIN PRIVATE KEY-----\ntest\n-----END PRIVATE KEY-----');
    vi.mocked(createAppleAuthAdapter).mockReturnValue(adapter);
    adapter.authenticateNative.mockResolvedValue({
      user: {
        provider: 'apple',
        providerId: 'external-apple-subject',
        email: undefined,
        nickname: 'Ada Lovelace',
      },
      providerSession: {
        audience: 'com.example.pitchetch',
        refreshToken: 'server-only-apple-refresh-token',
      },
    });
    adapter.revoke.mockResolvedValue(undefined);
    mockCapabilities({ emailNullable: false });
    vi.mocked(findProjectAuthIdentity).mockResolvedValue(null);
    vi.mocked(createProjectAuthIdentity).mockResolvedValue({
      id: 12,
      projectId: 'proj_123',
      projectUserId: 'generated-user-id',
      provider: 'apple',
      issuer: 'https://appleid.apple.com',
      subject: 'external-apple-subject',
      audience: 'com.example.pitchetch',
      status: 'active',
    });
    client.query.mockImplementation(async (sql: string) => {
      if (sql.includes('.users (')) {
        return {
          rows: [{
            id: 'generated-user-id',
            email: 'generated-user-id@users.invalid',
            username: 'Ada Lovelace',
            avatar_url: null,
            provider: 'apple',
            provider_id: null,
            status: 'active',
            last_login_at: new Date(),
            created_at: new Date(),
          }],
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: 1 };
    });
  });

  it('locks the project before the Apple identity during login', async () => {
    const calls: string[] = [];
    vi.mocked(acquireProjectAuthProjectLock).mockImplementation(async () => { calls.push('project'); });
    const identityRepository = await import('../../apps/api/src/modules/project-auth/project-identity.repository.js');
    vi.mocked(identityRepository.acquireProjectAuthIdentityLock).mockImplementation(async () => { calls.push('identity'); });
    adapter.authenticateNative.mockResolvedValue({
      user: { providerId: 'apple-subject', email: 'ada@example.com', nickname: 'Ada' },
      providerSession: { audience: 'com.example.pitchetch', refreshToken: 'provider-refresh' },
    });
    vi.mocked(findProjectAuthIdentity).mockResolvedValue(null);
    vi.mocked(createProjectAuthIdentity).mockResolvedValue({
      id: 12,
      projectId: 'proj_123',
      projectUserId: 'user-123',
      provider: 'apple',
      issuer: 'https://appleid.apple.com',
      subject: 'apple-subject',
      audience: 'com.example.pitchetch',
      status: 'active',
    });
    client.query.mockImplementation(async (sql: string) => {
      if (sql.includes('INSERT INTO dru_default_pitchetch.users')) {
        return { rows: [{ id: 'user-123', email: 'ada@example.com', username: 'Ada', provider: 'apple', status: 'active' }] };
      }
      return { rows: [], rowCount: 1 };
    });

    await appleLogin('proj_123', credential);

    expect(calls).toEqual(['project', 'identity']);
  });

  it('creates user, identity, encrypted provider token, and identity-bound session in one transaction', async () => {
    const session = await appleLogin('proj_123', credential);

    expect(client.query).toHaveBeenNthCalledWith(1, 'BEGIN');
    expect(createProjectAuthIdentity).toHaveBeenCalledWith(client as unknown as PoolClient, expect.objectContaining({
      projectUserId: 'generated-user-id',
      subject: 'external-apple-subject',
    }));
    expect(upsertProjectAuthProviderToken).toHaveBeenCalledWith(client, {
      identityId: 12,
      audience: 'com.example.pitchetch',
      refreshTokenEncrypted: 'encrypted-apple-refresh-token',
    });
    const userInsert = client.query.mock.calls.find(([sql]) => String(sql).includes('.users'))!;
    expect(userInsert[1]).not.toContain('external-apple-subject');
    expect(userInsert[1]).toContain(null);
    expect(client.query).toHaveBeenCalledWith(
      expect.stringContaining('identity_id, provider_audience'),
      expect.arrayContaining(['proj_123', 'generated-user-id', 'apple', 12, 'com.example.pitchetch']),
    );
    expect(client.query).toHaveBeenLastCalledWith('COMMIT');
    expect(session.expiresIn).toBe(3_600);
    expect(session.user.email).toBeNull();
  });

  it('reuses the same Project User for a repeated Apple subject', async () => {
    vi.mocked(findProjectAuthIdentity).mockResolvedValue({
      id: 12,
      projectId: 'proj_123',
      projectUserId: 'existing-user-id',
      provider: 'apple',
      issuer: 'https://appleid.apple.com',
      subject: 'external-apple-subject',
      audience: 'com.example.pitchetch',
      status: 'active',
    });
    vi.mocked(reactivateProjectAuthIdentity).mockResolvedValue({
      id: 12,
      projectId: 'proj_123',
      projectUserId: 'existing-user-id',
      provider: 'apple',
      issuer: 'https://appleid.apple.com',
      subject: 'external-apple-subject',
      audience: 'com.example.pitchetch',
      status: 'active',
    });
    client.query.mockImplementation(async (sql: string) => {
      if (sql.includes('.users WHERE')) {
        return { rows: [{
          id: 'existing-user-id', email: null, username: 'Existing', avatar_url: null,
          provider: 'apple', provider_id: null, status: 'active', last_login_at: null,
          created_at: new Date(),
        }], rowCount: 1 };
      }
      return { rows: [], rowCount: 1 };
    });

    const session = await appleLogin('proj_123', credential);

    expect(session.user.id).toBe('existing-user-id');
    expect(createProjectAuthIdentity).not.toHaveBeenCalled();
    expect(client.query.mock.calls.some(([sql]) => String(sql).includes('INSERT INTO') && String(sql).includes('.users'))).toBe(false);
  });

  it('rejects a new identity when signup is disabled and compensates the consumed code', async () => {
    vi.mocked(getAuthConfig).mockResolvedValue({
      projectId: 'proj_123',
      jwtExpiresIn: 7_200,
      refreshTokenExpiresIn: 86_400,
      passwordMinLength: 8,
      requireEmailVerification: false,
      allowSignup: false,
    });

    await expect(appleLogin('proj_123', credential)).rejects.toEqual(
      expect.objectContaining<ProjectAuthError>({ code: 'PROVIDER_REAUTH_REQUIRED' }),
    );

    expect(adapter.revoke).toHaveBeenCalled();
    expect(createProjectAuthIdentity).not.toHaveBeenCalled();
  });

  it('moves an orphaned existing identity to recovery instead of creating another user', async () => {
    vi.mocked(findProjectAuthIdentity).mockResolvedValue({
      id: 12,
      projectId: 'proj_123',
      projectUserId: 'missing-user-id',
      provider: 'apple',
      issuer: 'https://appleid.apple.com',
      subject: 'external-apple-subject',
      audience: 'com.example.pitchetch',
      status: 'active',
    });
    vi.mocked(reactivateProjectAuthIdentity).mockResolvedValue({
      id: 12,
      projectId: 'proj_123',
      projectUserId: 'missing-user-id',
      provider: 'apple',
      issuer: 'https://appleid.apple.com',
      subject: 'external-apple-subject',
      audience: 'com.example.pitchetch',
      status: 'active',
    });

    await expect(appleLogin('proj_123', credential)).rejects.toEqual(
      expect.objectContaining<ProjectAuthError>({ code: 'PROVIDER_REAUTH_REQUIRED' }),
    );

    expect(markProjectAuthIdentityRevokePending).toHaveBeenCalledWith(client, 12);
    expect(createProjectAuthIdentity).not.toHaveBeenCalled();
  });

  it('does not issue a session while the identity lifecycle is pending', async () => {
    vi.mocked(findProjectAuthIdentity).mockResolvedValue({
      id: 12,
      projectId: 'proj_123',
      projectUserId: 'existing-user-id',
      provider: 'apple',
      issuer: 'https://appleid.apple.com',
      subject: 'external-apple-subject',
      audience: 'com.example.pitchetch',
      status: 'deletion_pending',
    });

    await expect(appleLogin('proj_123', credential)).rejects.toEqual(
      expect.objectContaining<ProjectAuthError>({ code: 'PROVIDER_REAUTH_REQUIRED' }),
    );

    expect(upsertProjectAuthProviderToken).not.toHaveBeenCalled();
  });

  it('fails preflight before Apple network access when the project users table is missing', async () => {
    vi.mocked(query).mockResolvedValue([]);

    await expect(appleLogin('proj_123', credential)).rejects.toEqual(
      expect.objectContaining<ProjectAuthError>({ code: 'PROVIDER_SCHEMA_INCOMPATIBLE' }),
    );
    expect(adapter.authenticateNative).not.toHaveBeenCalled();
  });

  it('rolls back and best-effort revokes the Apple token when local persistence fails', async () => {
    client.query.mockImplementation(async (sql: string) => {
      if (sql.includes('INSERT INTO druv_default_pitchetch.users')) {
        throw new Error('database unavailable');
      }
      return { rows: [], rowCount: 1 };
    });

    await expect(appleLogin('proj_123', credential)).rejects.toEqual(
      expect.objectContaining<ProjectAuthError>({ code: 'PROVIDER_REAUTH_REQUIRED' }),
    );
    expect(client.query).toHaveBeenCalledWith('ROLLBACK');
    expect(adapter.revoke).toHaveBeenCalledWith({
      audience: 'com.example.pitchetch',
      refreshToken: 'server-only-apple-refresh-token',
    });
  });

  it('rotates a fresh identity-bound Druvia token without calling Apple again', async () => {
    const columns = [
      { column_name: 'id', data_type: 'uuid', is_nullable: 'NO' },
      { column_name: 'email', data_type: 'character varying', is_nullable: 'YES' },
      { column_name: 'username', data_type: 'character varying', is_nullable: 'YES' },
      { column_name: 'provider', data_type: 'character varying', is_nullable: 'YES' },
      { column_name: 'provider_id', data_type: 'character varying', is_nullable: 'YES' },
      { column_name: 'status', data_type: 'character varying', is_nullable: 'YES' },
    ];
    vi.mocked(query).mockImplementation(async (sql) => {
      if (sql.includes('information_schema.columns')) return columns as never;
      if (sql.includes('SELECT provider, identity_id')) {
        return [{ provider: 'apple', identity_id: 12 }] as never;
      }
      return [];
    });
    client.query.mockImplementation(async (sql: string) => {
      if (sql.includes('SELECT r.id AS token_id')) {
        return { rows: [{
          token_id: 99,
          user_id: 'existing-user-id',
          identity_id: 12,
          provider_audience: 'com.example.pitchetch',
          status: 'active',
          subject: 'external-apple-subject',
          refresh_token_encrypted: 'encrypted-token',
          last_validated_at: new Date(),
        }], rowCount: 1 };
      }
      if (sql.includes('.users WHERE')) {
        return { rows: [{
          id: 'existing-user-id', email: null, username: 'Existing', avatar_url: null,
          provider: 'apple', provider_id: null, status: 'active', last_login_at: null,
          created_at: new Date(),
        }], rowCount: 1 };
      }
      return { rows: [], rowCount: 1 };
    });

    const session = await refreshProjectSession('proj_123', 'old-druvia-refresh-token');

    expect(session.user.id).toBe('existing-user-id');
    expect(adapter.validateRefreshToken).not.toHaveBeenCalled();
    expect(client.query).toHaveBeenCalledWith(
      expect.stringContaining('SET revoked = true'),
      [99],
    );
    expect(client.query).toHaveBeenLastCalledWith('COMMIT');
  });

  it('does not consume a stale Druvia refresh token when Apple is temporarily unavailable', async () => {
    const columns = [
      { column_name: 'id', data_type: 'uuid', is_nullable: 'NO' },
      { column_name: 'provider_id', data_type: 'character varying', is_nullable: 'YES' },
    ];
    vi.mocked(query).mockImplementation(async (sql) => {
      if (sql.includes('information_schema.columns')) return columns as never;
      if (sql.includes('SELECT provider, identity_id')) {
        return [{ provider: 'apple', identity_id: 12 }] as never;
      }
      return [];
    });
    client.query.mockImplementation(async (sql: string) => {
      if (sql.includes('SELECT r.id AS token_id')) {
        return { rows: [{
          token_id: 99,
          user_id: 'existing-user-id',
          identity_id: 12,
          provider_audience: 'com.example.pitchetch',
          status: 'active',
          subject: 'external-apple-subject',
          refresh_token_encrypted: 'encrypted-token',
          last_validated_at: new Date(Date.now() - 25 * 60 * 60 * 1000),
        }], rowCount: 1 };
      }
      return { rows: [], rowCount: 1 };
    });
    adapter.validateRefreshToken.mockRejectedValue(
      new AppleAdapterError('upstream_unavailable', true, 503),
    );

    await expect(refreshProjectSession('proj_123', 'old-druvia-refresh-token')).rejects.toEqual(
      expect.objectContaining<ProjectAuthError>({ code: 'PROVIDER_UNAVAILABLE' }),
    );
    expect(client.query).toHaveBeenCalledWith('ROLLBACK');
    expect(client.query.mock.calls.some(([sql]) => String(sql).includes('WHERE id = $1 AND revoked = false'))).toBe(false);
  });
});
