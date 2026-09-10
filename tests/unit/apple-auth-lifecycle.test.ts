import { beforeEach, describe, expect, it, vi } from 'vitest';

const { client, poolQuery } = vi.hoisted(() => ({
  client: { query: vi.fn(), release: vi.fn() },
  poolQuery: vi.fn(),
}));

vi.mock('../../apps/api/src/db/index.js', () => ({
  pool: { connect: vi.fn().mockResolvedValue(client), query: poolQuery },
}));

vi.mock('../../apps/api/src/modules/auth-admin/auth-admin.service.js', () => ({
  getProvider: vi.fn(),
}));

vi.mock('../../apps/api/src/modules/project/project.service.js', () => ({
  getProjectById: vi.fn(),
}));

vi.mock('../../apps/api/src/modules/project-auth/project-auth.service.js', () => ({
  ProjectAuthError: class ProjectAuthError extends Error {
    constructor(public code: string, message: string, public statusCode: number) {
      super(message);
    }
  },
  getAppleAdapter: vi.fn(),
}));

vi.mock('../../apps/api/src/modules/project-auth/project-account-deletion.service.js', () => ({
  createAccountDeletionFromAppleNotification: vi.fn(),
}));

vi.mock('../../apps/api/src/lib/secret-encryption.js', () => ({
  decryptSecret: vi.fn(() => 'decrypted-provider-refresh-token'),
}));

vi.mock('../../apps/api/src/modules/project-auth/project-identity.repository.js', () => ({
  acquireProjectAuthProjectLock: vi.fn(),
  acquireProjectAuthIdentityLock: vi.fn(),
  acquireProjectAuthIdentityIdLock: vi.fn(),
  findProjectAuthIdentity: vi.fn(),
  findProjectAuthIdentityById: vi.fn(),
  findProjectAuthIdentityByProjectUser: vi.fn(),
  listProjectAuthProviderTokens: vi.fn(),
  markProjectAuthIdentityRevokePending: vi.fn(),
  markProjectAuthIdentityRevoked: vi.fn(),
  markProjectAuthIdentityDeletionPending: vi.fn(),
  updateProjectAuthEmailForwardingStatus: vi.fn(),
  deleteProjectAuthProviderTokens: vi.fn(),
  recordProjectAuthEvent: vi.fn(),
}));

import { getProvider } from '../../apps/api/src/modules/auth-admin/auth-admin.service.js';
import { getProjectById } from '../../apps/api/src/modules/project/project.service.js';
import { getAppleAdapter, ProjectAuthError } from '../../apps/api/src/modules/project-auth/project-auth.service.js';
import {
  acquireProjectAuthProjectLock,
  deleteProjectAuthProviderTokens,
  findProjectAuthIdentity,
  findProjectAuthIdentityById,
  findProjectAuthIdentityByProjectUser,
  listProjectAuthProviderTokens,
  markProjectAuthIdentityDeletionPending,
  markProjectAuthIdentityRevoked,
  markProjectAuthIdentityRevokePending,
  recordProjectAuthEvent,
} from '../../apps/api/src/modules/project-auth/project-identity.repository.js';
import {
  acknowledgeAppleLifecycleEvent,
  listPendingAppleLifecycleEvents,
  processAppleNotification,
  revokeAppleProjectUser,
} from '../../apps/api/src/modules/project-auth/apple-lifecycle.service.js';
import { createAccountDeletionFromAppleNotification } from '../../apps/api/src/modules/project-auth/project-account-deletion.service.js';

const identity = {
  id: 12,
  projectId: 'proj_123',
  projectUserId: 'user-123',
  provider: 'apple',
  issuer: 'https://appleid.apple.com',
  subject: 'external-subject',
  audience: 'com.example.pitchetch',
  status: 'active' as const,
  generation: 1,
  createdAt: new Date('2026-09-09T00:00:00.000Z'),
};

const adapter = {
  provider: 'apple' as const,
  authenticateNative: vi.fn(),
  validateRefreshToken: vi.fn(),
  revoke: vi.fn(),
};

const signedPayload = `header.${Buffer.from(JSON.stringify({
  aud: 'com.example.pitchetch',
})).toString('base64url')}.signature`;

