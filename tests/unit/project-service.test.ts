import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../apps/api/src/db/index.js', () => ({
  query: vi.fn(),
  queryOne: vi.fn(),
  pool: {},
}))

vi.mock('../../apps/api/src/modules/schema/schema.service.js', () => ({
  createSchema: vi.fn(),
  dropSchema: vi.fn(),
}))

vi.mock('../../apps/api/src/modules/environment/environment.service.js', () => ({
  listEnvironments: vi.fn(),
}))

vi.mock('../../apps/api/src/modules/project/db-credentials.service.js', () => ({
  dropProjectDbUser: vi.fn(),
}))

import { queryOne } from '../../apps/api/src/db/index.js'
import { updateProject } from '../../apps/api/src/modules/project/project.service.js'

const mockQueryOne = vi.mocked(queryOne)

describe('Project Service', () => {
  beforeEach(() => {
    vi.clearAllMocks()
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
})
