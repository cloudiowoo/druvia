import type { FastifyReply, FastifyRequest } from 'fastify';
import type {
  ProjectAccess,
  ProjectCapability,
  ProjectEffectiveRole,
  ProjectMemberRole,
} from '@druvia/shared';
import { queryOne } from '../db/index.js';
import { query } from '../db/index.js';
import { isPlatformUser, type RequestUser } from '../middleware/auth.js';

export const ROLE_CAPABILITIES: Readonly<Record<ProjectEffectiveRole, readonly ProjectCapability[]>> = {
  owner: [
    'project:read',
    'project:update',
    'project:delete',
    'members:read',
    'members:manage',
    'database:read',
    'database:write',
    'database:credentials',
    'data_access:manage',
    'auth:manage',
    'api_keys:manage',
    'trusted_keys:manage',
    'storage:manage',
    'functions:manage',
    'realtime:manage',
    'environments:manage',
    'backups:read',
    'backups:create',
    'backups:restore',
  ],
  project_admin: [
    'project:read',
    'project:update',
    'members:read',
    'database:read',
    'database:write',
    'data_access:manage',
    'auth:manage',
    'api_keys:manage',
    'storage:manage',
    'functions:manage',
    'realtime:manage',
    'environments:manage',
    'backups:read',
    'backups:create',
    'backups:restore',
  ],
  database_admin: [
    'project:read',
    'members:read',
    'database:read',
    'database:write',
    'data_access:manage',
    'realtime:manage',
    'backups:read',
    'backups:create',
  ],
  viewer: ['project:read', 'members:read', 'database:read'],
};

interface ProjectAuthorizationRow {
  project_id: string;
  user_uid: number | null;
  user_id: string | null;
  user_status: string | null;
  platform_role: string | null;
  owner_uid: number;
  member_role: ProjectMemberRole | null;
}

interface CurrentPlatformUserRow {
  user_id: string;
  status: string;
  role: string;
}

interface TenantAuthorizationRow {
  tenant_id: string;
  user_uid: number | null;
  user_status: string | null;
  platform_role: string | null;
  owner_uid: number;
  has_project_membership: boolean;
}

export interface TenantAccess {
  tenantId: string;
  isWorkspaceOwner: boolean;
  isSuperAdmin: boolean;
}

export class AuthorizationError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'AuthorizationError';
  }
}

declare module 'fastify' {
  interface FastifyRequest {
    projectAccess?: ProjectAccess;
    tenantAccess?: TenantAccess;
  }
}

function accessForRole(
  projectId: string,
  role: ProjectEffectiveRole,
  options: { isWorkspaceOwner: boolean; isSuperAdmin: boolean },
): ProjectAccess {
  return {
    projectId,
    role,
    capabilities: [...ROLE_CAPABILITIES[role]],
    ...options,
  };
}

async function loadProjectAuthorization(
  user: RequestUser,
  projectId: string,
): Promise<ProjectAuthorizationRow | null> {
  if (!isPlatformUser(user)) return null;

  return queryOne<ProjectAuthorizationRow>(
    `SELECT p.project_id,
            u.id AS user_uid,
            u.user_id,
            u.status AS user_status,
            u.role AS platform_role,
            t.owner_uid,
            pm.role AS member_role
       FROM druvia_projects p
       JOIN druvia_tenants t ON t.tenant_id = p.tenant_id
       LEFT JOIN druvia_users u ON u.id = $2 AND u.user_id = $3
       LEFT JOIN druvia_project_members pm
         ON pm.project_id = p.project_id AND pm.user_uid = u.id
      WHERE p.project_id = $1`,
    [projectId, user.uid, user.userId],
  );
}

function resolveAccessFromRow(row: ProjectAuthorizationRow | null): ProjectAccess | null {
  if (!row || row.user_uid === null || row.user_status !== 'active') return null;

  if (row.platform_role === 'super_admin') {
    return accessForRole(row.project_id, 'owner', {
      isWorkspaceOwner: row.owner_uid === row.user_uid,
      isSuperAdmin: true,
    });
  }

  if (row.owner_uid === row.user_uid) {
    return accessForRole(row.project_id, 'owner', {
      isWorkspaceOwner: true,
      isSuperAdmin: false,
    });
  }

  if (row.member_role && row.member_role in ROLE_CAPABILITIES) {
    return accessForRole(row.project_id, row.member_role, {
      isWorkspaceOwner: false,
      isSuperAdmin: false,
    });
  }

  return null;
}

