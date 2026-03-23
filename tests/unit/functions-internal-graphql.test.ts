import Fastify from 'fastify'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../apps/api/src/db/index.js', () => ({
  pool: {
    query: vi.fn(),
  },
}))

import { pool } from '../../apps/api/src/db/index.js'
import { internalFunctionsGraphqlRoutes } from '../../apps/api/src/modules/functions/internal-graphql.routes.js'
import { signInternalFunctionToken } from '../../apps/api/src/modules/functions/internal-token.js'

describe('Functions Internal GraphQL Route', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubGlobal('fetch', vi.fn())
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('allows access with a valid internal token and binds project scope from token only', async () => {
    const app = Fastify()
    await app.register(internalFunctionsGraphqlRoutes, { prefix: '/api' })

    vi.mocked(pool.query).mockResolvedValueOnce({
      rows: [{ schema_name: 'dru_proj_123' }],
    } as never)
    vi.mocked(pool.query).mockResolvedValueOnce({
      rows: [{ schema_name: 'dru_proj_other' }],
    } as never)
    vi.mocked(pool.query).mockResolvedValueOnce({
      rows: [{ schema_name: 'dru_proj_other_dev' }],
    } as never)
    vi.mocked(global.fetch).mockResolvedValueOnce({
      ok: true,
      json: vi.fn().mockResolvedValue({ data: { ok: true }, errors: null }),
    } as never)

    const token = signInternalFunctionToken({
      projectId: 'proj_123',
      functionName: 'wx-login-register',
      authType: 'apikey',
      expiresIn: 120,
    })

    try {
      const response = await app.inject({
        method: 'POST',
        url: '/api/internal/functions/graphql',
        headers: {
          'x-druvia-internal-token': token,
        },
        payload: {
          projectId: 'proj_other',
          query: 'query { __typename }',
          variables: { id: 1 },
        },
      })

      expect(response.statusCode).toBe(200)
      expect(pool.query).toHaveBeenCalledWith(
        'SELECT schema_name FROM druvia_projects WHERE project_id = $1',
        ['proj_123']
      )
      expect(pool.query).toHaveBeenCalledWith(
        'SELECT schema_name FROM druvia_projects WHERE project_id <> $1',
        ['proj_123']
      )
      expect(pool.query).toHaveBeenCalledWith(
        'SELECT schema_name FROM druvia_project_environments WHERE project_id <> $1',
        ['proj_123']
      )
      expect(global.fetch).toHaveBeenCalledTimes(1)
      const [, init] = vi.mocked(global.fetch).mock.calls[0]
      expect(JSON.parse(init!.body as string)).toEqual({
        query: 'query { __typename }',
        variables: { id: 1 },
        operationName: undefined,
      })
    } finally {
      await app.close()
    }
  })

  it('rejects requests with an invalid internal token', async () => {
    const app = Fastify()
    await app.register(internalFunctionsGraphqlRoutes, { prefix: '/api' })

    try {
      const response = await app.inject({
        method: 'POST',
        url: '/api/internal/functions/graphql',
        headers: {
          'x-druvia-internal-token': 'invalid-token',
        },
        payload: {
          query: 'query { __typename }',
        },
      })

      expect(response.statusCode).toBe(401)
      expect(global.fetch).not.toHaveBeenCalled()
      expect(pool.query).not.toHaveBeenCalled()
    } finally {
      await app.close()
    }
  })

  it('rejects graphql operations that explicitly reference another project schema', async () => {
    const app = Fastify()
    await app.register(internalFunctionsGraphqlRoutes, { prefix: '/api' })

    vi.mocked(pool.query).mockResolvedValueOnce({
      rows: [{ schema_name: 'dru_proj_123' }],
    } as never)
    vi.mocked(pool.query).mockResolvedValueOnce({
      rows: [{ schema_name: 'dru_proj_other' }],
    } as never)
    vi.mocked(pool.query).mockResolvedValueOnce({
      rows: [],
    } as never)

    const token = signInternalFunctionToken({
      projectId: 'proj_123',
      functionName: 'wx-login-register',
      authType: 'apikey',
      expiresIn: 120,
    })

    try {
      const response = await app.inject({
        method: 'POST',
        url: '/api/internal/functions/graphql',
        headers: {
          'x-druvia-internal-token': token,
        },
        payload: {
          query: 'query { dru_proj_other_users(limit: 1) { id } }',
        },
      })

      expect(response.statusCode).toBe(403)
      expect(global.fetch).not.toHaveBeenCalled()
    } finally {
      await app.close()
    }
  })

  it('rejects graphql operations that explicitly reference another project environment schema', async () => {
    const app = Fastify()
    await app.register(internalFunctionsGraphqlRoutes, { prefix: '/api' })

    vi.mocked(pool.query).mockResolvedValueOnce({
      rows: [{ schema_name: 'dru_proj_123' }],
    } as never)
    vi.mocked(pool.query).mockResolvedValueOnce({
      rows: [{ schema_name: 'dru_proj_other' }],
    } as never)
    vi.mocked(pool.query).mockResolvedValueOnce({
      rows: [{ schema_name: 'dru_proj_other_dev' }],
    } as never)

    const token = signInternalFunctionToken({
      projectId: 'proj_123',
      functionName: 'wx-login-register',
      authType: 'apikey',
      expiresIn: 120,
    })

    try {
      const response = await app.inject({
        method: 'POST',
        url: '/api/internal/functions/graphql',
        headers: {
          'x-druvia-internal-token': token,
        },
        payload: {
          query: 'query { dru_proj_other_dev_users(limit: 1) { id } }',
        },
      })

      expect(response.statusCode).toBe(403)
      expect(global.fetch).not.toHaveBeenCalled()
    } finally {
      await app.close()
    }
  })
})
