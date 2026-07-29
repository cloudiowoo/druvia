import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const SEMVER_PATTERN = /^v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?)$/;
const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;
const CHANNELS = new Set(['stable', 'beta', 'nightly']);

function required(env, key) {
  const value = env[key];
  if (!value) {
    throw new Error(`MISSING_ENV: ${key}`);
  }
  return value;
}

function parseBoolean(env, key, fallback) {
  const value = env[key];
  if (value === undefined || value === '') return fallback;
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new Error(`INVALID_BOOLEAN: ${key}`);
}

function parseInteger(env, key, fallback) {
  const value = env[key];
  if (value === undefined || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`INVALID_INTEGER: ${key}`);
  }
  return parsed;
}

function normalizeDigest(env, key) {
  const digest = required(env, key);
  if (!DIGEST_PATTERN.test(digest)) {
    throw new Error(`INVALID_IMAGE_DIGEST: ${key}`);
  }
  return digest;
}

export function normalizeReleaseVersion(value) {
  const match = value?.match(SEMVER_PATTERN);
  if (!match) {
    throw new Error(`INVALID_RELEASE_VERSION: ${value ?? ''}`);
  }
  return match[1];
}

function releaseTagFromVersion(version) {
  return `v${version}`;
}

function defaultReleaseUrl(env, tag, assetName) {
  const serverUrl = env.GITHUB_SERVER_URL || 'https://github.com';
  const repository = required(env, 'GITHUB_REPOSITORY');
  return `${serverUrl}/${repository}/releases/download/${tag}/${assetName}`;
}

function defaultReleaseNotesUrl(env, tag) {
  const serverUrl = env.GITHUB_SERVER_URL || 'https://github.com';
  const repository = required(env, 'GITHUB_REPOSITORY');
  return `${serverUrl}/${repository}/releases/tag/${tag}`;
}

function buildImage(env, version, name, envPrefix) {
  return {
    repository: required(env, `${envPrefix}_IMAGE_REPOSITORY`),
    tag: version,
    digest: normalizeDigest(env, `${envPrefix}_IMAGE_DIGEST`),
  };
}

export async function buildReleaseManifest(env = process.env, options = {}) {
  const version = normalizeReleaseVersion(env.RELEASE_VERSION || env.GITHUB_REF_NAME);
  const tag = releaseTagFromVersion(version);
  const channel = env.DRUVIA_RELEASE_CHANNEL || 'stable';
  if (!CHANNELS.has(channel)) {
    throw new Error(`INVALID_RELEASE_CHANNEL: ${channel}`);
  }

  const composePath = options.composePath || env.DRUVIA_RELEASE_COMPOSE_PATH || 'docker/docker-compose.release.yml';
  const composeContent = await readFile(composePath);
  const composeSha256 = createHash('sha256').update(composeContent).digest('hex');

  const from = parseInteger(env, 'DRUVIA_MIGRATION_FROM', 0);
  const to = parseInteger(env, 'DRUVIA_MIGRATION_TO', from);
  if (from > to) {
    throw new Error('INVALID_MIGRATION_RANGE');
  }

  return {
    schemaVersion: 1,
    product: 'druvia',
    version,
    channel,
    createdAt: options.createdAt || new Date().toISOString(),
    minUpdaterVersion: env.DRUVIA_MIN_UPDATER_VERSION || '0.1.0',
    releaseNotesUrl: env.DRUVIA_RELEASE_NOTES_URL || defaultReleaseNotesUrl(env, tag),
    compose: {
      url: env.DRUVIA_COMPOSE_URL || defaultReleaseUrl(env, tag, 'docker-compose.release.yml'),
      sha256: composeSha256,
    },
    images: {
      api: buildImage(env, version, 'api', 'DRUVIA_API'),
      admin: buildImage(env, version, 'admin', 'DRUVIA_ADMIN'),
      worker: buildImage(env, version, 'worker', 'DRUVIA_WORKER'),
      updater: buildImage(env, version, 'updater', 'DRUVIA_UPDATER'),
    },
    migrations: {
      required: parseBoolean(env, 'DRUVIA_MIGRATION_REQUIRED', false),
      from,
      to,
      requiresBackup: parseBoolean(env, 'DRUVIA_MIGRATION_REQUIRES_BACKUP', false),
      reversible: parseBoolean(env, 'DRUVIA_MIGRATION_REVERSIBLE', false),
    },
  };
}

export async function writeReleaseManifest(env = process.env, options = {}) {
  const outputPath = options.outputPath || env.DRUVIA_RELEASE_MANIFEST_OUTPUT || 'release-manifest.json';
  const manifest = await buildReleaseManifest(env, options);
  await writeFile(outputPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  return manifest;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  writeReleaseManifest().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
