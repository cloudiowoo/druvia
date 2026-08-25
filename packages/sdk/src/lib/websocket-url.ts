const WEBSOCKET_URL_PATTERN = /^(ws|wss):\/\/([^/?#]+)(\/[^?#]*)?$/i
const HOST_LABEL_PATTERN = /^[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?$/i
const PATH_UNSAFE_PATTERN = /[\u0000-\u0020\u007f\\]/

function normalizeIpv4(value: string): string | null {
  const parts = value.split('.')
  if (parts.length !== 4) return null

  const normalized: string[] = []
  for (const part of parts) {
    if (!/^(?:0|[1-9]\d{0,2})$/.test(part)) return null
    const octet = Number(part)
    if (octet > 255) return null
    normalized.push(String(octet))
  }
  return normalized.join('.')
}

function isValidIpv6(value: string): boolean {
  if (value.length === 0 || value.includes('%')) return false

  if (value.includes('.')) {
    const ipv4Segment = value.slice(value.lastIndexOf(':') + 1)
    if (!normalizeIpv4(ipv4Segment)) return false
  }

  const compressionIndex = value.indexOf('::')
  const hasCompression = compressionIndex >= 0
  if (hasCompression && compressionIndex !== value.lastIndexOf('::')) return false

  const sides = hasCompression ? value.split('::') : [value]
  const segments: string[] = []
  for (const side of sides) {
    if (side.length === 0) continue
    const sideSegments = side.split(':')
    if (sideSegments.some((segment) => segment.length === 0)) return false
    segments.push(...sideSegments)
  }

  let groupCount = 0
  for (const [index, segment] of segments.entries()) {
    if (segment.includes('.')) {
      if (index !== segments.length - 1 || !normalizeIpv4(segment)) return false
      groupCount += 2
    } else {
      if (!/^[0-9a-f]{1,4}$/i.test(segment)) return false
      groupCount += 1
    }
  }

  return hasCompression ? groupCount < 8 : groupCount === 8
}

function normalizeHostname(value: string): string | null {
  if (value.length === 0 || value.length > 253) return null

  const hasTrailingDot = value.endsWith('.')
  const candidate = hasTrailingDot ? value.slice(0, -1) : value
  const labels = candidate.split('.')
  const lastLabel = labels[labels.length - 1] ?? ''
  if (/^(?:\d+|0x[0-9a-f]+)$/i.test(lastLabel)) {
    return normalizeIpv4(candidate)
  }
  if (labels.some((label) => !HOST_LABEL_PATTERN.test(label))) return null

  const normalized = labels.join('.').toLowerCase()
  return hasTrailingDot ? `${normalized}.` : normalized
}

function normalizeAuthority(
  value: string,
  scheme: 'ws' | 'wss'
): string | null {
  if (value.includes('@') || /[\u0000-\u0020\u007f\\]/.test(value)) return null

  let host: string
  let port: string | undefined
  if (value.startsWith('[')) {
    const closingBracket = value.indexOf(']')
    if (closingBracket < 0) return null

    const address = value.slice(1, closingBracket)
    const suffix = value.slice(closingBracket + 1)
    if (!isValidIpv6(address)) return null
    if (suffix.length > 0) {
      if (!suffix.startsWith(':')) return null
      port = suffix.slice(1)
    }
    host = `[${address.toLowerCase()}]`
  } else {
    if (value.includes('[') || value.includes(']')) return null

    const firstColon = value.indexOf(':')
    const lastColon = value.lastIndexOf(':')
    if (firstColon !== lastColon) return null
    const hostname = firstColon < 0 ? value : value.slice(0, firstColon)
    port = firstColon < 0 ? undefined : value.slice(firstColon + 1)
    const normalizedHostname = normalizeHostname(hostname)
    if (!normalizedHostname) return null
    host = normalizedHostname
  }

  if (port === undefined) return host
  if (!/^\d{1,5}$/.test(port)) return null

  const portNumber = Number(port)
  if (portNumber > 65535) return null
  if ((scheme === 'ws' && portNumber === 80) || (scheme === 'wss' && portNumber === 443)) {
    return host
  }
  return `${host}:${portNumber}`
}

function normalizePath(value: string): string | null {
  if (PATH_UNSAFE_PATTERN.test(value)) return null

  const path = value.replace(/^\/+/, '/')
  for (const segment of path.split('/')) {
    const dotCandidate = segment.replace(/%2e/gi, '.')
    if (dotCandidate === '.' || dotCandidate === '..') return null
  }

  const trimmedPath = path.replace(/\/+$/, '')
  return trimmedPath.endsWith('/v1/graphql')
    ? trimmedPath
    : `${trimmedPath}/v1/graphql`.replace(/^\/{2,}/, '/')
}

export function normalizeWebSocketUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null

  const candidate = value.trim()
  if (candidate.length === 0) return null

  const match = WEBSOCKET_URL_PATTERN.exec(candidate)
  if (!match) return null

  const scheme = match[1].toLowerCase() as 'ws' | 'wss'
  const authority = normalizeAuthority(match[2], scheme)
  if (!authority) return null

  const endpointPath = normalizePath(match[3] ?? '')
  if (!endpointPath) return null
  return `${scheme}://${authority}${endpointPath}`
}
