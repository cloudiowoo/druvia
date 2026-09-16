import { appendFile } from 'node:fs/promises';
import { resolveUpdaterBootstrapMetadata } from './generate-manifest.mjs';

const githubEnv = process.env.GITHUB_ENV;
if (!githubEnv) throw new Error('MISSING_ENV: GITHUB_ENV');

const bootstrap = resolveUpdaterBootstrapMetadata(
  process.env.RELEASE_VERSION,
  process.env.BOOTSTRAP_INPUT_BASE_VERSION,
  process.env.BOOTSTRAP_INPUT_MIGRATION_VERSION,
);

await appendFile(githubEnv, [
  `BOOTSTRAP_BASE_VERSION=${bootstrap.baseVersion}`,
  `BOOTSTRAP_MIGRATION_VERSION=${bootstrap.migrationVersion}`,
  '',
].join('\n'));