describe('Apple auth lifecycle', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    client.query.mockResolvedValue({ rows: [], rowCount: 1 });
    poolQuery.mockResolvedValue({ rows: [], rowCount: 0 });
    vi.mocked(getProvider).mockResolvedValue({
      id: 1,
      projectId: 'proj_123',
      provider: 'apple',
      enabled: true,
      clientId: 'com.example.pitchetch',
      config: { allowedAudiences: ['com.example.pitchetch'] },
      hasCredentials: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    vi.mocked(getAppleAdapter).mockResolvedValue(adapter);
    vi.mocked(getProjectById).mockResolvedValue({
      projectId: 'proj_123',
      schemaName: 'dru_default_pitchetch',
    } as never);
    vi.mocked(findProjectAuthIdentityByProjectUser).mockResolvedValue(identity);
    vi.mocked(listProjectAuthProviderTokens).mockResolvedValue([{
      audience: 'com.example.pitchetch',
      refreshTokenEncrypted: 'encrypted-token',
      lastValidatedAt: new Date(),
    }]);
    adapter.revoke.mockResolvedValue(undefined);
    vi.mocked(recordProjectAuthEvent).mockResolvedValue(true);
    vi.mocked(findProjectAuthIdentity).mockResolvedValue(identity);
    vi.mocked(findProjectAuthIdentityById).mockResolvedValue(identity);
    vi.mocked(createAccountDeletionFromAppleNotification).mockResolvedValue(false);
  });

  it('allows revoke to load Apple credentials after the provider is disabled', async () => {
    vi.mocked(findProjectAuthIdentityByProjectUser).mockResolvedValue(identity);
    vi.mocked(listProjectAuthProviderTokens).mockResolvedValue([{
      audience: 'com.example.pitchetch',
      refreshTokenEncrypted: 'encrypted-token',
      lastValidatedAt: new Date(),
    }]);

    await revokeAppleProjectUser('proj_123', 'user-123');

    expect(getAppleAdapter).toHaveBeenCalledWith('proj_123', { requireEnabled: false });
    expect(acquireProjectAuthProjectLock).toHaveBeenCalled();
  });

  it('marks pending before remote revoke and finalizes only after every Apple token succeeds', async () => {
    await revokeAppleProjectUser('proj_123', 'user-123');

    expect(markProjectAuthIdentityRevokePending).toHaveBeenCalledWith(client, 12);
    expect(adapter.revoke).toHaveBeenCalledWith({
      audience: 'com.example.pitchetch',
      refreshToken: 'decrypted-provider-refresh-token',
    });
    expect(markProjectAuthIdentityRevoked).toHaveBeenCalledWith(client, 12);
    expect(deleteProjectAuthProviderTokens).toHaveBeenCalledWith(client, 12);
  });

  it('keeps revoke_pending and encrypted tokens when Apple is temporarily unavailable', async () => {
    adapter.revoke.mockRejectedValue(new Error('temporary failure'));

    await expect(revokeAppleProjectUser('proj_123', 'user-123')).rejects.toEqual(
      expect.objectContaining<ProjectAuthError>({ code: 'PROVIDER_UNAVAILABLE' }),
    );
    expect(markProjectAuthIdentityRevokePending).toHaveBeenCalled();
    expect(markProjectAuthIdentityRevoked).not.toHaveBeenCalled();
    expect(deleteProjectAuthProviderTokens).not.toHaveBeenCalled();
  });

  it('requires reauthorization when no Apple provider token remains', async () => {
    vi.mocked(listProjectAuthProviderTokens).mockResolvedValue([]);

    await expect(revokeAppleProjectUser('proj_123', 'user-123')).rejects.toEqual(
      expect.objectContaining<ProjectAuthError>({ code: 'PROVIDER_REAUTH_REQUIRED' }),
    );

    expect(adapter.revoke).not.toHaveBeenCalled();
  });

  it('treats a repeated revoke of an already revoked identity as complete', async () => {
    vi.mocked(findProjectAuthIdentityByProjectUser).mockResolvedValue({
      ...identity,
      status: 'revoked',
    });

    await expect(revokeAppleProjectUser('proj_123', 'user-123')).resolves.toBeUndefined();

    expect(adapter.revoke).not.toHaveBeenCalled();
    expect(client.query).toHaveBeenCalledWith('COMMIT');
  });

  it('handles consent-revoked idempotently and deletes invalid provider tokens', async () => {
    const verifier = {
      verify: vi.fn().mockResolvedValue({
        issuer: 'https://appleid.apple.com',
        audience: 'com.example.pitchetch',
        eventId: 'event-1',
        eventType: 'consent-revoked',
        subject: 'external-subject',
        occurredAt: new Date(),
      }),
    };

    const first = await processAppleNotification('proj_123', signedPayload, { verifier });
    vi.mocked(recordProjectAuthEvent).mockResolvedValue(false);
    const duplicate = await processAppleNotification('proj_123', signedPayload, { verifier });

    expect(first).toEqual({ handled: true, duplicate: false });
    expect(duplicate).toEqual({ handled: true, duplicate: true });
    expect(markProjectAuthIdentityRevoked).toHaveBeenCalledTimes(1);
    expect(deleteProjectAuthProviderTokens).toHaveBeenCalledTimes(1);
  });

  it('persists account deletion as an application action instead of deleting the business user', async () => {
    const verifier = {
      verify: vi.fn().mockResolvedValue({
        issuer: 'https://appleid.apple.com',
        audience: 'com.example.pitchetch',
        eventId: 'event-delete',
        eventType: 'account-deleted',
        subject: 'external-subject',
        occurredAt: new Date(),
      }),
    };

    await processAppleNotification('proj_123', signedPayload, { verifier });

    expect(recordProjectAuthEvent).toHaveBeenCalledWith(client, expect.objectContaining({
      status: 'application_action_pending',
      projectUserId: 'user-123',
    }));
    expect(markProjectAuthIdentityDeletionPending).toHaveBeenCalledWith(client, 12);
    expect(deleteProjectAuthProviderTokens).toHaveBeenCalledWith(client, 12);
  });

  it('acknowledges an account-deleted event only after it converges to a deletion operation', async () => {
    vi.mocked(createAccountDeletionFromAppleNotification).mockResolvedValue(true);
    const verifier = {
      verify: vi.fn().mockResolvedValue({
        issuer: 'https://appleid.apple.com',
        audience: 'com.example.pitchetch',
        eventId: 'event-delete-converged',
        eventType: 'account-deleted',
        subject: 'external-subject',
        occurredAt: new Date(),
      }),
    };

    await processAppleNotification('proj_123', signedPayload, { verifier });

    expect(client.query).toHaveBeenCalledWith(
      expect.stringContaining("SET status = 'handled'"),
      ['https://appleid.apple.com', 'event-delete-converged'],
    );
    expect(markProjectAuthIdentityDeletionPending).not.toHaveBeenCalled();
  });

  it('rolls back an account-deleted event when managed deletion cannot be persisted', async () => {
    vi.mocked(createAccountDeletionFromAppleNotification).mockRejectedValue(
      new ProjectAuthError('ACCOUNT_DELETION_NOT_CONFIGURED', 'cleanup contract invalid', 409),
    );
    const verifier = {
      verify: vi.fn().mockResolvedValue({
        issuer: 'https://appleid.apple.com',
        audience: 'com.example.pitchetch',
        eventId: 'event-delete-failed',
        eventType: 'account-deleted',
        subject: 'external-subject',
        occurredAt: new Date(),
      }),
    };

    await expect(processAppleNotification('proj_123', signedPayload, { verifier }))
      .rejects.toMatchObject({ code: 'ACCOUNT_DELETION_NOT_CONFIGURED' });

    expect(client.query).toHaveBeenCalledWith('ROLLBACK');
    expect(markProjectAuthIdentityDeletionPending).not.toHaveBeenCalled();
    expect(deleteProjectAuthProviderTokens).not.toHaveBeenCalled();
  });

  it('records a notification for an unknown subject without creating lifecycle work', async () => {
    vi.mocked(findProjectAuthIdentity).mockResolvedValue(null);
    const verifier = {
      verify: vi.fn().mockResolvedValue({
        issuer: 'https://appleid.apple.com',
        audience: 'com.example.pitchetch',
        eventId: 'event-unknown',
        eventType: 'account-deleted',
        subject: 'unknown-subject',
        occurredAt: new Date(),
      }),
    };

    await processAppleNotification('proj_123', signedPayload, { verifier });

    expect(recordProjectAuthEvent).toHaveBeenCalledWith(client, expect.objectContaining({
      identityId: undefined,
      projectUserId: undefined,
      status: 'handled',
    }));
    expect(markProjectAuthIdentityDeletionPending).not.toHaveBeenCalled();
  });

  it('ignores an account deletion notification that predates the current identity generation', async () => {
    const verifier = {
      verify: vi.fn().mockResolvedValue({
        issuer: 'https://appleid.apple.com',
        audience: 'com.example.pitchetch',
        eventId: 'event-old-generation',
        eventType: 'account-deleted',
        subject: 'external-subject',
        occurredAt: new Date('2026-09-08T23:59:59.000Z'),
      }),
    };

    await processAppleNotification('proj_123', signedPayload, { verifier });

    expect(recordProjectAuthEvent).toHaveBeenCalledWith(client, expect.objectContaining({
      status: 'handled',
    }));
    expect(markProjectAuthIdentityDeletionPending).not.toHaveBeenCalled();
    expect(deleteProjectAuthProviderTokens).not.toHaveBeenCalled();
  });

  it('keeps account deletion pending when lifecycle ack cannot create a managed operation', async () => {
    client.query.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM druvia_project_auth_events')) {
        return {
          rows: [{
            identity_id: 12,
            project_user_id: 'user-123',
            status: 'application_action_pending',
            event_type: 'account-deleted',
            issuer: 'https://appleid.apple.com',
            event_id: 'event-delete',
          }],
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: 1 };
    });
    vi.mocked(createAccountDeletionFromAppleNotification).mockResolvedValue(false);

    await expect(acknowledgeAppleLifecycleEvent('proj_123', 7))
      .rejects.toMatchObject({ code: 'ACCOUNT_DELETION_NOT_CONFIGURED' });

    expect(client.query).toHaveBeenCalledWith('ROLLBACK');
    expect(client.query.mock.calls.some(([sql]) => String(sql).includes('.users WHERE'))).toBe(false);
    expect(client.query.mock.calls.some(([sql]) => String(sql).includes("SET status = 'acknowledged'")))
      .toBe(false);
  });

  it('acknowledges account deletion only after lifecycle ack creates a managed operation', async () => {
    client.query.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM druvia_project_auth_events')) {
        return {
          rows: [{
            identity_id: 12,
            project_user_id: 'user-123',
            status: 'application_action_pending',
            event_type: 'account-deleted',
            issuer: 'https://appleid.apple.com',
            event_id: 'event-delete',
          }],
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: 1 };
    });
    vi.mocked(createAccountDeletionFromAppleNotification).mockResolvedValue(true);

    await acknowledgeAppleLifecycleEvent('proj_123', 7);

    expect(createAccountDeletionFromAppleNotification).toHaveBeenCalledWith(client, {
      projectId: 'proj_123',
      eventId: 'event-delete',
      identity,
    });
    expect(client.query.mock.calls.some(([sql]) => String(sql).includes('.users WHERE'))).toBe(false);
    expect(client.query).toHaveBeenCalledWith(
      expect.stringContaining("SET status = 'acknowledged'"),
      [7],
    );
  });

  it('paginates pending lifecycle events with an opaque cursor and a hard limit', async () => {
    poolQuery.mockResolvedValue({
      rows: [1, 2, 3].map((id) => ({
        id,
        event_type: 'account-deleted',
        occurred_at: new Date(`2026-08-28T00:00:0${id}.000Z`),
        project_user_id: `user-${id}`,
      })),
      rowCount: 3,
    });

    const page = await listPendingAppleLifecycleEvents('proj_123', { limit: 2 });

    expect(poolQuery).toHaveBeenCalledWith(expect.stringContaining('LIMIT $3'), ['proj_123', 0, 3]);
    expect(page.items.map((event) => event.id)).toEqual([1, 2]);
    expect(page.nextCursor).toBe(Buffer.from('2').toString('base64url'));
  });

  it('rejects an invalid lifecycle cursor before querying the database', async () => {
    await expect(listPendingAppleLifecycleEvents('proj_123', { cursor: 'not-valid' }))
      .rejects.toEqual(expect.objectContaining<ProjectAuthError>({ code: 'INVALID_INPUT' }));
    expect(poolQuery).not.toHaveBeenCalled();
  });
});
