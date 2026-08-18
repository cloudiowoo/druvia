import jwt from 'jsonwebtoken'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { config, resolveRealtimeConfig } from '../../apps/api/src/config/index.js'
import {
  RealtimeTokenUnavailableError,
  derivePublicRealtimeUrl,
  issueRealtimeAccessToken,
} from '../../apps/api/src/modules/realtime/realtime-token.service.js'

const originalRealtime = { ...config.realtime }
const originalNodeEnv = config.nodeEnv
const originalHasuraEndpoint = config.hasura.endpoint

afterEach(() => {
  Object.assign(config.realtime, originalRealtime)
  config.nodeEnv = originalNodeEnv
  config.hasura.endpoint = originalHasuraEndpoint
  vi.restoreAllMocks()
})

describe('Realtime token configuration', () => {
  it('prefers the dedicated secret and clamps a short TTL', () => {
    expect(resolveRealtimeConfig({
      HASURA_JWT_SECRET: 'h'.repeat(32),
      JWT_SECRET: 'j'.repeat(32),
      HASURA_REALTIME_TOKEN_TTL_SECONDS: '30',
      HASURA_PUBLIC_URL: 'https://graphql.druvia.example.com/',
      API_BASE_URL: 'https://druvia.example.com/',
    })).toEqual({
      tokenSecret: 'h'.repeat(32),
      tokenSecretSource: 'HASURA_JWT_SECRET',
      tokenTtlSeconds: 60,
      hasuraPublicUrl: 'https://graphql.druvia.example.com/',
      apiBaseUrl: 'https://druvia.example.com/',
    })
  })

  it('uses the compatibility secret and clamps a long TTL', () => {
    expect(resolveRealtimeConfig({
      JWT_SECRET: 'j'.repeat(32),
      HASURA_REALTIME_TOKEN_TTL_SECONDS: '3600',
    })).toMatchObject({
      tokenSecret: 'j'.repeat(32),
      tokenSecretSource: 'JWT_SECRET',
      tokenTtlSeconds: 900,
    })
  })

  it('uses the default TTL for an invalid value', () => {
    expect(resolveRealtimeConfig({
      HASURA_REALTIME_TOKEN_TTL_SECONDS: 'invalid',
    }).tokenTtlSeconds).toBe(300)
  })
})

describe('public Realtime URL', () => {
  it('prefers HASURA_PUBLIC_URL and converts HTTPS to WSS', () => {
    expect(derivePublicRealtimeUrl({
      hasuraPublicUrl: 'https://graphql.druvia.example.com/',
      apiBaseUrl: 'https://api.druvia.example.com/',
      nodeEnv: 'production',
      hasuraEndpoint: 'http://hasura:8080',
    })).toBe('wss://graphql.druvia.example.com/v1/graphql')
  })

  it('uses the public API origin when no Hasura public origin is configured', () => {
    expect(derivePublicRealtimeUrl({
      hasuraPublicUrl: '',
      apiBaseUrl: 'http://localhost:8088/',
      nodeEnv: 'production',
      hasuraEndpoint: 'http://hasura:8080',
    })).toBe('ws://localhost:8088/v1/graphql')
  })

  it('allows the internal Hasura endpoint only in development', () => {
    expect(derivePublicRealtimeUrl({
      hasuraPublicUrl: '',
      apiBaseUrl: '',
      nodeEnv: 'development',
      hasuraEndpoint: 'http://localhost:8180/',
    })).toBe('ws://localhost:8180/v1/graphql')
  })

  it.each([
    'https://user:pass@example.com',
    'https://example.com/graphql',
    'https://example.com/?token=secret',
    'https://example.com/#fragment',
    'ftp://example.com',
    'not-a-url',
  ])('rejects invalid public origins: %s', (hasuraPublicUrl) => {
    expect(() => derivePublicRealtimeUrl({
      hasuraPublicUrl,
      apiBaseUrl: '',
      nodeEnv: 'production',
      hasuraEndpoint: 'http://hasura:8080',
    })).toThrow(RealtimeTokenUnavailableError)
  })

  it('rejects missing public origins in production', () => {
    expect(() => derivePublicRealtimeUrl({
      hasuraPublicUrl: '',
      apiBaseUrl: '',
      nodeEnv: 'production',
      hasuraEndpoint: 'http://hasura:8080',
    })).toThrow(RealtimeTokenUnavailableError)
  })
})

