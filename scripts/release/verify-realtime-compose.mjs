import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

const root = resolve(import.meta.dirname, '../..')
const composeFiles = [
  { path: 'docker/docker-compose.yml', hasApi: false },
  { path: 'docker/docker-compose.dev.yml', hasApi: false },
  { path: 'docker/docker-compose.local.yml', hasApi: true, publicUrl: 'http://localhost:8080' },
  { path: 'docker/docker-compose.prod.yml', hasApi: true, publicUrl: 'https://verify.druvia.example' },
  { path: 'docker/docker-compose.release.yml', hasApi: true, publicUrl: 'https://verify.druvia.example' },
]

const inheritedKeys = ['PATH', 'HOME', 'DOCKER_CONFIG', 'TMPDIR']
const inheritedEnv = Object.fromEntries(
  inheritedKeys.flatMap((key) => process.env[key] ? [[key, process.env[key]]] : [])
)

function fail(message) {
  throw new Error(`Realtime Compose verification failed: ${message}`)
}

function serviceBlock(source, service) {
  const marker = `  ${service}:\n`
  const match = new RegExp(`^  ${service}:$`, 'm').exec(source)
  if (!match) fail(`rendered output is missing the ${service} service`)
  const start = match.index
  const remaining = source.slice(start + marker.length)
  const nextMatch = remaining.match(/^  [a-zA-Z0-9_-]+:\n/m)
  const end = nextMatch ? start + marker.length + nextMatch.index : source.length
  return source.slice(start, end)
}

function syntheticEnv(overrides = {}) {
  return {
    ...inheritedEnv,
    COMPOSE_PROJECT_NAME: 'druvia-realtime-verify',
    POSTGRES_PASSWORD: 'synthetic-postgres-password',
    POSTGRES_PASSWORD_ENCODED: 'synthetic-postgres-password',
    HASURA_ADMIN_SECRET: 'synthetic-hasura-admin-secret',
    JWT_SECRET: 'legacy_platform_secret_1234567890ab',
    HASURA_JWT_SECRET: 'hasura_realtime_secret_1234567890ab',
    STORAGE_TRUSTED_TICKET_SECRET: 'synthetic_storage_ticket_secret_123456',
    API_BASE_URL: 'https://verify.druvia.example',
    DRUVIA_VERSION: '0.0.0',
    DRUVIA_RELEASE_MANIFEST_URL: 'https://verify.druvia.example/release-manifest.json',
    DRUVIA_UPDATER_SECRET: 'synthetic_updater_secret_1234567890',
    DRUVIA_DEPLOY_DIR: '/tmp/druvia-realtime-verify',
    DRUVIA_API_IMAGE: 'example.invalid/druvia-api:0.0.0',
    DRUVIA_ADMIN_IMAGE: 'example.invalid/druvia-admin:0.0.0',
    DRUVIA_WORKER_IMAGE: 'example.invalid/druvia-worker:0.0.0',
    DRUVIA_UPDATER_IMAGE: 'example.invalid/druvia-updater:0.0.0',
    CERTBOT_EMAIL: 'verify@example.com',
    CERTBOT_PRIMARY_DOMAIN: 'verify.druvia.example',
    ...overrides,
  }
}

function render(file, envFile, env, profiles = []) {
  const result = spawnSync(
    'docker',
    [
      'compose',
      '--env-file', envFile,
      '-f', resolve(root, file),
      ...profiles.flatMap((profile) => ['--profile', profile]),
      'config',
    ],
    { cwd: root, env, encoding: 'utf8', shell: false }
  )
  if (result.error) {
    fail(`cannot execute Docker Compose for ${file}: ${result.error.message}`)
  }
  return result
}

function assertContains(source, expected, context) {
  if (!source.includes(expected)) fail(`${context} does not contain ${JSON.stringify(expected)}`)
}

function verifyRendered(file, output, expectedKey, publicUrl, hasApi) {
  if (output.includes('HASURA_PUBLIC_URL: http://localhost:3001')) {
    fail(`${file} rendered an API-internal localhost origin for browser Realtime clients`)
  }

  const hasura = serviceBlock(output, 'hasura')
  assertContains(hasura, expectedKey, `${file} Hasura signing key`)
  assertContains(hasura, 'issuer', `${file} Hasura JWT issuer`)
  assertContains(hasura, 'druvia', `${file} Hasura JWT issuer value`)
  assertContains(hasura, 'audience', `${file} Hasura JWT audience`)
  assertContains(hasura, 'druvia-hasura', `${file} Hasura JWT audience value`)

  if (hasApi) {
    const api = serviceBlock(output, 'api')
    assertContains(api, `HASURA_JWT_SECRET: ${expectedKey}`, `${file} API signing key`)
    assertContains(api, 'HASURA_REALTIME_TOKEN_TTL_SECONDS: "300"', `${file} token TTL`)
    assertContains(api, `HASURA_PUBLIC_URL: ${publicUrl}`, `${file} public Hasura origin`)
  }
}

const temporaryDirectory = mkdtempSync(join(tmpdir(), 'druvia-realtime-compose-'))
const emptyEnvFile = join(temporaryDirectory, 'empty.env')
writeFileSync(emptyEnvFile, '', 'utf8')

try {
  for (const compose of composeFiles) {
    for (const scenario of [
      {
        name: 'dedicated key',
        key: 'hasura_realtime_secret_1234567890ab',
        env: syntheticEnv(),
      },
      {
        name: 'JWT_SECRET fallback',
        key: 'legacy_platform_secret_1234567890ab',
        env: syntheticEnv({ HASURA_JWT_SECRET: '' }),
      },
    ]) {
      const result = render(compose.path, emptyEnvFile, scenario.env)
      if (result.status !== 0) {
        fail(`${compose.path} ${scenario.name} render exited ${result.status}: ${result.stderr.trim()}`)
      }
      verifyRendered(compose.path, result.stdout, scenario.key, compose.publicUrl, compose.hasApi)
    }
  }

  for (const file of ['docker/docker-compose.prod.yml', 'docker/docker-compose.release.yml']) {
    const env = syntheticEnv()
    delete env.API_BASE_URL
    delete env.HASURA_PUBLIC_URL
    const result = render(file, emptyEnvFile, env)
    if (result.status === 0) fail(`${file} accepts a missing public origin`)
  }

  const localRelease = render(
    'docker/docker-compose.release.yml',
    emptyEnvFile,
    syntheticEnv({ HASURA_PUBLIC_URL: 'http://localhost:8088' }),
    ['with-local-nginx']
  )
  if (localRelease.status !== 0) {
    fail(`release local-nginx render exited ${localRelease.status}: ${localRelease.stderr.trim()}`)
  }
  verifyRendered(
    'docker/docker-compose.release.yml (with-local-nginx)',
    localRelease.stdout,
    'hasura_realtime_secret_1234567890ab',
    'http://localhost:8088',
    true
  )
  serviceBlock(localRelease.stdout, 'local-nginx')

  console.log('Realtime Compose configuration verified for base, dev, local, prod and release modes.')
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true })
}
