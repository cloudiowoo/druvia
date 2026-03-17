import type { FetchFn, StorageAdapter, DruviaResponse, Session, UserInfo } from '../types.js'

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

  async getUser(): Promise<DruviaResponse<UserInfo>> {
    try {
      const response = await this.fetchFn(`${this.baseUrl}/users/me`, { method: 'GET' })
      const json = await response.json()
      if (!response.ok) {
        return { data: null, error: json.error ?? { code: 'AUTH_ERROR', message: 'Failed to get user' } }
      }
      return { data: json.data ?? json, error: null }
    } catch (err) {
      return { data: null, error: { code: 'NETWORK_ERROR', message: err instanceof Error ? err.message : String(err) } }
    }
  }

  async getSession(): Promise<DruviaResponse<Session>> {
    const raw = await this.storage.getItem(SESSION_KEY)
    if (!raw) return { data: null, error: null }
    try {
      return { data: JSON.parse(raw), error: null }
    } catch {
      return { data: null, error: null }
    }
  }

  async getToken(): Promise<string | null> {
    const { data } = await this.getSession()
    return data?.accessToken ?? null
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