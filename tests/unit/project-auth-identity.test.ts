import { describe, expect, it, vi } from 'vitest';
import type { PoolClient } from 'pg';
import {
  ProjectAuthLifecycleError,
  acquireProjectAuthIdentityLock,
  assertProjectAuthUserDeletionAllowed,
  createProjectAuthIdentity,
  markProjectAuthIdentityRevoked,
  summarizeProjectAuthSubject,
  upsertProjectAuthProviderToken,
} from '../../apps/api/src/modules/project-auth/project-identity.repository.js';

function clientWithRows(rows: unknown[] = []): PoolClient {
  return {
    query: vi.fn().mockResolvedValue({ rows, rowCount: rows.length }),
  } as unknown as PoolClient;
}

describe('project auth identity repository', () => {
  it('exposes only a stable irreversible subject summary to administrators', () => {
    const summary = summarizeProjectAuthSubject('external-subject');

    expect(summary).toMatch(/^sha256:[a-f0-9]{12}$/);
    expect(summary).not.toContain('external-subject');
  });
  it('uses a transaction-scoped advisory lock for the stable provider identity key', async () => {
    const client = clientWithRows();

    await acquireProjectAuthIdentityLock(client, {
      projectId: 'project-1',
      provider: 'apple',
      issuer: 'https://appleid.apple.com',
      subject: 'external-subject',
    });

    expect(client.query).toHaveBeenCalledWith(
      expect.stringContaining('pg_advisory_xact_lock'),
      ['project-auth:project-1:apple:https://appleid.apple.com:external-subject'],
    );
  });

  it('creates an active identity without writing the subject into the project user row', async () => {
    const client = clientWithRows([{
      id: '12',
      project_id: 'project-1',
      project_user_id: 'user-1',
      provider: 'apple',
      issuer: 'https://appleid.apple.com',
      subject: 'external-subject',
      audience: 'com.example.app',
      status: 'active',
      generation: 1,
    }]);

    const identity = await createProjectAuthIdentity(client, {
      projectId: 'project-1',
      projectUserId: 'user-1',
      provider: 'apple',
      issuer: 'https://appleid.apple.com',
      subject: 'external-subject',
      audience: 'com.example.app',
    });

    expect(identity.id).toBe(12);
    expect(client.query).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO druvia_project_auth_identities'),
      ['project-1', 'user-1', 'apple', 'https://appleid.apple.com', 'external-subject', 'com.example.app', 1],
    );
  });

  it('atomically replaces the encrypted provider token for one identity and audience', async () => {
    const client = clientWithRows();

    await upsertProjectAuthProviderToken(client, {
      identityId: 12,
      audience: 'com.example.app',
      refreshTokenEncrypted: 'encrypted-value',
    });

    expect(client.query).toHaveBeenCalledWith(
      expect.stringMatching(/ON CONFLICT \(identity_id, audience\)[\s\S]*refresh_token_encrypted = EXCLUDED\.refresh_token_encrypted/),
      [12, 'com.example.app', 'encrypted-value'],
    );
  });

  it('revokes the identity and every Druvia refresh token on the same client', async () => {
    const client = clientWithRows();

    await markProjectAuthIdentityRevoked(client, 12);

    expect(client.query).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining("status = 'revoked'"),
      [12],
    );
    expect(client.query).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining('UPDATE druvia_project_refresh_tokens'),
      [12],
    );
  });

  it('blocks user deletion while Apple revoke or application lifecycle work remains', async () => {
    const client = clientWithRows([{ blocked: true }]);

    await expect(assertProjectAuthUserDeletionAllowed(client, 'project-1', 'user-1'))
      .rejects.toEqual(expect.objectContaining<ProjectAuthLifecycleError>({
        code: 'PROVIDER_REVOKE_REQUIRED',
      }));
  });
});
