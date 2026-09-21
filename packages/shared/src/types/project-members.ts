export const PROJECT_MEMBER_ROLES = [
  'project_admin',
  'database_admin',
  'viewer',
] as const;

export type ProjectMemberRole = (typeof PROJECT_MEMBER_ROLES)[number];
export type ProjectEffectiveRole = 'owner' | ProjectMemberRole;

export const PROJECT_CAPABILITIES = [
  'project:read',
  'project:update',
  'runtime_context:manage',
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
] as const;

export type ProjectCapability = (typeof PROJECT_CAPABILITIES)[number];

export interface ProjectAccess {
  projectId: string;
  role: ProjectEffectiveRole;
  capabilities: ProjectCapability[];
  isWorkspaceOwner: boolean;
  isSuperAdmin: boolean;
}

export interface ProjectMemberView {
  userId: string;
  email: string;
  username: string | null;
  status: 'active' | 'inactive' | 'suspended';
  role: ProjectEffectiveRole;
  isWorkspaceOwner: boolean;
  createdAt: string | null;
}
