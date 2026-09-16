import { createHash } from 'node:crypto';
import { appendFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;
const SERVICES = ['api', 'admin', 'worker'];

function fail(code) {
  throw new Error(code);
}

async function readJson(path, code) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    fail(code);
  }
}

function verifyManifest(manifest, expected) {
  if (manifest?.schemaVersion !== 1
    || manifest?.product !== 'druvia'
    || manifest?.version !== expected.baseVersion
    || manifest?.channel !== 'stable') {
    fail('INVALID_BOOTSTRAP_BASE_MANIFEST');
  }
  if (!Number.isInteger(manifest?.migrations?.to)
    || manifest.migrations.to !== expected.migrationVersion) {
    fail('BOOTSTRAP_BASE_MIGRATION_MISMATCH');
  }
  if (manifest?.compose?.sha256 !== expected.composeSha256) {
    fail('BOOTSTRAP_BASE_COMPOSE_MISMATCH');
  }

  return Object.fromEntries(SERVICES.map((service) => {
    const image = manifest?.images?.[service];
    if (image?.repository !== expected.repositories[service]
      || image?.tag !== expected.baseVersion
      || !DIGEST_PATTERN.test(image?.digest ?? '')) {
      fail(`INVALID_BOOTSTRAP_BASE_IMAGE_${service.toUpperCase()}`);
    }
    return [service, image.digest];
  }));
}

export async function verifyUpdaterBootstrapBaseAssets({
  baseDir,
  baseVersion,
  migrationVersion,
  repositories,
}) {
  if (!baseDir || !baseVersion || !Number.isInteger(migrationVersion)) {
    fail('INVALID_BOOTSTRAP_BASE_INPUT');
  }
  const compose = await readFile(join(baseDir, 'docker-compose.release.yml'));
  const composeSha256 = createHash('sha256').update(compose).digest('hex');
  const ghcrManifest = await readJson(
    join(baseDir, 'release-manifest.json'),
    'INVALID_BOOTSTRAP_BASE_GHCR_MANIFEST',
  );
  const selfHostedManifest = await readJson(
    join(baseDir, 'release-manifest.cn.json'),
    'INVALID_BOOTSTRAP_BASE_SELF_HOSTED_MANIFEST',
  );

  return {
    composeSha256,
    ghcr: verifyManifest(ghcrManifest, {
      baseVersion, migrationVersion, composeSha256, repositories: repositories.ghcr,
    }),
    selfHosted: verifyManifest(selfHostedManifest, {
      baseVersion, migrationVersion, composeSha256, repositories: repositories.selfHosted,
    }),
  };
}

async function runCli(env = process.env) {
  const result = await verifyUpdaterBootstrapBaseAssets({
    baseDir: env.BOOTSTRAP_BASE_DIR || 'bootstrap-base',
    baseVersion: env.BOOTSTRAP_BASE_VERSION,
    migrationVersion: Number(env.BOOTSTRAP_MIGRATION_VERSION),
    repositories: {
      ghcr: {
        api: env.GHCR_API_IMAGE,
        admin: env.GHCR_ADMIN_IMAGE,
        worker: env.GHCR_WORKER_IMAGE,
      },
      selfHosted: {
        api: env.SELF_HOSTED_API_IMAGE,
        admin: env.SELF_HOSTED_ADMIN_IMAGE,
        worker: env.SELF_HOSTED_WORKER_IMAGE,
      },
    },
  });
  if (!env.GITHUB_OUTPUT) fail('MISSING_GITHUB_OUTPUT');
  await appendFile(env.GITHUB_OUTPUT, [
    `compose_sha256=${result.composeSha256}`,
    `ghcr_api=${result.ghcr.api}`,
    `ghcr_admin=${result.ghcr.admin}`,
    `ghcr_worker=${result.ghcr.worker}`,
    `self_hosted_api=${result.selfHosted.api}`,
    `self_hosted_admin=${result.selfHosted.admin}`,
    `self_hosted_worker=${result.selfHosted.worker}`,
    '',
  ].join('\n'));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  runCli().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
