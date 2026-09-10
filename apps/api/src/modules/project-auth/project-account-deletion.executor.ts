import crypto from 'node:crypto';
import type { PoolClient } from 'pg';
import { config } from '../../config/index.js';
import { pool } from '../../db/index.js';
import { decryptSecret } from '../../lib/secret-encryption.js';
import { createApiLogger } from '../../lib/logger.js';
import * as storageService from '../storage/storage.service.js';
import { getAppleAdapter } from './project-auth.service.js';
import {
  acquireProjectAuthIdentityIdLock,
  withProjectAuthProjectLock,
} from './project-identity.repository.js';
import { executeAccountDeletionCleanupContract } from './project-account-deletion.service.js';

const logger = createApiLogger({ module: 'project-account-deletion-executor' });

interface ClaimedDeletion {
  deletion_id: string;
  project_id: string;
  project_schema: string;
  project_user_id: string;
  identity_id: string | number | null;
  cleanup_function: string;
  cleanup_contract_hash: string;
  phase: 'business_cleanup' | 'storage_cleanup' | 'project_user_cleanup' | 'provider_revoke';
  lease_token: string;
  data_deletion_deadline_at: Date;
  attempt_count: number;
}

interface ClaimedProviderToken {
  id: string | number;
  deletion_id: string;
  project_id: string;
  audience: string;
  refresh_token_encrypted: string;
  lease_token: string;
  attempt_count: number;
}

interface DeletionCandidate {
  deletion_id: string;
  project_id: string;
}

interface ProviderTokenCandidate {
  id: string | number;
  project_id: string;
}

let lastHeartbeatAt = 0;

function quoteIdentifier(value: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) throw new Error('INVALID_CLEANUP_IDENTIFIER');
  return `"${value.replace(/"/g, '""')}"`;
}

function retryDelaySeconds(attemptCount: number): number {
  return Math.min(3_600, 5 * (2 ** Math.min(attemptCount, 9)));
}

async function withLeaseRenewal<T>(input: {
  renew: () => Promise<boolean>;
  run: () => Promise<T>;
}): Promise<T> {
  let leaseLost = false;
  let renewal: Promise<void> | null = null;
  const intervalMs = Math.max(1_000, Math.floor(config.accountDeletion.executorLeaseSeconds * 1_000 / 3));
  const timer = setInterval(() => {
    if (renewal || leaseLost) return;
    renewal = input.renew()
      .then((renewed) => { leaseLost = !renewed; })
      .catch(() => { leaseLost = true; })
      .finally(() => { renewal = null; });
  }, intervalMs);
  timer.unref();
  try {
    const result = await input.run();
    if (renewal) await renewal;
    if (leaseLost) throw new Error('ACCOUNT_DELETION_LEASE_LOST');
    return result;
  } finally {
    clearInterval(timer);
  }
}

async function findDeletionCandidate(client: PoolClient): Promise<DeletionCandidate | null> {
  const result = await client.query<DeletionCandidate>(
    `SELECT operation.deletion_id, operation.project_id
     FROM druvia_project_account_deletions operation
     WHERE operation.status IN ('accepted', 'processing')
       AND operation.phase IN ('business_cleanup', 'storage_cleanup', 'project_user_cleanup', 'provider_revoke')
       AND COALESCE(operation.next_attempt_at, NOW()) <= NOW()
       AND (operation.lease_until IS NULL OR operation.lease_until < NOW())
       AND NOT EXISTS (
         SELECT 1 FROM druvia_project_runtime_gates gate
         WHERE gate.project_id = operation.project_id
       )
     ORDER BY operation.data_deletion_deadline_at, operation.created_at
     LIMIT 1`,
  );
  return result.rows[0] ?? null;
}

async function claimDeletion(client: PoolClient, deletionId: string): Promise<ClaimedDeletion | null> {
  const leaseToken = crypto.randomUUID();
  const result = await client.query<ClaimedDeletion>(
    `UPDATE druvia_project_account_deletions operation
     SET status = 'processing', lease_token = $1,
         lease_until = NOW() + ($2 * INTERVAL '1 second'), attempt_count = attempt_count + 1
     WHERE operation.deletion_id = $3
       AND operation.status IN ('accepted', 'processing')
       AND operation.phase IN ('business_cleanup', 'storage_cleanup', 'project_user_cleanup', 'provider_revoke')
       AND COALESCE(operation.next_attempt_at, NOW()) <= NOW()
       AND (operation.lease_until IS NULL OR operation.lease_until < NOW())
       AND NOT EXISTS (
         SELECT 1 FROM druvia_project_runtime_gates gate
         WHERE gate.project_id = operation.project_id
       )
     RETURNING deletion_id, project_id, project_schema, project_user_id, identity_id,
       cleanup_function, cleanup_contract_hash, phase, lease_token,
       data_deletion_deadline_at, attempt_count`,
    [leaseToken, config.accountDeletion.executorLeaseSeconds, deletionId],
  );
  return result.rows[0] ?? null;
}

