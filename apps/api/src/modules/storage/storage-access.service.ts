export type StorageProjectUserAccess = 'admin_only' | 'owner_only' | 'authenticated_read';
export type StorageObjectOperation = 'read' | 'write' | 'delete';
const STORAGE_PROJECT_USER_ACCESS_VALUES = new Set<StorageProjectUserAccess>([
  'admin_only', 'owner_only', 'authenticated_read',
]);

export function normalizeStorageProjectUserAccess(value: unknown): StorageProjectUserAccess {
  if (typeof value !== 'string' || !STORAGE_PROJECT_USER_ACCESS_VALUES.has(value as StorageProjectUserAccess)) {
    throw new StorageAccessError('INVALID_STORAGE_ACCESS', 'Invalid project user access preset', 400);
  }
  return value as StorageProjectUserAccess;
}

export type StorageActor =
  | { actorType: 'platform_user'; projectId: string; platformUserId: string }
  | { actorType: 'project_user'; projectId: string; projectUserId: string }
  | { actorType: 'apikey'; projectId: string };

export class StorageAccessError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly statusCode: number
  ) {
    super(message);
    this.name = 'StorageAccessError';
  }
}

export interface StorageAccessDecisionInput {
  preset: StorageProjectUserAccess;
  actor: StorageActor;
  operation: StorageObjectOperation;
  objectExists?: boolean;
  objectOwnerProjectUserId?: string | null;
}

export interface StorageAccessDecision {
  visible: boolean;
  writable: boolean;
  ownerProjectUserId?: string;
}

export function assertStorageActorProject(actor: StorageActor, projectId: string): void {
  if (actor.projectId !== projectId) {
    throw new StorageAccessError(
      'PROJECT_SCOPE_MISMATCH',
      'Project credential belongs to another project',
      403
    );
  }
}

export function decideStorageObjectAccess(input: StorageAccessDecisionInput): StorageAccessDecision {
  if (input.actor.actorType === 'platform_user') {
    return { visible: true, writable: true, ownerProjectUserId: undefined };
  }
  if (input.actor.actorType === 'apikey') {
    throw new StorageAccessError(
      'PROJECT_ACTOR_REQUIRED',
      'A Project User session is required for protected storage objects',
      403
    );
  }
  if (input.preset === 'admin_only') {
    throw new StorageAccessError('STORAGE_ACCESS_DISABLED', 'Storage bucket is restricted to administrators', 403);
  }

  const ownObject = input.objectOwnerProjectUserId === input.actor.projectUserId;
  if (input.operation === 'read') {
    if (input.preset === 'authenticated_read' || ownObject) {
      return { visible: true, writable: ownObject, ownerProjectUserId: input.actor.projectUserId };
    }
    throw new StorageAccessError('OBJECT_NOT_FOUND', 'Storage object not found', 404);
  }

  if (!input.objectExists) {
    return { visible: true, writable: true, ownerProjectUserId: input.actor.projectUserId };
  }
  if (ownObject) {
    return { visible: true, writable: true, ownerProjectUserId: input.actor.projectUserId };
  }
  if (input.operation === 'write' && input.preset === 'authenticated_read') {
    throw new StorageAccessError('OBJECT_OWNERSHIP_CONFLICT', 'Storage object is owned by another user', 409);
  }
  throw new StorageAccessError('OBJECT_NOT_FOUND', 'Storage object not found', 404);
}

export function storageOwnerFilter(
  preset: StorageProjectUserAccess,
  actor: StorageActor
): string | undefined {
  if (actor.actorType === 'platform_user') return undefined;
  if (actor.actorType === 'apikey' || preset === 'admin_only') {
    decideStorageObjectAccess({ preset, actor, operation: 'read' });
  }
  return preset === 'owner_only' && actor.actorType === 'project_user'
    ? actor.projectUserId
    : undefined;
}
