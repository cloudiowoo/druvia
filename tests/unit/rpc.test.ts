import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock db module before importing service
vi.mock('../../apps/api/src/db/index.js', () => ({
  query: vi.fn(),
  queryOne: vi.fn(),
}))

import { callFunction, clearSignatureCache, RpcError } from '../../apps/api/src/modules/rpc/rpc.service.js'
import { query } from '../../apps/api/src/db/index.js'

const mockQuery = vi.mocked(query)

describe('RPC Service', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    clearSignatureCache()
  })

  it('throws FUNCTION_NOT_FOUND when pg_proc returns no rows', async () => {
    mockQuery.mockResolvedValueOnce([]) // discoverFunction returns empty

    try {
      await callFunction('dru_test', 'nonexistent', {})
      expect.unreachable('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(RpcError)
      expect((err as RpcError).code).toBe('FUNCTION_NOT_FOUND')
    }
  })

  it('calls function with no args', async () => {
    // discoverFunction
    mockQuery.mockResolvedValueOnce([{ proargnames: null }])
    // actual function call
    mockQuery.mockResolvedValueOnce([{ count: 42 }])

    const result = await callFunction('dru_test', 'get_count')
    expect(result).toBe(42)

    // Verify the function call SQL contains schema.function
    const callSql = mockQuery.mock.calls[1][0] as string
    expect(callSql).toContain('dru_test')
    expect(callSql).toContain('get_count')
    expect(callSql).toContain('SELECT * FROM')
  })

  it('maps named args to positional params by proargnames order', async () => {
    mockQuery.mockResolvedValueOnce([{ proargnames: ['match_id', 'user_id'], proargtypes: '23 25' }])
    mockQuery.mockResolvedValueOnce([{ id: 1, status: 'confirmed' }])

    const result = await callFunction('dru_test', 'confirm_draft', {
      user_id: 'abc',
      match_id: 5,
    })

    // Should map: $1=match_id(5), $2=user_id('abc') per proargnames order
    const callArgs = mockQuery.mock.calls[1][1] as unknown[]
    expect(callArgs[0]).toBe(5)       // match_id first
    expect(callArgs[1]).toBe('abc')   // user_id second
    expect(result).toEqual({ id: 1, status: 'confirmed' })
  })

  it('returns array for SETOF results', async () => {
    mockQuery.mockResolvedValueOnce([{ proargnames: ['season_id'], proargtypes: '23' }])
    mockQuery.mockResolvedValueOnce([
      { id: 1, name: 'A' },
      { id: 2, name: 'B' },
    ])

    const result = await callFunction('dru_test', 'get_items', { season_id: 1 })
    expect(result).toEqual([{ id: 1, name: 'A' }, { id: 2, name: 'B' }])
  })

  it('returns null for void functions (no rows)', async () => {
    mockQuery.mockResolvedValueOnce([{ proargnames: [], proargtypes: '' }])
    mockQuery.mockResolvedValueOnce([])

    const result = await callFunction('dru_test', 'cleanup')
    expect(result).toBeNull()
  })

  it('caches function signatures', async () => {
    mockQuery.mockResolvedValueOnce([{ proargnames: ['id'], proargtypes: '23' }])
    mockQuery.mockResolvedValueOnce([{ result: true }])

    await callFunction('dru_test', 'fn1', { id: 1 })

    // Second call should not query pg_proc again
    mockQuery.mockResolvedValueOnce([{ result: true }])
    await callFunction('dru_test', 'fn1', { id: 2 })

    // pg_proc queried once, function called twice
    expect(mockQuery).toHaveBeenCalledTimes(3)
  })

  it('clearSignatureCache clears specific key', async () => {
    mockQuery.mockResolvedValueOnce([{ proargnames: ['id'], proargtypes: '23' }])
    mockQuery.mockResolvedValueOnce([{ ok: true }])
    await callFunction('dru_test', 'fn1', { id: 1 })

    clearSignatureCache('dru_test.fn1')

    // Should query pg_proc again after cache clear
    mockQuery.mockResolvedValueOnce([{ proargnames: ['id'], proargtypes: '23' }])
    mockQuery.mockResolvedValueOnce([{ ok: true }])
    await callFunction('dru_test', 'fn1', { id: 1 })

    // 2 pg_proc queries + 2 function calls = 4
    expect(mockQuery).toHaveBeenCalledTimes(4)
  })

  it('serializes jsonb array args and casts placeholders to jsonb', async () => {
    mockQuery.mockResolvedValueOnce([{ proargnames: ['match_id', 'events'], proargtypes: '23 3802' }])
    mockQuery.mockResolvedValueOnce([{ ok: true }])

    await callFunction('dru_test', 'update_draft_with_events', {
      match_id: 249,
      events: [{ minute: 90, event_type: 'goal' }],
    })

    const callSql = mockQuery.mock.calls[1][0] as string
    const callArgs = mockQuery.mock.calls[1][1] as unknown[]

    expect(callSql).toContain('$1')
    expect(callSql).toContain('$2::jsonb')
    expect(callArgs[0]).toBe(249)
    expect(callArgs[1]).toBe('[{"minute":90,"event_type":"goal"}]')
  })

  it('serializes json object args and casts placeholders to json', async () => {
    mockQuery.mockResolvedValueOnce([{ proargnames: ['payload'], proargtypes: '114' }])
    mockQuery.mockResolvedValueOnce([{ ok: true }])

    await callFunction('dru_test', 'update_payload', {
      payload: { status: 'draft', score: { home: 1, away: 0 } },
    })

    const callSql = mockQuery.mock.calls[1][0] as string
    const callArgs = mockQuery.mock.calls[1][1] as unknown[]

    expect(callSql).toContain('$1::json')
    expect(callArgs[0]).toBe('{"status":"draft","score":{"home":1,"away":0}}')
  })

  it('serializes jsonb string args as valid JSON strings', async () => {
    mockQuery.mockResolvedValueOnce([{ proargnames: ['payload'], proargtypes: '3802' }])
    mockQuery.mockResolvedValueOnce([{ ok: true }])

    await callFunction('dru_test', 'update_payload', {
      payload: 'draft',
    })

    const callSql = mockQuery.mock.calls[1][0] as string
    const callArgs = mockQuery.mock.calls[1][1] as unknown[]

    expect(callSql).toContain('$1::jsonb')
    expect(callArgs[0]).toBe('"draft"')
  })

  it('serializes explicit null jsonb args as JSON null instead of SQL NULL', async () => {
    mockQuery.mockResolvedValueOnce([{ proargnames: ['payload'], proargtypes: '3802' }])
    mockQuery.mockResolvedValueOnce([{ ok: true }])

    await callFunction('dru_test', 'update_payload', {
      payload: null,
    })

    const callSql = mockQuery.mock.calls[1][0] as string
    const callArgs = mockQuery.mock.calls[1][1] as unknown[]

    expect(callSql).toContain('$1::jsonb')
    expect(callArgs[0]).toBe('null')
  })

  it('filters RETURNS TABLE output columns out of input args', async () => {
    mockQuery.mockResolvedValueOnce([{
      proargnames: ['p_events', 'inserted_count', 'message'],
      proargtypes: '3802',
      proallargtypes: '{3802,23,25}',
      proargmodes: '{i,t,t}',
    }])
    mockQuery.mockResolvedValueOnce([{ inserted_count: 2, message: 'ok' }])

    const result = await callFunction('dru_test', 'batch_insert_score_events', {
      p_events: [{ minute: 1, points: 2 }],
    })

    const callSql = mockQuery.mock.calls[1][0] as string
    const callArgs = mockQuery.mock.calls[1][1] as unknown[]

    expect(callSql).toContain('batch_insert_score_events($1::jsonb)')
    expect(callSql).not.toContain('$2')
    expect(callArgs).toEqual(['[{"minute":1,"points":2}]'])
    expect(result).toEqual({ inserted_count: 2, message: 'ok' })
  })

  it('keeps only input params for mixed input and table output signatures', async () => {
    mockQuery.mockResolvedValueOnce([{
      proargnames: ['p_season_id', 'p_enable_combo', 'p_max_combo_size', 'step', 'status', 'message', 'duration_ms'],
      proargtypes: '20 16 23',
      proallargtypes: '{20,16,23,25,25,25,1700}',
      proargmodes: '{i,i,i,t,t,t,t}',
    }])
    mockQuery.mockResolvedValueOnce([{ step: 'done', status: 'ok', message: null, duration_ms: 12.5 }])

    await callFunction('dru_test', 'calculate_all_season_aggregations', {
      p_enable_combo: true,
      p_max_combo_size: 5,
      p_season_id: 9,
    })

    const callSql = mockQuery.mock.calls[1][0] as string
    const callArgs = mockQuery.mock.calls[1][1] as unknown[]

    expect(callSql).toContain('calculate_all_season_aggregations($1, $2, $3)')
    expect(callSql).not.toContain('$4')
    expect(callArgs).toEqual([9, true, 5])
  })
})
