import type {
  ApiKeyIdentity,
  PlatformJwtUser,
  ProjectJwtUser,
  RequestUser,
} from '../middleware/auth.js';

export const PROJECT_ACTOR_CONTRACT_VERSION = 1 as const;

export type ProjectActorType = 'platform_user' | 'project_user' | 'apikey';
export type ProjectActorSource = 'platform_session' | 'project_session' | 'project_api_key';

export type ProjectActorContext =
  | {
      version: 1;
      actorType: 'platform_user';
      source: 'platform_session';
      projectId: string;
      subject: string;
      role: string;
      platformUserId: string;
      platformUid: number;
      tenantId?: string;
    }
  | {
      version: 1;
      actorType: 'project_user';
      source: 'project_session';
      projectId: string;
      subject: string;
      role: 'authenticated';
      projectUserId: string;
      provider: string;
    }
  | {
      version: 1;
      actorType: 'apikey';
      source: 'project_api_key';
      projectId: string;
      subject: string;
      role: 'anon';
      apiKeyId: number;
      apiKeyPrefix: string;
    };

export class ProjectActorScopeError extends Error {
  constructor() {
    super('Project actor does not match the requested project');
    this.name = 'ProjectActorScopeError';
  }
}

export class ProjectActorRequiredError extends Error {
  constructor() {
    super('A valid project actor is required');
    this.name = 'ProjectActorRequiredError';
  }
}

function isValidString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowedKeys: string[]): boolean {
  const allowed = new Set(allowedKeys);
  return Object.keys(value).every((key) => allowed.has(key));
}

export function parseProjectActorContext(value: unknown): ProjectActorContext {
  if (!isRecord(value) || value.version !== PROJECT_ACTOR_CONTRACT_VERSION) {
    throw new ProjectActorRequiredError();
  }
  if (!isValidString(value.projectId) || !isValidString(value.subject) || !isValidString(value.role)) {
    throw new ProjectActorRequiredError();
  }

  if (value.actorType === 'platform_user') {
    if (
      !hasOnlyKeys(value, [
        'version', 'actorType', 'source', 'projectId', 'subject', 'role',
        'platformUserId', 'platformUid', 'tenantId',
      ])
      || value.source !== 'platform_session'
      || !isValidString(value.platformUserId)
      || !Number.isSafeInteger(value.platformUid)
      || (value.platformUid as number) <= 0
      || value.subject !== `platform_user:${value.platformUserId}`
      || (value.tenantId !== undefined && !isValidString(value.tenantId))
    ) {
      throw new ProjectActorRequiredError();
    }
    return {
      version: PROJECT_ACTOR_CONTRACT_VERSION,
      actorType: 'platform_user',
      source: 'platform_session',
      projectId: value.projectId,
      subject: value.subject,
      role: value.role,
      platformUserId: value.platformUserId,
      platformUid: value.platformUid as number,
      ...(value.tenantId ? { tenantId: value.tenantId } : {}),
    };
  }

  if (value.actorType === 'project_user') {
    if (
      !hasOnlyKeys(value, [
        'version', 'actorType', 'source', 'projectId', 'subject', 'role',
        'projectUserId', 'provider',
      ])
      || value.source !== 'project_session'
      || value.role !== 'authenticated'
      || !isValidString(value.projectUserId)
      || !isValidString(value.provider)
      || value.subject !== `project_user:${value.projectUserId}`
    ) {
      throw new ProjectActorRequiredError();
    }
    return {
      version: PROJECT_ACTOR_CONTRACT_VERSION,
      actorType: 'project_user',
      source: 'project_session',
      projectId: value.projectId,
      subject: value.subject,
      role: 'authenticated',
      projectUserId: value.projectUserId,
      provider: value.provider,
    };
  }

  if (value.actorType === 'apikey') {
    if (
      !hasOnlyKeys(value, [
        'version', 'actorType', 'source', 'projectId', 'subject', 'role',
        'apiKeyId', 'apiKeyPrefix',
      ])
      || value.source !== 'project_api_key'
      || value.role !== 'anon'
      || !Number.isSafeInteger(value.apiKeyId)
      || (value.apiKeyId as number) <= 0
      || !isValidString(value.apiKeyPrefix)
      || value.apiKeyPrefix.length > 12
      || value.subject !== `apikey:${value.apiKeyId}`
    ) {
      throw new ProjectActorRequiredError();
    }
    return {
      version: PROJECT_ACTOR_CONTRACT_VERSION,
      actorType: 'apikey',
      source: 'project_api_key',
      projectId: value.projectId,
      subject: value.subject,
      role: 'anon',
      apiKeyId: value.apiKeyId as number,
      apiKeyPrefix: value.apiKeyPrefix,
    };
  }

  throw new ProjectActorRequiredError();
}

