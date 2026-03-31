import type {
  DruviaError,
  DruviaResponse,
  FetchFn,
  ProjectSession,
  ProjectSessionResponse,
  ProjectUserResponse,
  StorageAdapter,
} from '../types.js'

type ProjectAuthChangeCallback = (event: 'SIGNED_IN' | 'SIGNED_OUT', session: ProjectSession | null) => void

export class DruviaProjectAuth {
  private baseUrl: string
  private projectId: string
  private fetchFn: FetchFn
  private storage: StorageAdapter
  private listeners: ProjectAuthChangeCallback[] = []

  constructor(baseUrl: string, projectId: string, fetchFn: FetchFn, storage: StorageAdapter) {
    this.baseUrl = baseUrl
    this.projectId = projectId
    this.fetchFn = fetchFn
    this.storage = storage
  }

  private get sessionKey(): string {
    return `druvia.project_session:${this.projectId}`
  }

  private get legacySessionKey(): string {
    return 'druvia.project_session'
  }

  async wechatLogin(params: {
    code: string
    userInfo?: {
      nickName?: string
      avatarUrl?: string
    }
  }): Promise<DruviaResponse<ProjectSession>> {
    return this.signInWithProvider('wechat', params)
  }

  async wechatSilentLogin(params: { code: string }): Promise<DruviaResponse<ProjectSession>> {
    return this.silentLoginWithProvider('wechat', params)
  }

  async signInWithProvider(
    provider: string,
    params: {
      code: string
      userInfo?: {
        nickName?: string
        avatarUrl?: string
      }
    }
  ): Promise<DruviaResponse<ProjectSession>> {
    return this.authRequest(`/projects/${this.projectId}/auth/${provider}/login`, params)
  }

  async silentLoginWithProvider(provider: string, params: { code: string }): Promise<DruviaResponse<ProjectSession>> {
    return this.authRequest(`/projects/${this.projectId}/auth/${provider}/silent-login`, params)
  }

  async issueTrustedSession(params: {
    userId: string
    trustedBackendKey: string
  }): Promise<DruviaResponse<ProjectSession>> {
    return this.authRequest(
      `/projects/${this.projectId}/auth/trusted/issue-session`,
      { userId: params.userId },
      { 'x-druvia-trusted-backend-key': params.trustedBackendKey }
    )
  }

  async refreshSession(params: { refresh_token: string }): Promise<ProjectSessionResponse> {
    try {
      const response = await this.fetchFn(`${this.baseUrl}/projects/${this.projectId}/auth/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refresh_token: params.refresh_token }),
      })
      const json = await response.json()
      if (!response.ok || json.success === false) {
        return { data: { session: null }, error: json.error ?? { code: 'REFRESH_FAILED', message: 'Failed to refresh project session' } }
      }

      const session = this.toProjectSession(json.data ?? json)
      await this.persistSession(session)
      this.notify('SIGNED_IN', session)
      return { data: { session }, error: null }
    } catch (err) {
      return { data: { session: null }, error: { code: 'NETWORK_ERROR', message: err instanceof Error ? err.message : String(err) } }
    }
  }

  async logout(): Promise<DruviaResponse<{ loggedOut: boolean }>> {
    try {
      const token = await this.getToken()
      const response = await this.fetchFn(`${this.baseUrl}/projects/${this.projectId}/auth/logout`, {
        method: 'POST',
        headers: token ? { Authorization: `Bearer ${token}` } : undefined,
      })
      const json = await response.json()
      if (!response.ok || json.success === false) {
        return { data: null, error: json.error ?? { code: 'LOGOUT_FAILED', message: 'Failed to logout project session' } }
      }

      await this.clearStoredSession()
      this.notify('SIGNED_OUT', null)
      return { data: json.data ?? { loggedOut: true }, error: null }
    } catch (err) {
      return { data: null, error: { code: 'NETWORK_ERROR', message: err instanceof Error ? err.message : String(err) } }
    }
  }

  async getSession(): Promise<ProjectSessionResponse> {
    const raw = await this.readSessionRaw()
    if (!raw) return { data: { session: null }, error: null }

    try {
      return { data: { session: JSON.parse(raw) as ProjectSession }, error: null }
    } catch {
      return { data: { session: null }, error: null }
    }
  }

  async getUser(): Promise<ProjectUserResponse> {
    const { data, error } = await this.getSession()
    return { data: { user: data.session?.user ?? null }, error }
  }

  async getToken(): Promise<string | null> {
    const { data } = await this.getSession()
    return data.session?.accessToken ?? null
  }

  onAuthStateChange(callback: ProjectAuthChangeCallback): { unsubscribe: () => void } {
    this.listeners.push(callback)
    return { unsubscribe: () => { this.listeners = this.listeners.filter(listener => listener !== callback) } }
  }

  private async authRequest(
    path: string,
    body: Record<string, unknown>,
    headers?: Record<string, string>
  ): Promise<DruviaResponse<ProjectSession>> {
    try {
      const response = await this.fetchFn(`${this.baseUrl}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify(body),
      })
      const json = await response.json()
      if (!response.ok || json.success === false) {
        return { data: null, error: json.error ?? { code: 'AUTH_FAILED', message: 'Project authentication failed' } }
      }

      const session = this.toProjectSession(json.data ?? json)
      await this.persistSession(session)
      this.notify('SIGNED_IN', session)
      return { data: session, error: null }
    } catch (err) {
      return { data: null, error: { code: 'NETWORK_ERROR', message: err instanceof Error ? err.message : String(err) } }
    }
  }

  private toProjectSession(sessionData: Record<string, unknown>): ProjectSession {
    return {
      accessToken: sessionData.token as string,
      refreshToken: sessionData.refreshToken as string | undefined,
      expiresIn: sessionData.expiresIn as number | undefined,
      expiresAt: sessionData.expiresAt as string | undefined,
      user: sessionData.user as ProjectSession['user'],
    }
  }

  private async readSessionRaw(): Promise<string | null> {
    const currentRaw = await this.storage.getItem(this.sessionKey)
    if (typeof currentRaw === 'string' && currentRaw.length > 0) {
      return currentRaw
    }

    const legacyRaw = await this.storage.getItem(this.legacySessionKey)
    if (typeof legacyRaw !== 'string' || legacyRaw.length === 0) {
      return null
    }

    await this.storage.setItem(this.sessionKey, legacyRaw)
    await this.storage.removeItem(this.legacySessionKey)
    return legacyRaw
  }

  private async persistSession(session: ProjectSession): Promise<void> {
    await this.storage.setItem(this.sessionKey, JSON.stringify(session))
    await this.storage.removeItem(this.legacySessionKey)
  }

  private async clearStoredSession(): Promise<void> {
    await this.storage.removeItem(this.sessionKey)
    await this.storage.removeItem(this.legacySessionKey)
  }

  private notify(event: 'SIGNED_IN' | 'SIGNED_OUT', session: ProjectSession | null) {
    for (const cb of this.listeners) cb(event, session)
  }
}
