import { beforeEach, describe, expect, it, vi } from 'vitest'

const { query, queryOne, release, getClient } = vi.hoisted(() => {
  const query = vi.fn()
  const queryOne = vi.fn()
  const release = vi.fn()
  const getClient = vi.fn(async () => ({ query, release }))
  return { query, queryOne, release, getClient }
})

vi.mock('../../apps/api/src/db/index.js', () => ({ getClient, queryOne }))

import {
  DATA_ACCESS_GLOBAL_LOCK_ID,
  DataAccessMutationLockedError,
  projectDataAccessLockId,
  withProjectDataAccessMutationLock,
  withSchemaDataAccessMutationLock,
} from '../../apps/api/src/modules/data-access/data-access-mutation-lock.js'

describe('project data access mutation lock', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    queryOne.mockResolvedValue(null)
    query.mockImplementation(async (sql: string) => {
      if (sql.includes('pg_try_advisory')) return { rows: [{ acquired: true }] }
      if (sql.includes('SELECT EXISTS')) return { rows: [{ blocked: false }] }
      return { rows: [] }
    })
  })

  it('derives stable deployment and project lock identities', () => {
    expect(DATA_ACCESS_GLOBAL_LOCK_ID).toBe('data-access-mutation:global')
    expect(projectDataAccessLockId('proj_1')).toBe('data-access-migration:proj_1')
    expect(() => projectDataAccessLockId(' ')).toThrow('Project ID is required')
  })

  it('acquires shared-global then project-exclusive and releases in reverse order', async () => {
    const callback = vi.fn(async () => 'done')

    await expect(withProjectDataAccessMutationLock('proj_1', callback)).resolves.toBe('done')

    expect(query.mock.calls[0][0]).toContain('pg_try_advisory_lock_shared')
    expect(query.mock.calls[0][1]).toEqual([DATA_ACCESS_GLOBAL_LOCK_ID])
    expect(query.mock.calls[1][0]).toContain('pg_try_advisory_lock')
    expect(query.mock.calls[1][1]).toEqual([projectDataAccessLockId('proj_1')])
    expect(query.mock.calls[2][0]).toContain('SELECT EXISTS')
    expect(query.mock.calls.at(-2)?.[0]).toContain('pg_advisory_unlock')
    expect(query.mock.calls.at(-1)?.[0]).toContain('pg_advisory_unlock_shared')
    expect(release).toHaveBeenCalledOnce()
  })

  it('uses exclusive global mode and deployment-wide persisted-state gating', async () => {
    await withProjectDataAccessMutationLock('proj_1', async () => undefined, { globalMode: 'exclusive' })

    expect(query.mock.calls[0][0]).not.toContain('_shared')
    expect(query.mock.calls[2][0]).toContain('WHERE ($1::text IS NOT NULL)')
    expect(query.mock.calls[2][0]).toMatch(
      /FROM druvia_table_deletion_outbox\s+WHERE \(lock_scope = \$1\)/
    )
    expect(query.mock.calls[2][1]?.[0]).toBe('proj_1')
  })

  it('keeps an unresolved schema under the requested deployment-wide lock', async () => {
    const callback = vi.fn(async () => 'done')

    await expect(withSchemaDataAccessMutationLock(
      'detached_schema', callback, { globalMode: 'exclusive' }
    )).resolves.toBe('done')

    expect(callback).toHaveBeenCalledWith(null, expect.objectContaining({ query }))
    expect(query.mock.calls[0][1]).toEqual([DATA_ACCESS_GLOBAL_LOCK_ID])
    expect(query.mock.calls[1][1]).toEqual([
      projectDataAccessLockId('unresolved-schema:detached_schema'),
    ])
    expect(query.mock.calls[2][0]).toContain('WHERE ($1::text IS NOT NULL)')
    expect(query.mock.calls[2][1]?.[0]).toBe('unresolved-schema:detached_schema')
  })

  it.each([0, 1])('rejects conflict at lock acquisition %s and always releases the client', async (failedIndex) => {
    let lockIndex = 0
    query.mockImplementation(async (sql: string) => {
      if (sql.includes('pg_try_advisory')) {
        return { rows: [{ acquired: lockIndex++ !== failedIndex }] }
      }
      return { rows: [{ blocked: false }] }
    })

    await expect(withProjectDataAccessMutationLock('proj_1', async () => undefined))
      .rejects.toBeInstanceOf(DataAccessMutationLockedError)
    expect(release).toHaveBeenCalledOnce()
  })

  it('rejects persisted active or recovery-required operations for ordinary writes', async () => {
    query.mockImplementation(async (sql: string) => {
      if (sql.includes('pg_try_advisory')) return { rows: [{ acquired: true }] }
      if (sql.includes('SELECT EXISTS')) return { rows: [{ blocked: true }] }
      return { rows: [] }
    })

    await expect(withProjectDataAccessMutationLock('proj_1', async () => undefined))
      .rejects.toBeInstanceOf(DataAccessMutationLockedError)
  })

  it('requires migration identity and checks only competing persisted operations', async () => {
    await expect(withProjectDataAccessMutationLock('proj_1', async () => undefined, {
      purpose: 'migration',
    })).rejects.toThrow('Migration ID and operation ID are required')

    await withProjectDataAccessMutationLock('proj_1', async () => undefined, {
      purpose: 'migration', migrationId: 'mig_1', operationId: 'op_1',
    })
    expect(query.mock.calls.some(([sql]) => String(sql).includes('SELECT EXISTS'))).toBe(true)
    expect(query.mock.calls.find(([sql]) => String(sql).includes('SELECT EXISTS'))?.[0])
      .toContain('druvia_data_access_policy_operations')
  })

  it('blocks ordinary and new table writes on a pending deletion but lets recovery proceed', async () => {
    await withProjectDataAccessMutationLock('proj_1', async () => undefined)
    const ordinaryCheck = query.mock.calls.find(([sql]) => String(sql).includes('SELECT EXISTS'))
    expect(ordinaryCheck?.[0]).toContain('druvia_table_deletion_outbox')
    expect(ordinaryCheck?.[1]).toContain(true)

    vi.clearAllMocks()
    query.mockImplementation(async (sql: string) => {
      if (sql.includes('pg_try_advisory')) return { rows: [{ acquired: true }] }
      if (sql.includes('SELECT EXISTS')) return { rows: [{ blocked: false }] }
      return { rows: [] }
    })
    await withProjectDataAccessMutationLock('proj_1', async () => undefined, {
      globalMode: 'exclusive', purpose: 'table_delete', operationId: 'delete_1',
    })
    const deleteCheck = query.mock.calls.find(([sql]) => String(sql).includes('SELECT EXISTS'))
    expect(deleteCheck?.[1]).toContain(true)
    expect(deleteCheck?.[0]).toContain('lock_scope = $1')

    vi.clearAllMocks()
    query.mockImplementation(async (sql: string) => {
      if (sql.includes('pg_try_advisory')) return { rows: [{ acquired: true }] }
      if (sql.includes('SELECT EXISTS')) return { rows: [{ blocked: false }] }
      return { rows: [] }
    })
    await withProjectDataAccessMutationLock('proj_1', async () => undefined, {
      globalMode: 'exclusive', purpose: 'table_delete_recovery', operationId: 'delete_1',
    })
    const recoveryCheck = query.mock.calls.find(([sql]) => String(sql).includes('SELECT EXISTS'))
    expect(recoveryCheck?.[1]).toContain(false)
    expect(recoveryCheck?.[0]).toContain('WHERE (project_id = $1)')
  })

  it('releases both locks and the client after callback failure', async () => {
    await expect(withProjectDataAccessMutationLock('proj_1', async () => {
      throw new Error('callback failed')
    })).rejects.toThrow('callback failed')

    expect(query.mock.calls.at(-2)?.[0]).toContain('pg_advisory_unlock')
    expect(query.mock.calls.at(-1)?.[0]).toContain('pg_advisory_unlock_shared')
    expect(release).toHaveBeenCalledOnce()
  })

  it('still attempts global unlock and client release when project unlock fails', async () => {
    query.mockImplementation(async (sql: string) => {
      if (sql.includes('pg_try_advisory')) return { rows: [{ acquired: true }] }
      if (sql.includes('SELECT EXISTS')) return { rows: [{ blocked: false }] }
      if (sql.includes('pg_advisory_unlock') && !sql.includes('_shared')) {
        throw new Error('unlock failed')
      }
      return { rows: [] }
    })

    await expect(withProjectDataAccessMutationLock('proj_1', async () => undefined))
      .rejects.toThrow('unlock failed')
    expect(query.mock.calls.some(([sql]) => String(sql).includes('pg_advisory_unlock_shared'))).toBe(true)
    expect(release).toHaveBeenCalledOnce()
  })
})