describe('Realtime access token issuer', () => {
  it('signs a short-lived project-user token with server-derived Hasura claims', () => {
    Object.assign(config.realtime, {
      tokenSecret: 'h'.repeat(32),
      tokenSecretSource: 'HASURA_JWT_SECRET',
      tokenTtlSeconds: 300,
      hasuraPublicUrl: 'https://graphql.druvia.example.com/',
      apiBaseUrl: '',
    })
    config.nodeEnv = 'production'

    const now = new Date('2026-08-18T10:00:00.000Z')
    const result = issueRealtimeAccessToken({
      projectId: 'proj_123',
      context: {
        role: 'user',
        actorType: 'project_user',
        subject: 'usr_project_1',
        sessionVariables: {
          'x-hasura-project-id': 'proj_123',
          'x-hasura-actor-type': 'project_user',
          'x-hasura-user-id': 'usr_project_1',
        },
      },
      now,
      operationId: 'op_realtime_1',
    })

    const payload = jwt.verify(result.token, 'h'.repeat(32), {
      algorithms: ['HS256'],
      issuer: 'druvia',
      audience: 'druvia-hasura',
    }) as jwt.JwtPayload

    expect(payload).toMatchObject({
      sub: 'usr_project_1',
      jti: 'op_realtime_1',
      iat: Math.floor(now.getTime() / 1000),
      exp: Math.floor(now.getTime() / 1000) + 300,
      tokenType: 'druvia_realtime_access',
      projectId: 'proj_123',
      actorType: 'project_user',
      'https://hasura.io/jwt/claims': {
        'x-hasura-allowed-roles': ['user'],
        'x-hasura-default-role': 'user',
        'x-hasura-project-id': 'proj_123',
        'x-hasura-actor-type': 'project_user',
        'x-hasura-user-id': 'usr_project_1',
      },
    })
    expect(result).toMatchObject({
      operationId: 'op_realtime_1',
      expiresIn: 300,
      expiresAt: '2026-08-18T10:05:00.000Z',
      websocketUrl: 'wss://graphql.druvia.example.com/v1/graphql',
    })
  })

  it('omits user identity from API-key tokens', () => {
    Object.assign(config.realtime, {
      tokenSecret: 'h'.repeat(32),
      tokenSecretSource: 'HASURA_JWT_SECRET',
      tokenTtlSeconds: 60,
      hasuraPublicUrl: 'https://graphql.druvia.example.com',
      apiBaseUrl: '',
    })
    config.nodeEnv = 'production'

    const result = issueRealtimeAccessToken({
      projectId: 'proj_123',
      context: {
        role: 'anonymous',
        actorType: 'apikey',
        subject: 'apikey:proj_123',
        sessionVariables: {
          'x-hasura-project-id': 'proj_123',
          'x-hasura-actor-type': 'apikey',
        },
      },
    })
    const payload = jwt.verify(result.token, 'h'.repeat(32)) as jwt.JwtPayload
    const claims = payload['https://hasura.io/jwt/claims'] as Record<string, unknown>

    expect(claims['x-hasura-allowed-roles']).toEqual(['anonymous'])
    expect(claims).not.toHaveProperty('x-hasura-user-id')
    expect(payload.jti).toBeTruthy()
  })

  it('rejects an invalid secret without leaking it', () => {
    const invalidSecret = 'too-short-secret'
    Object.assign(config.realtime, {
      tokenSecret: invalidSecret,
      tokenSecretSource: 'HASURA_JWT_SECRET',
      tokenTtlSeconds: 300,
      hasuraPublicUrl: 'https://graphql.druvia.example.com',
      apiBaseUrl: '',
    })

    expect(() => issueRealtimeAccessToken({
      projectId: 'proj_123',
      context: {
        role: 'user',
        actorType: 'project_user',
        subject: 'usr_project_1',
        sessionVariables: {},
      },
    })).toThrow(RealtimeTokenUnavailableError)

    try {
      issueRealtimeAccessToken({
        projectId: 'proj_123',
        context: {
          role: 'user',
          actorType: 'project_user',
          subject: 'usr_project_1',
          sessionVariables: {},
        },
      })
    } catch (error) {
      expect((error as Error).message).not.toContain(invalidSecret)
    }
  })

  it('warns once when JWT_SECRET compatibility fallback is used', () => {
    Object.assign(config.realtime, {
      tokenSecret: 'j'.repeat(32),
      tokenSecretSource: 'JWT_SECRET',
      tokenTtlSeconds: 300,
      hasuraPublicUrl: 'https://graphql.druvia.example.com',
      apiBaseUrl: '',
    })
    config.nodeEnv = 'production'
    const write = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    const input = {
      projectId: 'proj_123',
      context: {
        role: 'user',
        actorType: 'project_user' as const,
        subject: 'usr_project_1',
        sessionVariables: {},
      },
    }

    issueRealtimeAccessToken(input)
    issueRealtimeAccessToken(input)

    expect(write).toHaveBeenCalledTimes(1)
    expect(String(write.mock.calls[0][0])).toContain('"secretSource":"JWT_SECRET"')
    expect(String(write.mock.calls[0][0])).not.toContain('j'.repeat(32))
  })
})
