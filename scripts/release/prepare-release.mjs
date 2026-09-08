import { appendFile } from 'node:fs/promises';
import { resolveReleaseMetadata } from './generate-manifest.mjs';

const rawVersion = process.env.RELEASE_INPUT_VERSION || process.env.GITHUB_REF_NAME;
const requestedChannel = process.env.RELEASE_INPUT_CHANNEL || '';
const githubEnv = process.env.GITHUB_ENV;
const githubSha = process.env.GITHUB_SHA || '';

if (!githubEnv) throw new Error('MISSING_ENV: GITHUB_ENV');
if (!githubSha) throw new Error('MISSING_ENV: GITHUB_SHA');

const release = resolveReleaseMetadata(rawVersion, requestedChannel);
await appendFile(githubEnv, [
  `RELEASE_VERSION=${release.version}`,
  `RELEASE_TAG=${release.tag}`,
  `RELEASE_CHANNEL=${release.channel}`,
  `RELEASE_PRERELEASE=${release.prerelease}`,
  `SHORT_SHA=${githubSha.slice(0, 7)}`,
  '',
].join('\n'));
