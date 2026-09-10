import type { PoolClient } from 'pg';
import type { ProjectAccountDeletionOperation } from './project-account-deletion.types.js';

interface OperationRow {
  deletion_id: string;
  project_id: string;
  project_schema: string;
  project_user_id: string;
  provider: 'apple';
  issuer: string;
  identity_id: string | number | null;
  generation: number;
  idempotency_key: string;
  reauth_nonce_hash: string | null;
  intent_expires_at: Date | null;
  confirmation_lease_token: string | null;
  confirmation_lease_until: Date | null;
  cleanup_function: string;
  cleanup_contract_hash: string;
  status: ProjectAccountDeletionOperation['status'];
  phase: ProjectAccountDeletionOperation['phase'];
  accepted_at: Date | null;
  data_deletion_deadline_at: Date | null;
  provider_revocation_status: ProjectAccountDeletionOperation['providerRevocationStatus'];
  completed_at: Date | null;
}

const operationColumns = `
  deletion_id, project_id, project_schema, project_user_id, provider, issuer,
  identity_id, generation, idempotency_key, reauth_nonce_hash, intent_expires_at,
  confirmation_lease_token, confirmation_lease_until, cleanup_function,
  cleanup_contract_hash, status, phase, accepted_at, data_deletion_deadline_at,
  provider_revocation_status, completed_at`;

function toOperation(row: OperationRow): ProjectAccountDeletionOperation {
  return {
    deletionId: row.deletion_id,
    projectId: row.project_id,
    projectSchema: row.project_schema,
    projectUserId: row.project_user_id,
    provider: row.provider,
    issuer: row.issuer,
    identityId: row.identity_id === null ? null : Number(row.identity_id),
    generation: row.generation,
    idempotencyKey: row.idempotency_key,
    reauthNonceHash: row.reauth_nonce_hash,
    intentExpiresAt: row.intent_expires_at,
    confirmationLeaseToken: row.confirmation_lease_token,
    confirmationLeaseUntil: row.confirmation_lease_until,
    cleanupFunction: row.cleanup_function,
    cleanupContractHash: row.cleanup_contract_hash,
    status: row.status,
    phase: row.phase,
    acceptedAt: row.accepted_at,
    dataDeletionDeadlineAt: row.data_deletion_deadline_at,
    providerRevocationStatus: row.provider_revocation_status,
    completedAt: row.completed_at,
  };
}

export async function findAccountDeletion(
  client: PoolClient,
  projectId: string,
  deletionId: string,
  options: { forUpdate?: boolean } = {},
): Promise<ProjectAccountDeletionOperation | null> {
  const result = await client.query<OperationRow>(
    `SELECT ${operationColumns}
     FROM druvia_project_account_deletions
     WHERE project_id = $1 AND deletion_id = $2
     ${options.forUpdate ? 'FOR UPDATE' : ''}`,
    [projectId, deletionId],
  );
  return result.rows[0] ? toOperation(result.rows[0]) : null;
}

export async function findActiveAccountDeletionForUser(
  client: PoolClient,
  projectId: string,
  projectUserId: string,
): Promise<ProjectAccountDeletionOperation | null> {
  const result = await client.query<OperationRow>(
    `SELECT ${operationColumns}
     FROM druvia_project_account_deletions
     WHERE project_id = $1 AND project_user_id = $2
       AND status NOT IN ('expired', 'completed')
     ORDER BY created_at DESC LIMIT 1
     FOR UPDATE`,
    [projectId, projectUserId],
  );
  return result.rows[0] ? toOperation(result.rows[0]) : null;
}

export async function insertAccountDeletionIntent(client: PoolClient, input: {
  deletionId: string;
  projectId: string;
  projectSchema: string;
  projectUserId: string;
  identityId: number;
  issuer: string;
  generation: number;
  idempotencyKey: string;
  reauthNonceHash: string;
  intentExpiresAt: Date;
  cleanupFunction: string;
  cleanupContractHash: string;
}): Promise<ProjectAccountDeletionOperation> {
  const result = await client.query<OperationRow>(
    `INSERT INTO druvia_project_account_deletions (
       deletion_id, project_id, project_schema, project_user_id, provider, issuer,
       identity_id, generation, idempotency_key, reauth_nonce_hash, intent_expires_at,
       cleanup_function, cleanup_contract_hash, status, phase
     ) VALUES ($1, $2, $3, $4, 'apple', $5, $6, $7, $8, $9, $10, $11, $12,
       'pending_confirmation', 'awaiting_confirmation')
     RETURNING ${operationColumns}`,
    [
      input.deletionId, input.projectId, input.projectSchema, input.projectUserId,
      input.issuer, input.identityId, input.generation, input.idempotencyKey,
      input.reauthNonceHash, input.intentExpiresAt, input.cleanupFunction,
      input.cleanupContractHash,
    ],
  );
  if (!result.rows[0]) throw new Error('Failed to create account deletion intent');
  return toOperation(result.rows[0]);
}

export async function claimAccountDeletionConfirmation(
  client: PoolClient,
  input: { projectId: string; deletionId: string; leaseToken: string; leaseSeconds: number },
): Promise<ProjectAccountDeletionOperation | null> {
  const result = await client.query<OperationRow>(
    `UPDATE druvia_project_account_deletions
     SET phase = 'confirmation_in_progress', confirmation_lease_token = $3,
         confirmation_lease_until = NOW() + ($4 * INTERVAL '1 second')
     WHERE project_id = $1 AND deletion_id = $2
       AND status = 'pending_confirmation'
       AND intent_expires_at > NOW()
       AND (confirmation_lease_until IS NULL OR confirmation_lease_until < NOW())
     RETURNING ${operationColumns}`,
    [input.projectId, input.deletionId, input.leaseToken, input.leaseSeconds],
  );
  return result.rows[0] ? toOperation(result.rows[0]) : null;
}
