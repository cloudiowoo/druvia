const WEBSOCKET_URL_PATTERN = /^(ws|wss):\/\/([^/?#]+)(\/[^?#]*)?$/i

export function normalizeWebSocketUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null

  const candidate = value.trim()
  if (candidate.length === 0) return null

  const match = WEBSOCKET_URL_PATTERN.exec(candidate)
  if (!match) return null

  const scheme = match[1].toLowerCase() as 'ws' | 'wss'
  const authority = match[2]
  if (authority.includes('@')) return null

  const mappedScheme = scheme === 'wss' ? 'https' : 'http'
  const mappedValue = `${mappedScheme}://${candidate.slice(candidate.indexOf('://') + 3)}`

  try {
    const parsed = new URL(mappedValue)
    const username = (parsed as { username?: unknown }).username
    const password = (parsed as { password?: unknown }).password
    if (
      parsed.protocol.toLowerCase() !== `${mappedScheme}:`
      || typeof parsed.host !== 'string'
      || parsed.host.length === 0
      || typeof parsed.pathname !== 'string'
      || (typeof parsed.search === 'string' && parsed.search !== '')
      || (typeof parsed.hash === 'string' && parsed.hash !== '')
      || (typeof username === 'string' && username !== '')
      || (typeof password === 'string' && password !== '')
    ) {
      return null
    }

    const trimmedPath = parsed.pathname.replace(/\/+$/, '')
    const endpointPath = trimmedPath.endsWith('/v1/graphql')
      ? trimmedPath
      : `${trimmedPath}/v1/graphql`.replace(/^\/{2,}/, '/')
    return `${scheme}://${parsed.host}${endpointPath}`
  } catch {
    return null
  }
}
