import { describe, expect, it } from 'vitest'
import {
  decideStorageObjectAccess,
  StorageAccessError,
} from '../../apps/api/src/modules/storage/storage-access.service.js'

const platform = { actorType: 'platform_user' as const, projectId: 'proj_1', platformUserId: 'user_1' }
const projectUser = { actorType: 'project_user' as const, projectId: 'proj_1', projectUserId: 'puser_1' }
const apiKey = { actorType: 'apikey' as const, projectId: 'proj_1' }

describe('storage object access decisions', () => {
  it.each(['admin_only', 'owner_only', 'authenticated_read'] as const)(
    'allows platform management for %s',
    (preset) => expect(decideStorageObjectAccess({ preset, actor: platform, operation: 'write' })).toEqual({
      visible: true,
      writable: true,
      ownerProjectUserId: undefined,
    })
  )

  it.each(['read', 'write', 'delete'] as const)(
    'rejects Project User %s in admin_only',
    (operation) => expect(() => decideStorageObjectAccess({
      preset: 'admin_only', actor: projectUser, operation,
    })).toThrowError(expect.objectContaining({
      code: 'STORAGE_ACCESS_DISABLED',
      statusCode: 403,
    }))
  )

  it('limits owner_only to the Project User owner', () => {
    expect(decideStorageObjectAccess({
      preset: 'owner_only', actor: projectUser, operation: 'read', objectOwnerProjectUserId: 'puser_1',
    }).visible).toBe(true)
    expect(() => decideStorageObjectAccess({
      preset: 'owner_only', actor: projectUser, operation: 'read', objectOwnerProjectUserId: 'other',
    })).toThrowError(expect.objectContaining({ statusCode: 404 }))
  })

  it('allows authenticated_read reads but rejects overwriting another owner with conflict', () => {
    expect(decideStorageObjectAccess({
      preset: 'authenticated_read', actor: projectUser, operation: 'read', objectOwnerProjectUserId: 'other',
    }).visible).toBe(true)
    expect(() => decideStorageObjectAccess({
      preset: 'authenticated_read', actor: projectUser, operation: 'write', objectOwnerProjectUserId: 'other',
      objectExists: true,
    })).toThrowError(expect.objectContaining({ statusCode: 409 }))
  })

  it('assigns new Project User objects to that user', () => {
    expect(decideStorageObjectAccess({
      preset: 'owner_only', actor: projectUser, operation: 'write', objectExists: false,
    }).ownerProjectUserId).toBe('puser_1')
  })

  it('rejects API keys for protected object routes', () => {
    expect(() => decideStorageObjectAccess({
      preset: 'authenticated_read', actor: apiKey, operation: 'read',
    })).toThrowError(expect.objectContaining({ code: 'PROJECT_ACTOR_REQUIRED', statusCode: 403 }))
  })
})
