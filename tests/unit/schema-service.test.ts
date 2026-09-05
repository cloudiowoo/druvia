import { beforeEach, describe, expect, it, vi } from 'vitest'

const { connect, clientQuery, release } = vi.hoisted(() => ({
  connect: vi.fn(),
  clientQuery: vi.fn(),
  release: vi.fn(),
}))

vi.mock('../../apps/api/src/db/index.js', () => ({
  pool: { connect },
  query: vi.fn(),
  queryOne: vi.fn(),
  execute: vi.fn(),
}))

import { createProjectSchema } from '../../apps/api/src/modules/schema/schema.service.js'

describe('project schema creation', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    connect.mockResolvedValue({ query: clientQuery, release })
  })

  it('rejects a project schema already used by an environment before reusing it', async () => {
    clientQuery
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ rows: [{ assigned: true, schema_exists: true }] })

    await expect(createProjectSchema(
      'tenant_1', 'tenant', 'proj_new', 'app_dev',
    )).rejects.toMatchObject({ code: 'PROJECT_SCHEMA_CONFLICT' })

    expect(clientQuery).toHaveBeenCalledWith(
      expect.stringContaining('pg_advisory_xact_lock'),
      ['dru_tenant_app_dev'],
    )
    expect(clientQuery).not.toHaveBeenCalledWith(
      expect.stringContaining('CREATE SCHEMA'),
    )
    expect(clientQuery).toHaveBeenCalledWith('ROLLBACK')
    expect(release).toHaveBeenCalled()
  })
})
