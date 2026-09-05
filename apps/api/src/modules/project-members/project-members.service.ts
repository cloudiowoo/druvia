import type { PoolClient } from 'pg';
import type { ProjectMemberRole, ProjectMemberView } from '@druvia/shared';
import { PROJECT_MEMBER_ROLES } from '@druvia/shared';
import { getClient, query } from '../../db/index.js';
import type { PlatformJwtUser } from '../../middleware/auth.js';
import { logActivity } from '../activity/activity.service.js';

interface MemberRow {
  user_id: string;
  email: string;
  username: string | null;
  status: 'active' | 'inactive' | 'suspended';
  role: 'owner' | ProjectMemberRole | null;
  is_workspace_owner: boolean;
  created_at: Date | string | null;
}

interface ManagerRow {
  owner_uid: number;
  actor_uid: number | null;
  actor_status: string | null;
  actor_role: string | null;
}

interface TargetUserRow {
  uid: number;
  user_id: string;
  email: string;
  username: string | null;
  status: 'active' | 'inactive' | 'suspended';
  is_owner: boolean;
}

export class ProjectMemberError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ProjectMemberError';
  }
}

export function isProjectMemberRole(value: unknown): value is ProjectMemberRole {
  return typeof value === 'string'
    && (PROJECT_MEMBER_ROLES as readonly string[]).includes(value);
}

function toMemberView(row: MemberRow): ProjectMemberView {
  return {
    userId: row.user_id,
    email: row.email,
    username: row.username,
    status: row.status,
    role: row.role ?? 'viewer',
    isWorkspaceOwner: row.is_workspace_owner,
    createdAt: row.created_at instanceof Date
      ? row.created_at.toISOString()
      : row.created_at,
  };
}

export async function listProjectMembers(projectId: string): Promise<ProjectMemberView[]> {
  const rows = await query<MemberRow>(
    `WITH project_context AS (
       SELECT p.project_id, t.owner_uid
         FROM druvia_projects p
         JOIN druvia_tenants t ON t.tenant_id = p.tenant_id
        WHERE p.project_id = $1
     ), member_rows AS (
       SELECT u.user_id, u.email, u.username, u.status,
              'owner'::text AS role, true AS is_workspace_owner,
              NULL::timestamptz AS created_at
         FROM project_context pc
         JOIN druvia_users u ON u.id = pc.owner_uid
       UNION ALL
       SELECT u.user_id, u.email, u.username, u.status,
              pm.role, false AS is_workspace_owner, pm.created_at
         FROM project_context pc
         JOIN druvia_project_members pm ON pm.project_id = pc.project_id
         JOIN druvia_users u ON u.id = pm.user_uid
     )
     SELECT * FROM member_rows
     ORDER BY is_workspace_owner DESC, created_at ASC NULLS FIRST, user_id ASC`,
    [projectId],
  );
  return rows.map(toMemberView);
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, '\\$&');
}

export async function searchProjectMemberCandidates(
  projectId: string,
  rawQuery: string,
): Promise<ProjectMemberView[]> {
  const search = rawQuery.trim();
  if (search.length < 2) {
    throw new ProjectMemberError(400, 'INVALID_QUERY', 'Search query must contain at least 2 characters');
  }
  const pattern = `%${escapeLike(search)}%`;
  const rows = await query<MemberRow>(
    `SELECT u.user_id, u.email, u.username, u.status,
            NULL::text AS role, false AS is_workspace_owner,
            NULL::timestamptz AS created_at
       FROM druvia_projects p
       JOIN druvia_tenants t ON t.tenant_id = p.tenant_id
       JOIN druvia_users u ON u.status = 'active'
       LEFT JOIN druvia_project_members pm
         ON pm.project_id = p.project_id AND pm.user_uid = u.id
      WHERE p.project_id = $1
        AND pm.id IS NULL
        AND u.id <> t.owner_uid
        AND (u.email ILIKE $2 ESCAPE '\\' OR u.username ILIKE $2 ESCAPE '\\')
      ORDER BY CASE WHEN lower(u.email) = lower(trim(both '%' from $2)) THEN 0 ELSE 1 END,
               u.email ASC
      LIMIT 10`,
    [projectId, pattern],
  );
  return rows.map(toMemberView);
}

async function assertMembershipManager(
  client: PoolClient,
  actor: PlatformJwtUser,
  projectId: string,
): Promise<void> {
  const result = await client.query<ManagerRow>(
    `SELECT t.owner_uid,
            u.id AS actor_uid,
            u.status AS actor_status,
            u.role AS actor_role
       FROM druvia_projects p
       JOIN druvia_tenants t ON t.tenant_id = p.tenant_id
       LEFT JOIN druvia_users u ON u.id = $2 AND u.user_id = $3
      WHERE p.project_id = $1
      FOR UPDATE OF p`,
    [projectId, actor.uid, actor.userId],
  );
  const row = result.rows[0];
  if (!row) throw new ProjectMemberError(404, 'PROJECT_NOT_FOUND', 'Project not found');
  if (
    row.actor_uid === null
    || row.actor_status !== 'active'
    || (row.actor_role !== 'super_admin' && row.owner_uid !== row.actor_uid)
  ) {
    throw new ProjectMemberError(403, 'FORBIDDEN', 'Only the workspace owner can manage project members');
  }
}

