import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../apps/api/src/db/index.js', () => ({
  query: vi.fn(),
  queryOne: vi.fn(),
}))

import { query, queryOne } from '../../apps/api/src/db/index.js'
import {
  DataAccessInventorySchemaNotFoundError,
  getDataAccessInventory,
} from '../../apps/api/src/modules/data-access/data-access-inventory.js'

describe('data access inventory', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns ordered visible tables, columns and existing realtime flags', async () => {
    vi.mocked(queryOne).mockResolvedValue({
      schema_exists: true,
      metadata_exists: true,
    })
    vi.mocked(query).mockResolvedValue([
      {
        table_name: 'orders',
        columns: ['id', 'owner_id', 'created_at'],
        realtime_enabled: true,
      },
      {
        table_name: 'profiles',
        columns: ['id', 'display_name'],
        realtime_enabled: false,
      },
    ])

    const result = await getDataAccessInventory('dru_test')

    expect(result).toEqual([
      {
        tableName: 'orders',
        columns: ['id', 'owner_id', 'created_at'],
        realtimeEnabled: true,
      },
      {
        tableName: 'profiles',
        columns: ['id', 'display_name'],
        realtimeEnabled: false,
      },
    ])
    expect(queryOne).toHaveBeenCalledWith(
      expect.stringContaining('to_regnamespace($1)'),
      ['dru_test', '"dru_test"."_meta_tables"']
    )
    const [sql, params] = vi.mocked(query).mock.calls[0]
    expect(sql).toContain('LEFT JOIN "dru_test"._meta_tables')
    expect(sql).toContain("t.table_name NOT LIKE '\\_%'")
    expect(sql).toContain('ORDER BY c.ordinal_position')
    expect(sql).toContain('ORDER BY t.table_name')
    expect(params).toEqual(['dru_test'])
  })

  it('defaults realtime to false without referencing a missing metadata table', async () => {
    vi.mocked(queryOne).mockResolvedValue({
      schema_exists: true,
      metadata_exists: false,
    })
    vi.mocked(query).mockResolvedValue([{
      table_name: 'orders',
      columns: ['id'],
      realtime_enabled: false,
    }])

    const result = await getDataAccessInventory('dru_test')

    expect(result[0].realtimeEnabled).toBe(false)
    const sql = String(vi.mocked(query).mock.calls[0][0])
    expect(sql).not.toContain('_meta_tables')
    expect(sql).not.toMatch(/\b(?:CREATE|ALTER)\b/i)
  })

  it('rejects a missing physical schema instead of returning an empty project', async () => {
    vi.mocked(queryOne).mockResolvedValue({
      schema_exists: false,
      metadata_exists: false,
    })

    await expect(getDataAccessInventory('dru_missing'))
      .rejects.toBeInstanceOf(DataAccessInventorySchemaNotFoundError)

    expect(query).not.toHaveBeenCalled()
  })

  it('rejects invalid schema identifiers before querying', async () => {
    await expect(getDataAccessInventory('dru_test"; DROP SCHEMA public'))
      .rejects.toThrow('Invalid schema name')

    expect(queryOne).not.toHaveBeenCalled()
    expect(query).not.toHaveBeenCalled()
  })
})
