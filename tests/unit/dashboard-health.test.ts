import { describe, expect, it, vi } from 'vitest'

vi.mock('../../apps/api/src/lib/redis.js', () => ({
  redis: {
    ping: vi.fn(),
  },
}))

import {
  buildTenantHealth,
  buildTenantActionItems,
  buildTenantCapabilities,
  computeProjectHealthScore,
  computeProjectRiskTags,
  computeCapabilityCoverage,
  resolveTenantStorageConfigured,
  type TenantDashboardCapabilityStatus,
} from '../../apps/api/src/modules/dashboard/dashboard.service.js'

describe('tenant dashboard health helpers', () => {
  it('normalizes unknown probes and surfaces partial-signal summary', () => {
    const health = buildTenantHealth({
      totalProjects: 2,
      activeProjects: 1,
      projectHealthAverage: 75,
      backupCoverage: 50,
      serviceStatus: {
        api: 'healthy',
        database: 'healthy',
        redis: 'unknown',
        hasura: 'healthy',
        worker: 'unknown',
      },
      actionItems: [],
      capabilities: [
        { key: 'database', label: 'Database', coveredProjects: 2, totalProjects: 2, status: 'healthy' },
        { key: 'auth', label: 'Auth', coveredProjects: 1, totalProjects: 2, status: 'attention' },
      ],
    })

    expect(health.score).toBeGreaterThanOrEqual(0)
    expect(health.score).toBeLessThanOrEqual(100)
    expect(health.summary).toContain('部分信号缺失')
  })

  it('does not keep a perfect workspace score when functions are only attention', () => {
    const health = buildTenantHealth({
      totalProjects: 1,
      activeProjects: 1,
      projectHealthAverage: 92,
      backupCoverage: 100,
      signalCoverage: 100,
      hasRecentFailures: false,
      hasDisabledProjects: false,
      storageConfigured: true,
      partialSignals: true,
      serviceStatus: {
        api: 'healthy',
        database: 'healthy',
        redis: 'healthy',
        hasura: 'healthy',
        worker: 'unknown',
      },
      actionItems: [],
      capabilities: [
        { key: 'database', label: 'Database', coveredProjects: 1, totalProjects: 1, status: 'healthy' },
        { key: 'auth', label: 'Auth', coveredProjects: 1, totalProjects: 1, status: 'healthy' },
        { key: 'storage', label: 'Storage', coveredProjects: 1, totalProjects: 1, status: 'healthy' },
        { key: 'realtime', label: 'Realtime', coveredProjects: 1, totalProjects: 1, status: 'healthy' },
        { key: 'functions', label: 'Functions', coveredProjects: 1, totalProjects: 1, status: 'attention' },
      ],
    })

    expect(health.score).toBe(92)
    expect(health.factors.availability + health.factors.stability + health.factors.risk).toBe(92)
    expect(health.summary).toContain('Functions 可用性不足')
  })

  it('does not exceed average project health for multi-project workspaces', () => {
    const health = buildTenantHealth({
      totalProjects: 2,
      activeProjects: 2,
      projectHealthAverage: 88,
      backupCoverage: 100,
      signalCoverage: 100,
      hasRecentFailures: false,
      hasDisabledProjects: false,
      storageConfigured: true,
      partialSignals: false,
      serviceStatus: {
        api: 'healthy',
        database: 'healthy',
        redis: 'healthy',
        hasura: 'healthy',
        worker: 'healthy',
      },
      actionItems: [],
      capabilities: [
        { key: 'database', label: 'Database', coveredProjects: 2, totalProjects: 2, status: 'healthy' },
        { key: 'auth', label: 'Auth', coveredProjects: 2, totalProjects: 2, status: 'healthy' },
        { key: 'storage', label: 'Storage', coveredProjects: 2, totalProjects: 2, status: 'healthy' },
        { key: 'realtime', label: 'Realtime', coveredProjects: 2, totalProjects: 2, status: 'healthy' },
        { key: 'functions', label: 'Functions', coveredProjects: 2, totalProjects: 2, status: 'healthy' },
      ],
    })

    expect(health.score).toBe(88)
    expect(health.factors.availability + health.factors.stability + health.factors.risk).toBe(88)
  })

  it('computes capability coverage from real coveredProjects values', () => {
    const capabilities: Array<{
      key: TenantDashboardCapabilityStatus['key']
      label: string
      coveredProjects: number
      totalProjects: number
      status: TenantDashboardCapabilityStatus['status']
    }> = [
      { key: 'database', label: 'Database', coveredProjects: 3, totalProjects: 3, status: 'healthy' },
      { key: 'auth', label: 'Auth', coveredProjects: 0, totalProjects: 3, status: 'risk' },
      { key: 'storage', label: 'Storage', coveredProjects: 1, totalProjects: 3, status: 'attention' },
      { key: 'realtime', label: 'Realtime', coveredProjects: 2, totalProjects: 3, status: 'attention' },
      { key: 'functions', label: 'Functions', coveredProjects: 3, totalProjects: 3, status: 'healthy' },
    ]

    expect(computeCapabilityCoverage(capabilities)).toBe(60)
  })

  it('treats existing storage buckets as configured even without tenant storage config', () => {
    expect(
      resolveTenantStorageConfigured({
        hasTenantStorageConfig: false,
        bucketCount: 2,
        legacyFileCount: 0,
      })
    ).toBe(true)

    expect(
      resolveTenantStorageConfigured({
        hasTenantStorageConfig: false,
        bucketCount: 0,
        legacyFileCount: 0,
      })
    ).toBe(false)
  })

  it('counts function projects with unknown worker health as covered attention, not uncovered risk', () => {
    const capabilities = buildTenantCapabilities(
      [
        {
          projectId: 'proj_123',
          name: 'Taro 小程序',
          alias: 'taroapp',
          status: 'active',
          healthScore: 78,
          healthStatus: 'attention',
          capabilities: {
            database: 'ready',
            auth: 'configured',
            storage: 'ready',
            realtime: 'ready',
            functions: 'attention',
          },
          latestSignalAt: '2026-04-20T06:00:00.000Z',
          latestBackupAt: '2026-04-19T06:00:00.000Z',
          riskTags: [],
        },
      ],
      {
        totalProjects: 1,
        storageConfigured: true,
        serviceStatus: {
          api: 'healthy',
          database: 'healthy',
          redis: 'healthy',
          hasura: 'healthy',
          worker: 'unknown',
        },
      }
    )

    expect(capabilities.find((item) => item.key === 'functions')).toMatchObject({
      coveredProjects: 1,
      status: 'attention',
    })
  })

  it('does not treat unused optional capabilities as project risks', () => {
    const capabilities = {
      database: 'ready',
      auth: 'configured',
      storage: 'missing',
      realtime: 'missing',
      functions: 'missing',
    } as const

    expect(
      computeProjectRiskTags({
        projectStatus: 'active',
        capabilities,
        latestBackupAt: '2026-04-19T06:00:00.000Z',
        hasBackupFailures24h: false,
        hasFunctionFailures24h: false,
      })
    ).toEqual([])

    expect(
      computeProjectHealthScore({
        projectStatus: 'active',
        capabilities,
        latestBackupAt: '2026-04-19T06:00:00.000Z',
        latestSignalAt: '2026-04-20T06:00:00.000Z',
        hasBackupFailures24h: false,
        hasFunctionFailures24h: false,
      })
    ).toBeGreaterThanOrEqual(85)
  })

  it('marks workspace optional capabilities with zero adoption as attention, not risk', () => {
    const capabilities = buildTenantCapabilities(
      [
        {
          projectId: 'proj_123',
          name: 'DB/Auth Only',
          alias: 'db-auth',
          status: 'active',
          healthScore: 92,
          healthStatus: 'healthy',
          capabilities: {
            database: 'ready',
            auth: 'configured',
            storage: 'missing',
            realtime: 'missing',
            functions: 'missing',
          },
          latestSignalAt: '2026-04-20T06:00:00.000Z',
          latestBackupAt: '2026-04-19T06:00:00.000Z',
          riskTags: [],
        },
      ],
      {
        totalProjects: 1,
        storageConfigured: false,
        serviceStatus: {
          api: 'healthy',
          database: 'healthy',
          redis: 'healthy',
          hasura: 'healthy',
          worker: 'unknown',
        },
      }
    )

    expect(capabilities.find((item) => item.key === 'storage')?.status).toBe('attention')
    expect(capabilities.find((item) => item.key === 'functions')?.status).toBe('attention')
  })

  it('does not emit optional-capability action items when there is no adoption signal', () => {
    const items = buildTenantActionItems({
      tenantId: 'default',
      backupCoverage: 100,
      serviceStatus: {
        api: 'healthy',
        database: 'healthy',
        redis: 'healthy',
        hasura: 'healthy',
        worker: 'risk',
      },
      storageConfigured: false,
      projectRows: [
        {
          projectId: 'proj_123',
          name: 'DB/Auth Only',
          alias: 'db-auth',
          status: 'active',
          healthScore: 92,
          healthStatus: 'healthy',
          capabilities: {
            database: 'ready',
            auth: 'missing',
            storage: 'missing',
            realtime: 'missing',
            functions: 'missing',
          },
          latestSignalAt: '2026-04-20T06:00:00.000Z',
          latestBackupAt: '2026-04-19T06:00:00.000Z',
          riskTags: [],
        },
      ],
    })

    expect(items.find((item) => item.title.includes('Storage'))).toBeUndefined()
    expect(items.find((item) => item.title.includes('Functions Worker'))).toBeUndefined()
    expect(items.find((item) => item.title.includes('Auth'))).toBeUndefined()
  })

  it('does not emit auth action items for mixed workspaces without a per-project auth requirement signal', () => {
    const items = buildTenantActionItems({
      tenantId: 'default',
      backupCoverage: 100,
      serviceStatus: {
        api: 'healthy',
        database: 'healthy',
        redis: 'healthy',
        hasura: 'healthy',
        worker: 'healthy',
      },
      storageConfigured: true,
      projectRows: [
        {
          projectId: 'proj_auth',
          name: 'Uses Auth',
          alias: 'uses-auth',
          status: 'active',
          healthScore: 95,
          healthStatus: 'healthy',
          capabilities: {
            database: 'ready',
            auth: 'configured',
            storage: 'missing',
            realtime: 'missing',
            functions: 'missing',
          },
          latestSignalAt: '2026-04-20T06:00:00.000Z',
          latestBackupAt: '2026-04-19T06:00:00.000Z',
          riskTags: [],
        },
        {
          projectId: 'proj_db',
          name: 'DB Only',
          alias: 'db-only',
          status: 'active',
          healthScore: 92,
          healthStatus: 'healthy',
          capabilities: {
            database: 'ready',
            auth: 'missing',
            storage: 'missing',
            realtime: 'missing',
            functions: 'missing',
          },
          latestSignalAt: '2026-04-20T06:00:00.000Z',
          latestBackupAt: '2026-04-19T06:00:00.000Z',
          riskTags: [],
        },
      ],
    })

    expect(items.find((item) => item.title.includes('Auth'))).toBeUndefined()
  })
})
