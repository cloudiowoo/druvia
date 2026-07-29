import { createHash } from 'node:crypto';
import {
  DRUVIA_RELEASE_CHANNELS,
  type DruviaReleaseChannel,
  type DruviaReleaseImage,
  type DruviaReleaseManifest,
} from '@druvia/shared';

const SEMVER_PATTERN = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;
const SHA256_PATTERN = /^sha256:[a-f0-9]{64}$/;
const HEX_SHA256_PATTERN = /^[a-f0-9]{64}$/;

export interface ValidateReleaseManifestOptions {
  currentVersion: string;
  channel: DruviaReleaseChannel;
  currentUpdaterVersion: string;
  allowedHosts: string[];
}

export class UpdateManifestError extends Error {
  constructor(
    public readonly code: string,
    message: string
  ) {
    super(`${code}: ${message}`);
    this.name = 'UpdateManifestError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isReleaseChannel(value: unknown): value is DruviaReleaseChannel {
  return typeof value === 'string' && DRUVIA_RELEASE_CHANNELS.includes(value as DruviaReleaseChannel);
}

interface ParsedSemver {
  major: number;
  minor: number;
  patch: number;
  prerelease: string[];
}

function parseSemver(version: string): ParsedSemver {
  const match = version.match(SEMVER_PATTERN);
  if (!match) {
    throw new UpdateManifestError('INVALID_SEMVER', `Invalid semver: ${version}`);
  }

  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ? match[4].split('.') : [],
  };
}

function comparePrerelease(left: string[], right: string[]): -1 | 0 | 1 {
  if (left.length === 0 && right.length === 0) return 0;
  if (left.length === 0) return 1;
  if (right.length === 0) return -1;

  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const leftPart = left[index];
    const rightPart = right[index];
    if (leftPart === undefined) return -1;
    if (rightPart === undefined) return 1;
    if (leftPart === rightPart) continue;

    const leftNumeric = /^\d+$/.test(leftPart);
    const rightNumeric = /^\d+$/.test(rightPart);
    if (leftNumeric && rightNumeric) {
      const leftNumber = Number(leftPart);
      const rightNumber = Number(rightPart);
      if (leftNumber > rightNumber) return 1;
      if (leftNumber < rightNumber) return -1;
      continue;
    }
    if (leftNumeric) return -1;
    if (rightNumeric) return 1;
    return leftPart > rightPart ? 1 : -1;
  }

  return 0;
}

export function compareSemver(left: string, right: string): -1 | 0 | 1 {
  const a = parseSemver(left);
  const b = parseSemver(right);

  for (const key of ['major', 'minor', 'patch'] as const) {
    if (a[key] > b[key]) return 1;
    if (a[key] < b[key]) return -1;
  }
  return comparePrerelease(a.prerelease, b.prerelease);
}

export function validateAllowedReleaseUrl(url: string, allowedHosts: string[]): URL {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new UpdateManifestError('INVALID_RELEASE_URL', `Invalid release URL: ${url}`);
  }

  const normalizedHosts = new Set(allowedHosts.map((host) => host.trim().toLowerCase()).filter(Boolean));
  if (!normalizedHosts.has(parsed.hostname.toLowerCase())) {
    throw new UpdateManifestError('DISALLOWED_RELEASE_HOST', `Release host is not allowed: ${parsed.hostname}`);
  }

  return parsed;
}

export function verifySha256(payload: Buffer | string, expectedSha256: string): boolean {
  if (!HEX_SHA256_PATTERN.test(expectedSha256)) return false;
  const actual = createHash('sha256').update(payload).digest('hex');
  return actual === expectedSha256;
}

export function buildImageRef(image: DruviaReleaseImage): string {
  return `${image.repository}@${image.digest}`;
}

function validateImage(name: string, value: unknown): DruviaReleaseImage {
  if (!isRecord(value)) {
    throw new UpdateManifestError('INVALID_IMAGE', `Invalid ${name} image`);
  }
  const { repository, tag, digest } = value;
  if (typeof repository !== 'string' || repository.length === 0) {
    throw new UpdateManifestError('INVALID_IMAGE_REPOSITORY', `Invalid ${name} image repository`);
  }
  if (typeof tag !== 'string' || tag.length === 0) {
    throw new UpdateManifestError('INVALID_IMAGE_TAG', `Invalid ${name} image tag`);
  }
  if (typeof digest !== 'string' || !SHA256_PATTERN.test(digest)) {
    throw new UpdateManifestError('INVALID_IMAGE_DIGEST', `Invalid ${name} image digest`);
  }
  return { repository, tag, digest };
}

