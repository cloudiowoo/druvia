import { pool } from '../../db/index.js';
import {
  createRemoteAppleNotificationVerifier,
  type AppleNotificationVerifier,
} from '../../adapters/auth/apple-notification-verifier.js';
import { readUnverifiedAppleAudience } from '../../adapters/auth/apple-token-verifier.js';
import { decryptSecret } from '../../lib/secret-encryption.js';
import * as authAdminService from '../auth-admin/auth-admin.service.js';
import * as projectService from '../project/project.service.js';
import { getAppleAdapter, ProjectAuthError } from './project-auth.service.js';
import {
  acquireProjectAuthProjectLock,
  acquireProjectAuthIdentityIdLock,
  acquireProjectAuthIdentityLock,
  deleteProjectAuthProviderTokens,
  findProjectAuthIdentity,
  findProjectAuthIdentityByProjectUser,
  listProjectAuthProviderTokens,
  markProjectAuthIdentityDeletionPending,
  markProjectAuthIdentityRevoked,
  markProjectAuthIdentityRevokePending,
  recordProjectAuthEvent,
  updateProjectAuthEmailForwardingStatus,
} from './project-identity.repository.js';

export async function revokeAppleProjectUser(projectId: string, projectUserId: string): Promise<void> {
  const adapter = await getAppleAdapter(projectId, { requireEnabled: false });
  const client = await pool.connect();
  let identityId: number | undefined;
  let tokens: Awaited<ReturnType<typeof listProjectAuthProviderTokens>> = [];
  try {
    await client.query('BEGIN');
    await acquireProjectAuthProjectLock(client, projectId);
    const identity = await findProjectAuthIdentityByProjectUser(client, projectId, projectUserId);
    if (!identity) {
      throw new ProjectAuthError('PROVIDER_REAUTH_REQUIRED', 'Apple identity was not found', 409);
    }
    identityId = identity.id;
    await acquireProjectAuthIdentityIdLock(client, identity.id);
    if (identity.status === 'revoked') {
      await client.query('COMMIT');
      return;
    }
    tokens = await listProjectAuthProviderTokens(client, identity.id);
    await markProjectAuthIdentityRevokePending(client, identity.id);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }

  if (!identityId || tokens.length === 0) {
    throw new ProjectAuthError(
      'PROVIDER_REAUTH_REQUIRED',
      'Apple authorization must be renewed before it can be revoked',
      409,
    );
  }

  try {
    for (const token of tokens) {
      await adapter.revoke({
        audience: token.audience,
        refreshToken: decryptSecret(token.refreshTokenEncrypted, { requireDedicatedKey: true }),
      });
    }
  } catch {
    throw new ProjectAuthError('PROVIDER_UNAVAILABLE', 'Apple revoke is temporarily unavailable', 503);
  }

  const finalizeClient = await pool.connect();
  try {
    await finalizeClient.query('BEGIN');
    await acquireProjectAuthProjectLock(finalizeClient, projectId);
    await acquireProjectAuthIdentityIdLock(finalizeClient, identityId);
    await markProjectAuthIdentityRevoked(finalizeClient, identityId);
    await deleteProjectAuthProviderTokens(finalizeClient, identityId);
    await finalizeClient.query('COMMIT');
  } catch (error) {
    await finalizeClient.query('ROLLBACK');
    throw error;
  } finally {
    finalizeClient.release();
  }
}

