// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { apiMock, probeMock, disposeProbe, testState } = vi.hoisted(() => ({
  apiMock: {
    listRealtimeSubscriptions: vi.fn(),
    getRealtimeConfig: vi.fn(),
    configureRealtimeSubscription: vi.fn(),
    getSubscriptionExample: vi.fn(),
    issueRealtimeToken: vi.fn(),
  },
  probeMock: vi.fn(),
  disposeProbe: vi.fn(),
  testState: { envName: 'prod' },
}))

vi.mock('next/navigation', () => ({
  useParams: () => ({ tenantId: 'tenant_1', projectId: 'proj_123' }),
}))
vi.mock('@/store', () => ({
  useAppStore: () => ({
    currentProject: { name: 'Demo' },
    currentTenant: { name: 'Workspace' },
    currentEnv: { envName: testState.envName },
  }),
}))
vi.mock('@/components/DashboardLayout', () => ({
  DashboardLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}))
vi.mock('@/components/ui/tabs', () => ({
  Tabs: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  TabsList: ({ children }: { children: React.ReactNode }) => <div role="tablist">{children}</div>,
  TabsTrigger: ({ children }: { children: React.ReactNode }) => (
    <button type="button" role="tab">{children}</button>
  ),
  TabsContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}))
vi.mock('@/lib/api', () => ({ api: apiMock }))
vi.mock('@/lib/realtime-connection-test', () => ({
  startRealtimeConnectionTest: probeMock,
}))

import RealtimePage from '../../../apps/admin/src/app/t/[tenantId]/p/[projectId]/realtime/page'

function setupApi(runtimeAvailability: 'available' | 'environment_identity_required' = 'available') {
  apiMock.listRealtimeSubscriptions.mockResolvedValue({
    success: true,
    data: {
      subscriptions: [{
        tableName: 'events',
        schemaName: 'dru_test',
        enabled: true,
        operations: ['INSERT', 'UPDATE', 'DELETE'],
        hasAuthenticatedRead: true,
        hasAnonymousRead: false,
        hasSelectPermission: true,
        permissionStatus: 'known',
        accessStatus: 'ready',
      }],
      stats: { totalTables: 1, enabledTables: 1, disabledTables: 0 },
    },
  })
  apiMock.getRealtimeConfig.mockResolvedValue({
    success: true,
    data: {
      schemaName: 'dru_test',
      websocketEndpoint: 'wss://druvia.example.com/v1/graphql',
      graphqlEndpoint: 'https://druvia.example.com/v1/graphql',
      runtimeAvailability,
      hasuraConnected: true,
    },
  })
  apiMock.issueRealtimeToken.mockResolvedValue({
    success: true,
    data: {
      token: 'signed-realtime-token',
      expiresIn: 300,
      expiresAt: '2099-08-18T10:05:00.000Z',
      websocketUrl: 'wss://druvia.example.com/v1/graphql',
    },
  })
  probeMock.mockImplementation(({ onState }) => {
    onState('connecting')
    onState('connected')
    return { dispose: disposeProbe }
  })
}

describe('Realtime page', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    testState.envName = 'prod'
    setupApi()
  })

  it('shows actor-specific readiness and an in-memory credential connection flow', async () => {
    render(<RealtimePage />)

    expect(await screen.findByText('认证用户可读')).toBeInTheDocument()
    expect(screen.getByText('匿名用户不可读')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('tab', { name: '测试' }))

    expect(screen.getByRole('button', { name: 'API Key' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Project Token' })).toBeInTheDocument()
    const credential = screen.getByLabelText('应用凭证')
    expect(credential).toHaveAttribute('type', 'password')
    fireEvent.change(credential, { target: { value: 'project-api-key' } })
    fireEvent.click(screen.getByRole('button', { name: '连接' }))

    await waitFor(() => expect(apiMock.issueRealtimeToken).toHaveBeenCalledWith(
      'proj_123',
      { kind: 'apikey', value: 'project-api-key' }
    ))
    expect(probeMock).toHaveBeenCalledWith(expect.objectContaining({
      token: 'signed-realtime-token',
      websocketUrl: 'wss://druvia.example.com/v1/graphql',
    }))
    expect(screen.getByText('已连接')).toBeInTheDocument()
  })

  it('disposes the live probe on disconnect and unmount', async () => {
    const view = render(<RealtimePage />)
    await screen.findByText('认证用户可读')
    fireEvent.click(screen.getByRole('tab', { name: '测试' }))
    fireEvent.change(screen.getByLabelText('应用凭证'), { target: { value: 'key' } })
    fireEvent.click(screen.getByRole('button', { name: '连接' }))
    await screen.findByText('已连接')
    fireEvent.click(screen.getByRole('button', { name: '断开连接' }))
    expect(disposeProbe).toHaveBeenCalledTimes(1)

    fireEvent.change(screen.getByLabelText('应用凭证'), { target: { value: 'key-2' } })
    fireEvent.click(screen.getByRole('button', { name: '连接' }))
    await screen.findByText('已连接')
    view.unmount()
    expect(disposeProbe).toHaveBeenCalledTimes(2)
  })

  it('disables connection testing for a non-production environment identity gap', async () => {
    testState.envName = 'dev'
    setupApi('environment_identity_required')
    render(<RealtimePage />)
    await screen.findByText('认证用户可读')
    fireEvent.click(screen.getByRole('tab', { name: '测试' }))

    expect(screen.getByText('当前环境暂不支持应用身份连接测试')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '连接' })).toBeDisabled()
  })

  it('does not present production Realtime endpoints as available for a non-production environment', async () => {
    testState.envName = 'dev'
    setupApi('environment_identity_required')

    render(<RealtimePage />)

    expect(await screen.findByText('当前环境暂不提供应用 Realtime 连接')).toBeInTheDocument()
    expect(screen.getByText('当前环境没有可用的应用连接端点')).toBeInTheDocument()
    expect(screen.queryByText('实时服务已连接')).not.toBeInTheDocument()
    expect(screen.queryByText('wss://druvia.example.com/v1/graphql')).not.toBeInTheDocument()
    expect(screen.queryByText('https://druvia.example.com/v1/graphql')).not.toBeInTheDocument()
  })

  it('hides production endpoints immediately while a non-production config is loading', async () => {
    const view = render(<RealtimePage />)
    expect(await screen.findByText('wss://druvia.example.com/v1/graphql')).toBeInTheDocument()

    apiMock.getRealtimeConfig.mockReturnValueOnce(new Promise(() => undefined))
    testState.envName = 'dev'
    view.rerender(<RealtimePage />)

    expect(screen.getByText('当前环境暂不提供应用 Realtime 连接')).toBeInTheDocument()
    expect(screen.queryByText('wss://druvia.example.com/v1/graphql')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: '连接' })).toBeDisabled()
  })

  it('contains no platform-token or simulated-test Realtime path', () => {
    const source = readFileSync(resolve(
      process.cwd(),
      'apps/admin/src/app/t/[tenantId]/p/[projectId]/realtime/page.tsx'
    ), 'utf8')

    expect(source).not.toContain('api.getToken()')
    expect(source).not.toContain('模拟测试')
    expect(source).not.toContain('testTable')
  })
})
