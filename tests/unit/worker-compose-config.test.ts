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
  const contentStart = match.index + match[0].length
  const next = /^  [a-zA-Z0-9_-]+:/m.exec(source.slice(contentStart))
  const end = next ? contentStart + next.index : source.length
  return source.slice(match.index, end)
}

describe.each(composeFiles)('%s Worker security contract', (file) => {
  const source = readFileSync(file, 'utf8')
  const deno = serviceBlock(source, 'deno')

  it('passes only the resolved Worker credential and exposes a healthcheck', () => {
    expect(deno).toContain(
      'DENO_WORKER_SECRET: ${DENO_WORKER_SECRET:-${FUNCTIONS_INTERNAL_TOKEN_SECRET:-${JWT_SECRET}}}'
    )
    expect(deno).not.toMatch(/^\s+FUNCTIONS_INTERNAL_TOKEN_SECRET:/m)
    expect(deno).toContain('healthcheck:')
    expect(deno).toContain('test: ["CMD", "deno", "eval", "const r = await fetch')
    expect(deno).not.toContain('"eval", "--allow-net=127.0.0.1:7133"')
    expect(deno).toContain("fetch('http://127.0.0.1:7133/health')")
  })

  it('uses deployment-appropriate host exposure', () => {
    if (file.endsWith('docker-compose.yml') || file.endsWith('docker-compose.dev.yml')) {
      expect(deno).toContain('127.0.0.1:${DENO_PORT:-7133}:7133')
      return
    }
    expect(deno).not.toContain('ports:')
    expect(deno).not.toContain(':7133:7133')
  })
})

describe.each([
  'docker/docker-compose.local.yml',
  'docker/docker-compose.prod.yml',
  'docker/docker-compose.release.yml',
])('%s containerized API Worker credentials', (file) => {
  const source = readFileSync(file, 'utf8')
  const api = serviceBlock(source, 'api')

  it('passes independently resolved Worker and Function-token secrets to the API', () => {
    expect(api).toContain(
      'DENO_WORKER_SECRET: ${DENO_WORKER_SECRET:-${FUNCTIONS_INTERNAL_TOKEN_SECRET:-${JWT_SECRET}}}'
    )
    expect(api).toContain(
      'FUNCTIONS_INTERNAL_TOKEN_SECRET: ${FUNCTIONS_INTERNAL_TOKEN_SECRET:-${JWT_SECRET}}'
    )
  })
})

describe('Worker credential environment examples', () => {
  it.each(['.env.example', 'docker/.env.example', 'docker/.env.prod.example'])(
    'documents separate Function token and Worker credentials in %s',
    (file) => {
      const source = readFileSync(file, 'utf8')
      expect(source).toContain('FUNCTIONS_INTERNAL_TOKEN_SECRET=')
      expect(source).toContain('DENO_WORKER_SECRET=')
      expect(source).toMatch(/DENO_WORKER_SECRET[\s\S]{0,300}32 UTF-8 bytes|32 UTF-8 bytes[\s\S]{0,300}DENO_WORKER_SECRET/)
    }
  )
})
