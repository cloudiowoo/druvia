import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import { query, queryOne } from '../../db/index.js';

export type ProjectAuthIdentityStatus =
  | 'active'
  | 'revoke_pending'
  | 'revoked'
  | 'deletion_pending';

export interface ProjectAuthIdentity {
  id: number;
  projectId: string;
  projectUserId: string;
  provider: string;
  issuer: string;
  subject: string;
  audience: string | null;
  status: ProjectAuthIdentityStatus;
}

export interface ProjectAuthIdentitySummary {
  id: number;
  projectUserId: string;
  provider: string;
  audience: string | null;
  status: ProjectAuthIdentityStatus;
  subjectSummary: string;
  updatedAt: Date;
  lastAuthenticatedAt: Date;
}

interface ProjectAuthIdentityRow {
  id: string | number;
  project_id: string;
  project_user_id: string;
  provider: string;
  issuer: string;
  subject: string;
  audience: string | null;
  status: ProjectAuthIdentityStatus;
}

function toIdentity(row: ProjectAuthIdentityRow): ProjectAuthIdentity {
  return {
    id: Number(row.id),
    projectId: row.project_id,
    projectUserId: row.project_user_id,
    provider: row.provider,
    issuer: row.issuer,
    subject: row.subject,
    audience: row.audience,
    status: row.status,
  };
}

export function summarizeProjectAuthSubject(subject: string): string {
  return `sha256:${createHash('sha256').update(subject).digest('hex').slice(0, 12)}`;
}

export async function listProjectAuthIdentities(
  projectId: string,
): Promise<ProjectAuthIdentitySummary[]> {
  const rows = await query<{
    id: string | number;
    project_user_id: string;
    provider: string;
    subject: string;
    audience: string | null;
    status: ProjectAuthIdentityStatus;
    updated_at: Date;
    last_authenticated_at: Date;
  }>(
    `SELECT id, project_user_id, provider, subject, audience, status,
            updated_at, last_authenticated_at
     FROM druvia_project_auth_identities
     WHERE project_id = $1
     ORDER BY updated_at DESC, id DESC`,
    [projectId],
  );
  return rows.map((row) => ({
    id: Number(row.id),
    projectUserId: row.project_user_id,
    provider: row.provider,
    audience: row.audience,
    status: row.status,
    subjectSummary: summarizeProjectAuthSubject(row.subject),
    updatedAt: row.updated_at,
    lastAuthenticatedAt: row.last_authenticated_at,
  }));
}

export class ProjectAuthLifecycleError extends Error {
  constructor(
    readonly code: 'PROVIDER_DECOMMISSION_REQUIRED' | 'PROVIDER_REVOKE_REQUIRED',
    message: string
  ) {
    super(message);
    this.name = 'ProjectAuthLifecycleError';
  }
}

const projectAuthProjectLockKey = (projectId: string) =>
  `project-auth-project:${projectId}`;

export async function acquireProjectAuthProjectLock(
  client: PoolClient,
  projectId: string,
): Promise<void> {
  await client.query(
    'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
    [projectAuthProjectLockKey(projectId)],
  );
}

export async function withProjectAuthProjectLock<T>(
  client: PoolClient,
  projectId: string,
  callback: () => Promise<T>,
): Promise<T> {
  const key = projectAuthProjectLockKey(projectId);
  await client.query('SELECT pg_advisory_lock(hashtextextended($1, 0))', [key]);
  try {
    return await callback();
  } finally {
    await client.query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [key]);
  }
}

export async function acquireProjectAuthIdentityLock(
  client: PoolClient,
  input: { projectId: string; provider: string; issuer: string; subject: string },
): Promise<void> {
  const identityKey = [
    'project-auth',
    input.projectId,
    input.provider,
    input.issuer,
    input.subject,
  ].join(':');
  await client.query(
    'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
    [identityKey],
  );
}

