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
    mockQuery.mockResolvedValueOnce([{ proargnames: ['match_id', 'user_id'] }])
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
    mockQuery.mockResolvedValueOnce([{ proargnames: ['season_id'] }])
    mockQuery.mockResolvedValueOnce([
      { id: 1, name: 'A' },
      { id: 2, name: 'B' },
    ])

    const result = await callFunction('dru_test', 'get_items', { season_id: 1 })
    expect(result).toEqual([{ id: 1, name: 'A' }, { id: 2, name: 'B' }])
  })

  it('returns null for void functions (no rows)', async () => {
    mockQuery.mockResolvedValueOnce([{ proargnames: [] }])
    mockQuery.mockResolvedValueOnce([])

    const result = await callFunction('dru_test', 'cleanup')
    expect(result).toBeNull()
  })

  it('caches function signatures', async () => {
    mockQuery.mockResolvedValueOnce([{ proargnames: ['id'] }])
    mockQuery.mockResolvedValueOnce([{ result: true }])

    await callFunction('dru_test', 'fn1', { id: 1 })

    // Second call should not query pg_proc again
    mockQuery.mockResolvedValueOnce([{ result: true }])
    await callFunction('dru_test', 'fn1', { id: 2 })

    // pg_proc queried once, function called twice
    expect(mockQuery).toHaveBeenCalledTimes(3)
  })

  it('clearSignatureCache clears specific key', async () => {
    mockQuery.mockResolvedValueOnce([{ proargnames: ['id'] }])
    mockQuery.mockResolvedValueOnce([{ ok: true }])
    await callFunction('dru_test', 'fn1', { id: 1 })

    clearSignatureCache('dru_test.fn1')

    // Should query pg_proc again after cache clear
    mockQuery.mockResolvedValueOnce([{ proargnames: ['id'] }])
    mockQuery.mockResolvedValueOnce([{ ok: true }])
    await callFunction('dru_test', 'fn1', { id: 1 })

    // 2 pg_proc queries + 2 function calls = 4
    expect(mockQuery).toHaveBeenCalledTimes(4)
  })
})
