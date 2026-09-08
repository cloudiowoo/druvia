import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../apps/api/src/db/index.js', () => ({
  query: vi.fn(),
}))

import { query } from '../../apps/api/src/db/index.js'
import { config } from '../../apps/api/src/config/index.js'
import { resolveDataScopeRole } from '../../apps/api/src/modules/data-access/data-scope-role.js'
import {
  configureTableSubscription,
  deriveRealtimeAccessStatus,
  generateSubscriptionExample,
  getRealtimeConfig,
  getTableSubscriptions,
  HasuraMetadataRequestError,
  hasuraMetadataRequestWithOptions,
} from '../../apps/api/src/modules/realtime/realtime.service.js'

const compatibilityScope = {
  projectId: 'proj_123',
  runtimeMode: 'compatibility' as const,
}
const originalRealtimeConfig = { ...config.realtime }
const originalNodeEnv = config.nodeEnv
const originalHasuraEndpoint = config.hasura.endpoint

function metadataRequestTypes(): string[] {
  return vi.mocked(global.fetch).mock.calls.map(([, init]) => {
    const body = JSON.parse(String(init?.body)) as { type: string }
    return body.type
  })
}

describe('Realtime permission isolation', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(query).mockResolvedValue([] as never)
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({}),
      text: vi.fn().mockResolvedValue(''),
    }))
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    Object.assign(config.realtime, originalRealtimeConfig)
    config.nodeEnv = originalNodeEnv
    config.hasura.endpoint = originalHasuraEndpoint
  })

  it('enables realtime without creating select permission', async () => {
    const result = await configureTableSubscription('dru_test', 'events', true, compatibilityScope)

    expect(result.enabled).toBe(true)
    expect(metadataRequestTypes()).toContain('pg_track_table')
    expect(metadataRequestTypes().some((type) => type.includes('_permission'))).toBe(false)
  })

  it('disables realtime without dropping select permission', async () => {
    const result = await configureTableSubscription('dru_test', 'events', false, compatibilityScope)

    expect(result.enabled).toBe(false)
    expect(metadataRequestTypes().some((type) => type.includes('_permission'))).toBe(false)
  })

  it('derives realtime readiness from capability and read access', () => {
    expect(deriveRealtimeAccessStatus(false, 'known', false)).toBe('disabled')
    expect(deriveRealtimeAccessStatus(true, 'known', false)).toBe('access_required')
    expect(deriveRealtimeAccessStatus(true, 'known', true)).toBe('ready')
    expect(deriveRealtimeAccessStatus(true, 'unknown', false)).toBe('unknown')
  })

  it('accepts either active compatibility role for Realtime reads', async () => {
    vi.mocked(query).mockImplementation(async (sql) => {
      if (String(sql).includes('FROM information_schema.tables')) {
        return [
          { table_name: 'private_events', realtime_enabled: true },
          { table_name: 'public_events', realtime_enabled: true },
        ] as never
      }
      return [] as never
    })
    vi.mocked(global.fetch).mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({
        sources: [{
          tables: [
            {
              table: { schema: 'dru_test', name: 'private_events' },
              select_permissions: [{ role: 'user' }],
            },
            {
              table: { schema: 'dru_test', name: 'public_events' },
              select_permissions: [{ role: 'anonymous' }],
            },
          ],
        }],
      }),
      text: vi.fn().mockResolvedValue(''),
    } as never)

    const subscriptions = await getTableSubscriptions('dru_test', compatibilityScope)

    expect(subscriptions[0]).toMatchObject({
      tableName: 'private_events',
      hasAuthenticatedRead: true,
      hasAnonymousRead: false,
      hasSelectPermission: true,
      accessStatus: 'ready',
    })
    expect(subscriptions[1]).toMatchObject({
      tableName: 'public_events',
      hasAuthenticatedRead: false,
      hasAnonymousRead: true,
      hasSelectPermission: true,
      accessStatus: 'ready',
    })
  })

  it('classifies explicit production and environment roles from immutable scope IDs', async () => {
    const productionUserRole = resolveDataScopeRole({
      projectId: 'proj_123',
      actor: 'authenticated',
    })
    const environmentAnonRole = resolveDataScopeRole({
      projectId: 'proj_123',
      environmentId: 42,
      actor: 'anonymous',
    })
    vi.mocked(query).mockImplementation(async (sql) => {
      if (String(sql).includes('FROM information_schema.tables')) {
        return [{ table_name: 'events', realtime_enabled: true }] as never
      }
      return [] as never
    })
    vi.mocked(global.fetch).mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({
        sources: [{
          tables: [{
            table: { schema: 'dru_test', name: 'events' },
            select_permissions: [
              { role: productionUserRole },
              { role: environmentAnonRole },
            ],
          }],
        }],
      }),
      text: vi.fn().mockResolvedValue(''),
    } as never)

    const production = await getTableSubscriptions('dru_test', {
      projectId: 'proj_123',
      runtimeMode: 'explicit',
    })
    const environment = await getTableSubscriptions('dru_test', {
      projectId: 'proj_123',
      runtimeMode: 'explicit',
      environmentId: 42,
    })

    expect(production[0]).toMatchObject({
      hasAuthenticatedRead: true,
      hasAnonymousRead: false,
      hasSelectPermission: true,
      accessStatus: 'ready',
    })
    expect(environment[0]).toMatchObject({
      hasAuthenticatedRead: false,
      hasAnonymousRead: true,
      hasSelectPermission: true,
      accessStatus: 'ready',
    })
  })

  it('reports access-required, unknown and disabled states independently', async () => {
    vi.mocked(query).mockImplementation(async (sql) => {
      if (String(sql).includes('FROM information_schema.tables')) {
        return [
          { table_name: 'enabled_events', realtime_enabled: true },
          { table_name: 'disabled_events', realtime_enabled: false },
        ] as never
      }
      return [] as never
    })

    const known = await getTableSubscriptions('dru_test', compatibilityScope)
    expect(known.map((item) => item.accessStatus)).toEqual(['access_required', 'disabled'])

    vi.mocked(global.fetch).mockRejectedValueOnce(new Error('metadata unavailable'))
    const unknown = await getTableSubscriptions('dru_test', compatibilityScope)
    expect(unknown.find((item) => item.tableName === 'enabled_events')).toMatchObject({
      permissionStatus: 'unknown',
      accessStatus: 'unknown',
    })
  })

  it('does not enable realtime when table tracking fails', async () => {
    vi.mocked(global.fetch).mockResolvedValue({
      ok: false,
      json: vi.fn(),
      text: vi.fn().mockResolvedValue('metadata unavailable'),
    } as never)

    await expect(
      configureTableSubscription('dru_test', 'events', true, compatibilityScope)
    ).rejects.toThrow('metadata unavailable')

    expect(vi.mocked(query).mock.calls.some(([sql]) =>
      String(sql).includes('INSERT INTO "dru_test"._meta_tables')
    )).toBe(false)
  })

  it('preserves Hasura HTTP status and structured error code', async () => {
    vi.mocked(global.fetch).mockResolvedValueOnce({
      ok: false,
      status: 503,
      text: vi.fn().mockResolvedValue('{"code":"unavailable","error":"gateway timeout"}'),
    } as never)

    const error = await hasuraMetadataRequestWithOptions('export_metadata', {}, { version: 2 })
      .catch((cause) => cause)

    expect(error).toBeInstanceOf(HasuraMetadataRequestError)
    expect(error).toMatchObject({ status: 503, code: 'unavailable' })
    expect(error.isDefinitiveRejection).toBe(false)
  })

  it('generates a client-safe SDK example without Hasura admin credentials', () => {
    const examples = generateSubscriptionExample('dru_test', 'events')
    const javascript = examples.find((example) => example.language === 'javascript')?.code

    expect(javascript).toContain("from '@druvia/sdk'")
    expect(javascript).toContain('YOUR_PROJECT_API_KEY')
    expect(javascript).toContain('dru_test_events')
    expect(javascript).toContain("createClient('YOUR_DRUVIA_URL/api/v1'")
    expect(javascript).not.toContain('realtimeUrl')
    expect(javascript).not.toContain('anonymous Hasura role')
    expect(javascript).not.toContain('x-hasura-admin-secret')
    expect(javascript).not.toContain('YOUR_ADMIN_SECRET')
  })

  it('derives management endpoints from the same public Realtime origin', () => {
    Object.assign(config.realtime, {
      hasuraPublicUrl: 'https://graphql.druvia.example.com/',
      apiBaseUrl: 'https://api.druvia.example.com/',
    })
    config.nodeEnv = 'production'

    expect(getRealtimeConfig('dru_test')).toEqual({
      schemaName: 'dru_test',
      websocketEndpoint: 'wss://graphql.druvia.example.com/v1/graphql',
      graphqlEndpoint: 'https://graphql.druvia.example.com/v1/graphql',
    })
  })

  it('keeps generated examples available without public-origin configuration', () => {
    Object.assign(config.realtime, { hasuraPublicUrl: '', apiBaseUrl: '' })
    config.nodeEnv = 'production'

    expect(() => generateSubscriptionExample('dru_test', 'events')).not.toThrow()
  })
})
