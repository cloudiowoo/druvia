import { createHash } from 'node:crypto';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildReleaseManifest, normalizeReleaseVersion } from '../../scripts/release/generate-manifest.mjs';

const digest = (char: string) => `sha256:${char.repeat(64)}`;

describe('release manifest generator', () => {
  it('normalizes v-prefixed tags and writes deterministic manifest data', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'druvia-release-'));
    const composePath = join(dir, 'docker-compose.release.yml');
    const composeContent = 'services:\n  api:\n    image: ${DRUVIA_API_IMAGE}\n';
    await writeFile(composePath, composeContent, 'utf8');

    const manifest = await buildReleaseManifest({
      GITHUB_REF_NAME: 'v0.2.0',
      GITHUB_REPOSITORY: 'druvia/druvia',
      GITHUB_SERVER_URL: 'https://github.com',
      DRUVIA_RELEASE_CHANNEL: 'stable',
      DRUVIA_MIN_UPDATER_VERSION: '0.1.0',
      DRUVIA_API_IMAGE_REPOSITORY: 'ghcr.io/druvia/druvia-api',
      DRUVIA_ADMIN_IMAGE_REPOSITORY: 'ghcr.io/druvia/druvia-admin',
      DRUVIA_WORKER_IMAGE_REPOSITORY: 'ghcr.io/druvia/druvia-worker',
      DRUVIA_UPDATER_IMAGE_REPOSITORY: 'ghcr.io/druvia/druvia-updater',
      DRUVIA_API_IMAGE_DIGEST: digest('a'),
      DRUVIA_ADMIN_IMAGE_DIGEST: digest('b'),
      DRUVIA_WORKER_IMAGE_DIGEST: digest('c'),
      DRUVIA_UPDATER_IMAGE_DIGEST: digest('d'),
      DRUVIA_MIGRATION_REQUIRED: 'true',
      DRUVIA_MIGRATION_FROM: '17',
      DRUVIA_MIGRATION_TO: '18',
      DRUVIA_MIGRATION_REQUIRES_BACKUP: 'true',
      DRUVIA_MIGRATION_REVERSIBLE: 'false',
    }, {
      composePath,
      createdAt: '2026-07-28T00:00:00.000Z',
    });

    expect(normalizeReleaseVersion('v0.2.0')).toBe('0.2.0');
    expect(manifest).toMatchObject({
      schemaVersion: 1,
      product: 'druvia',
      version: '0.2.0',
      channel: 'stable',
      createdAt: '2026-07-28T00:00:00.000Z',
      releaseNotesUrl: 'https://github.com/druvia/druvia/releases/tag/v0.2.0',
      compose: {
        url: 'https://github.com/druvia/druvia/releases/download/v0.2.0/docker-compose.release.yml',
        sha256: createHash('sha256').update(composeContent).digest('hex'),
      },
      migrations: {
        required: true,
        from: 17,
        to: 18,
        requiresBackup: true,
        reversible: false,
      },
    });
    expect(manifest.images.api).toEqual({
      repository: 'ghcr.io/druvia/druvia-api',
      tag: '0.2.0',
      digest: digest('a'),
    });
  });

  it('rejects non-semver release refs', () => {
    expect(() => normalizeReleaseVersion('preview')).toThrow(/INVALID_RELEASE_VERSION/);
  });

  it('rejects build metadata because release versions are also used as Docker tags', () => {
    expect(() => normalizeReleaseVersion('v0.2.0+build.1')).toThrow(/INVALID_RELEASE_VERSION/);
  });
});

describe('release workflow', () => {
  it('builds all release images and uploads manifest assets', () => {
    const workflow = readFileSync('.github/workflows/release.yml', 'utf8');

    expect(workflow).toContain("tags:\n      - 'v*'");
    expect(workflow).toContain('workflow_dispatch:');
    expect(workflow).toContain('ghcr.io/${{ github.repository_owner }}/druvia-api');
    expect(workflow).toContain('ghcr.io/${{ github.repository_owner }}/druvia-admin');
    expect(workflow).toContain('ghcr.io/${{ github.repository_owner }}/druvia-worker');
    expect(workflow).toContain('ghcr.io/${{ github.repository_owner }}/druvia-updater');
    expect(workflow).toContain('context: docker/deno-worker');
    expect(workflow).toContain('file: docker/Dockerfile.worker');
    expect(workflow).toContain('scripts/release/generate-manifest.mjs');
    expect(workflow).toContain('release-manifest.json');
    expect(workflow).toContain('docker/docker-compose.release.yml');
  });
});