export async function acquireProjectAuthIdentityIdLock(
  client: PoolClient,
  identityId: number,
): Promise<void> {
  await client.query(
    'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
    [`project-auth-identity:${identityId}`],
  );
}

export async function findProjectAuthIdentity(
  client: PoolClient,
  input: { projectId: string; provider: string; issuer: string; subject: string },
): Promise<ProjectAuthIdentity | null> {
  const result = await client.query<ProjectAuthIdentityRow>(
    `SELECT id, project_id, project_user_id, provider, issuer, subject, audience, status
     FROM druvia_project_auth_identities
     WHERE project_id = $1 AND provider = $2 AND issuer = $3 AND subject = $4`,
    [input.projectId, input.provider, input.issuer, input.subject],
  );
  return result.rows[0] ? toIdentity(result.rows[0]) : null;
}

export async function findProjectAuthIdentityById(
  client: PoolClient,
  identityId: number,
): Promise<ProjectAuthIdentity | null> {
  const result = await client.query<ProjectAuthIdentityRow>(
    `SELECT id, project_id, project_user_id, provider, issuer, subject, audience, status
     FROM druvia_project_auth_identities
     WHERE id = $1`,
    [identityId],
  );
  return result.rows[0] ? toIdentity(result.rows[0]) : null;
}

export async function findProjectAuthIdentityByProjectUser(
  client: PoolClient,
  projectId: string,
  projectUserId: string,
): Promise<ProjectAuthIdentity | null> {
  const result = await client.query<ProjectAuthIdentityRow>(
    `SELECT id, project_id, project_user_id, provider, issuer, subject, audience, status
     FROM druvia_project_auth_identities
     WHERE project_id = $1 AND project_user_id = $2 AND provider = 'apple'
     ORDER BY id LIMIT 1`,
    [projectId, projectUserId],
  );
  return result.rows[0] ? toIdentity(result.rows[0]) : null;
}

export async function listProjectAuthProviderTokens(
  client: PoolClient,
  identityId: number,
): Promise<Array<{
  audience: string;
  refreshTokenEncrypted: string;
  lastValidatedAt: Date | null;
}>> {
  const result = await client.query<{
    audience: string;
    refresh_token_encrypted: string;
    last_validated_at: Date | null;
  }>(
    `SELECT audience, refresh_token_encrypted, last_validated_at
     FROM druvia_project_auth_provider_tokens
     WHERE identity_id = $1 ORDER BY audience`,
    [identityId],
  );
  return result.rows.map((row) => ({
    audience: row.audience,
    refreshTokenEncrypted: row.refresh_token_encrypted,
    lastValidatedAt: row.last_validated_at,
  }));
}

export async function deleteProjectAuthProviderTokens(
  client: PoolClient,
  identityId: number,
): Promise<void> {
  await client.query(
    'DELETE FROM druvia_project_auth_provider_tokens WHERE identity_id = $1',
    [identityId],
  );
}

export async function createProjectAuthIdentity(
  client: PoolClient,
  input: {
    projectId: string;
    projectUserId: string;
    provider: string;
    issuer: string;
    subject: string;
    audience: string;
  },
): Promise<ProjectAuthIdentity> {
  const result = await client.query<ProjectAuthIdentityRow>(
    `INSERT INTO druvia_project_auth_identities
       (project_id, project_user_id, provider, issuer, subject, audience)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id, project_id, project_user_id, provider, issuer, subject, audience, status`,
    [
      input.projectId,
      input.projectUserId,
      input.provider,
      input.issuer,
      input.subject,
      input.audience,
    ],
  );
  const row = result.rows[0];
  if (!row) throw new Error('Failed to create project auth identity');
  return toIdentity(row);
}

