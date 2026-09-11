import type { PoolClient } from 'pg';
import { queryOne } from '../../db/index.js';

export class ProjectRuntimeBlockedError extends Error {
  constructor(
    readonly code:
      | 'ACCOUNT_DELETION_IN_PROGRESS'
      | 'ACCOUNT_DELETION_ATTENTION_REQUIRED'
      | 'PROJECT_RESTORE_IN_PROGRESS',
    readonly statusCode: 409 | 503,
  ) {
    super(code);
    this.name = 'ProjectRuntimeBlockedError';
  }
}

export async function assertProjectRuntimeAvailable(
  projectId: string,
  client?: Pick<PoolClient, 'query'>,
): Promise<void> {
  const sql = `SELECT status
     FROM druvia_project_runtime_gates
     WHERE project_id = $1`;
  const gate = client
    ? (await client.query<{ status: 'restoring' | 'recovery_required' }>(sql, [projectId])).rows[0] ?? null
    : await queryOne<{ status: 'restoring' | 'recovery_required' }>(sql, [projectId]);
  if (gate) {
    throw new ProjectRuntimeBlockedError('PROJECT_RESTORE_IN_PROGRESS', 503);
  }
}

export async function assertProjectSessionUsable(input: {
  projectId: string;
  projectUserId: string;
}): Promise<void> {
  await assertProjectRuntimeAvailable(input.projectId);
  const deletion = await queryOne<{
    status: 'accepted' | 'processing' | 'attention_required' | 'completed';
  }>(
    `SELECT state.status
     FROM (
       SELECT status, accepted_at, 1 AS priority
       FROM druvia_project_account_deletions
       WHERE project_id = $1
         AND project_user_id = $2
         AND status IN ('accepted', 'processing', 'attention_required', 'completed')
       UNION ALL
       SELECT 'attention_required' AS status, updated_at AS accepted_at, 2 AS priority
       FROM druvia_project_auth_identities
       WHERE project_id = $1
         AND project_user_id = $2
         AND provider = 'apple'
         AND status = 'deletion_pending'
     ) state
     ORDER BY state.priority, state.accepted_at DESC NULLS LAST
     LIMIT 1`,
    [input.projectId, input.projectUserId],
  );
  if (!deletion) return;

  if (deletion.status === 'attention_required' || deletion.status === 'completed') {
    throw new ProjectRuntimeBlockedError('ACCOUNT_DELETION_ATTENTION_REQUIRED', 503);
  }
  throw new ProjectRuntimeBlockedError('ACCOUNT_DELETION_IN_PROGRESS', 409);
}
