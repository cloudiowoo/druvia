import { beforeEach, describe, expect, it, vi } from 'vitest'

const { mockDbClient, mockPoolConnect } = vi.hoisted(() => {
  const mockDbClient = {
    query: vi.fn(),
    release: vi.fn(),
  }
  return {
    mockDbClient,
    mockPoolConnect: vi.fn(),
  }
})

vi.mock('../../apps/api/src/db/index.js', () => ({
  query: vi.fn(),
  queryOne: vi.fn(),
  pool: { connect: mockPoolConnect },
}))

vi.mock('../../apps/api/src/modules/schema/schema.service.js', () => ({
  createProjectSchema: vi.fn(),
  dropSchema: vi.fn(),
}))

vi.mock('../../apps/api/src/modules/environment/environment.service.js', () => ({
  listEnvironments: vi.fn(),
}))

vi.mock('../../apps/api/src/modules/project/db-credentials.service.js', () => ({
  dropProjectDbUser: vi.fn(),
}))

vi.mock('../../apps/api/src/modules/realtime/realtime.service.js', () => ({
  hasuraMetadataRequest: vi.fn(),
}))

vi.mock('../../apps/api/src/adapters/storage/index.js', () => ({
  getDefaultStorageAdapter: vi.fn(),
}))

vi.mock('../../apps/api/src/lib/logger.js', () => ({
  createApiLogger: vi.fn(() => ({
    warn: vi.fn(),
    error: vi.fn(),
  })),
}))

vi.mock('../../apps/api/src/modules/data-access/data-access-mutation-lock.js', () => ({
  withProjectDataAccessMutationLock: vi.fn(async (_projectId, callback) => callback({ query: vi.fn() })),
}))

vi.mock('../../apps/api/src/modules/project-auth/project-identity.repository.js', () => ({
  assertProjectAuthProjectDeletionAllowed: vi.fn(),
  withProjectAuthProjectLock: vi.fn(async (_client, _projectId, callback) => callback()),
}))

import { query, queryOne } from '../../apps/api/src/db/index.js'
import * as schemaService from '../../apps/api/src/modules/schema/schema.service.js'
import * as environmentService from '../../apps/api/src/modules/environment/environment.service.js'
import * as dbCredentialsService from '../../apps/api/src/modules/project/db-credentials.service.js'
import { getDefaultStorageAdapter } from '../../apps/api/src/adapters/storage/index.js'
import * as mutationLock from '../../apps/api/src/modules/data-access/data-access-mutation-lock.js'
import * as projectIdentityRepository from '../../apps/api/src/modules/project-auth/project-identity.repository.js'
import {
  createProject,
  deleteProject,
  executeQuery,
  getProjectById,
  updateProject,
} from '../../apps/api/src/modules/project/project.service.js'

const mockQuery = vi.mocked(query)
const mockQueryOne = vi.mocked(queryOne)
const mockDropSchema = vi.mocked(schemaService.dropSchema)
const mockListEnvironments = vi.mocked(environmentService.listEnvironments)
const mockDropProjectDbUser = vi.mocked(dbCredentialsService.dropProjectDbUser)
const mockGetDefaultStorageAdapter = vi.mocked(getDefaultStorageAdapter)
const mockAssertProjectAuthProjectDeletionAllowed = vi.mocked(
  projectIdentityRepository.assertProjectAuthProjectDeletionAllowed
)
const mockWithProjectAuthProjectLock = vi.mocked(
  projectIdentityRepository.withProjectAuthProjectLock
)

function projectRow(dataAccessMode?: string) {
  return {
    id: 1,
    project_id: 'proj_123',
    tenant_id: 'tenant_123',
    alias: 'demo',
    name: 'Demo',
    schema_name: 'dru_demo',
    settings: {},
    status: 'active',
    data_access_mode: dataAccessMode,
    created_at: new Date(),
    updated_at: new Date(),
  }
}