async function loadTargetUser(
  client: PoolClient,
  projectId: string,
  userId: string,
  options: { requireActive?: boolean } = { requireActive: true },
): Promise<TargetUserRow> {
  const result = await client.query<TargetUserRow>(
    `SELECT u.id AS uid, u.user_id, u.email, u.username, u.status,
            u.id = t.owner_uid AS is_owner
       FROM druvia_projects p
       JOIN druvia_tenants t ON t.tenant_id = p.tenant_id
       JOIN druvia_users u ON u.user_id = $2
      WHERE p.project_id = $1`,
    [projectId, userId],
  );
  const target = result.rows[0];
  if (!target) throw new ProjectMemberError(404, 'USER_NOT_FOUND', 'Platform user not found');
  if (target.is_owner) {
    throw new ProjectMemberError(400, 'OWNER_MEMBERSHIP_NOT_ALLOWED', 'Workspace owner is already an implicit project owner');
  }
  if (options.requireActive !== false && target.status !== 'active') {
    throw new ProjectMemberError(409, 'USER_INACTIVE', 'Only active platform users can be project members');
  }
  return target;
}

async function withMembershipTransaction<T>(
  actor: PlatformJwtUser,
  projectId: string,
  operation: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await getClient();
  try {
    await client.query('BEGIN');
    await assertMembershipManager(client, actor, projectId);
    const result = await operation(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function addProjectMember(
  actor: PlatformJwtUser,
  projectId: string,
  userId: string,
  role: ProjectMemberRole,
  requestId?: string,
): Promise<ProjectMemberView> {
  let result: { target: TargetUserRow; createdAt: Date } | undefined;
  try {
    result = await withMembershipTransaction(actor, projectId, async (client) => {
      const user = await loadTargetUser(client, projectId, userId);
      const inserted = await client.query<{ created_at: Date }>(
        `INSERT INTO druvia_project_members (project_id, user_uid, role, created_by)
         VALUES ($1, $2, $3, $4)
         RETURNING created_at`,
        [projectId, user.uid, role, actor.uid],
      );
      const createdAt = inserted.rows[0]?.created_at ?? new Date();
      await logActivity(actor.userId, 'project_member.created', 'project', projectId, {
        projectId,
        targetUserId: userId,
        previousRole: null,
        role,
        ...(requestId ? { requestId } : {}),
      }, client);
      return { target: user, createdAt };
    });
  } catch (error) {
    if ((error as { code?: string }).code === '23505') {
      throw new ProjectMemberError(409, 'MEMBER_EXISTS', 'Project member already exists');
    }
    throw error;
  }

  return toMemberView({
    ...result.target,
    role,
    is_workspace_owner: false,
    created_at: result.createdAt,
  });
}

export async function updateProjectMemberRole(
  actor: PlatformJwtUser,
  projectId: string,
  userId: string,
  role: ProjectMemberRole,
  requestId?: string,
): Promise<ProjectMemberView> {
  const result = await withMembershipTransaction(actor, projectId, async (client) => {
    const target = await loadTargetUser(client, projectId, userId);
    const result = await client.query<{ previous_role: ProjectMemberRole; created_at: Date }>(
      `WITH existing AS (
         SELECT role, created_at
           FROM druvia_project_members
          WHERE project_id = $1 AND user_uid = $2
          FOR UPDATE
       ), updated AS (
         UPDATE druvia_project_members
            SET role = $3
          WHERE project_id = $1 AND user_uid = $2
          RETURNING 1
       )
       SELECT existing.role AS previous_role, existing.created_at
         FROM existing
         JOIN updated ON true`,
      [projectId, target.uid, role],
    );
    const updated = result.rows[0];
    if (!updated) {
      throw new ProjectMemberError(404, 'MEMBER_NOT_FOUND', 'Project member not found');
    }
    await logActivity(actor.userId, 'project_member.role_updated', 'project', projectId, {
      projectId,
      targetUserId: userId,
      previousRole: updated.previous_role,
      role,
      ...(requestId ? { requestId } : {}),
    }, client);
    return { target, createdAt: updated.created_at };
  });
  return toMemberView({
    ...result.target, role, is_workspace_owner: false, created_at: result.createdAt,
  });
}

export async function removeProjectMember(
  actor: PlatformJwtUser,
  projectId: string,
  userId: string,
  requestId?: string,
): Promise<void> {
  await withMembershipTransaction(actor, projectId, async (client) => {
    const target = await loadTargetUser(client, projectId, userId, { requireActive: false });
    const result = await client.query<{ role: ProjectMemberRole }>(
      `DELETE FROM druvia_project_members
        WHERE project_id = $1 AND user_uid = $2
      RETURNING role`,
      [projectId, target.uid],
    );
    if (!result.rows[0]) {
      throw new ProjectMemberError(404, 'MEMBER_NOT_FOUND', 'Project member not found');
    }
    await logActivity(actor.userId, 'project_member.removed', 'project', projectId, {
      projectId,
      targetUserId: userId,
      previousRole: result.rows[0].role,
      role: null,
      ...(requestId ? { requestId } : {}),
    }, client);
  });
}
