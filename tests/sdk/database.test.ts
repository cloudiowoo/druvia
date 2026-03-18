import { describe, it, expect, vi } from 'vitest'
import { DruviaDatabase } from '../../packages/sdk/src/modules/database.js'
import type { FetchFn } from '../../packages/sdk/src/types.js'

describe('DruviaDatabase', () => {
  it('from() returns a QueryBuilder for the given table', () => {
    const fetch = vi.fn() as unknown as FetchFn
    const db = new DruviaDatabase('/graphql', fetch)
    const qb = db.from('users')
    expect(qb).toBeDefined()
    expect(typeof qb.select).toBe('function')
    expect(typeof qb.insert).toBe('function')
    expect(typeof qb.eq).toBe('function')
  })

  it('graphql() sends raw query', async () => {
    const fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: { users: [{ id: 1 }] } }),
    }) as unknown as FetchFn
    const db = new DruviaDatabase('/graphql', fetch)
    const result = await db.graphql('query { users { id } }')
    expect(result.data).toEqual({ users: [{ id: 1 }] })
    expect(fetch).toHaveBeenCalledWith('/graphql', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ query: 'query { users { id } }' }),
    }))
  })

  it('graphql() handles errors', async () => {
    const fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ errors: [{ message: 'syntax error' }] }),
    }) as unknown as FetchFn
    const db = new DruviaDatabase('/graphql', fetch)
    const result = await db.graphql('invalid')
    expect(result.data).toBeNull()
    expect(result.error!.code).toBe('GRAPHQL_ERROR')
  })
})
