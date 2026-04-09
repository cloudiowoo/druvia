import { describe, it, expect, vi, beforeEach } from 'vitest'
import { QueryBuilder } from '../../packages/sdk/src/modules/query-builder.js'
import type { FetchFn } from '../../packages/sdk/src/types.js'

function mockFetch(responseData: unknown): FetchFn {
  return vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => responseData,
  } as Response)
}

beforeEach(() => {
  QueryBuilder.clearFieldCache()
})

describe('QueryBuilder', () => {
  it('builds and executes select query', async () => {
    const fetch = mockFetch({ data: { users: [{ id: 1, name: 'Alice' }] } })
    const qb = new QueryBuilder('users', '/graphql', fetch)
    const result = await qb.select('id, name').eq('id', 1)

    expect(fetch).toHaveBeenCalledOnce()
    expect(result.data).toEqual([{ id: 1, name: 'Alice' }])
    expect(result.error).toBeNull()
  })

  it('chains multiple filters', async () => {
    const fetch = mockFetch({ data: { activities: [] } })
    const qb = new QueryBuilder('activities', '/graphql', fetch)
    const result = await qb
      .select('id, status')
      .eq('status', 'active')
      .neq('type', 'draft')
      .order('created_at', { ascending: false })
      .range(0, 9)

    expect(fetch).toHaveBeenCalledOnce()
    const body = JSON.parse((fetch as any).mock.calls[0][1].body)
    expect(body.query).toContain('_eq')
    expect(body.query).toContain('_neq')
    expect(body.query).toContain('order_by')
    expect(body.query).toContain('limit: 10')
    expect(body.query).toContain('offset: 0')
  })

  it('single() returns one object not array', async () => {
    const fetch = mockFetch({ data: { users: [{ id: 1, name: 'Alice' }] } })
    const qb = new QueryBuilder('users', '/graphql', fetch)
    const result = await qb.select('id, name').eq('id', 1).single()

    expect(result.data).toEqual({ id: 1, name: 'Alice' })
  })

  it('single() returns error when no rows', async () => {
    const fetch = mockFetch({ data: { users: [] } })
    const qb = new QueryBuilder('users', '/graphql', fetch)
    const result = await qb.select('id, name').eq('id', 999).single()

    expect(result.data).toBeNull()
    expect(result.error).toBeTruthy()
    expect(result.error!.code).toBe('PGRST116')
  })

  it('insert sends mutation', async () => {
    const fetch = mockFetch({ data: { insert_users: { affected_rows: 1 } } })
    const qb = new QueryBuilder('users', '/graphql', fetch)
    const result = await qb.insert({ username: 'test', user_id: 'u1' })

    const body = JSON.parse((fetch as any).mock.calls[0][1].body)
    expect(body.query).toContain('insert_users')
    expect(body.query).toContain('affected_rows')
    expect(body.query).not.toContain('returning {')
    expect(result.data).toEqual({ affected_rows: 1 })
  })

  it('update sends mutation with where', async () => {
    const fetch = mockFetch({ data: { update_users: { affected_rows: 1 } } })
    const qb = new QueryBuilder('users', '/graphql', fetch)
    const result = await qb.update({ username: 'new' }).eq('id', 1)

    const body = JSON.parse((fetch as any).mock.calls[0][1].body)
    expect(body.query).toContain('update_users')
    expect(body.query).toContain('_set')
    expect(body.query).toContain('affected_rows')
    expect(result.data).toEqual({ affected_rows: 1 })
  })

  it('delete sends mutation with where', async () => {
    const fetch = mockFetch({ data: { delete_users: { affected_rows: 1 } } })
    const qb = new QueryBuilder('users', '/graphql', fetch)
    const result = await qb.delete().eq('id', 1)

    const body = JSON.parse((fetch as any).mock.calls[0][1].body)
    expect(body.query).toContain('delete_users')
    expect(body.query).toContain('affected_rows')
    expect(result.data).toEqual({ affected_rows: 1 })
  })

  it('upsert sends insert mutation with on_conflict', async () => {
    const fetch = mockFetch({ data: { insert_users: { affected_rows: 1 } } })
    const qb = new QueryBuilder('users', '/graphql', fetch)
    const result = await qb.upsert({ id: 1, username: 'test' })

    const body = JSON.parse((fetch as any).mock.calls[0][1].body)
    expect(body.query).toContain('insert_users')
    expect(body.query).toContain('on_conflict')
    expect(body.query).toContain('affected_rows')
    expect(result.data).toEqual({ affected_rows: 1 })
  })

  it('supports insert().select() with Hasura returning wrapper', async () => {
    const fetch = mockFetch({ data: { insert_match_results: { returning: [{ match_id: 'm1' }] } } })
    const qb = new QueryBuilder('match_results', '/graphql', fetch)
    const result = await qb.insert({ match_id: 'm1' }).select('match_id')

    const body = JSON.parse((fetch as any).mock.calls[0][1].body)
    expect(body.query).toContain('insert_match_results')
    expect(body.query).toContain('returning {')
    expect(body.query).toContain('match_id')
    expect(result.data).toEqual([{ match_id: 'm1' }])
  })

  it('supports select().insert() with Hasura returning wrapper', async () => {
    const fetch = mockFetch({ data: { insert_match_results: { returning: [{ match_id: 'm1' }] } } })
    const qb = new QueryBuilder('match_results', '/graphql', fetch)
    const result = await qb.select('match_id').insert({ match_id: 'm1' })

    const body = JSON.parse((fetch as any).mock.calls[0][1].body)
    expect(body.query).toContain('insert_match_results')
    expect(body.query).toContain('returning {')
    expect(body.query).toContain('match_id')
    expect(result.data).toEqual([{ match_id: 'm1' }])
  })

  it('supports update().select() with Hasura returning wrapper', async () => {
    const fetch = mockFetch({ data: { update_match_results: { returning: [{ match_id: 'm1' }] } } })
    const qb = new QueryBuilder('match_results', '/graphql', fetch)
    const result = await qb.update({ status: 'done' }).eq('match_id', 'm1').select('match_id')

    const body = JSON.parse((fetch as any).mock.calls[0][1].body)
    expect(body.query).toContain('update_match_results')
    expect(body.query).toContain('returning {')
    expect(body.query).toContain('match_id')
    expect(result.data).toEqual([{ match_id: 'm1' }])
  })

  it('supports delete().select() with Hasura returning wrapper', async () => {
    const fetch = mockFetch({ data: { delete_match_results: { returning: [{ match_id: 'm1' }] } } })
    const qb = new QueryBuilder('match_results', '/graphql', fetch)
    const result = await qb.delete().eq('match_id', 'm1').select('match_id')

    const body = JSON.parse((fetch as any).mock.calls[0][1].body)
    expect(body.query).toContain('delete_match_results')
    expect(body.query).toContain('returning {')
    expect(body.query).toContain('match_id')
    expect(result.data).toEqual([{ match_id: 'm1' }])
  })

  it('supports upsert().select() with Hasura returning wrapper', async () => {
    const fetch = mockFetch({ data: { insert_match_results: { returning: [{ match_id: 'm1' }] } } })
    const qb = new QueryBuilder('match_results', '/graphql', fetch)
    const result = await qb.upsert({ match_id: 'm1', status: 'done' }, { onConflict: 'match_results_pkey' }).select('match_id')

    const body = JSON.parse((fetch as any).mock.calls[0][1].body)
    expect(body.query).toContain('insert_match_results')
    expect(body.query).toContain('on_conflict')
    expect(body.query).toContain('returning {')
    expect(body.query).toContain('match_id')
    expect(result.data).toEqual([{ match_id: 'm1' }])
  })

  it('serializes nested JSON objects in insert payloads', async () => {
    const fetch = mockFetch({ data: { insert_stats_match_result: { affected_rows: 1 } } })
    const qb = new QueryBuilder('stats_match_result', '/graphql', fetch)

    await qb.insert({
      match_id: 'm1',
      meta: {
        snapshot: {
          teams: [{ team_id: 't1', team_name: 'A 队' }],
        },
        snapshot_hash: 'abc',
      },
    })

    const body = JSON.parse((fetch as any).mock.calls[0][1].body)
    expect(body.query).toContain('snapshot: {')
    expect(body.query).toContain('teams: [{team_id: "t1", team_name: "A 队"}]')
    expect(body.query).not.toContain('[object Object]')
  })

  it('select("*") triggers introspection to resolve fields', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce({
        ok: true, json: async () => ({
          data: {
            __type: {
              fields: [
                { name: 'id', type: { kind: 'SCALAR' } },
                { name: 'username', type: { kind: 'SCALAR' } },
                { name: 'email', type: { kind: 'SCALAR' } },
              ]
            }
          }
        })
      } as Response)
      .mockResolvedValueOnce({
        ok: true, json: async () => ({ data: { users: [{ id: 1, username: 'a', email: 'a@b.com' }] } })
      } as Response) as unknown as FetchFn

    const qb = new QueryBuilder('users', '/graphql', fetch)
    const result = await qb.select('*').eq('id', 1)

    expect(fetch).toHaveBeenCalledTimes(2)
    const dataBody = JSON.parse((fetch as any).mock.calls[1][1].body)
    expect(dataBody.query).toContain('id')
    expect(dataBody.query).toContain('username')
    expect(dataBody.query).not.toContain('*')
  })

  it('select("*") keeps scalar array fields resolved from introspection', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce({
        ok: true, json: async () => ({
          data: {
            __type: {
              fields: [
                { name: 'combo_id', type: { kind: 'SCALAR' } },
                {
                  name: 'player_ids',
                  type: {
                    kind: 'NON_NULL',
                    ofType: {
                      kind: 'LIST',
                      ofType: {
                        kind: 'NON_NULL',
                        ofType: { kind: 'SCALAR' },
                      },
                    },
                  },
                },
                {
                  name: 'player',
                  type: {
                    kind: 'OBJECT',
                  },
                },
              ]
            }
          }
        })
      } as Response)
      .mockResolvedValueOnce({
        ok: true, json: async () => ({ data: { stats_player_combo_agg: [{ combo_id: 'c1', player_ids: ['u1', 'u2'] }] } })
      } as Response) as unknown as FetchFn

    const qb = new QueryBuilder('stats_player_combo_agg', '/graphql', fetch)
    const result = await qb.select('*').limit(1)

    expect(fetch).toHaveBeenCalledTimes(2)
    const dataBody = JSON.parse((fetch as any).mock.calls[1][1].body)
    expect(dataBody.query).toContain('combo_id')
    expect(dataBody.query).toContain('player_ids')
    expect(dataBody.query).not.toContain('player {')
    expect(result.data).toEqual([{ combo_id: 'c1', player_ids: ['u1', 'u2'] }])
  })

  it('handles GraphQL errors', async () => {
    const fetch = mockFetch({ errors: [{ message: 'field not found' }] })
    const qb = new QueryBuilder('users', '/graphql', fetch)
    const result = await qb.select('nonexistent')

    expect(result.data).toBeNull()
    expect(result.error).toBeTruthy()
    expect(result.error!.message).toContain('field not found')
  })

  it('preserves non-standard top-level error payloads instead of misclassifying them as network errors', async () => {
    const fetch = mockFetch({
      data: null,
      error: {
        code: 'FORBIDDEN',
        message: 'permission denied',
      },
    })
    const qb = new QueryBuilder('users', '/graphql', fetch)
    const result = await qb.select('id').eq('id', 'user_123')

    expect(result.data).toBeNull()
    expect(result.error).toEqual({
      code: 'FORBIDDEN',
      message: 'permission denied',
    })
  })

  it('returns BAD_RESPONSE when GraphQL payload is malformed', async () => {
    const fetch = mockFetch({ success: false })
    const qb = new QueryBuilder('users', '/graphql', fetch)
    const result = await qb.select('id').maybeSingle()

    expect(result.data).toBeNull()
    expect(result.error).toEqual({
      code: 'BAD_RESPONSE',
      message: 'GraphQL response did not contain a data field',
    })
  })

  it('returns BAD_RESPONSE when response JSON cannot be parsed', async () => {
    const fetch = vi.fn().mockResolvedValue({
      ok: false,
      json: async () => {
        throw new Error('Unexpected token < in JSON')
      },
    } as Response) as unknown as FetchFn
    const qb = new QueryBuilder('users', '/graphql', fetch)
    const result = await qb.select('id')

    expect(result.data).toBeNull()
    expect(result.error).toEqual({
      code: 'BAD_RESPONSE',
      message: 'GraphQL response was empty or malformed',
    })
  })

  it('returns BAD_RESPONSE when wildcard introspection payload is malformed', async () => {
    const fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => null,
    } as Response) as unknown as FetchFn

    const qb = new QueryBuilder('users', '/graphql', fetch)
    const result = await qb.select('*')

    expect(result.data).toBeNull()
    expect(result.error).toEqual({
      code: 'BAD_RESPONSE',
      message: '@druvia/sdk: Introspection failed for type "users": GraphQL response was empty or malformed. Specify fields explicitly.',
    })
  })

  it('preserves non-standard top-level errors during wildcard introspection', async () => {
    const fetch = vi.fn().mockResolvedValueOnce({
      ok: false,
      json: async () => ({
        data: null,
        error: {
          code: 'FORBIDDEN',
          message: 'permission denied',
        },
      }),
    } as Response) as unknown as FetchFn

    const qb = new QueryBuilder('users', '/graphql', fetch)
    const result = await qb.select('*')

    expect(result.data).toBeNull()
    expect(result.error).toEqual({
      code: 'FORBIDDEN',
      message: '@druvia/sdk: Introspection failed for type "users": permission denied. Specify fields explicitly.',
    })
  })

  it('handles network errors', async () => {
    const fetch = vi.fn().mockRejectedValue(new Error('Network error'))
    const qb = new QueryBuilder('users', '/graphql', fetch as FetchFn)
    const result = await qb.select('id')

    expect(result.data).toBeNull()
    expect(result.error!.code).toBe('NETWORK_ERROR')
  })

  it('maybeSingle() returns single object when found', async () => {
    const fetch = mockFetch({ data: { users: [{ id: 1, name: 'Alice' }] } })
    const qb = new QueryBuilder('users', '/graphql', fetch)
    const result = await qb.select('id, name').eq('id', 1).maybeSingle()

    expect(result.data).toEqual({ id: 1, name: 'Alice' })
    expect(result.error).toBeNull()
  })

  it('maybeSingle() returns null without error when no rows', async () => {
    const fetch = mockFetch({ data: { users: [] } })
    const qb = new QueryBuilder('users', '/graphql', fetch)
    const result = await qb.select('id, name').eq('id', 999).maybeSingle()

    expect(result.data).toBeNull()
    expect(result.error).toBeNull()
  })

  it('or() generates _or where clause', async () => {
    const fetch = mockFetch({ data: { activities: [{ id: 1 }] } })
    const qb = new QueryBuilder('activities', '/graphql', fetch)
    const result = await qb
      .select('id')
      .or('is_demo.eq.true,is_creator_demo.eq.true')

    const body = JSON.parse((fetch as any).mock.calls[0][1].body)
    expect(body.query).toContain('_or')
    expect(body.query).toContain('is_demo')
    expect(body.query).toContain('is_creator_demo')
    expect(body.query).toContain('_eq')
    expect(result.error).toBeNull()
  })

  it('or() combines with existing eq filters', async () => {
    const fetch = mockFetch({ data: { activities: [] } })
    const qb = new QueryBuilder('activities', '/graphql', fetch)
    await qb
      .select('id')
      .eq('status', 'active')
      .or('is_demo.eq.true,is_creator_demo.eq.true')

    const body = JSON.parse((fetch as any).mock.calls[0][1].body)
    expect(body.query).toContain('status')
    expect(body.query).toContain('_or')
  })

  it('not() negates a filter condition', async () => {
    const fetch = mockFetch({ data: { users: [{ id: 1, display_name: 'Alice' }] } })
    const qb = new QueryBuilder('users', '/graphql', fetch)
    const result = await qb.select('id, display_name').not('display_name', 'is', null)

    const body = JSON.parse((fetch as any).mock.calls[0][1].body)
    expect(body.query).toContain('display_name')
    expect(body.query).toContain('_is_null: false')
    expect(result.error).toBeNull()
  })

  it('not() with eq operator', async () => {
    const fetch = mockFetch({ data: { users: [] } })
    const qb = new QueryBuilder('users', '/graphql', fetch)
    await qb.select('id').not('status', 'eq', 'deleted')

    const body = JSON.parse((fetch as any).mock.calls[0][1].body)
    expect(body.query).toContain('_neq')
  })
})
