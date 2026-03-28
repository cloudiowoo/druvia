import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../apps/api/src/db/index.js', () => ({
  query: vi.fn(),
  queryOne: vi.fn(),
}))

vi.mock('../../apps/api/src/modules/project/project.service.js', () => ({
  getProjectById: vi.fn(),
}))

vi.mock('../../apps/api/src/modules/auth-admin/auth-admin.service.js', () => ({
  getAuthConfig: vi.fn(),
  getProvider: vi.fn(),
  getProviderSecret: vi.fn(),
}))

vi.mock('../../apps/api/src/adapters/auth/index.js', () => ({
  createAuthAdapter: vi.fn(),
}))

import { query, queryOne } from '../../apps/api/src/db/index.js'
import { getProjectById } from '../../apps/api/src/modules/project/project.service.js'
import {
  getAuthConfig,
  getProvider,
  getProviderSecret,
} from '../../apps/api/src/modules/auth-admin/auth-admin.service.js'
import { createAuthAdapter } from '../../apps/api/src/adapters/auth/index.js'
import { verifyProjectUserToken } from '../../apps/api/src/middleware/auth.js'
import {
  ProjectAuthError,
  issueTrustedProjectSession,
  providerLogin,
  providerSilentLogin,
  refreshProjectSession,
  wechatLogin,
  wechatSilentLogin,
} from '../../apps/api/src/modules/project-auth/project-auth.service.js'

const mockQuery = vi.mocked(query)
const mockQueryOne = vi.mocked(queryOne)
const mockGetProjectById = vi.mocked(getProjectById)
const mockGetAuthConfig = vi.mocked(getAuthConfig)
const mockGetProvider = vi.mocked(getProvider)
const mockGetProviderSecret = vi.mocked(getProviderSecret)
const mockCreateAuthAdapter = vi.mocked(createAuthAdapter)

function mockProjectContext() {
  mockGetProjectById.mockResolvedValue({
    projectId: 'proj_123',
    schemaName: 'dru_default_taroapp',
  } as Awaited<ReturnType<typeof getProjectById>>)

  mockGetAuthConfig.mockResolvedValue({
    projectId: 'proj_123',
    jwtExpiresIn: 3600,
    refreshTokenExpiresIn: 86400,
    passwordMinLength: 8,
    requireEmailVerification: false,
    allowSignup: true,
  })

  mockGetProvider.mockResolvedValue({
    id: 1,
    projectId: 'proj_123',
    provider: 'wechat',
    enabled: true,
    clientId: 'wx_appid',
    config: { type: 'miniprogram' },
    createdAt: new Date(),
    updatedAt: new Date(),
  })

  mockGetProviderSecret.mockResolvedValue('wx_secret')
}