export async function resolveProjectAccess(
  user: RequestUser | undefined,
  projectId: string,
): Promise<ProjectAccess | null> {
  if (!user || !isPlatformUser(user)) return null;
  return resolveAccessFromRow(await loadProjectAuthorization(user, projectId));
}

export async function assertProjectCapability(
  user: RequestUser | undefined,
  projectId: string,
  capability: ProjectCapability,
): Promise<ProjectAccess> {
  if (!user || !isPlatformUser(user)) {
    throw new AuthorizationError(401, 'UNAUTHORIZED', 'Platform authentication required');
  }

  const row = await loadProjectAuthorization(user, projectId);
  if (!row) {
    throw new AuthorizationError(404, 'PROJECT_NOT_FOUND', 'Project not found');
  }

  const access = resolveAccessFromRow(row);
  if (!access || !access.capabilities.includes(capability)) {
    throw new AuthorizationError(403, 'FORBIDDEN', 'Project capability required');
  }

  return access;
}

export async function requireCurrentSuperAdmin(user: RequestUser | undefined): Promise<void> {
  if (!user || !isPlatformUser(user)) {
    throw new AuthorizationError(401, 'UNAUTHORIZED', 'Platform authentication required');
  }

  const current = await queryOne<CurrentPlatformUserRow>(
    `SELECT user_id, status, role
       FROM druvia_users
      WHERE id = $1 AND user_id = $2`,
    [user.uid, user.userId],
  );
  if (!current || current.status !== 'active' || current.role !== 'super_admin') {
    throw new AuthorizationError(403, 'FORBIDDEN', 'Current super_admin role required');
  }
}

export async function assertTenantAccess(
  user: RequestUser | undefined,
  tenantId: string,
  options: { ownerOnly?: boolean } = {},
): Promise<TenantAccess> {
  if (!user || !isPlatformUser(user)) {
    throw new AuthorizationError(401, 'UNAUTHORIZED', 'Platform authentication required');
  }
  const row = await queryOne<TenantAuthorizationRow>(
    `SELECT t.tenant_id,
            u.id AS user_uid,
            u.status AS user_status,
            u.role AS platform_role,
            t.owner_uid,
            EXISTS (
              SELECT 1
                FROM druvia_projects p
                JOIN druvia_project_members pm ON pm.project_id = p.project_id
               WHERE p.tenant_id = t.tenant_id AND pm.user_uid = u.id
            ) AS has_project_membership
       FROM druvia_tenants t
       LEFT JOIN druvia_users u ON u.id = $2 AND u.user_id = $3
      WHERE t.tenant_id = $1`,
    [tenantId, user.uid, user.userId],
  );
  if (!row) throw new AuthorizationError(404, 'TENANT_NOT_FOUND', 'Workspace not found');
  if (row.user_uid === null || row.user_status !== 'active') {
    throw new AuthorizationError(403, 'FORBIDDEN', 'Workspace access required');
  }
  const isSuperAdmin = row.platform_role === 'super_admin';
  const isWorkspaceOwner = row.owner_uid === row.user_uid;
  if (
    (!isSuperAdmin && !isWorkspaceOwner && !row.has_project_membership)
    || (options.ownerOnly && !isSuperAdmin && !isWorkspaceOwner)
  ) {
    throw new AuthorizationError(403, 'FORBIDDEN', 'Workspace access required');
  }
  return { tenantId, isWorkspaceOwner, isSuperAdmin };
}

