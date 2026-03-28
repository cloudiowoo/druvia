/** Pluggable fetch function — must return Response-compatible object */
export type FetchFn = (input: string, init?: RequestInit) => Promise<Response>

/** Pluggable localStorage-like storage */
export interface StorageAdapter {
  getItem(key: string): string | null | Promise<string | null>
  setItem(key: string, value: string): void | Promise<void>
  removeItem(key: string): void | Promise<void>
}

/** Pluggable WebSocket adapter for non-standard environments (e.g. WeChat) */
export interface WebSocketLike {
  onOpen(cb: () => void): void
  onMessage(cb: (data: string) => void): void
  onClose(cb: (event?: { code?: number; reason?: string }) => void): void
  onError(cb: (error: unknown) => void): void
  send(data: string): void
  close(): void
}

export type WebSocketFactory = (url: string, protocols?: string[]) => WebSocketLike

export interface DruviaClientOptions {
  projectId: string
  schema?: string
  realtimeUrl?: string
  fetch?: FetchFn
  storage?: StorageAdapter
  websocket?: WebSocketFactory
}

/** Standard response shape from all SDK methods */
export interface DruviaResponse<T> {
  data: T | null
  error: DruviaError | null
}

export interface DruviaError {
  code: string
  message: string
}

/** Auth token pair */
export interface Session {
  accessToken: string
  refreshToken?: string
  user: UserInfo
}

export interface ProjectSession {
  accessToken: string
  refreshToken?: string
  expiresIn?: number
  expiresAt?: string
  user: ProjectUserInfo
}

export interface UserInfo {
  id: number
  userId?: string
  email?: string
  username?: string
  avatarUrl?: string
  role?: string
}

export interface ProjectUserInfo {
  id: string
  email?: string | null
  username?: string | null
  avatarUrl?: string | null
  role?: string
}

/** Supabase-compatible nested response for getUser() */
export interface UserResponse {
  data: { user: UserInfo | null }
  error: DruviaError | null
}

/** Supabase-compatible nested response for getSession() */
export interface SessionResponse {
  data: { session: Session | null }
  error: DruviaError | null
}

export interface ProjectUserResponse {
  data: { user: ProjectUserInfo | null }
  error: DruviaError | null
}

export interface ProjectSessionResponse {
  data: { session: ProjectSession | null }
  error: DruviaError | null
}

export interface StorageUploadTicket {
  ticket: string
  expiresIn: number
  expiresAt: string
  payload: {
    purpose: 'upload'
    projectId: string
    projectUserId: string
    bucket: string
    pathPrefix: string
    contentTypes?: string[]
    maxBytes?: number
    issuedBy: string
    issuedVia: 'trusted_storage_ticket'
  }
}

export interface StorageRemoveTicket {
  ticket: string
  expiresIn: number
  expiresAt: string
  payload: {
    purpose: 'remove'
    projectId: string
    projectUserId: string
    bucket: string
    path: string
    issuedBy: string
    issuedVia: 'trusted_storage_ticket'
  }
}