function isValidApiKeyIdentity(user: ApiKeyIdentity): boolean {
  return Number.isSafeInteger(user.apiKeyId)
    && user.apiKeyId > 0
    && isValidString(user.apiKeyPrefix)
    && user.apiKeyPrefix.length <= 12;
}

export function resolveScopedProjectActor(
  user: RequestUser,
  projectId: string
): Extract<ProjectActorContext, { actorType: 'project_user' | 'apikey' }> {
  if (user.kind !== 'project_user' && user.kind !== 'apikey') {
    throw new ProjectActorRequiredError();
  }
  if (user.projectId !== projectId) {
    throw new ProjectActorScopeError();
  }

  if (user.kind === 'project_user') {
    if (!isValidString(user.sub) || !isValidString(user.provider)) {
      throw new ProjectActorRequiredError();
    }
    return {
      version: PROJECT_ACTOR_CONTRACT_VERSION,
      actorType: 'project_user',
      source: 'project_session',
      projectId,
      subject: `project_user:${user.sub}`,
      role: 'authenticated',
      projectUserId: user.sub,
      provider: user.provider,
    };
  }

  if (!isValidApiKeyIdentity(user)) {
    throw new ProjectActorRequiredError();
  }
  return {
    version: PROJECT_ACTOR_CONTRACT_VERSION,
    actorType: 'apikey',
    source: 'project_api_key',
    projectId,
    subject: `apikey:${user.apiKeyId}`,
    role: 'anon',
    apiKeyId: user.apiKeyId,
    apiKeyPrefix: user.apiKeyPrefix,
  };
}

export function resolvePlatformProjectActor(
  user: RequestUser,
  projectId: string
): Extract<ProjectActorContext, { actorType: 'platform_user' }> {
  if (
    user.kind !== 'platform_user'
    || !isValidString(user.userId)
    || !Number.isSafeInteger(user.uid)
    || user.uid <= 0
  ) {
    throw new ProjectActorRequiredError();
  }

  return {
    version: PROJECT_ACTOR_CONTRACT_VERSION,
    actorType: 'platform_user',
    source: 'platform_session',
    projectId,
    subject: `platform_user:${user.userId}`,
    role: user.role ?? 'authenticated',
    platformUserId: user.userId,
    platformUid: user.uid,
    ...(user.tenantId ? { tenantId: user.tenantId } : {}),
  };
}

export function toProjectActorAuditContext(actor: ProjectActorContext) {
  return {
    actorType: actor.actorType,
    actorSource: actor.source,
    actorSubject: actor.subject,
    projectId: actor.projectId,
    ...(actor.actorType === 'platform_user'
      ? { platformUserId: actor.platformUserId }
      : {}),
    ...(actor.actorType === 'project_user'
      ? { projectUserId: actor.projectUserId }
      : {}),
    ...(actor.actorType === 'apikey'
      ? { apiKeyId: actor.apiKeyId, apiKeyPrefix: actor.apiKeyPrefix }
      : {}),
  };
}

export function toProjectActorClaims(actor: ProjectActorContext) {
  return {
    sub: actor.subject,
    role: actor.role,
    project_id: actor.projectId,
    actor_type: actor.actorType,
    actor_source: actor.source,
    ...(actor.actorType === 'platform_user'
      ? {
          platform_user_id: actor.platformUserId,
          platform_uid: actor.platformUid,
          ...(actor.tenantId ? { tenant_id: actor.tenantId } : {}),
        }
      : {}),
    ...(actor.actorType === 'project_user'
      ? {
          project_user_id: actor.projectUserId,
          provider: actor.provider,
        }
      : {}),
    ...(actor.actorType === 'apikey'
      ? {
          api_key_id: actor.apiKeyId,
          api_key_prefix: actor.apiKeyPrefix,
        }
      : {}),
  };
}

export function toProjectActorHeaders(actor: ProjectActorContext): Record<string, string> {
  return {
    'x-druvia-actor-type': actor.actorType,
    'x-druvia-actor-source': actor.source,
    'x-druvia-actor-subject': actor.subject,
    'x-druvia-project-id': actor.projectId,
    ...(actor.actorType === 'platform_user'
      ? { 'x-druvia-platform-user-id': actor.platformUserId }
      : {}),
    ...(actor.actorType === 'project_user'
      ? { 'x-druvia-project-user-id': actor.projectUserId }
      : {}),
    ...(actor.actorType === 'apikey'
      ? {
          'x-druvia-api-key-id': String(actor.apiKeyId),
          'x-druvia-api-key-prefix': actor.apiKeyPrefix,
        }
      : {}),
  };
}

export type { ApiKeyIdentity, PlatformJwtUser, ProjectJwtUser };
