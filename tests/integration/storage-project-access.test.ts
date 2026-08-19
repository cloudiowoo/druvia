import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { pool } from '../../apps/api/src/db/index.js'
import * as storageService from '../../apps/api/src/modules/storage/storage.service.js'
import * as projectService from '../../apps/api/src/modules/project/project.service.js'
import * as tenantService from '../../apps/api/src/modules/tenant/tenant.service.js'

describe('Storage Project User access integration', () => {
  let tenantId: string
  let projectId: string
  let ownerBucket: storageService.Bucket
  let readableBucket: storageService.Bucket

  const owner = { actorType: 'project_user' as const, projectId: '', projectUserId: 'puser_owner' }
  const other = { actorType: 'project_user' as const, projectId: '', projectUserId: 'puser_other' }
  const platform = { actorType: 'platform_user' as const, projectId: '', platformUserId: 'user_storage_actor_test' }

  beforeAll(async () => {
    const user = await pool.query<{ id: number }>(`
      INSERT INTO druvia_users (user_id, email, username, status)
      VALUES ('user_storage_actor_test', 'storage-actor@test.com', 'storage_actor_test', 'active')
      ON CONFLICT (user_id) DO UPDATE SET status = 'active'
      RETURNING id
    `)
    const suffix = Date.now().toString(36).slice(-6)
    tenantId = (await tenantService.createTenant({
      alias: `stactor${suffix}`,
      name: 'Storage Actor Test',
      ownerUid: user.rows[0].id,
    })).tenantId
    projectId = (await projectService.createProject({
      tenantId,
      alias: `stproject${suffix}`,
      name: 'Storage Actor Project',
    })).projectId
    owner.projectId = projectId
    other.projectId = projectId
    platform.projectId = projectId
    ownerBucket = await storageService.createBucket(projectId, {
      name: 'owner-files', projectUserAccess: 'owner_only',
    })
    readableBucket = await storageService.createBucket(projectId, {
      name: 'shared-files', projectUserAccess: 'authenticated_read',
    })
  })

  afterAll(async () => {
    for (const bucket of [ownerBucket, readableBucket]) {
      if (!bucket) continue
      const { objects } = await storageService.listObjects(bucket.bucketId)
      for (const object of objects) {
        await storageService.deleteObject(bucket.bucketId, object.name)
      }
    }
    await pool.query(`DELETE FROM druvia_storage_objects WHERE bucket_id IN (
      SELECT bucket_id FROM druvia_storage_buckets WHERE project_id = $1
    )`, [projectId])
    await pool.query('DELETE FROM druvia_storage_buckets WHERE project_id = $1', [projectId])
    await pool.query('DELETE FROM druvia_projects WHERE project_id = $1', [projectId])
    await pool.query('DELETE FROM druvia_tenants WHERE tenant_id = $1', [tenantId])
    await pool.query("DELETE FROM druvia_users WHERE user_id = 'user_storage_actor_test'")
  })

  it('isolates owner_only rows and rejects another user overwrite', async () => {
    const object = await storageService.uploadObject(
      ownerBucket, 'avatars/a.png', Buffer.from('owner'), 'image/png',
      { createdByType: 'project_user', projectUserId: owner.projectUserId }, owner
    )
    expect(object.ownerProjectUserId).toBe(owner.projectUserId)
    expect(object.storagePath).toMatch(new RegExp(`^${projectId}/${ownerBucket.bucketId}/objects/obj_`))
    await expect(storageService.getObjectForActor(ownerBucket, object.name, owner))
      .resolves.toMatchObject({ objectId: object.objectId })
    await expect(storageService.getObjectForActor(ownerBucket, object.name, other))
      .rejects.toMatchObject({ code: 'OBJECT_NOT_FOUND', statusCode: 404 })

    const forgedReadableBucket = {
      ...ownerBucket,
      projectUserAccess: 'authenticated_read' as const,
    }
    await expect(storageService.getObjectForActor(forgedReadableBucket, object.name, other))
      .rejects.toMatchObject({ code: 'OBJECT_NOT_FOUND', statusCode: 404 })
    await expect(storageService.listObjectsForActor(forgedReadableBucket, other, {
      limit: 50,
      offset: 0,
    })).resolves.toMatchObject({ objects: [] })

    const ownList = await storageService.listObjectsForActor(ownerBucket, owner, {
      limit: 50, offset: 0,
    })
    const otherList = await storageService.listObjectsForActor(ownerBucket, other, {
      limit: 50, offset: 0,
    })
    expect(ownList.objects).toHaveLength(1)
    expect(otherList.objects).toHaveLength(0)

    await expect(storageService.uploadObject(
      ownerBucket, 'avatars/a.png', Buffer.from('other'), 'image/png',
      { createdByType: 'project_user', projectUserId: other.projectUserId }, other
    )).rejects.toMatchObject({ statusCode: 404 })
  })

  it('allows exactly one Project User to claim a new path concurrently', async () => {
    const path = 'claims/only-one.txt'
    const attempts = await Promise.allSettled([
      storageService.uploadObject(
        ownerBucket, path, Buffer.from('owner'), 'text/plain',
        { createdByType: 'project_user', projectUserId: owner.projectUserId }, owner
      ),
      storageService.uploadObject(
        ownerBucket, path, Buffer.from('other'), 'text/plain',
        { createdByType: 'project_user', projectUserId: other.projectUserId }, other
      ),
    ])
    expect(attempts.filter((attempt) => attempt.status === 'fulfilled')).toHaveLength(1)
    const rejection = attempts.find((attempt) => attempt.status === 'rejected')
    expect(rejection).toMatchObject({ reason: { statusCode: 404 } })
    const persisted = await storageService.getObject(ownerBucket.bucketId, path)
    expect([owner.projectUserId, other.projectUserId]).toContain(persisted?.ownerProjectUserId)
  })

  it('allows authenticated users to read but not overwrite or delete another owner', async () => {
    await storageService.uploadObject(
      readableBucket, 'shared/a.txt', Buffer.from('shared'), 'text/plain',
      { createdByType: 'project_user', projectUserId: owner.projectUserId }, owner
    )
    const visible = await storageService.listObjectsForActor(readableBucket, other, {
      limit: 50, offset: 0,
    })
    expect(visible.objects.map((object) => object.name)).toContain('shared/a.txt')
    await expect(storageService.uploadObject(
      readableBucket, 'shared/a.txt', Buffer.from('conflict'), 'text/plain',
      { createdByType: 'project_user', projectUserId: other.projectUserId }, other
    )).rejects.toMatchObject({ statusCode: 409 })
    await expect(storageService.deleteObject(readableBucket.bucketId, 'shared/a.txt', other))
      .rejects.toMatchObject({ statusCode: 404 })
  })

  it('preserves owner when a platform administrator overwrites an object', async () => {
    const updated = await storageService.uploadObject(
      readableBucket, 'shared/a.txt', Buffer.from('admin update'), 'text/plain',
      { createdByType: 'platform_user', platformUserId: platform.platformUserId }, platform
    )
    expect(updated.ownerProjectUserId).toBe(owner.projectUserId)
  })
})