export function validateReleaseManifest(
  input: unknown,
  options: ValidateReleaseManifestOptions
): DruviaReleaseManifest {
  if (!isRecord(input)) {
    throw new UpdateManifestError('INVALID_MANIFEST', 'Manifest must be an object');
  }
  if (input.schemaVersion !== 1) {
    throw new UpdateManifestError('INVALID_SCHEMA_VERSION', 'Unsupported manifest schema version');
  }
  if (input.product !== 'druvia') {
    throw new UpdateManifestError('INVALID_PRODUCT', 'Manifest product must be druvia');
  }
  if (typeof input.version !== 'string') {
    throw new UpdateManifestError('INVALID_VERSION', 'Manifest version is required');
  }
  if (compareSemver(input.version, options.currentVersion) <= 0) {
    throw new UpdateManifestError('NO_UPDATE_AVAILABLE', 'Manifest version is not newer than the current version');
  }
  if (!isReleaseChannel(input.channel)) {
    throw new UpdateManifestError('INVALID_CHANNEL', 'Manifest channel is invalid');
  }
  if (input.channel !== options.channel) {
    throw new UpdateManifestError('CHANNEL_MISMATCH', 'Manifest channel does not match the configured channel');
  }
  if (typeof input.minUpdaterVersion !== 'string') {
    throw new UpdateManifestError('INVALID_MIN_UPDATER_VERSION', 'minUpdaterVersion is required');
  }
  if (compareSemver(input.minUpdaterVersion, options.currentUpdaterVersion) > 0) {
    throw new UpdateManifestError('UPDATER_TOO_OLD', 'Current updater is older than the manifest requirement');
  }
  if (typeof input.createdAt !== 'string' || Number.isNaN(Date.parse(input.createdAt))) {
    throw new UpdateManifestError('INVALID_CREATED_AT', 'Manifest createdAt must be an ISO date string');
  }
  if (typeof input.releaseNotesUrl !== 'string') {
    throw new UpdateManifestError('INVALID_RELEASE_NOTES_URL', 'releaseNotesUrl is required');
  }
  validateAllowedReleaseUrl(input.releaseNotesUrl, options.allowedHosts);

  if (!isRecord(input.compose) || typeof input.compose.url !== 'string' || typeof input.compose.sha256 !== 'string') {
    throw new UpdateManifestError('INVALID_COMPOSE', 'Manifest compose block is invalid');
  }
  validateAllowedReleaseUrl(input.compose.url, options.allowedHosts);
  if (!HEX_SHA256_PATTERN.test(input.compose.sha256)) {
    throw new UpdateManifestError('INVALID_COMPOSE_SHA256', 'Compose sha256 must be lowercase hex');
  }

  if (!isRecord(input.images)) {
    throw new UpdateManifestError('INVALID_IMAGES', 'Manifest images block is invalid');
  }
  const images = {
    api: validateImage('api', input.images.api),
    admin: validateImage('admin', input.images.admin),
    worker: validateImage('worker', input.images.worker),
    updater: validateImage('updater', input.images.updater),
  };

  if (!isRecord(input.migrations)) {
    throw new UpdateManifestError('INVALID_MIGRATIONS', 'Manifest migrations block is invalid');
  }
  const migrations = input.migrations;
  if (
    typeof migrations.required !== 'boolean'
    || typeof migrations.from !== 'number'
    || typeof migrations.to !== 'number'
    || typeof migrations.requiresBackup !== 'boolean'
    || typeof migrations.reversible !== 'boolean'
    || migrations.from > migrations.to
  ) {
    throw new UpdateManifestError('INVALID_MIGRATIONS', 'Manifest migrations block is invalid');
  }

  return {
    schemaVersion: 1,
    product: 'druvia',
    version: input.version,
    channel: input.channel,
    createdAt: input.createdAt,
    minUpdaterVersion: input.minUpdaterVersion,
    releaseNotesUrl: input.releaseNotesUrl,
    compose: {
      url: input.compose.url,
      sha256: input.compose.sha256,
    },
    images,
    migrations: {
      required: migrations.required,
      from: migrations.from,
      to: migrations.to,
      requiresBackup: migrations.requiresBackup,
      reversible: migrations.reversible,
    },
  };
}
