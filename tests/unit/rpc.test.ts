import { beforeEach, describe, expect, it, vi } from 'vitest'

const { discoveryQuery, clientQuery, releaseClient, getClient } = vi.hoisted(() => ({
  discoveryQuery: vi.fn(),
  clientQuery: vi.fn(),
  releaseClient: vi.fn(),
  getClient: vi.fn(),
}))

vi.mock('../../apps/api/src/db/index.js', () => ({
  query: discoveryQuery,
  getClient,
}))

import type { ProjectActorContext } from '../../apps/api/src/lib/project-actor.js'
import { callFunction, clearSignatureCache, RpcError } from '../../apps/api/src/modules/rpc/rpc.service.js'

const actor: ProjectActorContext = {
  version: 1,
  actorType: 'project_user',
  source: 'project_session',
  projectId: 'proj_123',
  subject: 'project_user:pusr_123',
  role: 'authenticated',
  projectUserId: 'pusr_123',
  provider: 'trusted_backend',
}

let functionRows: Array<Record<string, unknown>[]> = []

function queueFunctionRows(rows: Record<string, unknown>[]) {
  functionRows.push(rows)
}

function invoke(name: string, args?: Record<string, unknown>) {
  return callFunction('dru_test', name, args, actor)
}

describe('RPC Service', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    clearSignatureCache()
    functionRows = []
    getClient.mockResolvedValue({ query: clientQuery, release: releaseClient })
    clientQuery.mockImplementation(async (sql: string) => {
      if (sql.startsWith('SELECT * FROM')) {
        return { rows: functionRows.shift() ?? [] }
      }
      return { rows: [] }
    })
  })

  it('throws FUNCTION_NOT_FOUND before opening a transaction', async () => {
    discoveryQuery.mockResolvedValueOnce([])

    await expect(invoke('nonexistent', {})).rejects.toMatchObject<RpcError>({
      code: 'FUNCTION_NOT_FOUND',
    })
    expect(getClient).not.toHaveBeenCalled()
  })

  it('sets all actor claims and executes the function on one transaction client', async () => {
    discoveryQuery.mockResolvedValueOnce([{ proargnames: null }])
    queueFunctionRows([{ count: 42 }])

    await expect(invoke('get_count')).resolves.toBe(42)

    const calls = clientQuery.mock.calls
    expect(calls.map(([sql]) => sql)).toEqual([
      'BEGIN',
      expect.stringContaining("set_config('request.jwt.claims'"),
      expect.stringContaining("set_config('request.headers'"),
      expect.stringContaining("set_config('druvia.actor'"),
      expect.stringContaining('SELECT * FROM'),
      'COMMIT',
    ])
    expect(JSON.parse(calls[1][1][0])).toMatchObject({
      sub: 'project_user:pusr_123',
      project_id: 'proj_123',
      actor_type: 'project_user',
    })
    expect(JSON.parse(calls[2][1][0])).toMatchObject({
      'x-druvia-actor-subject': 'project_user:pusr_123',
      'x-druvia-project-user-id': 'pusr_123',
    })
    expect(JSON.parse(calls[3][1][0])).toMatchObject({
      actor_type: 'project_user',
      project_user_id: 'pusr_123',
    })
    expect(releaseClient).toHaveBeenCalledOnce()
  })

  it('rolls back and releases the client when function execution fails', async () => {
    discoveryQuery.mockResolvedValueOnce([{ proargnames: null }])
    clientQuery.mockImplementation(async (sql: string) => {
      if (sql.startsWith('SELECT * FROM')) throw new Error('function failed')
      return { rows: [] }
    })

    await expect(invoke('explode')).rejects.toThrow('function failed')

    expect(clientQuery.mock.calls.map(([sql]) => sql)).toContain('ROLLBACK')
    expect(clientQuery.mock.calls.map(([sql]) => sql)).not.toContain('COMMIT')
    expect(releaseClient).toHaveBeenCalledOnce()
  })

  it('maps PostgreSQL raised exceptions to a generic RPC rejection after rollback', async () => {
    discoveryQuery.mockResolvedValueOnce([{ proargnames: null }])
    const databaseError = Object.assign(
      new Error('PITCHETCH upload chunks are incomplete'),
      { code: 'P0001' },
    )
    clientQuery.mockImplementation(async (sql: string) => {
      if (sql.startsWith('SELECT * FROM')) throw databaseError
      return { rows: [] }
    })

    await expect(invoke('complete_base_samples')).rejects.toMatchObject<RpcError>({
      code: 'RPC_REJECTED',
      message: 'RPC request rejected',
    })

    expect(clientQuery.mock.calls.map(([sql]) => sql)).toContain('ROLLBACK')
    expect(releaseClient).toHaveBeenCalledWith(undefined)
  })

  it('does not map actor context setup errors to RPC business rejections', async () => {
    discoveryQuery.mockResolvedValueOnce([{ proargnames: null }])
    const databaseError = Object.assign(new Error('actor context setup failed'), { code: 'P0001' })
    clientQuery.mockImplementation(async (sql: string) => {
      if (sql.includes("set_config('request.jwt.claims'")) throw databaseError
      return { rows: [] }
    })

    await expect(invoke('get_count')).rejects.toBe(databaseError)
    expect(clientQuery.mock.calls.map(([sql]) => sql)).toContain('ROLLBACK')
  })

  it('keeps unknown PostgreSQL errors as infrastructure failures', async () => {
    discoveryQuery.mockResolvedValueOnce([{ proargnames: null }])
    const databaseError = Object.assign(new Error('internal SQL failure'), { code: 'XX000' })
    clientQuery.mockImplementation(async (sql: string) => {
      if (sql.startsWith('SELECT * FROM')) throw databaseError
      return { rows: [] }
    })

    await expect(invoke('explode')).rejects.toBe(databaseError)
  })

  it('keeps connection failures as infrastructure failures', async () => {
    discoveryQuery.mockResolvedValueOnce([{ proargnames: null }])
    const connectionError = Object.assign(new Error('connection refused'), { code: 'ECONNREFUSED' })
    getClient.mockRejectedValueOnce(connectionError)

    await expect(invoke('get_count')).rejects.toBe(connectionError)
    expect(clientQuery).not.toHaveBeenCalled()
  })

  it('discards the client when rollback itself fails', async () => {
    discoveryQuery.mockResolvedValueOnce([{ proargnames: null }])
    clientQuery.mockImplementation(async (sql: string) => {
      if (sql.startsWith('SELECT * FROM')) throw new Error('function failed')
      if (sql === 'ROLLBACK') throw new Error('rollback failed')
      return { rows: [] }
    })

    await expect(invoke('explode')).rejects.toThrow('function failed')

    expect(releaseClient).toHaveBeenCalledWith(expect.objectContaining({
      message: 'rollback failed',
    }))
  })

  it('treats rollback failure after a raised exception as an infrastructure failure', async () => {
    discoveryQuery.mockResolvedValueOnce([{ proargnames: null }])
    const databaseError = Object.assign(new Error('business rejection'), { code: 'P0001' })
    const rollbackError = Object.assign(new Error('rollback connection lost'), { code: 'ECONNRESET' })
    clientQuery.mockImplementation(async (sql: string) => {
      if (sql.startsWith('SELECT * FROM')) throw databaseError
      if (sql === 'ROLLBACK') throw rollbackError
      return { rows: [] }
    })

    await expect(invoke('complete_base_samples')).rejects.toBe(rollbackError)
    expect(releaseClient).toHaveBeenCalledWith(rollbackError)
  })

  it('maps named args to positional params by pg_proc order', async () => {
    discoveryQuery.mockResolvedValueOnce([{
      proargnames: ['match_id', 'user_id'], proargtypes: '23 25',
    }])
    queueFunctionRows([{ id: 1, status: 'confirmed' }])

    const result = await invoke('confirm_draft', { user_id: 'abc', match_id: 5 })

    const call = clientQuery.mock.calls.find(([sql]) => sql.startsWith('SELECT * FROM'))
    expect(call?.[1]).toEqual([5, 'abc'])
    expect(result).toEqual({ id: 1, status: 'confirmed' })
  })

  it('returns arrays and null without changing result compatibility', async () => {
    discoveryQuery.mockResolvedValueOnce([{ proargnames: ['season_id'], proargtypes: '23' }])
    queueFunctionRows([{ id: 1 }, { id: 2 }])
    await expect(invoke('get_items', { season_id: 1 })).resolves.toEqual([{ id: 1 }, { id: 2 }])

    discoveryQuery.mockResolvedValueOnce([{ proargnames: [], proargtypes: '' }])
    queueFunctionRows([])
    await expect(invoke('cleanup')).resolves.toBeNull()
  })

  it('caches function signatures and supports targeted cache clearing', async () => {
    discoveryQuery.mockResolvedValueOnce([{ proargnames: ['id'], proargtypes: '23' }])
    queueFunctionRows([{ result: true }])
    await invoke('cached', { id: 1 })
    queueFunctionRows([{ result: true }])
    await invoke('cached', { id: 2 })
    expect(discoveryQuery).toHaveBeenCalledOnce()

    clearSignatureCache('dru_test.cached')
    discoveryQuery.mockResolvedValueOnce([{ proargnames: ['id'], proargtypes: '23' }])
    queueFunctionRows([{ result: true }])
    await invoke('cached', { id: 3 })
    expect(discoveryQuery).toHaveBeenCalledTimes(2)
  })

  it.each([
    ['jsonb array', '3802', [{ minute: 90 }], '$1::jsonb', '[{"minute":90}]'],
    ['json object', '114', { status: 'draft' }, '$1::json', '{"status":"draft"}'],
    ['jsonb string', '3802', 'draft', '$1::jsonb', '"draft"'],
    ['jsonb null', '3802', null, '$1::jsonb', 'null'],
  ])('serializes %s args with explicit casts', async (_label, oid, value, cast, expected) => {
    discoveryQuery.mockResolvedValueOnce([{ proargnames: ['payload'], proargtypes: oid }])
    queueFunctionRows([{ ok: true }])

    await invoke('update_payload', { payload: value })

    const call = clientQuery.mock.calls.find(([sql]) => sql.startsWith('SELECT * FROM'))
    expect(call?.[0]).toContain(cast)
    expect(call?.[1]).toEqual([expected])
  })

  it('filters RETURNS TABLE output columns out of input args', async () => {
    discoveryQuery.mockResolvedValueOnce([{
      proargnames: ['p_events', 'inserted_count', 'message'],
      proargtypes: '3802',
      proallargtypes: '{3802,23,25}',
      proargmodes: '{i,t,t}',
    }])
    queueFunctionRows([{ inserted_count: 2, message: 'ok' }])

    const result = await invoke('batch_insert_score_events', {
      p_events: [{ minute: 1, points: 2 }],
    })

    const call = clientQuery.mock.calls.find(([sql]) => sql.startsWith('SELECT * FROM'))
    expect(call?.[0]).toContain('batch_insert_score_events($1::jsonb)')
    expect(call?.[0]).not.toContain('$2')
    expect(call?.[1]).toEqual(['[{"minute":1,"points":2}]'])
    expect(result).toEqual({ inserted_count: 2, message: 'ok' })
  })

  it('keeps only input params for mixed input and table output signatures', async () => {
    discoveryQuery.mockResolvedValueOnce([{
      proargnames: ['p_season_id', 'p_enable_combo', 'p_max_combo_size', 'step', 'status'],
      proargtypes: '20 16 23',
      proallargtypes: '{20,16,23,25,25}',
      proargmodes: '{i,i,i,t,t}',
    }])
    queueFunctionRows([{ step: 'done', status: 'ok' }])

    await invoke('calculate_all_season_aggregations', {
      p_enable_combo: true,
      p_max_combo_size: 5,
      p_season_id: 9,
    })

    const call = clientQuery.mock.calls.find(([sql]) => sql.startsWith('SELECT * FROM'))
    expect(call?.[0]).toContain('calculate_all_season_aggregations($1, $2, $3)')
    expect(call?.[0]).not.toContain('$4')
    expect(call?.[1]).toEqual([9, true, 5])
  })
})