export async function listAccessibleProjectIds(
  user: RequestUser | undefined,
  tenantId: string,
  capability: ProjectCapability = 'project:read',
): Promise<string[]> {
  if (!user || !isPlatformUser(user)) {
    throw new AuthorizationError(401, 'UNAUTHORIZED', 'Platform authentication required');
  }
  const memberRoles = (Object.entries(ROLE_CAPABILITIES) as Array<
    [ProjectEffectiveRole, readonly ProjectCapability[]]
  >)
    .filter(([role, capabilities]) => role !== 'owner' && capabilities.includes(capability))
    .map(([role]) => role);
  const rows = await query<{ project_id: string }>(
    `SELECT p.project_id
       FROM druvia_projects p
       JOIN druvia_tenants t ON t.tenant_id = p.tenant_id
       JOIN druvia_users u
         ON u.id = $2 AND u.user_id = $3 AND u.status = 'active'
       LEFT JOIN druvia_project_members pm
         ON pm.project_id = p.project_id AND pm.user_uid = u.id
      WHERE p.tenant_id = $1
        AND (
          u.role = 'super_admin'
          OR t.owner_uid = u.id
          OR pm.role = ANY($4::text[])
        )
      ORDER BY p.created_at DESC`,
    [tenantId, user.uid, user.userId, memberRoles],
  );
  return rows.map((row) => row.project_id);
}

export async function resolveSchemaProject(schemaName: string): Promise<string | null> {
  const projects = await query<{ project_id: string }>(
    `SELECT DISTINCT project_id
       FROM (
         SELECT p.project_id
           FROM druvia_projects p
          WHERE p.schema_name = $1
         UNION ALL
         SELECT e.project_id
           FROM druvia_project_environments e
          WHERE e.schema_name = $1
       ) schema_projects
      ORDER BY project_id
      LIMIT 2`,
    [schemaName],
  );
  return projects.length === 1 ? projects[0].project_id : null;
}

function sendAuthorizationError(reply: FastifyReply, error: unknown): void {
  if (!(error instanceof AuthorizationError)) throw error;
  void reply.status(error.statusCode).send({
    success: false,
    error: { code: error.code, message: error.message },
  });
}

export function requireProjectCapability(capability: ProjectCapability) {
  return async function projectCapabilityGuard(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> {
    const { projectId } = request.params as { projectId?: string };
    if (!projectId) {
      void reply.status(400).send({
        success: false,
        error: { code: 'BAD_REQUEST', message: 'Project ID is required' },
      });
      return;
    }
    try {
      request.projectAccess = await assertProjectCapability(request.user, projectId, capability);
    } catch (error) {
      sendAuthorizationError(reply, error);
    }
  };
}

export function requireSchemaCapability(capability: ProjectCapability) {
  return async function schemaCapabilityGuard(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> {
    const params = request.params as { schema?: string; schemaName?: string };
    const schemaName = params.schema ?? params.schemaName;
    if (!schemaName) {
      void reply.status(400).send({
        success: false,
        error: { code: 'BAD_REQUEST', message: 'Schema name is required' },
      });
      return;
    }
    const projectId = await resolveSchemaProject(schemaName);
    if (!projectId) {
      void reply.status(404).send({
        success: false,
        error: { code: 'PROJECT_NOT_FOUND', message: 'Project not found for schema' },
      });
      return;
    }
    try {
      request.projectAccess = await assertProjectCapability(request.user, projectId, capability);
    } catch (error) {
      sendAuthorizationError(reply, error);
    }
  };
}

export async function requireSuperAdmin(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  try {
    await requireCurrentSuperAdmin(request.user);
    if (request.user && isPlatformUser(request.user)) request.user.role = 'super_admin';
  } catch (error) {
    sendAuthorizationError(reply, error);
  }
}

export function requireTenantAccess(options: { ownerOnly?: boolean } = {}) {
  return async function tenantAccessGuard(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> {
    const { tenantId } = request.params as { tenantId?: string };
    if (!tenantId) {
      void reply.status(400).send({
        success: false,
        error: { code: 'BAD_REQUEST', message: 'Workspace ID is required' },
      });
      return;
    }
    try {
      request.tenantAccess = await assertTenantAccess(request.user, tenantId, options);
    } catch (error) {
      sendAuthorizationError(reply, error);
    }
  };
}
