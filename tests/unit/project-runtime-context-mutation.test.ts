import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  createProjectRuntimeContextService,
  ProjectRuntimeContextNotFoundError,
} from '../../apps/api/src/modules/project/project-runtime-context.service.js'

const clientQuery = vi.fn()
const clientRelease = vi.fn()
const getClient = vi.fn()
const logActivity = vi.fn()

const service = createProjectRuntimeContextService({
  queryOne: vi.fn(),
  getClient,
  logActivity,
})

describe('project runtime context mutations', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    getClient.mockResolvedValue({ query: clientQuery, release: clientRelease })
    clientQuery.mockResolvedValue({ rows: [] })
    logActivity.mockResolvedValue(undefined)
  })

  it('serializes a managed environment update with project locking and an audit event', async () => {
    clientQuery.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM druvia_projects') && sql.includes('FOR UPDATE')) {
        return { rows: [{ project_id: 'proj_global' }] }
      }
      if (sql.includes('FROM druvia_project_runtime_contexts') && sql.includes('FOR UPDATE')) {
        return { rows: [{ service_environment: 'local', revision: '2', updated_at: new Date('2026-09-21T07:00:00.000Z') }] }
      }
      if (sql.startsWith('INSERT INTO druvia_project_runtime_contexts')) {
        return { rows: [{ service_environment: 'sandbox', revision: '3', updated_at: new Date('2026-09-21T08:00:00.000Z') }] }
      }
      return { rows: [] }
    })

    await expect(service.setProjectRuntimeContext({
      projectId: 'proj_global',
      serviceEnvironment: 'sandbox',
      actorUserId: 'usr_owner',
      requestId: 'req_runtime_1',
    })).resolves.toEqual({
      enabled: true,
      serviceEnvironment: 'sandbox',
      revision: 3,
      updatedAt: '2026-09-21T08:00:00.000Z',
    })

    expect(clientQuery.mock.calls.map(([sql]) => sql)).toEqual([
      'BEGIN',
      expect.stringContaining('FROM druvia_projects'),
      expect.stringContaining('FROM druvia_project_runtime_contexts'),
      expect.stringContaining('INSERT INTO druvia_project_runtime_contexts'),
      expect.stringContaining('INSERT INTO druvia_project_runtime_context_fences'),
      'COMMIT',
    ])
    expect(logActivity).toHaveBeenCalledWith(
      'usr_owner',
      'project.runtime_context_updated',
      'project',
      'proj_global',
      {
        oldServiceEnvironment: 'local',
        serviceEnvironment: 'sandbox',
        revision: 3,
        requestId: 'req_runtime_1',
      },
      expect.objectContaining({ query: clientQuery }),
    )
  })

  it('does not rewrite or audit an idempotent environment update', async () => {
    clientQuery.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM druvia_projects') && sql.includes('FOR UPDATE')) {
        return { rows: [{ project_id: 'proj_global' }] }
      }
      if (sql.includes('FROM druvia_project_runtime_contexts') && sql.includes('FOR UPDATE')) {
        return { rows: [{ service_environment: 'sandbox', revision: '3', updated_at: new Date('2026-09-21T08:00:00.000Z') }] }
      }
      return { rows: [] }
    })

    await expect(service.setProjectRuntimeContext({
      projectId: 'proj_global',
      serviceEnvironment: 'sandbox',
      actorUserId: 'usr_owner',
    })).resolves.toEqual({
      enabled: true,
      serviceEnvironment: 'sandbox',
      revision: 3,
      updatedAt: '2026-09-21T08:00:00.000Z',
    })

    expect(clientQuery).not.toHaveBeenCalledWith(expect.stringContaining('INSERT INTO druvia_project_runtime_contexts'))
    expect(logActivity).not.toHaveBeenCalled()
  })

  it('fails without a project row before it writes configuration or audit state', async () => {
    clientQuery.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM druvia_projects') && sql.includes('FOR UPDATE')) return { rows: [] }
      return { rows: [] }
    })

    await expect(service.setProjectRuntimeContext({
      projectId: 'proj_missing',
      serviceEnvironment: 'sandbox',
      actorUserId: 'usr_owner',
    })).rejects.toBeInstanceOf(ProjectRuntimeContextNotFoundError)

    expect(logActivity).not.toHaveBeenCalled()
    expect(clientQuery.mock.calls.map(([sql]) => sql)).toContain('ROLLBACK')
  })

  it('disables a configured context atomically and records its prior environment', async () => {
    clientQuery.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM druvia_projects') && sql.includes('FOR UPDATE')) {
        return { rows: [{ project_id: 'proj_global' }] }
      }
      if (sql.includes('FROM druvia_project_runtime_contexts') && sql.includes('FOR UPDATE')) {
        return { rows: [{ service_environment: 'sandbox', revision: '3', updated_at: new Date('2026-09-21T08:00:00.000Z') }] }
      }
      return { rows: [] }
    })

    await expect(service.disableProjectRuntimeContext({
      projectId: 'proj_global',
      actorUserId: 'usr_owner',
      requestId: 'req_runtime_2',
    })).resolves.toEqual({ enabled: false })

    expect(clientQuery).toHaveBeenCalledWith(
      expect.stringContaining('DELETE FROM druvia_project_runtime_contexts'),
      ['proj_global'],
    )
    expect(logActivity).toHaveBeenCalledWith(
      'usr_owner',
      'project.runtime_context_disabled',
      'project',
      'proj_global',
      {
        oldServiceEnvironment: 'sandbox',
        revision: 3,
        requestId: 'req_runtime_2',
      },
      expect.objectContaining({ query: clientQuery }),
    )
  })
})
