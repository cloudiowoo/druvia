import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../apps/api/src/db/index.js', () => ({
  query: vi.fn(),
}))

import { query } from '../../apps/api/src/db/index.js'
import {
  configureTableSubscription,
  deriveRealtimeAccessStatus,
  generateSubscriptionExample,
  getTableSubscriptions,
} from '../../apps/api/src/modules/realtime/realtime.service.js'

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
  })

  it('enables realtime without creating select permission', async () => {
    const result = await configureTableSubscription('dru_test', 'events', true)

    expect(result.enabled).toBe(true)
    expect(metadataRequestTypes()).toContain('pg_track_table')
    expect(metadataRequestTypes().some((type) => type.includes('_permission'))).toBe(false)
  })

  it('disables realtime without dropping select permission', async () => {
    const result = await configureTableSubscription('dru_test', 'events', false)

    expect(result.enabled).toBe(false)
    expect(metadataRequestTypes().some((type) => type.includes('_permission'))).toBe(false)
  })

  it('derives realtime readiness from capability and read access', () => {
    expect(deriveRealtimeAccessStatus(false, 'known', false)).toBe('disabled')
    expect(deriveRealtimeAccessStatus(true, 'known', false)).toBe('access_required')
    expect(deriveRealtimeAccessStatus(true, 'known', true)).toBe('ready')
    expect(deriveRealtimeAccessStatus(true, 'unknown', false)).toBe('unknown')
  })

  it('requires anonymous read access for the current realtime client', async () => {
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

    const subscriptions = await getTableSubscriptions('dru_test')

    expect(subscriptions[0]).toMatchObject({
      tableName: 'private_events',
      hasAuthenticatedRead: true,
      hasAnonymousRead: false,
      hasSelectPermission: false,
      accessStatus: 'access_required',
    })
    expect(subscriptions[1]).toMatchObject({
      tableName: 'public_events',
      hasAuthenticatedRead: false,
      hasAnonymousRead: true,
      hasSelectPermission: true,
      accessStatus: 'ready',
    })
  })

  it('does not enable realtime when table tracking fails', async () => {
    vi.mocked(global.fetch).mockResolvedValue({
      ok: false,
      json: vi.fn(),
      text: vi.fn().mockResolvedValue('metadata unavailable'),
    } as never)

    await expect(
      configureTableSubscription('dru_test', 'events', true)
    ).rejects.toThrow('metadata unavailable')

    expect(vi.mocked(query).mock.calls.some(([sql]) =>
      String(sql).includes('INSERT INTO "dru_test"._meta_tables')
    )).toBe(false)
  })

  it('generates a client-safe SDK example without Hasura admin credentials', () => {
    const examples = generateSubscriptionExample('dru_test', 'events')
    const javascript = examples.find((example) => example.language === 'javascript')?.code

    expect(javascript).toContain("from '@druvia/sdk'")
    expect(javascript).toContain('YOUR_PROJECT_API_KEY')
    expect(javascript).toContain('dru_test_events')
    expect(javascript).not.toContain('x-hasura-admin-secret')
    expect(javascript).not.toContain('YOUR_ADMIN_SECRET')
  })
})
