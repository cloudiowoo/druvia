import type { FetchFn, StorageAdapter, DruviaResponse, Session, UserInfo, UserResponse, SessionResponse } from '../types.js'

const SESSION_KEY = 'druvia.session'

interface SignUpParams { email: string; password: string; username?: string }
interface SignInParams { email?: string; username?: string; password: string }

type AuthChangeCallback = (event: 'SIGNED_IN' | 'SIGNED_OUT', session: Session | null) => void

export class DruviaAuth {
  private baseUrl: string
  private fetchFn: FetchFn
  private storage: StorageAdapter
  private listeners: AuthChangeCallback[] = []

  constructor(baseUrl: string, fetchFn: FetchFn, storage: StorageAdapter) {
    this.baseUrl = baseUrl
    this.fetchFn = fetchFn
    this.storage = storage
  }

  async signUp(params: SignUpParams): Promise<DruviaResponse<Session>> {
    return this.authRequest('/auth/register', {
      email: params.email,
      password: params.password,
      username: params.username ?? params.email.split('@')[0],
    })
  }

  async signIn(params: SignInParams): Promise<DruviaResponse<Session>> {
    const body: Record<string, string> = { password: params.password }
    if (params.email) body.email = params.email
    if (params.username) body.username = params.username
    return this.authRequest('/auth/login', body)
  }

  async signOut(): Promise<void> {
    await this.storage.removeItem(SESSION_KEY)
    this.notify('SIGNED_OUT', null)
  }

  async getUser(): Promise<UserResponse> {
    try {
      const response = await this.fetchFn(`${this.baseUrl}/users/me`, { method: 'GET' })
      const json = await response.json()
      if (!response.ok) {
        return { data: { user: null }, error: json.error ?? { code: 'AUTH_ERROR', message: 'Failed to get user' } }
      }
      return { data: { user: json.data ?? json }, error: null }
    } catch (err) {
      return { data: { user: null }, error: { code: 'NETWORK_ERROR', message: err instanceof Error ? err.message : String(err) } }
    }
  }

  async getSession(): Promise<SessionResponse> {
    const raw = await this.storage.getItem(SESSION_KEY)
    if (!raw) return { data: { session: null }, error: null }
    try {
      return { data: { session: JSON.parse(raw) }, error: null }
    } catch {
      return { data: { session: null }, error: null }
    }
  }

  async getToken(): Promise<string | null> {
    const { data } = await this.getSession()
    return data.session?.accessToken ?? null
  }

  async updateUser(params: { data: Record<string, unknown> }): Promise<UserResponse> {
    try {
      const body: Record<string, unknown> = {}
      for (const [key, value] of Object.entries(params.data)) {
        const camelKey = key.replace(/_([a-z])/g, (_, c) => c.toUpperCase())
        body[camelKey] = value
      }
      const response = await this.fetchFn(`${this.baseUrl}/users/me`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const json = await response.json()
      if (!response.ok) {
        return { data: { user: null }, error: json.error ?? { code: 'UPDATE_ERROR', message: 'Failed to update user' } }
      }
      return { data: { user: json.data ?? json }, error: null }
    } catch (err) {
      return { data: { user: null }, error: { code: 'NETWORK_ERROR', message: err instanceof Error ? err.message : String(err) } }
    }
  }

  async refreshSession(params: { refresh_token: string }): Promise<SessionResponse> {
    try {
      const response = await this.fetchFn(`${this.baseUrl}/auth/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refresh_token: params.refresh_token }),
      })
      const json = await response.json()
      if (!response.ok || json.success === false) {
        return { data: { session: null }, error: json.error ?? { code: 'REFRESH_FAILED', message: 'Failed to refresh session' } }
      }
      const sessionData = json.data ?? json
      const session: Session = {
        accessToken: sessionData.token,
        refreshToken: sessionData.refreshToken,
        user: sessionData.user,
      }
      await this.storage.setItem(SESSION_KEY, JSON.stringify(session))
      this.notify('SIGNED_IN', session)
      return { data: { session }, error: null }
    } catch (err) {
      return { data: { session: null }, error: { code: 'NETWORK_ERROR', message: err instanceof Error ? err.message : String(err) } }
    }
  }

  onAuthStateChange(callback: AuthChangeCallback): { unsubscribe: () => void } {
    this.listeners.push(callback)
    return { unsubscribe: () => { this.listeners = this.listeners.filter(l => l !== callback) } }
  }

  private async authRequest(path: string, body: Record<string, string>): Promise<DruviaResponse<Session>> {
    try {
      const response = await this.fetchFn(`${this.baseUrl}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const json = await response.json()
      if (!response.ok || json.success === false) {
        return { data: null, error: json.error ?? { code: 'AUTH_FAILED', message: 'Authentication failed' } }
      }
      const sessionData = json.data ?? json
      const session: Session = {
        accessToken: sessionData.token,
        refreshToken: sessionData.refreshToken,
        user: sessionData.user,
      }
      await this.storage.setItem(SESSION_KEY, JSON.stringify(session))
      this.notify('SIGNED_IN', session)
      return { data: session, error: null }
    } catch (err) {
      return { data: null, error: { code: 'NETWORK_ERROR', message: err instanceof Error ? err.message : String(err) } }
    }
  }

  private notify(event: 'SIGNED_IN' | 'SIGNED_OUT', session: Session | null) {
    for (const cb of this.listeners) cb(event, session)
  }
}