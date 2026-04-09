import { describe, expect, it, vi } from 'vitest'

vi.mock('../../apps/api/src/lib/redis.js', () => ({
  redis: {
    on: vi.fn(),
    quit: vi.fn(),
    get: vi.fn(),
    setex: vi.fn(),
    del: vi.fn(),
    keys: vi.fn().mockResolvedValue([]),
  },
}))

import { appCorsOptions, buildApp } from '../../apps/api/src/index.js'
import { authenticate, signProjectUserToken, signToken } from '../../apps/api/src/middleware/auth.js'
import { getApiLogContext } from '../../apps/api/src/lib/log-context.js'

describe('API app CORS', () => {
  it('includes the apikey header in the allowed CORS headers', () => {
    expect(appCorsOptions.allowedHeaders).toContain('apikey')
    expect(appCorsOptions.allowedHeaders).toContain('x-druvia-storage-ticket')
    expect(appCorsOptions.allowedHeaders).toContain('x-druvia-trusted-backend-key')
  })
})

describe('API app proxy awareness', () => {
  it('honors X-Forwarded-For when trust proxy is enabled', async () => {
    const app = buildApp({ trustProxy: true })

    app.get('/__test/ip', async (request) => ({ ip: request.ip }))

    try {
      const response = await app.inject({
        method: 'GET',
        url: '/__test/ip',
        remoteAddress: '172.20.0.10',
        headers: {
          'x-forwarded-for': '198.51.100.24, 172.20.0.10',
        },
      })

      expect(response.statusCode).toBe(200)
      expect(response.json()).toEqual({ ip: '198.51.100.24' })
    } finally {
      await app.close()
    }
  })
})

describe('API app internal functions route', () => {
  it('registers the internal functions graphql route', async () => {
    const app = buildApp()

    try {
      const response = await app.inject({
        method: 'POST',
        url: '/api/internal/functions/graphql',
        payload: { query: 'query { __typename }' },
      })

      expect(response.statusCode).toBe(401)
    } finally {
      await app.close()
    }
  })

  it('registers the internal functions storage upload route', async () => {
    const app = buildApp()

    try {
      const response = await app.inject({
        method: 'POST',
        url: '/api/internal/functions/storage/upload',
        payload: {
          bucket: 'team-assets',
          path: 'avatars/a.png',
          contentType: 'image/png',
          dataBase64: 'ZmlsZQ==',
        },
      })

      expect(response.statusCode).toBe(401)
    } finally {
      await app.close()
    }
  })
})

describe('API app storage trusted access routes', () => {
  it('registers trusted storage issuer and consume routes', async () => {
    const app = buildApp()

    try {
      const uploadTicketResponse = await app.inject({
        method: 'POST',
        url: '/api/v1/projects/proj_123/storage/trusted/upload-ticket',
        payload: {},
      })

      const uploadWithTicketResponse = await app.inject({
        method: 'POST',
        url: '/api/v1/storage/upload-with-ticket',
        payload: {},
      })

      const removeWithTicketResponse = await app.inject({
        method: 'POST',
        url: '/api/v1/storage/remove-with-ticket',
        payload: {},
      })

      expect(uploadTicketResponse.statusCode).toBe(401)
      expect(uploadWithTicketResponse.statusCode).toBe(401)
      expect(removeWithTicketResponse.statusCode).toBe(401)
    } finally {
      await app.close()
    }
  })
})

describe('API app schema hasura routes', () => {
  it('registers the manual hasura reload route', async () => {
    const app = buildApp()

    try {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/schemas/dru_test/hasura/reload',
      })

      expect(response.statusCode).toBe(401)
    } finally {
      await app.close()
    }
  })
})

describe('API app project auth routes', () => {
  it('registers the public project auth routes', async () => {
    const app = buildApp()

    try {
      const loginResponse = await app.inject({
        method: 'POST',
        url: '/api/v1/projects/proj_123/auth/wechat/login',
        payload: {},
      })

      const refreshResponse = await app.inject({
        method: 'POST',
        url: '/api/v1/projects/proj_123/auth/refresh',
        payload: {},
      })

      const providerLoginResponse = await app.inject({
        method: 'POST',
        url: '/api/v1/projects/proj_123/auth/oidc/login',
        payload: {},
      })

      const trustedIssueResponse = await app.inject({
        method: 'POST',
        url: '/api/v1/projects/proj_123/auth/trusted/issue-session',
        payload: {},
      })

      const logoutResponse = await app.inject({
        method: 'POST',
        url: '/api/v1/projects/proj_123/auth/logout',
      })

      expect(loginResponse.statusCode).toBe(400)
      expect(refreshResponse.statusCode).toBe(400)
      expect(providerLoginResponse.statusCode).toBe(400)
      expect(trustedIssueResponse.statusCode).toBe(401)
      expect(logoutResponse.statusCode).toBe(401)
    } finally {
      await app.close()
    }
  })
})

describe('API app trusted backend key routes', () => {
  it('registers trusted backend key management routes', async () => {
    const app = buildApp()

    try {
      const listResponse = await app.inject({
        method: 'GET',
        url: '/api/v1/projects/proj_123/trusted-backend-keys',
      })

      const createResponse = await app.inject({
        method: 'POST',
        url: '/api/v1/projects/proj_123/trusted-backend-keys',
        payload: { name: 'H5 Backend', scopes: ['project_session:issue'] },
      })

      const deleteResponse = await app.inject({
        method: 'DELETE',
        url: '/api/v1/projects/proj_123/trusted-backend-keys/1',
      })

      expect(listResponse.statusCode).toBe(401)
      expect(createResponse.statusCode).toBe(401)
      expect(deleteResponse.statusCode).toBe(401)
    } finally {
      await app.close()
    }
  })
})

describe('API app log context hooks', () => {
  it('includes authenticated platform user context after route auth runs', async () => {
    const app = buildApp()
    const token = signToken({ userId: 'user_123', uid: 1, tenantId: 'tenant_123' })

    app.get('/__test/projects/:projectId/log-context', { preHandler: authenticate }, async () => {
      return getApiLogContext()
    })

    try {
      const response = await app.inject({
        method: 'GET',
        url: '/__test/projects/proj_123/log-context',
        headers: {
          authorization: `Bearer ${token}`,
        },
      })

      expect(response.statusCode).toBe(200)
      expect(response.json()).toMatchObject({
        requestId: expect.any(String),
        projectId: 'proj_123',
        userId: 'user_123',
      })
    } finally {
      await app.close()
    }
  })

  it('captures schema and table alias params and project user context', async () => {
    const app = buildApp()
    const token = signProjectUserToken({
      sub: 'usr_proj_123',
      projectId: 'proj_456',
      authType: 'project_user',
      role: 'authenticated',
      provider: 'wechat',
    })

    app.get('/__test/schemas/:schema/tables/:table/log-context', { preHandler: authenticate }, async () => {
      return getApiLogContext()
    })

    try {
      const response = await app.inject({
        method: 'GET',
        url: '/__test/schemas/dru_test/tables/users/log-context',
        headers: {
          authorization: `Bearer ${token}`,
        },
      })

      expect(response.statusCode).toBe(200)
      expect(response.json()).toMatchObject({
        requestId: expect.any(String),
        projectId: 'proj_456',
        projectUserId: 'usr_proj_123',
        schemaName: 'dru_test',
        tableName: 'users',
      })
    } finally {
      await app.close()
    }
  })
})