describe('Project Auth Service', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockProjectContext()
  })

  it('creates a missing user on wechat login when allowSignup is enabled', async () => {
    mockCreateAuthAdapter.mockReturnValue({
      provider: 'wechat',
      exchangeCode: vi.fn().mockResolvedValue({
        user: {
          provider: 'wechat',
          providerId: 'openid_123',
          raw: { openid: 'openid_123' },
        },
      }),
    })

    mockQuery.mockImplementation(async (sql) => {
      if (sql.includes('information_schema.columns')) {
        return [
          { column_name: 'id' },
          { column_name: 'email' },
          { column_name: 'username' },
          { column_name: 'avatar_url' },
          { column_name: 'provider' },
          { column_name: 'status' },
          { column_name: 'wx_open_id' },
          { column_name: 'created_at' },
          { column_name: 'updated_at' },
        ]
      }
      return []
    })

    mockQueryOne
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        id: 'usr_proj_1',
        email: 'openid_123@wechat.druvia.local',
        username: 'Alice',
        avatar_url: 'https://example.com/avatar.png',
        provider: 'wechat',
        provider_id: null,
        status: 'active',
        last_login_at: null,
        created_at: new Date('2026-03-24T00:00:00Z'),
      })

    const session = await wechatLogin('proj_123', {
      code: 'wx_code',
      userInfo: {
        nickName: 'Alice',
        avatarUrl: 'https://example.com/avatar.png',
      },
    })

    expect(session.user.id).toBe('usr_proj_1')
    expect(session.user.role).toBe('authenticated')
    expect(session.token).toBeTypeOf('string')
    expect(session.refreshToken).toBeTypeOf('string')

    expect(mockQueryOne).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining('INSERT INTO dru_default_taroapp.users'),
      expect.arrayContaining([
        'openid_123@wechat.druvia.local',
        'Alice',
        'https://example.com/avatar.png',
        'wechat',
        'active',
        'openid_123',
      ])
    )
  })

  it('generates uuid ids for uuid user tables on wechat signup', async () => {
    mockCreateAuthAdapter.mockReturnValue({
      provider: 'wechat',
      exchangeCode: vi.fn().mockResolvedValue({
        user: {
          provider: 'wechat',
          providerId: 'openid_uuid_123',
          raw: { openid: 'openid_uuid_123' },
        },
      }),
    })

    mockQuery.mockImplementation(async (sql) => {
      if (sql.includes('information_schema.columns')) {
        return [
          { column_name: 'id', data_type: 'uuid' },
          { column_name: 'email', data_type: 'text' },
          { column_name: 'username', data_type: 'text' },
          { column_name: 'avatar_url', data_type: 'text' },
          { column_name: 'provider', data_type: 'text' },
          { column_name: 'provider_id', data_type: 'text' },
          { column_name: 'status', data_type: 'text' },
          { column_name: 'wx_open_id', data_type: 'text' },
          { column_name: 'created_at', data_type: 'timestamp with time zone' },
          { column_name: 'updated_at', data_type: 'timestamp with time zone' },
        ]
      }
      return []
    })

    mockQueryOne
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        id: '550e8400-e29b-41d4-a716-446655440000',
        email: 'openid_uuid_123@wechat.druvia.local',
        username: 'UUID User',
        avatar_url: 'https://example.com/avatar-uuid.png',
        provider: 'wechat',
        provider_id: 'openid_uuid_123',
        status: 'active',
        last_login_at: null,
        created_at: new Date('2026-03-24T00:00:00Z'),
      })

    const session = await wechatLogin('proj_123', {
      code: 'wx_uuid_code',
      userInfo: {
        nickName: 'UUID User',
        avatarUrl: 'https://example.com/avatar-uuid.png',
      },
    })

    expect(session.user.id).toBe('550e8400-e29b-41d4-a716-446655440000')
    const [insertSql, insertValues] = mockQueryOne.mock.calls[2] ?? []
    expect(insertSql).toContain('INSERT INTO dru_default_taroapp.users')
    expect(insertSql).toContain('(id,')
    expect(insertValues).toEqual([
      expect.stringMatching(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
      ),
      'openid_uuid_123@wechat.druvia.local',
      'UUID User',
      'https://example.com/avatar-uuid.png',
      'wechat',
      'openid_uuid_123',
      'active',
      'openid_uuid_123',
    ])
  })

  it('wraps project user schema errors when uuid ids cannot be generated by the table', async () => {
    mockCreateAuthAdapter.mockReturnValue({
      provider: 'wechat',
      exchangeCode: vi.fn().mockResolvedValue({
        user: {
          provider: 'wechat',
          providerId: 'openid_schema_error',
          raw: { openid: 'openid_schema_error' },
        },
      }),
    })

    mockQuery.mockImplementation(async (sql) => {
      if (sql.includes('information_schema.columns')) {
        return [
          { column_name: 'id', data_type: 'uuid' },
          { column_name: 'email', data_type: 'text' },
          { column_name: 'provider', data_type: 'text' },
          { column_name: 'provider_id', data_type: 'text' },
          { column_name: 'status', data_type: 'text' },
          { column_name: 'wx_open_id', data_type: 'text' },
        ]
      }
      return []
    })

    mockQueryOne
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockRejectedValueOnce({
        code: '23502',
        message: 'null value in column "id" of relation "users" violates not-null constraint',
      })

    await expect(
      wechatLogin('proj_123', { code: 'wx_schema_error' })
    ).rejects.toMatchObject<ProjectAuthError>({
      code: 'USER_CREATE_FAILED',
      statusCode: 500,
    })
  })

  it('recovers from concurrent signup unique violations by returning the existing user', async () => {
    mockCreateAuthAdapter.mockReturnValue({
      provider: 'wechat',
      exchangeCode: vi.fn().mockResolvedValue({
        user: {
          provider: 'wechat',
          providerId: 'openid_race_123',
          raw: { openid: 'openid_race_123' },
        },
      }),
    })

    mockQuery.mockImplementation(async (sql) => {
      if (sql.includes('information_schema.columns')) {
        return [
          { column_name: 'id', data_type: 'uuid' },
          { column_name: 'email', data_type: 'text' },
          { column_name: 'username', data_type: 'text' },
          { column_name: 'avatar_url', data_type: 'text' },
          { column_name: 'provider', data_type: 'text' },
          { column_name: 'provider_id', data_type: 'text' },
          { column_name: 'status', data_type: 'text' },
          { column_name: 'wx_open_id', data_type: 'text' },
        ]
      }
      return []
    })

    mockQueryOne
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockRejectedValueOnce({
        code: '23505',
        message: 'duplicate key value violates unique constraint "users_wx_open_id_key"',
      })
      .mockResolvedValueOnce({
        id: '550e8400-e29b-41d4-a716-446655440001',
        email: 'openid_race_123@wechat.druvia.local',
        username: 'Race User',
        avatar_url: null,
        provider: 'wechat',
        provider_id: 'openid_race_123',
        status: 'active',
        last_login_at: null,
        created_at: new Date('2026-03-24T00:00:00Z'),
      })

    const session = await wechatLogin('proj_123', { code: 'wx_race_code' })

    expect(session.user.id).toBe('550e8400-e29b-41d4-a716-446655440001')
  })

  it('returns USER_NOT_FOUND on silent login when no matching user exists', async () => {
    mockCreateAuthAdapter.mockReturnValue({
      provider: 'wechat',
      exchangeCode: vi.fn().mockResolvedValue({
        user: {
          provider: 'wechat',
          providerId: 'openid_missing',
          raw: { openid: 'openid_missing' },
        },
      }),
    })

    mockQuery.mockResolvedValue([
      { column_name: 'id' },
      { column_name: 'provider' },
      { column_name: 'provider_id' },
      { column_name: 'status' },
    ])
    mockQueryOne.mockResolvedValue(null)

    await expect(
      wechatSilentLogin('proj_123', { code: 'wx_code' })
    ).rejects.toMatchObject<ProjectAuthError>({
      code: 'USER_NOT_FOUND',
      statusCode: 404,
    })
  })

  it('falls back to legacy wx_open_id users during wechat silent login', async () => {
    mockCreateAuthAdapter.mockReturnValue({
      provider: 'wechat',
      exchangeCode: vi.fn().mockResolvedValue({
        user: {
          provider: 'wechat',
          providerId: 'openid_legacy',
          raw: { openid: 'openid_legacy' },
        },
      }),
    })

    mockQuery.mockImplementation(async (sql) => {
      if (sql.includes('information_schema.columns')) {
        return [
          { column_name: 'id' },
          { column_name: 'email' },
          { column_name: 'username' },
          { column_name: 'avatar_url' },
          { column_name: 'provider' },
          { column_name: 'status' },
          { column_name: 'wx_open_id' },
        ]
      }
      return []
    })

    mockQueryOne.mockResolvedValue({
      id: 'usr_legacy_1',
      email: 'legacy@example.com',
      username: 'Legacy User',
      avatar_url: null,
      provider: 'email',
      provider_id: null,
      status: 'active',
      last_login_at: null,
      created_at: new Date('2026-03-24T00:00:00Z'),
    })

    const session = await wechatSilentLogin('proj_123', { code: 'wx_code' })

    expect(session.user.id).toBe('usr_legacy_1')
    expect(session.user.username).toBe('Legacy User')
    expect(session.token).toBeTypeOf('string')
  })

  it('rotates project refresh tokens on refresh', async () => {
    mockQuery.mockImplementation(async (sql) => {
      if (sql.includes('information_schema.columns')) {
        return [
          { column_name: 'id' },
          { column_name: 'email' },
          { column_name: 'username' },
          { column_name: 'avatar_url' },
          { column_name: 'provider' },
          { column_name: 'provider_id' },
          { column_name: 'status' },
          { column_name: 'last_login_at' },
        ]
      }
      return []
    })

    mockQueryOne
      .mockResolvedValueOnce({
        user_id: 'usr_refresh_1',
        provider: 'wechat',
      })
      .mockResolvedValueOnce({
        id: 'usr_refresh_1',
        email: 'refresh@example.com',
        username: 'Refresh User',
        avatar_url: null,
        provider: 'wechat',
        provider_id: 'openid_refresh',
        status: 'active',
        last_login_at: new Date('2026-03-24T00:00:00Z'),
        created_at: new Date('2026-03-24T00:00:00Z'),
      })

    const session = await refreshProjectSession('proj_123', 'refresh_token_old')

    expect(session.user.id).toBe('usr_refresh_1')
    expect(session.token).toBeTypeOf('string')
    expect(session.refreshToken).toBeTypeOf('string')
    expect(mockQueryOne).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE druvia_project_refresh_tokens'),
      expect.arrayContaining(['proj_123'])
    )
  })

  it('issues a trusted session for an existing project user id', async () => {
    mockQuery.mockImplementation(async (sql) => {
      if (sql.includes('information_schema.columns')) {
        return [
          { column_name: 'id' },
          { column_name: 'email' },
          { column_name: 'username' },
          { column_name: 'avatar_url' },
          { column_name: 'provider' },
          { column_name: 'provider_id' },
          { column_name: 'status' },
          { column_name: 'last_login_at' },
          { column_name: 'created_at' },
        ]
      }
      return []
    })

    mockQueryOne.mockResolvedValueOnce({
      id: 'usr_existing_issuer',
      email: 'issuer@example.com',
      username: 'Issuer User',
      avatar_url: null,
      provider: 'wechat',
      provider_id: 'openid_issuer',
      status: 'active',
      last_login_at: new Date('2026-03-24T01:00:00Z'),
      created_at: new Date('2026-03-24T00:00:00Z'),
    })

    const session = await issueTrustedProjectSession('proj_123', 'usr_existing_issuer')

    expect(session.user.id).toBe('usr_existing_issuer')
    expect(session.token).toBeTypeOf('string')
    expect(session.refreshToken).toBeTypeOf('string')
    expect(verifyProjectUserToken(session.token).provider).toBe('trusted_backend')
    expect(mockQueryOne).toHaveBeenCalledWith(
      expect.stringContaining(`WHERE id = $1 AND status = 'active'`),
      ['usr_existing_issuer']
    )
  })

  it('rejects trusted issuer requests for unknown project users', async () => {
    mockQuery.mockImplementation(async (sql) => {
      if (sql.includes('information_schema.columns')) {
        return [
          { column_name: 'id' },
          { column_name: 'status' },
          { column_name: 'last_login_at' },
        ]
      }
      return []
    })
    mockQueryOne.mockResolvedValueOnce(null)

    await expect(
      issueTrustedProjectSession('proj_123', 'usr_missing')
    ).rejects.toMatchObject<ProjectAuthError>({
      code: 'USER_NOT_FOUND',
      statusCode: 404,
    })
  })

  it('rejects trusted issuer requests for disabled project users', async () => {
    mockQuery.mockImplementation(async (sql) => {
      if (sql.includes('information_schema.columns')) {
        return [
          { column_name: 'id' },
          { column_name: 'status' },
          { column_name: 'last_login_at' },
        ]
      }
      return []
    })
    mockQueryOne.mockResolvedValueOnce(null)

    await expect(
      issueTrustedProjectSession('proj_123', 'usr_disabled')
    ).rejects.toMatchObject<ProjectAuthError>({
      code: 'USER_NOT_FOUND',
      statusCode: 404,
    })
    expect(mockQueryOne).toHaveBeenCalledWith(
      expect.stringContaining(`WHERE id = $1 AND status = 'active'`),
      ['usr_disabled']
    )
  })

  it('uses provider/provider_id for generic provider login flows', async () => {
    mockGetProvider.mockResolvedValue({
      id: 2,
      projectId: 'proj_123',
      provider: 'oidc',
      enabled: true,
      clientId: 'oidc_client',
      config: {
        name: 'OIDC',
        authorizationEndpoint: 'https://issuer.example.com/auth',
        tokenEndpoint: 'https://issuer.example.com/token',
        userinfoEndpoint: 'https://issuer.example.com/userinfo',
        redirectUri: 'https://app.example.com/callback',
      },
      createdAt: new Date(),
      updatedAt: new Date(),
    } as Awaited<ReturnType<typeof getProvider>>)
    mockGetProviderSecret.mockResolvedValue('oidc_secret')
    mockCreateAuthAdapter.mockReturnValue({
      provider: 'oidc',
      exchangeCode: vi.fn().mockResolvedValue({
        user: {
          provider: 'oidc',
          providerId: 'oidc_sub_123',
          email: 'oidc@example.com',
          nickname: 'OIDC User',
          avatar: 'https://example.com/oidc-avatar.png',
          raw: { sub: 'oidc_sub_123' },
        },
      }),
    })

    mockQuery.mockResolvedValue([
      { column_name: 'id' },
      { column_name: 'email' },
      { column_name: 'username' },
      { column_name: 'avatar_url' },
      { column_name: 'provider' },
      { column_name: 'provider_id' },
      { column_name: 'status' },
      { column_name: 'created_at' },
      { column_name: 'updated_at' },
    ])
    mockQueryOne
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        id: 'usr_oidc_1',
        email: 'oidc@example.com',
        username: 'OIDC User',
        avatar_url: 'https://example.com/oidc-avatar.png',
        provider: 'oidc',
        provider_id: 'oidc_sub_123',
        status: 'active',
        last_login_at: null,
        created_at: new Date('2026-03-24T00:00:00Z'),
      })

    const session = await providerLogin('proj_123', 'oidc', {
      code: 'oidc_code',
    })

    expect(session.user.id).toBe('usr_oidc_1')
    expect(mockGetProvider).toHaveBeenCalledWith('proj_123', 'oidc')
    expect(mockQueryOne).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining('WHERE provider = $1 AND provider_id = $2'),
      ['oidc', 'oidc_sub_123']
    )
    expect(mockQueryOne).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining('INSERT INTO dru_default_taroapp.users'),
      expect.arrayContaining([
        'oidc@example.com',
        'OIDC User',
        'https://example.com/oidc-avatar.png',
        'oidc',
        'oidc_sub_123',
        'active',
      ])
    )
  })

  it('uses generic provider silent login without wechat legacy fallback', async () => {
    mockGetProvider.mockResolvedValue({
      id: 2,
      projectId: 'proj_123',
      provider: 'oidc',
      enabled: true,
      clientId: 'oidc_client',
      config: {
        name: 'OIDC',
        authorizationEndpoint: 'https://issuer.example.com/auth',
        tokenEndpoint: 'https://issuer.example.com/token',
        userinfoEndpoint: 'https://issuer.example.com/userinfo',
        redirectUri: 'https://app.example.com/callback',
      },
      createdAt: new Date(),
      updatedAt: new Date(),
    } as Awaited<ReturnType<typeof getProvider>>)
    mockGetProviderSecret.mockResolvedValue('oidc_secret')
    mockCreateAuthAdapter.mockReturnValue({
      provider: 'oidc',
      exchangeCode: vi.fn().mockResolvedValue({
        user: {
          provider: 'oidc',
          providerId: 'oidc_sub_missing',
          raw: { sub: 'oidc_sub_missing' },
        },
      }),
    })
    mockQuery.mockResolvedValue([
      { column_name: 'id' },
      { column_name: 'provider' },
      { column_name: 'provider_id' },
      { column_name: 'status' },
      { column_name: 'wx_open_id' },
    ])
    mockQueryOne.mockResolvedValue(null)

    await expect(
      providerSilentLogin('proj_123', 'oidc', { code: 'oidc_code' })
    ).rejects.toMatchObject<ProjectAuthError>({
      code: 'USER_NOT_FOUND',
      statusCode: 404,
    })

    expect(mockQueryOne).toHaveBeenCalledWith(
      expect.stringContaining('WHERE provider = $1 AND provider_id = $2'),
      ['oidc', 'oidc_sub_missing']
    )
  })

  it('does not write wx_open_id for non-wechat providers', async () => {
    mockGetProvider.mockResolvedValue({
      id: 2,
      projectId: 'proj_123',
      provider: 'oidc',
      enabled: true,
      clientId: 'oidc_client',
      config: {
        name: 'OIDC',
        authorizationEndpoint: 'https://issuer.example.com/auth',
        tokenEndpoint: 'https://issuer.example.com/token',
        userinfoEndpoint: 'https://issuer.example.com/userinfo',
        redirectUri: 'https://app.example.com/callback',
      },
      createdAt: new Date(),
      updatedAt: new Date(),
    } as Awaited<ReturnType<typeof getProvider>>)
    mockGetProviderSecret.mockResolvedValue('oidc_secret')
    mockCreateAuthAdapter.mockReturnValue({
      provider: 'oidc',
      exchangeCode: vi.fn().mockResolvedValue({
        user: {
          provider: 'oidc',
          providerId: 'oidc_sub_456',
          email: 'oidc2@example.com',
          raw: { sub: 'oidc_sub_456' },
        },
      }),
    })

    mockQuery.mockResolvedValue([
      { column_name: 'id' },
      { column_name: 'email' },
      { column_name: 'provider' },
      { column_name: 'provider_id' },
      { column_name: 'status' },
      { column_name: 'wx_open_id' },
    ])
    mockQueryOne
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        id: 'usr_oidc_2',
        email: 'oidc2@example.com',
        username: null,
        avatar_url: null,
        provider: 'oidc',
        provider_id: 'oidc_sub_456',
        status: 'active',
        last_login_at: null,
        created_at: new Date('2026-03-24T00:00:00Z'),
      })

    await providerLogin('proj_123', 'oidc', { code: 'oidc_code_2' })

    expect(mockQueryOne).toHaveBeenNthCalledWith(
      2,
      expect.not.stringContaining('wx_open_id'),
      expect.any(Array)
    )
  })

  it('updates last_login_at for existing users when the column exists', async () => {
    mockCreateAuthAdapter.mockReturnValue({
      provider: 'wechat',
      exchangeCode: vi.fn().mockResolvedValue({
        user: {
          provider: 'wechat',
          providerId: 'openid_existing',
          raw: { openid: 'openid_existing' },
        },
      }),
    })

    mockQuery.mockResolvedValue([
      { column_name: 'id' },
      { column_name: 'email' },
      { column_name: 'username' },
      { column_name: 'avatar_url' },
      { column_name: 'provider' },
      { column_name: 'provider_id' },
      { column_name: 'status' },
      { column_name: 'last_login_at' },
    ])
    mockQueryOne
      .mockResolvedValueOnce({
        id: 'usr_existing_1',
        email: 'existing@example.com',
        username: 'Existing User',
        avatar_url: null,
        provider: 'wechat',
        provider_id: 'openid_existing',
        status: 'active',
        last_login_at: null,
        created_at: new Date('2026-03-24T00:00:00Z'),
      })
      .mockResolvedValueOnce({
        id: 'usr_existing_1',
        email: 'existing@example.com',
        username: 'Existing User',
        avatar_url: null,
        provider: 'wechat',
        provider_id: 'openid_existing',
        status: 'active',
        last_login_at: new Date('2026-03-24T01:00:00Z'),
        created_at: new Date('2026-03-24T00:00:00Z'),
      })

    const session = await wechatLogin('proj_123', { code: 'wx_existing_code' })

    expect(session.user.id).toBe('usr_existing_1')
    expect(mockQueryOne).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining('SET last_login_at = NOW()'),
      ['usr_existing_1']
    )
  })
})
