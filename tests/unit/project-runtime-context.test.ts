import { beforeEach, describe, expect, it, vi } from 'vitest'

const { queryOneMock } = vi.hoisted(() => ({
  queryOneMock: vi.fn(),
}))

vi.mock('../../apps/api/src/db/index.js', () => ({
  queryOne: queryOneMock,
  getClient: vi.fn(),
  query: vi.fn(),
}))

vi.mock('../../apps/api/src/modules/activity/activity.service.js', () => ({
  logActivity: vi.fn(),
}))

import {
  getRuntimeContextHasuraSessionVariables,
  ProjectRuntimeContextError,
  getProjectRuntimeContext,
} from '../../apps/api/src/modules/project/project-runtime-context.service.js'

describe('project runtime context', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('keeps a project without a context record in compatibility mode', async () => {
    queryOneMock.mockResolvedValueOnce(null)

    await expect(getProjectRuntimeContext('proj_legacy')).resolves.toEqual({ enabled: false })
    expect(queryOneMock).toHaveBeenCalledWith(
      expect.stringContaining('druvia_project_runtime_contexts'),
      ['proj_legacy'],
    )
  })

  it('fails closed when the runtime context query is unavailable', async () => {
    queryOneMock.mockRejectedValueOnce(new Error('database unavailable'))

    await expect(getProjectRuntimeContext('proj_unavailable')).rejects.toMatchObject<ProjectRuntimeContextError>({
      code: 'PROJECT_RUNTIME_CONTEXT_UNAVAILABLE',
      statusCode: 503,
    })
  })

  it('returns the server-managed environment and revision for a configured project', async () => {
    queryOneMock.mockResolvedValueOnce({
      service_environment: 'sandbox',
      revision: '4',
      updated_at: new Date('2026-09-21T08:00:00.000Z'),
    })

    await expect(getProjectRuntimeContext('proj_global')).resolves.toEqual({
      enabled: true,
      serviceEnvironment: 'sandbox',
      revision: 4,
      updatedAt: '2026-09-21T08:00:00.000Z',
    })
  })

  it.each([
    { service_environment: 'preview', revision: '1', updated_at: new Date() },
    { service_environment: 'sandbox', revision: '0', updated_at: new Date() },
    { service_environment: 'sandbox', revision: '1', updated_at: null },
  ])('fails closed for invalid persisted configuration %#', async (row) => {
    queryOneMock.mockResolvedValueOnce(row)

    await expect(getProjectRuntimeContext('proj_invalid')).rejects.toMatchObject<ProjectRuntimeContextError>({
      code: 'PROJECT_RUNTIME_CONTEXT_UNAVAILABLE',
      statusCode: 503,
    })
  })

  it('derives the Hasura environment variable only from an enabled context', () => {
    expect(getRuntimeContextHasuraSessionVariables({ enabled: false })).toEqual({})
    expect(getRuntimeContextHasuraSessionVariables({
      enabled: true,
      serviceEnvironment: 'sandbox',
      revision: 1,
      updatedAt: '2026-09-21T08:00:00.000Z',
    })).toEqual({
      'x-hasura-druvia-service-environment': 'sandbox',
    })
  })
})
