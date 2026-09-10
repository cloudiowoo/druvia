import { pool } from '../../db/index.js';
import {
  executeAccountDeletionCleanupContract,
  inspectAccountDeletionCleanupContract,
} from './project-account-deletion.service.js';
import { withProjectAuthProjectLock } from './project-identity.repository.js';

function quoteIdentifier(value: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) throw new Error('Invalid account deletion restore identifier');
  return `"${value.replace(/"/g, '""')}"`;
}

export async function beginProjectRestoreGate(projectId: string, operationId: string): Promise<void> {
  await pool.query(
    `INSERT INTO druvia_project_runtime_gates
       (project_id, operation_id, gate_type, status, reason_code)
     VALUES ($1, $2, 'backup_restore', 'restoring', NULL)
     ON CONFLICT (project_id) DO UPDATE
     SET operation_id = EXCLUDED.operation_id, status = 'restoring',
         reason_code = NULL, updated_at = NOW()`,
    [projectId, operationId],
  );
}

export async function markProjectRestoreRecoveryRequired(
  projectId: string,
  operationId: string,
  reasonCode: string,
): Promise<void> {
  await pool.query(
    `UPDATE druvia_project_runtime_gates
     SET status = 'recovery_required', reason_code = $3, updated_at = NOW()
     WHERE project_id = $1 AND operation_id = $2`,
    [projectId, operationId, reasonCode],
  );
}

export async function replayProjectAccountDeletionFences(
  projectId: string,
  operationId: string,
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const gate = await client.query(
      `SELECT 1 FROM druvia_project_runtime_gates
       WHERE project_id = $1 AND operation_id = $2 AND status = 'restoring'
       FOR UPDATE`,
      [projectId, operationId],
    );
    if (!gate.rows[0]) throw new Error('PROJECT_RESTORE_GATE_MISSING');
    const operations = await client.query<{
      deletion_id: string;
      project_schema: string;
      project_user_id: string;
      cleanup_function: string;
    }>(
      `SELECT operation.deletion_id, operation.project_schema, operation.project_user_id,
              operation.cleanup_function
       FROM druvia_project_account_deletions operation
       JOIN druvia_project_account_deletion_fences fence
         ON fence.deletion_id = operation.deletion_id
       WHERE operation.project_id = $1
         AND operation.status IN ('accepted', 'processing', 'attention_required', 'completed')
       ORDER BY operation.accepted_at`,
      [projectId],
    );
    const restoredContract = await inspectAccountDeletionCleanupContract(client, projectId);
    for (const operation of operations.rows) {
      if (
        operation.project_schema !== restoredContract.schemaName
        || operation.cleanup_function !== restoredContract.functionName
      ) {
        throw new Error('ACCOUNT_DELETION_CLEANUP_CONTRACT_CHANGED');
      }
      await executeAccountDeletionCleanupContract(client, {
        schemaName: operation.project_schema,
        functionName: operation.cleanup_function,
        contractHash: restoredContract.contractHash,
        projectUserId: operation.project_user_id,
        deletionId: operation.deletion_id,
      });
      await client.query(
        `DELETE FROM ${quoteIdentifier(operation.project_schema)}.users WHERE id::text = $1`,
        [operation.project_user_id],
      );
    }
    await client.query(
      `DELETE FROM druvia_project_runtime_gates
       WHERE project_id = $1 AND operation_id = $2 AND status = 'restoring'`,
      [projectId, operationId],
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
