import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { DruviaReleaseManifest } from '../../packages/shared/src/update.js';
import {
  buildImageRef,
  compareSemver,
  validateAllowedReleaseUrl,
  validateReleaseManifest,
  verifySha256,
} from '../../apps/updater/src/manifest.js';

function buildManifest(overrides: Partial<DruviaReleaseManifest> = {}): DruviaReleaseManifest {
  return {
    schemaVersion: 1,
    product: 'druvia',
    version: '0.2.0',
    channel: 'stable',
    createdAt: '2026-07-28T00:00:00.000Z',
    minUpdaterVersion: '0.1.0',
    releaseNotesUrl: 'https://github.com/druvia/druvia/releases/tag/v0.2.0',
    compose: {
      url: 'https://github.com/druvia/druvia/releases/download/v0.2.0/docker-compose.release.yml',
      sha256: 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
    },
    images: {
      api: {
        repository: 'ghcr.io/druvia/druvia-api',
        tag: '0.2.0',
        digest: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      },
      admin: {
        repository: 'ghcr.io/druvia/druvia-admin',
        tag: '0.2.0',
        digest: 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      },
      worker: {
        repository: 'ghcr.io/druvia/druvia-worker',
        tag: '0.2.0',
        digest: 'sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
      },
      updater: {
        repository: 'ghcr.io/druvia/druvia-updater',
        tag: '0.2.0',
        digest: 'sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd',
      },
    },
    migrations: {
      required: true,
      from: 17,
      to: 18,
      requiresBackup: true,
      reversible: false,
    },
    ...overrides,
  };
}

describe('updater manifest helpers', () => {
  it('compares semver strings without treating equal versions as newer', () => {
    expect(compareSemver('0.2.0', '0.1.9')).toBe(1);
    expect(compareSemver('0.2.0', '0.2.0')).toBe(0);
    expect(compareSemver('0.1.9', '0.2.0')).toBe(-1);
  });

  it('compares semver prerelease identifiers for beta and release-candidate upgrades', () => {
    expect(compareSemver('0.2.0', '0.2.0-rc.1')).toBe(1);
    expect(compareSemver('0.2.0-rc.2', '0.2.0-rc.1')).toBe(1);
    expect(compareSemver('0.2.0-rc.1', '0.2.0')).toBe(-1);
  });

  it('validates a release manifest and builds immutable image refs', () => {
    const manifest = validateReleaseManifest(buildManifest(), {
      currentVersion: '0.1.0',
      channel: 'stable',
      currentUpdaterVersion: '0.1.0',
      allowedHosts: ['github.com'],
    });

    expect(manifest.version).toBe('0.2.0');
    expect(buildImageRef(manifest.images.api)).toBe(
      'ghcr.io/druvia/druvia-api@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
    );
  });

  it('rejects downgrade or equal-version manifests', () => {
    expect(() =>
      validateReleaseManifest(buildManifest({ version: '0.1.0' }), {
        currentVersion: '0.1.0',
        channel: 'stable',
        currentUpdaterVersion: '0.1.0',
        allowedHosts: ['github.com'],
      })
    ).toThrow(/NO_UPDATE_AVAILABLE/);
  });

  it('rejects build metadata because release versions are used as Docker tags', () => {
    expect(() =>
      validateReleaseManifest(buildManifest({ version: '0.2.0+build.1' }), {
        currentVersion: '0.1.0',
        channel: 'stable',
        currentUpdaterVersion: '0.1.0',
        allowedHosts: ['github.com'],
      })
    ).toThrow(/INVALID_SEMVER/);
  });

  it('rejects manifests with unsupported release channels before comparing configured channel', () => {
    expect(() =>
      validateReleaseManifest({ ...buildManifest(), channel: 'dev' }, {
        currentVersion: '0.1.0',
        channel: 'stable',
        currentUpdaterVersion: '0.1.0',
        allowedHosts: ['github.com'],
      })
    ).toThrow(/INVALID_CHANNEL/);
  });

  it('rejects release URLs outside the allowlist', () => {
    expect(() => validateAllowedReleaseUrl('https://evil.example/release.json', ['github.com']))
      .toThrow(/DISALLOWED_RELEASE_HOST/);
  });

  it('verifies compose checksums against sha256 hex digests', () => {
    const payload = Buffer.from('compose: release');
    const sha256 = createHash('sha256').update(payload).digest('hex');

    expect(verifySha256(payload, sha256)).toBe(true);
    expect(verifySha256(payload, 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee')).toBe(false);
  });
});
