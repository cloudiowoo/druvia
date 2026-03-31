import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

function applyDefaultEnv(key: string, value: string) {
  if (process.env[key] == null) {
    process.env[key] = value
  }
}

function stripWrappingQuotes(value: string): string {
  if (
    (value.startsWith('"') && value.endsWith('"'))
    || (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1)
  }
  return value
}

function loadRepoEnvDefaults() {
  const envPath = resolve(process.cwd(), '.env')
  if (!existsSync(envPath)) return

  const content = readFileSync(envPath, 'utf8')
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue

    const separatorIndex = line.indexOf('=')
    if (separatorIndex <= 0) continue

    const key = line.slice(0, separatorIndex).trim()
    const value = stripWrappingQuotes(line.slice(separatorIndex + 1).trim())
    applyDefaultEnv(key, value)
  }
}

// Load repo-local defaults first so Vitest follows the current local stack.
loadRepoEnvDefaults()

// Set test environment variables before any imports.
applyDefaultEnv('JWT_SECRET', 'test-secret-key-for-testing-only-32chars')
applyDefaultEnv('DB_HOST', 'localhost')
applyDefaultEnv('DB_PORT', '5432')
applyDefaultEnv('DB_USER', 'postgres')
applyDefaultEnv('DB_NAME', 'druvia')
applyDefaultEnv('POSTGRES_PASSWORD', 'p@sscode1234!')
process.env.HASURA_ADMIN_SECRET = '' // Disable Hasura webhook verification in tests.
applyDefaultEnv('REDIS_URL', 'redis://localhost:6379')
process.env.STORAGE_PATH = './tests/.storage' // Isolate test storage from dev data.
