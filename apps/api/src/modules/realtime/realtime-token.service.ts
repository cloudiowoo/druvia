import { randomUUID } from 'node:crypto'
import jwt from 'jsonwebtoken'
import { config } from '../../config/index.js'
import { createApiLogger } from '../../lib/logger.js'
import type { RealtimeExecutionContext } from './realtime-actor.js'

const logger = createApiLogger({ module: 'realtime-token' })
const HASURA_CLAIMS_NAMESPACE = 'https://hasura.io/jwt/claims'
let fallbackWarningEmitted = false

export interface RealtimeTokenResult {
  token: string
  operationId: string
  expiresIn: number
  expiresAt: string
  websocketUrl: string
}

export type InternalRealtimeTokenResult = Omit<RealtimeTokenResult, 'websocketUrl'>

export class RealtimeTokenUnavailableError extends Error {
  readonly code = 'REALTIME_TOKEN_UNAVAILABLE'

  constructor(message = 'Realtime token service is unavailable') {
    super(message)
    this.name = 'RealtimeTokenUnavailableError'
  }
}

interface PublicRealtimeUrlInput {
  hasuraPublicUrl: string
  apiBaseUrl: string
  nodeEnv: string
  hasuraEndpoint: string
}

function parsePublicOrigin(value: string): URL {
  try {
    const url = new URL(value)
    const isHttp = url.protocol === 'http:' || url.protocol === 'https:'
    const isOriginOnly = url.username === ''
      && url.password === ''
      && url.search === ''
      && url.hash === ''
      && url.pathname === '/'
      && url.href === `${url.origin}/`

    if (!isHttp || !isOriginOnly) {
      throw new Error('invalid public origin')
    }

    return url
  } catch {
    throw new RealtimeTokenUnavailableError('Realtime public URL is not a valid HTTP(S) origin')
  }
}

export function derivePublicRealtimeUrl(input: PublicRealtimeUrlInput): string {
  const configuredOrigin = input.hasuraPublicUrl || input.apiBaseUrl
  const candidate = configuredOrigin
    || (input.nodeEnv === 'development' ? input.hasuraEndpoint : '')

  if (!candidate) {
    throw new RealtimeTokenUnavailableError('Realtime public URL is not configured')
  }

  const publicOrigin = parsePublicOrigin(candidate)
  const websocketProtocol = publicOrigin.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${websocketProtocol}//${publicOrigin.host}/v1/graphql`
}

function getSigningSecret(): string {
  const { tokenSecret, tokenSecretSource } = config.realtime

  if (tokenSecret.length < 32) {
    throw new RealtimeTokenUnavailableError()
  }

  if (tokenSecretSource === 'JWT_SECRET' && !fallbackWarningEmitted) {
    fallbackWarningEmitted = true
    logger.warn('Realtime token signing uses JWT_SECRET compatibility fallback', {
      secretSource: 'JWT_SECRET',
    })
  }

  return tokenSecret
}

export function issueRealtimeAccessToken(input: {
  projectId: string
  context: RealtimeExecutionContext
  now?: Date
  operationId?: string
}): RealtimeTokenResult {
  const websocketUrl = derivePublicRealtimeUrl({
    hasuraPublicUrl: config.realtime.hasuraPublicUrl,
    apiBaseUrl: config.realtime.apiBaseUrl,
    nodeEnv: config.nodeEnv,
    hasuraEndpoint: config.hasura.endpoint,
  })
  return { ...issueInternalRealtimeAccessToken(input), websocketUrl }
}

export function issueInternalRealtimeAccessToken(input: {
  projectId: string
  context: RealtimeExecutionContext
  now?: Date
  operationId?: string
}): InternalRealtimeTokenResult {
  const now = input.now ?? new Date()
  const issuedAt = Math.floor(now.getTime() / 1000)
  const expiresIn = config.realtime.tokenTtlSeconds
  const expiresAtSeconds = issuedAt + expiresIn
  const operationId = input.operationId ?? randomUUID()
  const token = jwt.sign({
    sub: input.context.subject,
    iat: issuedAt,
    exp: expiresAtSeconds,
    tokenType: 'druvia_realtime_access',
    projectId: input.projectId,
    actorType: input.context.actorType,
    [HASURA_CLAIMS_NAMESPACE]: {
      'x-hasura-allowed-roles': [input.context.role],
      'x-hasura-default-role': input.context.role,
      ...input.context.sessionVariables,
    },
  }, getSigningSecret(), {
    algorithm: 'HS256',
    issuer: 'druvia',
    audience: 'druvia-hasura',
    jwtid: operationId,
  })

  return {
    token,
    operationId,
    expiresIn,
    expiresAt: new Date(expiresAtSeconds * 1000).toISOString(),
  }
}
