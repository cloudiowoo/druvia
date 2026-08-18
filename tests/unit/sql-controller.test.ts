import { beforeEach, describe, expect, it, vi } from 'vitest'

const { withProjectLock } = vi.hoisted(() => ({ withProjectLock: vi.fn() }))

vi.mock('../../apps/api/src/modules/sql/sql.service.js', () => ({ importSql: vi.fn() }))
vi.mock('../../apps/api/src/modules/project/project.service.js', () => ({ getProjectById: vi.fn() }))
vi.mock('../../apps/api/src/lib/access.js', () => ({ checkProjectAccess: vi.fn() }))
vi.mock('../../apps/api/src/modules/data-access/data-access-mutation-lock.js', () => {
  class DataAccessMutationLockedError extends Error {
    readonly code = 'DATA_ACCESS_MIGRATION_IN_PROGRESS'
  }
  return { DataAccessMutationLockedError, withProjectDataAccessMutationLock: withProjectLock }
})

import { checkProjectAccess } from '../../apps/api/src/lib/access.js'
import { DataAccessMutationLockedError } from '../../apps/api/src/modules/data-access/data-access-mutation-lock.js'
import * as projectService from '../../apps/api/src/modules/project/project.service.js'
import * as sqlService from '../../apps/api/src/modules/sql/sql.service.js'
import { importSql } from '../../apps/api/src/modules/sql/sql.controller.js'

function replyStub() {
  const reply = { status: vi.fn(), send: vi.fn() }
  reply.status.mockReturnValue(reply)
  reply.send.mockReturnValue(reply)
  return reply
}

describe('SQL import migration lock', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(projectService.getProjectById).mockResolvedValue({
      projectId: 'proj_1', schemaName: 'dru_project',
    } as never)
    vi.mocked(checkProjectAccess).mockResolvedValue(true)
    vi.mocked(sqlService.importSql).mockResolvedValue({ executed: 1, errors: [] } as never)
    withProjectLock.mockImplementation(async (_projectId, callback) => callback())
  })

  it('runs JSON imports inside the deployment-wide exclusive project lock', async () => {
    const reply = replyStub()
    await importSql({
      params: { projectId: 'proj_1' }, body: { sql: 'CREATE TABLE orders(id int)', atomic: true },
      headers: { 'content-type': 'application/json' }, user: { userId: 'usr_1' },
    } as never, reply as never)

    expect(withProjectLock).toHaveBeenCalledWith(
      'proj_1', expect.any(Function), { globalMode: 'exclusive' }
    )
    expect(sqlService.importSql).toHaveBeenCalledWith(
      'dru_project', 'CREATE TABLE orders(id int)', { atomic: true }
    )
  })

  it('maps lock conflicts without exposing internal details', async () => {
    withProjectLock.mockRejectedValue(new DataAccessMutationLockedError('busy'))
    const reply = replyStub()

    await importSql({
      params: { projectId: 'proj_1' }, body: { sql: 'SELECT 1' },
      headers: { 'content-type': 'application/json' }, user: { userId: 'usr_1' },
    } as never, reply as never)

    expect(reply.status).toHaveBeenCalledWith(409)
    expect(reply.send).toHaveBeenCalledWith(expect.objectContaining({
      error: expect.objectContaining({ code: 'DATA_ACCESS_MIGRATION_IN_PROGRESS' }),
    }))
  })
})