export async function processAppleNotification(
  projectId: string,
  signedPayload: string,
  dependencies: { verifier?: AppleNotificationVerifier } = {},
): Promise<{ handled: true; duplicate: boolean }> {
  const provider = await authAdminService.getProvider(projectId, 'apple');
  const allowedAudiences = Array.isArray(provider?.config.allowedAudiences)
    ? provider.config.allowedAudiences.filter((value): value is string => typeof value === 'string')
    : [];
  const audience = readUnverifiedAppleAudience(signedPayload);
  if (!provider || !audience || !allowedAudiences.includes(audience)) {
    throw new ProjectAuthError('PROVIDER_NOTIFICATION_INVALID', 'Invalid Apple notification', 401);
  }

  const verifier = dependencies.verifier ?? createRemoteAppleNotificationVerifier();
  let notification;
  try {
    notification = await verifier.verify(signedPayload, { audience });
  } catch {
    throw new ProjectAuthError('PROVIDER_NOTIFICATION_INVALID', 'Invalid Apple notification', 401);
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await acquireProjectAuthProjectLock(client, projectId);
    const identityKey = {
      projectId,
      provider: 'apple',
      issuer: notification.issuer,
      subject: notification.subject,
    };
    await acquireProjectAuthIdentityLock(client, identityKey);
    const identity = await findProjectAuthIdentity(client, identityKey);
    const eventStatus = notification.eventType === 'account-deleted' && identity
      ? 'application_action_pending'
      : 'handled';
    const inserted = await recordProjectAuthEvent(client, {
      projectId,
      identityId: identity?.id,
      projectUserId: identity?.projectUserId,
      provider: 'apple',
      issuer: notification.issuer,
      eventId: notification.eventId,
      eventType: notification.eventType,
      status: eventStatus,
      occurredAt: notification.occurredAt,
    });
    if (!inserted) {
      await client.query('COMMIT');
      return { handled: true, duplicate: true };
    }

    if (identity) {
      switch (notification.eventType) {
        case 'consent-revoked':
          await markProjectAuthIdentityRevoked(client, identity.id);
          await deleteProjectAuthProviderTokens(client, identity.id);
          break;
        case 'account-deleted':
          await markProjectAuthIdentityDeletionPending(client, identity.id);
          await deleteProjectAuthProviderTokens(client, identity.id);
          break;
        case 'email-enabled':
          await updateProjectAuthEmailForwardingStatus(client, identity.id, 'enabled');
          break;
        case 'email-disabled':
          await updateProjectAuthEmailForwardingStatus(client, identity.id, 'disabled');
          break;
      }
    }
    await client.query('COMMIT');
    return { handled: true, duplicate: false };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export interface AppleLifecycleEventPage {
  items: Array<{
    id: number;
    type: string;
    occurredAt: Date;
    projectUserId: string | null;
  }>;
  nextCursor: string | null;
}

function decodeLifecycleCursor(cursor: string | undefined): number {
  if (!cursor) return 0;
  try {
    const value = Buffer.from(cursor, 'base64url').toString('utf8');
    if (!/^[1-9][0-9]*$/.test(value)) throw new Error('invalid cursor');
    const id = Number(value);
    if (!Number.isSafeInteger(id)) throw new Error('invalid cursor');
    return id;
  } catch {
    throw new ProjectAuthError('INVALID_INPUT', 'Invalid lifecycle cursor', 400);
  }
}

function encodeLifecycleCursor(id: number): string {
  return Buffer.from(String(id), 'utf8').toString('base64url');
}

export async function listPendingAppleLifecycleEvents(
  projectId: string,
  options: { limit?: number; cursor?: string } = {},
): Promise<AppleLifecycleEventPage> {
  const limit = Math.min(Math.max(options.limit ?? 100, 1), 100);
  const afterId = decodeLifecycleCursor(options.cursor);
  const result = await pool.query<{
    id: string | number;
    event_type: string;
    occurred_at: Date;
    project_user_id: string | null;
  }>(
    `SELECT id, event_type, occurred_at, project_user_id
     FROM druvia_project_auth_events
     WHERE project_id = $1 AND provider = 'apple'
       AND status = 'application_action_pending'
       AND id > $2
     ORDER BY id
     LIMIT $3`,
    [projectId, afterId, limit + 1],
  );
  const hasMore = result.rows.length > limit;
  const items = result.rows.slice(0, limit).map((row) => ({
    id: Number(row.id),
    type: row.event_type,
    occurredAt: row.occurred_at,
    projectUserId: row.project_user_id,
  }));
  return {
    items,
    nextCursor: hasMore && items.length
      ? encodeLifecycleCursor(items[items.length - 1].id)
      : null,
  };
}

export async function acknowledgeAppleLifecycleEvent(
  projectId: string,
  eventId: number,
): Promise<void> {
  const project = await projectService.getProjectById(projectId);
  if (!project?.schemaName || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(project.schemaName)) {
    throw new ProjectAuthError('PROJECT_NOT_FOUND', 'Project not found', 404);
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await acquireProjectAuthProjectLock(client, projectId);
    const eventResult = await client.query<{
      identity_id: string | number | null;
      project_user_id: string | null;
      status: string;
    }>(
      `SELECT identity_id, project_user_id, status
       FROM druvia_project_auth_events
       WHERE id = $1 AND project_id = $2 AND provider = 'apple'
       FOR UPDATE`,
      [eventId, projectId],
    );
    const event = eventResult.rows[0];
    if (!event) throw new ProjectAuthError('NOT_FOUND', 'Lifecycle event not found', 404);
    if (event.status === 'acknowledged') {
      await client.query('COMMIT');
      return;
    }
    if (event.status !== 'application_action_pending' || !event.identity_id || !event.project_user_id) {
      throw new ProjectAuthError('LIFECYCLE_EVENT_INVALID', 'Lifecycle event cannot be acknowledged', 409);
    }
    const identityId = Number(event.identity_id);
    await acquireProjectAuthIdentityIdLock(client, identityId);
    await client.query(
      'DELETE FROM druvia_project_refresh_tokens WHERE identity_id = $1',
      [identityId],
    );
    await deleteProjectAuthProviderTokens(client, identityId);
    await client.query(
      `DELETE FROM ${project.schemaName}.users WHERE id = $1`,
      [event.project_user_id],
    );
    await client.query(
      'DELETE FROM druvia_project_auth_identities WHERE id = $1',
      [identityId],
    );
    await client.query(
      `UPDATE druvia_project_auth_events
       SET status = 'acknowledged', acknowledged_at = NOW(),
           identity_id = NULL, project_user_id = NULL
       WHERE id = $1`,
      [eventId],
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