async function advanceDeletion(
  operation: ClaimedDeletion,
  phase: ClaimedDeletion['phase'] | 'completed',
): Promise<void> {
  const completed = phase === 'completed';
  const client = completed ? await pool.connect() : null;
  const executor = client ?? pool;
  try {
    if (client) await client.query('BEGIN');
    const result = await executor.query(
      `UPDATE druvia_project_account_deletions
       SET phase = $3, status = ${completed ? "'completed'" : "'processing'"},
           next_attempt_at = ${completed ? 'NULL' : 'NOW()'}, lease_token = NULL, lease_until = NULL,
           last_error_code = NULL, completed_at = ${completed ? 'NOW()' : 'completed_at'}
       WHERE deletion_id = $1 AND lease_token = $2 AND status = 'processing'`,
      [operation.deletion_id, operation.lease_token, phase],
    );
    if (result.rowCount !== 1) throw new Error('ACCOUNT_DELETION_LEASE_LOST');
    if (completed) {
      await executor.query(
        `UPDATE druvia_project_account_deletion_fences
         SET completed_at = NOW() WHERE deletion_id = $1 AND completed_at IS NULL`,
        [operation.deletion_id],
      );
      await client!.query('COMMIT');
    }
  } catch (error) {
    if (client) await client.query('ROLLBACK');
    throw error;
  } finally {
    client?.release();
  }
}

async function retryDeletion(operation: ClaimedDeletion, error: unknown): Promise<void> {
  const deadlineExceeded = operation.data_deletion_deadline_at <= new Date();
  const contractFailure = error instanceof Error
    && ['ACCOUNT_DELETION_CLEANUP_CONTRACT_CHANGED', 'INVALID_CLEANUP_RESULT'].includes(error.message);
  const attentionRequired = deadlineExceeded || contractFailure;
  const code = deadlineExceeded
    ? 'ACCOUNT_DELETION_DEADLINE_EXCEEDED'
    : contractFailure
      ? error.message
      : 'ACCOUNT_DELETION_STEP_FAILED';
  await pool.query(
    `UPDATE druvia_project_account_deletions
     SET status = $3, phase = $4, last_error_code = $5,
         next_attempt_at = $6, lease_token = NULL, lease_until = NULL
     WHERE deletion_id = $1 AND lease_token = $2 AND status = 'processing'`,
    [
      operation.deletion_id,
      operation.lease_token,
      attentionRequired ? 'attention_required' : 'processing',
      operation.phase,
      code,
      attentionRequired ? null : new Date(Date.now() + retryDelaySeconds(operation.attempt_count) * 1000),
    ],
  );
  logger.warn('project account deletion step failed', {
    deletionId: operation.deletion_id,
    projectId: operation.project_id,
    phase: operation.phase,
    errorCode: code,
  });
}

