import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../apps/api/src/db/index.js', () => ({
  query: vi.fn(),
  queryOne: vi.fn(),
  pool: {},
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

import { query, queryOne } from '../../apps/api/src/db/index.js'
import * as schemaService from '../../apps/api/src/modules/schema/schema.service.js'
import * as environmentService from '../../apps/api/src/modules/environment/environment.service.js'
import * as dbCredentialsService from '../../apps/api/src/modules/project/db-credentials.service.js'
import { getDefaultStorageAdapter } from '../../apps/api/src/adapters/storage/index.js'
import { deleteProject, updateProject } from '../../apps/api/src/modules/project/project.service.js'

const mockQuery = vi.mocked(query)
const mockQueryOne = vi.mocked(queryOne)
const mockDropSchema = vi.mocked(schemaService.dropSchema)
const mockListEnvironments = vi.mocked(environmentService.listEnvironments)
const mockDropProjectDbUser = vi.mocked(dbCredentialsService.dropProjectDbUser)
const mockGetDefaultStorageAdapter = vi.mocked(getDefaultStorageAdapter)

describe('Project Service', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockQuery.mockResolvedValue([])
    mockListEnvironments.mockResolvedValue([])
    mockDropSchema.mockResolvedValue(undefined)
    mockDropProjectDbUser.mockResolvedValue(false)
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
