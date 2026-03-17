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
    const fetch = mockFetch({ data: { insert_users: { returning: [{ id: 1 }] } } })
    const qb = new QueryBuilder('users', '/graphql', fetch)
    const result = await qb.insert({ username: 'test', user_id: 'u1' })

    const body = JSON.parse((fetch as any).mock.calls[0][1].body)
    expect(body.query).toContain('insert_users')
  })

  it('update sends mutation with where', async () => {
    const fetch = mockFetch({ data: { update_users: { returning: [{ id: 1 }] } } })
    const qb = new QueryBuilder('users', '/graphql', fetch)
    const result = await qb.update({ username: 'new' }).eq('id', 1)

    const body = JSON.parse((fetch as any).mock.calls[0][1].body)
    expect(body.query).toContain('update_users')
    expect(body.query).toContain('_set')
  })

  it('delete sends mutation with where', async () => {
    const fetch = mockFetch({ data: { delete_users: { returning: [{ id: 1 }] } } })
    const qb = new QueryBuilder('users', '/graphql', fetch)
    const result = await qb.delete().eq('id', 1)

    const body = JSON.parse((fetch as any).mock.calls[0][1].body)
    expect(body.query).toContain('delete_users')
  })

  it('upsert sends insert mutation with on_conflict', async () => {
    const fetch = mockFetch({ data: { insert_users: { returning: [{ id: 1 }] } } })
    const qb = new QueryBuilder('users', '/graphql', fetch)
    const result = await qb.upsert({ id: 1, username: 'test' })

    const body = JSON.parse((fetch as any).mock.calls[0][1].body)
    expect(body.query).toContain('insert_users')
    expect(body.query).toContain('on_conflict')
  })

  it('select("*") triggers introspection to resolve fields', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce({
        ok: true, json: async () => ({
          data: { __type: { fields: [{ name: 'id' }, { name: 'username' }, { name: 'email' }] } }
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

  it('handles GraphQL errors', async () => {
    const fetch = mockFetch({ errors: [{ message: 'field not found' }] })
    const qb = new QueryBuilder('users', '/graphql', fetch)
    const result = await qb.select('nonexistent')

    expect(result.data).toBeNull()
    expect(result.error).toBeTruthy()
    expect(result.error!.message).toContain('field not found')
  })

  it('handles network errors', async () => {
    const fetch = vi.fn().mockRejectedValue(new Error('Network error'))
    const qb = new QueryBuilder('users', '/graphql', fetch as FetchFn)
    const result = await qb.select('id')

    expect(result.data).toBeNull()
    expect(result.error!.code).toBe('NETWORK_ERROR')
  })
})