describe('Project Service', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockQuery.mockResolvedValue([])
    mockListEnvironments.mockResolvedValue([])
    mockDropSchema.mockResolvedValue(undefined)
    mockDropProjectDbUser.mockResolvedValue(false)
    mockPoolConnect.mockResolvedValue(mockDbClient)
    mockGetDefaultStorageAdapter.mockReturnValue({
      name: 'local',
      upload: vi.fn(),
      download: vi.fn(),
      delete: vi.fn(),
      exists: vi.fn(),
      getPublicUrl: vi.fn(),
      getSignedUrl: vi.fn(),
      list: vi.fn().mockResolvedValue([]),
    })
  })

  it('executes viewer SQL as one statement inside a read-only transaction', async () => {
    mockQueryOne.mockResolvedValueOnce(projectRow('explicit'))
    mockDbClient.query.mockImplementation(async (statement: unknown) => {
      const text = typeof statement === 'string'
        ? statement
        : (statement as { text: string }).text
      if (text.startsWith("SELECT format('SET LOCAL search_path")) {
        return { rows: [{ sql: 'SET LOCAL search_path TO dru_demo, public' }], fields: [], rowCount: 1 }
      }
      if (typeof statement === 'object' && text === 'WITH rows AS (SELECT 1 AS id) SELECT * FROM rows') {
        return {
          rows: [{ id: 1 }],
          fields: [{ name: 'id', dataTypeID: 23 }],
          rowCount: 1,
        }
      }
      return { rows: [], fields: [], rowCount: 0 }
    })

    await executeQuery('proj_123', 'WITH rows AS (SELECT 1 AS id) SELECT * FROM rows')

    expect(mockDbClient.query).toHaveBeenCalledWith('BEGIN READ ONLY')
    expect(mockDbClient.query).toHaveBeenCalledWith(expect.objectContaining({
      text: 'WITH rows AS (SELECT 1 AS id) SELECT * FROM rows',
      queryMode: 'extended',
    }))
    expect(mockDbClient.query).toHaveBeenCalledWith('COMMIT')
    expect(mockDbClient.release).toHaveBeenCalledOnce()
  })

  it.each([
    { stored: 'explicit', expected: 'explicit' },
    { stored: 'compatibility', expected: 'compatibility' },
    { stored: 'unknown', expected: 'compatibility' },
    { stored: undefined, expected: 'compatibility' },
  ])('normalizes project data access mode $stored to $expected', async ({ stored, expected }) => {
    mockQueryOne.mockResolvedValueOnce(projectRow(stored))

    const project = await getProjectById('proj_123')

    expect(project?.dataAccessMode).toBe(expected)
  })

  it('creates new projects in explicit data access mode', async () => {
    mockQueryOne
      .mockResolvedValueOnce({
        id: 1,
        tenant_id: 'tenant_123',
        alias: 'tenant-demo',
        name: 'Tenant Demo',
        owner_uid: 1,
        plan: 'free',
        settings: {},
        status: 'active',
        description: null,
        storage_limit: 0,
        project_limit: 10,
        user_limit: 10,
        created_at: new Date(),
        updated_at: new Date(),
      })
      .mockResolvedValueOnce(projectRow('explicit'))
    vi.mocked(schemaService.createProjectSchema).mockResolvedValueOnce('dru_demo')

    const project = await createProject({
      tenantId: 'tenant_123',
      alias: 'demo',
      name: 'Demo',
    })

    expect(mockQueryOne).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining('data_access_mode'),
      expect.arrayContaining(['explicit'])
    )
    expect(project.dataAccessMode).toBe('explicit')
  })

  it('removes the pending project row when schema creation is rejected', async () => {
    mockQueryOne
      .mockResolvedValueOnce({
        id: 1,
        tenant_id: 'tenant_123',
        alias: 'tenant-demo',
        name: 'Tenant Demo',
        owner_uid: 1,
        plan: 'free',
        settings: {},
        status: 'active',
        description: null,
        storage_limit: 0,
        project_limit: 10,
        user_limit: 10,
        created_at: new Date(),
        updated_at: new Date(),
      })
      .mockResolvedValueOnce(projectRow('explicit'))
    vi.mocked(schemaService.createProjectSchema).mockRejectedValueOnce(
      Object.assign(new Error('schema conflict'), { code: 'PROJECT_SCHEMA_CONFLICT' }),
    )

    await expect(createProject({
      tenantId: 'tenant_123',
      alias: 'demo',
      name: 'Demo',
    })).rejects.toMatchObject({ code: 'PROJECT_SCHEMA_CONFLICT' })

    expect(mockQuery).toHaveBeenCalledWith(
      'DELETE FROM druvia_projects WHERE project_id = $1 AND schema_name IS NULL',
      [expect.stringMatching(/^proj_/)],
    )
  })

  it('merges settings at the top level when updating a project', async () => {
    mockQueryOne.mockResolvedValue({
      id: 1,
      project_id: 'proj_123',
      tenant_id: 'tenant_123',
      alias: 'demo',
      name: 'Demo',
      schema_name: 'dru_demo',
      settings: { featureFlags: { betaDashboard: true } },
      status: 'active',
      created_at: new Date(),
      updated_at: new Date(),
    })

    await updateProject('proj_123', {
      settings: {
        rateLimits: { graphql: { perUser: 200, perProject: 1000 } },
      },
    })

    expect(mockQueryOne).toHaveBeenCalledWith(
      expect.stringContaining(`settings = COALESCE(settings, '{}'::jsonb) || $1::jsonb`),
      [JSON.stringify({ rateLimits: { graphql: { perUser: 200, perProject: 1000 } } }), 'proj_123']
    )
  })

  it('stops project deletion when dropping the project db user fails', async () => {
    const storage = mockGetDefaultStorageAdapter.mock.results[0]?.value ?? mockGetDefaultStorageAdapter()
    mockQueryOne.mockResolvedValue({
      id: 1,
      project_id: 'proj_123',
      tenant_id: 'tenant_123',
      alias: 'demo',
      name: 'Demo',
      schema_name: 'dru_demo',
      settings: {},
      status: 'active',
      created_at: new Date(),
      updated_at: new Date(),
    })
    mockDropProjectDbUser.mockRejectedValue(new Error('role is still in use'))

    await expect(deleteProject('proj_123')).rejects.toThrow('role is still in use')

    expect(mockDropSchema).not.toHaveBeenCalled()
    expect(storage.list).not.toHaveBeenCalled()
    expect(mockQuery).not.toHaveBeenCalledWith(
      expect.stringContaining('DELETE FROM druvia_projects'),
      expect.anything()
    )
  })

  it('runs the Apple decommission gate before any project deletion side effect', async () => {
    const storage = mockGetDefaultStorageAdapter.mock.results[0]?.value ?? mockGetDefaultStorageAdapter()
    mockQueryOne.mockResolvedValue(projectRow('explicit'))
    mockAssertProjectAuthProjectDeletionAllowed.mockRejectedValueOnce(
      new Error('PROVIDER_DECOMMISSION_REQUIRED')
    )

    await expect(deleteProject('proj_123')).rejects.toThrow('PROVIDER_DECOMMISSION_REQUIRED')

    expect(mockAssertProjectAuthProjectDeletionAllowed).toHaveBeenCalledWith('proj_123')
    expect(mockWithProjectAuthProjectLock).toHaveBeenCalledWith(
      expect.anything(), 'proj_123', expect.any(Function)
    )
    expect(mockDropProjectDbUser).not.toHaveBeenCalled()
    expect(mockListEnvironments).not.toHaveBeenCalled()
    expect(mockDropSchema).not.toHaveBeenCalled()
    expect(storage.list).not.toHaveBeenCalled()
  })

  it('checks the exclusive migration lock before loading destructive cleanup state', async () => {
    const failure = new Error('migration active')
    vi.mocked(mutationLock.withProjectDataAccessMutationLock).mockRejectedValueOnce(failure)

    await expect(deleteProject('proj_123')).rejects.toBe(failure)

    expect(mutationLock.withProjectDataAccessMutationLock).toHaveBeenCalledWith(
      'proj_123', expect.any(Function), { globalMode: 'exclusive' }
    )
    expect(mockQueryOne).not.toHaveBeenCalled()
    expect(mockDropProjectDbUser).not.toHaveBeenCalled()
    expect(mockDropSchema).not.toHaveBeenCalled()
  })

  it('cleans physical artifacts only after schema and db user cleanup succeeds', async () => {
    const storage = {
      name: 'local',
      upload: vi.fn(),
      download: vi.fn(),
      delete: vi.fn(),
      exists: vi.fn(),
      getPublicUrl: vi.fn(),
      getSignedUrl: vi.fn(),
      list: vi.fn()
        .mockResolvedValueOnce(['proj_123/team-assets/avatar.png'])
        .mockResolvedValueOnce(['tenant_123/proj_123/legacy-assets/legacy.txt']),
    }
    mockGetDefaultStorageAdapter.mockReturnValue(storage)
    mockQueryOne.mockResolvedValue({
      id: 1,
      project_id: 'proj_123',
      tenant_id: 'tenant_123',
      alias: 'demo',
      name: 'Demo',
      schema_name: 'dru_demo',
      settings: {},
      status: 'active',
      created_at: new Date(),
      updated_at: new Date(),
    })
    mockListEnvironments.mockResolvedValue([{ schemaName: 'dru_demo_dev' }] as never)
    mockQuery.mockImplementation(async (sql: string) => {
      if (sql.includes('SELECT table_name FROM information_schema.tables')) {
        return []
      }
      if (sql.includes('FROM druvia_backups')) {
        return [{ storage_key: 'backups/tenant_123/bkp_1.dump' }]
      }
      if (sql.includes('DELETE FROM druvia_projects')) {
        return [{ project_id: 'proj_123' }]
      }
      return []
    })

    const deleted = await deleteProject('proj_123')

    expect(deleted).toBe(true)
    expect(mutationLock.withProjectDataAccessMutationLock).toHaveBeenCalledWith(
      'proj_123', expect.any(Function), { globalMode: 'exclusive' }
    )
    expect(mockDropProjectDbUser.mock.invocationCallOrder[0]).toBeLessThan(mockDropSchema.mock.invocationCallOrder[0])
    expect(mockDropSchema).toHaveBeenCalledWith('dru_demo_dev')
    expect(mockDropSchema).toHaveBeenCalledWith('dru_demo')
    expect(mockDropProjectDbUser).toHaveBeenCalledWith('proj_123')
    expect(mockDropProjectDbUser.mock.invocationCallOrder[0]).toBeLessThan(storage.list.mock.invocationCallOrder[0])
    expect(storage.delete).toHaveBeenCalledWith('proj_123/team-assets/avatar.png')
    expect(storage.delete).toHaveBeenCalledWith('tenant_123/proj_123/legacy-assets/legacy.txt')
    expect(storage.delete).toHaveBeenCalledWith('backups/tenant_123/bkp_1.dump')
  })
})