async function runBusinessCleanup(operation: ClaimedDeletion): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SET LOCAL statement_timeout = '${config.accountDeletion.cleanupStatementTimeoutMs}ms'`);
    await executeAccountDeletionCleanupContract(client, {
      schemaName: operation.project_schema,
      functionName: operation.cleanup_function,
      contractHash: operation.cleanup_contract_hash,
      projectUserId: operation.project_user_id,
      deletionId: operation.deletion_id,
    });
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function runProjectUserCleanup(operation: ClaimedDeletion): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    if (operation.identity_id !== null) {
      await acquireProjectAuthIdentityIdLock(client, Number(operation.identity_id));
    }
    await client.query(
      `UPDATE druvia_project_auth_events
       SET identity_id = NULL, project_user_id = NULL
       WHERE project_id = $1 AND project_user_id = $2`,
      [operation.project_id, operation.project_user_id],
    );
    await client.query(
      `DELETE FROM druvia_project_refresh_tokens WHERE project_id = $1 AND user_id = $2`,
      [operation.project_id, operation.project_user_id],
    );
    if (operation.identity_id !== null) {
      await client.query(
        `DELETE FROM druvia_project_auth_identities
         WHERE id = $1 AND project_id = $2 AND project_user_id = $3 AND status = 'deletion_pending'`,
        [operation.identity_id, operation.project_id, operation.project_user_id],
      );
    }
    const userResult = await client.query(
      `DELETE FROM ${quoteIdentifier(operation.project_schema)}.users WHERE id::text = $1`,
      [operation.project_user_id],
    );
    if (userResult.rowCount === 0) {
      const fence = await client.query(
        `SELECT 1 FROM druvia_project_account_deletion_fences WHERE deletion_id = $1`,
        [operation.deletion_id],
      );
      if (!fence.rows[0]) throw new Error('ACCOUNT_DELETION_FENCE_MISSING');
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function processDeletion(operation: ClaimedDeletion): Promise<void> {
  try {
    let nextPhase: ClaimedDeletion['phase'] | 'completed';
    await withLeaseRenewal({
      renew: async () => {
        const result = await pool.query(
          `UPDATE druvia_project_account_deletions
           SET lease_until = NOW() + ($4 * INTERVAL '1 second')
           WHERE deletion_id = $1 AND lease_token = $2
             AND status = 'processing' AND phase = $3`,
          [
            operation.deletion_id,
            operation.lease_token,
            operation.phase,
            config.accountDeletion.executorLeaseSeconds,
          ],
        );
        return result.rowCount === 1;
      },
      run: async () => {
        switch (operation.phase) {
          case 'business_cleanup':
            await runBusinessCleanup(operation);
            nextPhase = 'storage_cleanup';
            break;
          case 'storage_cleanup':
            await storageService.deleteObjectsOwnedByProjectUser(operation.project_id, operation.project_user_id);
            nextPhase = 'project_user_cleanup';
            break;
          case 'project_user_cleanup':
            await runProjectUserCleanup(operation);
            nextPhase = 'provider_revoke';
            break;
          case 'provider_revoke':
            nextPhase = 'completed';
            break;
        }
      },
    });
    await advanceDeletion(operation, nextPhase!);
  } catch (error) {
    await retryDeletion(operation, error);
  }
}

async function findProviderTokenCandidate(client: PoolClient): Promise<ProviderTokenCandidate | null> {
  const result = await client.query<ProviderTokenCandidate>(
    `SELECT token.id, operation.project_id
     FROM druvia_project_account_deletion_provider_tokens token
     JOIN druvia_project_account_deletions operation
       ON operation.deletion_id = token.deletion_id
     WHERE token.status IN ('pending', 'in_flight')
       AND token.next_attempt_at <= NOW()
       AND (token.lease_until IS NULL OR token.lease_until < NOW())
     ORDER BY token.next_attempt_at, token.id
     LIMIT 1`,
  );
  return result.rows[0] ?? null;
}

async function claimProviderToken(client: PoolClient, tokenId: string | number): Promise<ClaimedProviderToken | null> {
  const leaseToken = crypto.randomUUID();
  const result = await client.query<ClaimedProviderToken>(
    `UPDATE druvia_project_account_deletion_provider_tokens token
     SET status = 'in_flight', lease_token = $1,
         lease_until = NOW() + ($2 * INTERVAL '1 second'), attempt_count = token.attempt_count + 1
     FROM druvia_project_account_deletions operation
     WHERE token.id = $3
       AND token.status IN ('pending', 'in_flight')
       AND token.next_attempt_at <= NOW()
       AND (token.lease_until IS NULL OR token.lease_until < NOW())
       AND operation.deletion_id = token.deletion_id
     RETURNING token.id, token.deletion_id, operation.project_id, token.audience,
       token.refresh_token_encrypted, token.lease_token, token.attempt_count`,
    [leaseToken, config.accountDeletion.executorLeaseSeconds, tokenId],
  );
  return result.rows[0] ?? null;
}

async function processProviderToken(token: ClaimedProviderToken): Promise<void> {
  try {
    await withLeaseRenewal({
      renew: async () => {
        const result = await pool.query(
          `UPDATE druvia_project_account_deletion_provider_tokens
           SET lease_until = NOW() + ($3 * INTERVAL '1 second')
           WHERE id = $1 AND lease_token = $2 AND status = 'in_flight'`,
          [token.id, token.lease_token, config.accountDeletion.executorLeaseSeconds],
        );
        return result.rowCount === 1;
      },
      run: async () => {
        const adapter = await getAppleAdapter(token.project_id, { requireEnabled: false });
        await adapter.revoke({
          audience: token.audience,
          refreshToken: decryptSecret(token.refresh_token_encrypted, { requireDedicatedKey: true }),
        });
      },
    });
    const result = await pool.query(
      `DELETE FROM druvia_project_account_deletion_provider_tokens
       WHERE id = $1 AND lease_token = $2`,
      [token.id, token.lease_token],
    );
    if (result.rowCount !== 1) return;
    await pool.query(
      `UPDATE druvia_project_account_deletions operation
       SET provider_revocation_status = 'succeeded'
       WHERE deletion_id = $1
         AND NOT EXISTS (
           SELECT 1 FROM druvia_project_account_deletion_provider_tokens remaining
           WHERE remaining.deletion_id = operation.deletion_id
             AND remaining.status <> 'superseded'
         )`,
      [token.deletion_id],
    );
  } catch {
    await pool.query(
      `UPDATE druvia_project_account_deletion_provider_tokens
       SET status = 'pending', lease_token = NULL, lease_until = NULL,
           last_error_code = 'APPLE_REVOKE_FAILED',
           next_attempt_at = NOW() + ($3 * INTERVAL '1 second')
       WHERE id = $1 AND lease_token = $2`,
      [token.id, token.lease_token, retryDelaySeconds(token.attempt_count)],
    );
    logger.warn('account deletion provider revoke failed', {
      deletionId: token.deletion_id,
      projectId: token.project_id,
      errorCode: 'APPLE_REVOKE_FAILED',
    });
  }
}

export async function runAccountDeletionExecutorCycle(): Promise<{ processed: number }> {
  if (!config.accountDeletion.executorEnabled) return { processed: 0 };
  const deletionClient = await pool.connect();
  let deletion: ClaimedDeletion | null;
  try {
    const candidate = await findDeletionCandidate(deletionClient);
    deletion = candidate
      ? await withProjectAuthProjectLock(deletionClient, candidate.project_id, async () => {
        const claimed = await claimDeletion(deletionClient, candidate.deletion_id);
        if (claimed) await processDeletion(claimed);
        return claimed;
      })
      : null;
  } finally {
    deletionClient.release();
  }

  const tokenClient = await pool.connect();
  let token: ClaimedProviderToken | null;
  try {
    const candidate = await findProviderTokenCandidate(tokenClient);
    token = candidate
      ? await withProjectAuthProjectLock(tokenClient, candidate.project_id, async () => {
        const claimed = await claimProviderToken(tokenClient, candidate.id);
        if (claimed) await processProviderToken(claimed);
        return claimed;
      })
      : null;
  } finally {
    tokenClient.release();
  }
  return { processed: Number(Boolean(deletion)) + Number(Boolean(token)) };
}

export function isAccountDeletionExecutorHealthy(): boolean {
  return config.accountDeletion.executorEnabled
    && Date.now() - lastHeartbeatAt <= Math.max(config.accountDeletion.executorPollMs * 3, 30_000);
}

export async function getAccountDeletionExecutorHealth(): Promise<{
  healthy: boolean;
  overdueOperations: number;
  attentionRequiredOperations: number;
}> {
  const result = await pool.query<{
    overdue_operations: string | number;
    attention_required_operations: string | number;
  }>(
    `SELECT
       COUNT(*) FILTER (
         WHERE status IN ('accepted', 'processing', 'attention_required')
           AND data_deletion_deadline_at < NOW()
       ) AS overdue_operations,
       COUNT(*) FILTER (WHERE status = 'attention_required') AS attention_required_operations
     FROM druvia_project_account_deletions`,
  );
  const overdueOperations = Number(result.rows[0]?.overdue_operations ?? 0);
  const attentionRequiredOperations = Number(result.rows[0]?.attention_required_operations ?? 0);
  return {
    healthy: isAccountDeletionExecutorHealthy()
      && overdueOperations === 0
      && attentionRequiredOperations === 0,
    overdueOperations,
    attentionRequiredOperations,
  };
}

export async function startAccountDeletionExecutor(): Promise<() => Promise<void>> {
  if (!config.accountDeletion.executorEnabled) return async () => {};
  const instanceId = crypto.randomUUID();
  let stopped = false;
  let activeRun: Promise<void> | null = null;
  const heartbeat = async () => {
    await pool.query(
      `INSERT INTO druvia_account_deletion_executor_heartbeats (instance_id, last_seen_at)
       VALUES ($1, NOW())
       ON CONFLICT (instance_id) DO UPDATE SET last_seen_at = NOW()`,
      [instanceId],
    );
    lastHeartbeatAt = Date.now();
  };
  const run = () => {
    if (stopped || activeRun) return activeRun;
    activeRun = (async () => {
      try {
        await heartbeat();
        await runAccountDeletionExecutorCycle();
        await pool.query(
          `DELETE FROM druvia_account_deletion_executor_heartbeats
           WHERE last_seen_at < NOW() - INTERVAL '5 minutes'`,
        );
      } catch (error) {
        logger.warn('account deletion executor cycle failed', {}, error);
      }
    })().finally(() => { activeRun = null; });
    return activeRun;
  };
  await heartbeat();
  void run();
  const timer = setInterval(() => void run(), config.accountDeletion.executorPollMs);
  timer.unref();
  return async () => {
    stopped = true;
    clearInterval(timer);
    if (activeRun) await activeRun;
    await pool.query(
      `DELETE FROM druvia_account_deletion_executor_heartbeats WHERE instance_id = $1`,
      [instanceId],
    );
  };
}
