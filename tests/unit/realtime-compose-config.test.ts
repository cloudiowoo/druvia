import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const composeFiles = [
  'docker/docker-compose.yml',
  'docker/docker-compose.dev.yml',
  'docker/docker-compose.local.yml',
  'docker/docker-compose.prod.yml',
  'docker/docker-compose.release.yml',
]

function serviceBlock(source: string, service: string): string {
  const match = new RegExp(`^  ${service}:$`, 'm').exec(source)
  if (!match) throw new Error(`Missing ${service} service`)
  const start = match.index
  const contentStart = start + match[0].length
  const next = /^  [a-zA-Z0-9_-]+:/m.exec(source.slice(contentStart))
  const end = next ? contentStart + next.index : source.length
  return source.slice(start, end)
}

describe.each(composeFiles)('%s Realtime configuration', (file) => {
  const source = readFileSync(file, 'utf8')
  const hasura = serviceBlock(source, 'hasura')
  const hasApiService = source.includes('\n  api:')
  const api = hasApiService ? serviceBlock(source, 'api') : ''

  it('shares one effective signing key and fixed JWT verification metadata', () => {
    expect(hasura).toContain(
      `'"type":"HS256","key":"\${HASURA_JWT_SECRET:-\${JWT_SECRET}}","issuer":"druvia","audience":"druvia-hasura"'`
        .replace(/^'|'$/g, '')
    )
    expect(hasura).toContain('HASURA_GRAPHQL_UNAUTHORIZED_ROLE: anonymous')
    if (hasApiService) {
      expect(api).toContain('HASURA_JWT_SECRET: ${HASURA_JWT_SECRET:-${JWT_SECRET}}')
      expect(api).toContain(
        'HASURA_REALTIME_TOKEN_TTL_SECONDS: ${HASURA_REALTIME_TOKEN_TTL_SECONDS:-300}'
      )
    }
  })

  it('passes a browser-reachable public origin to the API', () => {
    if (!hasApiService) {
      expect(['docker/docker-compose.yml', 'docker/docker-compose.dev.yml']).toContain(file)
      return
    }
    expect(api).toContain('HASURA_PUBLIC_URL:')
    if (file.endsWith('.prod.yml') || file.endsWith('.release.yml')) {
      expect(api).toContain(
        'API_BASE_URL: ${API_BASE_URL:?Set API_BASE_URL to the public Druvia origin}'
      )
      expect(api).toContain('HASURA_PUBLIC_URL: ${HASURA_PUBLIC_URL:-${API_BASE_URL}}')
      expect(api).not.toContain('API_BASE_URL:-http://localhost:3001')
    } else {
      expect(api).toContain(
        'HASURA_PUBLIC_URL: ${HASURA_PUBLIC_URL:-http://localhost:${HASURA_PORT:-8080}}'
      )
    }
  })
})

describe('Realtime environment examples', () => {
  it.each(['.env.example', 'docker/.env.example', 'docker/.env.prod.example'])(
    'documents safe Realtime settings in %s',
    (file) => {
      const source = readFileSync(file, 'utf8')
      expect(source).toContain('HASURA_JWT_SECRET=')
      expect(source).toContain('HASURA_REALTIME_TOKEN_TTL_SECONDS=300')
      expect(source).toContain('HASURA_PUBLIC_URL=')
    }
  )

  it('documents the persistent local OTA origin override', () => {
    const source = readFileSync('docker/.env.release.example', 'utf8')
    expect(source).toContain('# HASURA_PUBLIC_URL=http://localhost:8088')
    expect(source).toContain('updater preserves existing extra keys')
  })
})