export async function reactivateProjectAuthIdentity(
  client: PoolClient,
  identityId: number,
  audience: string,
): Promise<ProjectAuthIdentity | null> {
  const result = await client.query<ProjectAuthIdentityRow>(
    `UPDATE druvia_project_auth_identities
     SET status = 'active', audience = $2, revoked_at = NULL,
         updated_at = NOW(), last_authenticated_at = NOW()
     WHERE id = $1 AND status IN ('active', 'revoked')
     RETURNING id, project_id, project_user_id, provider, issuer, subject, audience, status`,
    [identityId, audience],
  );
  return result.rows[0] ? toIdentity(result.rows[0]) : null;
}

export async function upsertProjectAuthProviderToken(
  client: PoolClient,
  input: { identityId: number; audience: string; refreshTokenEncrypted: string },
): Promise<void> {
  await client.query(
    `INSERT INTO druvia_project_auth_provider_tokens
       (identity_id, audience, refresh_token_encrypted, last_validated_at)
     VALUES ($1, $2, $3, NOW())
     ON CONFLICT (identity_id, audience) DO UPDATE
     SET refresh_token_encrypted = EXCLUDED.refresh_token_encrypted,
         last_validated_at = NOW(), updated_at = NOW()`,
    [input.identityId, input.audience, input.refreshTokenEncrypted],
  );
}

export async function markProjectAuthIdentityRevokePending(
  client: PoolClient,
  identityId: number,
): Promise<void> {
  await client.query(
    `UPDATE druvia_project_auth_identities
     SET status = 'revoke_pending', updated_at = NOW()
     WHERE id = $1 AND status <> 'revoked'`,
    [identityId],
  );
  await client.query(
    `UPDATE druvia_project_refresh_tokens
     SET revoked = true
     WHERE identity_id = $1 AND revoked = false`,
    [identityId],
  );
}

export async function markProjectAuthIdentityRevoked(
  client: PoolClient,
  identityId: number,
): Promise<void> {
  await client.query(
    `UPDATE druvia_project_auth_identities
     SET status = 'revoked', revoked_at = NOW(), updated_at = NOW()
     WHERE id = $1`,
    [identityId],
  );
  await client.query(
    `UPDATE druvia_project_refresh_tokens
     SET revoked = true
     WHERE identity_id = $1 AND revoked = false`,
    [identityId],
  );
}

export async function markProjectAuthIdentityDeletionPending(
  client: PoolClient,
  identityId: number,
): Promise<void> {
  await client.query(
    `UPDATE druvia_project_auth_identities
     SET status = 'deletion_pending', updated_at = NOW()
     WHERE id = $1`,
    [identityId],
  );
  await client.query(
    `UPDATE druvia_project_refresh_tokens
     SET revoked = true
     WHERE identity_id = $1 AND revoked = false`,
    [identityId],
  );
}

export async function updateProjectAuthEmailForwardingStatus(
  client: PoolClient,
  identityId: number,
  status: 'enabled' | 'disabled',
): Promise<void> {
  await client.query(
    `UPDATE druvia_project_auth_identities
     SET email_forwarding_status = $2, updated_at = NOW()
     WHERE id = $1`,
    [identityId, status],
  );
}

export async function recordProjectAuthEvent(
  client: PoolClient,
  input: {
    projectId: string;
    identityId?: number;
    projectUserId?: string;
    provider: string;
    issuer: string;
    eventId: string;
    eventType: string;
    status: 'handled' | 'application_action_pending' | 'acknowledged';
    occurredAt: Date;
  },
): Promise<boolean> {
  const result = await client.query(
    `INSERT INTO druvia_project_auth_events
       (project_id, identity_id, project_user_id, provider, issuer, event_id,
        event_type, status, occurred_at, acknowledged_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9,
       CASE WHEN $8 = 'acknowledged' THEN NOW() ELSE NULL END)
     ON CONFLICT (provider, issuer, event_id) DO NOTHING`,
    [
      input.projectId,
      input.identityId ?? null,
      input.projectUserId ?? null,
      input.provider,
      input.issuer,
      input.eventId,
      input.eventType,
      input.status,
      input.occurredAt,
    ],
  );
  return result.rowCount === 1;
}

export async function assertProjectAuthUserDeletionAllowed(
  client: PoolClient,
  projectId: string,
  projectUserId: string,
): Promise<void> {
  const result = await client.query<{ blocked: boolean }>(
    `SELECT (
       EXISTS (
         SELECT 1 FROM druvia_project_auth_identities i
         WHERE i.project_id = $1 AND i.project_user_id = $2
           AND i.status IN ('active', 'revoke_pending', 'deletion_pending')
       )
       OR EXISTS (
         SELECT 1 FROM druvia_project_auth_provider_tokens t
         JOIN druvia_project_auth_identities i ON i.id = t.identity_id
         WHERE i.project_id = $1 AND i.project_user_id = $2
       )
       OR EXISTS (
         SELECT 1 FROM druvia_project_auth_events e
         WHERE e.project_id = $1 AND e.project_user_id = $2
           AND e.status = 'application_action_pending'
       )
     ) AS blocked`,
    [projectId, projectUserId],
  );
  if (result.rows[0]?.blocked) {
    throw new ProjectAuthLifecycleError(
      'PROVIDER_REVOKE_REQUIRED',
      'Apple provider authorization must be revoked before deleting this project user',
    );
  }
}

export async function cleanupTerminalProjectAuthUserState(
  client: PoolClient,
  projectId: string,
  projectUserId: string,
): Promise<void> {
  await client.query(
    `UPDATE druvia_project_refresh_tokens
     SET revoked = true
     WHERE project_id = $1 AND user_id = $2 AND revoked = false`,
    [projectId, projectUserId],
  );
  await client.query(
    `DELETE FROM druvia_project_auth_identities
     WHERE project_id = $1 AND project_user_id = $2 AND status = 'revoked'`,
    [projectId, projectUserId],
  );
}

export async function assertProjectAuthProjectDeletionAllowed(projectId: string): Promise<void> {
  const blocked = await queryOne<{ blocked: boolean }>(
    `SELECT (
       EXISTS (
         SELECT 1
         FROM druvia_project_auth_identities i
         WHERE i.project_id = $1
           AND i.status IN ('active', 'revoke_pending', 'deletion_pending')
       )
       OR EXISTS (
         SELECT 1
         FROM druvia_project_auth_provider_tokens t
         JOIN druvia_project_auth_identities i ON i.id = t.identity_id
         WHERE i.project_id = $1
       )
       OR EXISTS (
         SELECT 1
         FROM druvia_project_auth_events e
         WHERE e.project_id = $1
           AND e.status = 'application_action_pending'
       )
     ) AS blocked`,
    [projectId]
  );

  if (blocked?.blocked) {
    throw new ProjectAuthLifecycleError(
      'PROVIDER_DECOMMISSION_REQUIRED',
      'Apple provider identities must be decommissioned before deleting this project'
    );
  }
}

export async function assertAppleProviderDeletionAllowed(projectId: string): Promise<void> {
  const blocked = await queryOne<{ blocked: boolean }>(
    `SELECT (
       EXISTS (
         SELECT 1 FROM druvia_project_auth_identities
         WHERE project_id = $1
           AND status IN ('active', 'revoke_pending', 'deletion_pending')
       )
       OR EXISTS (
         SELECT 1 FROM druvia_project_auth_provider_tokens t
         JOIN druvia_project_auth_identities i ON i.id = t.identity_id
         WHERE i.project_id = $1
       )
       OR EXISTS (
         SELECT 1 FROM druvia_project_auth_events
         WHERE project_id = $1 AND status = 'application_action_pending'
       )
     ) AS blocked`,
    [projectId],
  );
  if (blocked?.blocked) {
    throw new ProjectAuthLifecycleError(
      'PROVIDER_DECOMMISSION_REQUIRED',
      'Apple identities must be decommissioned before removing this provider',
    );
  }
}
