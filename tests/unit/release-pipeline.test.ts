import { createHash } from 'node:crypto';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  buildReleaseManifest,
  normalizeReleaseVersion,
  resolveReleaseMetadata,
} from '../../scripts/release/generate-manifest.mjs';

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
      DRUVIA_MIGRATION_TO: '25',
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
        to: 25,
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

  it('rejects SemVer numeric identifiers with leading zeroes', () => {
    expect(() => normalizeReleaseVersion('v01.2.3')).toThrow(/INVALID_RELEASE_VERSION/);
    expect(() => normalizeReleaseVersion('v1.2.3-beta.01')).toThrow(/INVALID_RELEASE_VERSION/);
  });

  it('derives release channels from validated SemVer and rejects contradictory input', () => {
    expect(resolveReleaseMetadata('v1.2.3')).toEqual({
      version: '1.2.3', tag: 'v1.2.3', channel: 'stable', prerelease: false,
    });
    expect(resolveReleaseMetadata('1.2.3-beta.2', 'beta')).toMatchObject({
      channel: 'beta', prerelease: true,
    });
    expect(resolveReleaseMetadata('1.2.3-nightly.20260907', 'nightly')).toMatchObject({
      channel: 'nightly', prerelease: true,
    });
    expect(() => resolveReleaseMetadata('latest', 'stable')).toThrow(/INVALID_RELEASE_VERSION/);
    expect(() => resolveReleaseMetadata('1.2.3-beta.1', 'stable'))
      .toThrow(/RELEASE_CHANNEL_MISMATCH/);
    for (const unsupported of [
      '1.2.3-alpha.1',
      '1.2.3-rc.1',
      '1.2.3-preview',
      '1.2.3-beta.nightly.1',
      '1.2.3-beta.rc.1',
      '1.2.3-beta.preview',
      '1.2.3-nightly.alpha.1',
    ]) {
      expect(() => resolveReleaseMetadata(unsupported)).toThrow(/INVALID_RELEASE_CHANNEL_SUFFIX/);
    }
  });

  it('rejects a manifest whose configured channel contradicts its version', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'druvia-release-'));
    const composePath = join(dir, 'docker-compose.release.yml');
    await writeFile(composePath, 'services:\n  api:\n    image: test\n', 'utf8');

    await expect(buildReleaseManifest({
      GITHUB_REF_NAME: 'v1.2.3-beta.1',
      GITHUB_REPOSITORY: 'druvia/druvia',
      DRUVIA_RELEASE_CHANNEL: 'stable',
    }, { composePath })).rejects.toThrow(/RELEASE_CHANNEL_MISMATCH/);
  });

  it('rejects release manifests that can skip migration 024 or its backup', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'druvia-release-'));
    const composePath = join(dir, 'docker-compose.release.yml');
    await writeFile(composePath, 'services:\n  api:\n    image: test\n', 'utf8');
    const baseEnv = {
      GITHUB_REF_NAME: 'v0.3.0',
      GITHUB_REPOSITORY: 'druvia/druvia',
      DRUVIA_API_IMAGE_REPOSITORY: 'ghcr.io/druvia/druvia-api',
      DRUVIA_ADMIN_IMAGE_REPOSITORY: 'ghcr.io/druvia/druvia-admin',
      DRUVIA_WORKER_IMAGE_REPOSITORY: 'ghcr.io/druvia/druvia-worker',
      DRUVIA_UPDATER_IMAGE_REPOSITORY: 'ghcr.io/druvia/druvia-updater',
      DRUVIA_API_IMAGE_DIGEST: digest('a'),
      DRUVIA_ADMIN_IMAGE_DIGEST: digest('b'),
      DRUVIA_WORKER_IMAGE_DIGEST: digest('c'),
      DRUVIA_UPDATER_IMAGE_DIGEST: digest('d'),
      DRUVIA_MIGRATION_REQUIRED: 'true',
      DRUVIA_MIGRATION_FROM: '18',
      DRUVIA_MIGRATION_TO: '24',
      DRUVIA_MIGRATION_REQUIRES_BACKUP: 'true',
    };

    await expect(buildReleaseManifest({
      ...baseEnv, DRUVIA_MIGRATION_REQUIRED: 'false',
    }, { composePath })).rejects.toThrow(/UNSAFE_MIGRATION_CONTRACT/);
    await expect(buildReleaseManifest({
      ...baseEnv, DRUVIA_MIGRATION_TO: '21',
    }, { composePath })).rejects.toThrow(/UNSAFE_MIGRATION_CONTRACT/);
    await expect(buildReleaseManifest({
      ...baseEnv, DRUVIA_MIGRATION_REQUIRES_BACKUP: 'false',
    }, { composePath })).rejects.toThrow(/UNSAFE_MIGRATION_CONTRACT/);
    await expect(buildReleaseManifest({
      ...baseEnv, DRUVIA_MIGRATION_REVERSIBLE: 'true',
    }, { composePath })).rejects.toThrow(/UNSAFE_MIGRATION_CONTRACT/);
  });
});

describe('release workflow', () => {
  it('gates image publication on Realtime tests, SDK build and rendered Compose contracts', () => {
    const workflow = readFileSync('.github/workflows/release.yml', 'utf8');
    const setupPnpm = workflow.indexOf('name: Setup pnpm');
    const setupNode = workflow.indexOf('name: Setup Node.js');
    const install = workflow.indexOf('pnpm install --frozen-lockfile');
    const realtimeTests = workflow.indexOf('name: Verify Realtime behavior');
    const sdkBuild = workflow.indexOf('pnpm --filter @druvia/sdk build');
    const composeGate = workflow.indexOf('node scripts/release/verify-realtime-compose.mjs');
    const firstImageBuild = workflow.indexOf('uses: docker/build-push-action');

    expect(setupPnpm).toBeGreaterThan(0);
    expect(setupNode).toBeGreaterThan(setupPnpm);
    expect(install).toBeGreaterThan(setupNode);
    expect(realtimeTests).toBeGreaterThan(install);
    expect(sdkBuild).toBeGreaterThan(realtimeTests);
    expect(composeGate).toBeGreaterThan(sdkBuild);
    expect(firstImageBuild).toBeGreaterThan(composeGate);
    expect(workflow).toContain('tests/unit/realtime-token-service.test.ts');
    expect(workflow).toContain('tests/sdk/realtime.test.ts');
    expect(workflow).toContain('tests/unit/admin/realtime-page.test.tsx');
    expect(workflow).toContain('tests/unit/realtime-compose-config.test.ts');
  });

  it('validates release metadata before registry login and image publication', () => {
    const workflow = readFileSync('.github/workflows/release.yml', 'utf8');
    const preflight = workflow.indexOf('node scripts/release/prepare-release.mjs');
    const firstLogin = workflow.indexOf('uses: docker/login-action');
    const firstImageBuild = workflow.indexOf('uses: docker/build-push-action');

    expect(preflight).toBeGreaterThan(0);
    expect(firstLogin).toBeGreaterThan(preflight);
    expect(firstImageBuild).toBeGreaterThan(firstLogin);
  });

  it('gates image publication on both managed and legacy data access classifiers', () => {
    const workflow = readFileSync('.github/workflows/release.yml', 'utf8');

    for (const requiredTest of [
      'tests/unit/data-access-inspection.test.ts',
      'tests/unit/data-access-migration-inspection.test.ts',
      'tests/unit/data-access-managed-policy.test.ts',
      'tests/unit/data-access-managed-policy-schema.test.ts',
      'tests/unit/data-access-managed-policy-repository.test.ts',
      'tests/unit/data-access-policy-operation-service.test.ts',
      'tests/unit/table-deletion-outbox-schema.test.ts',
      'tests/unit/table-deletion-recovery.test.ts',
      'tests/unit/admin/table-data-access-panel.test.tsx',
    ]) {
      expect(workflow).toContain(requiredTest);
    }
  });

  it('requires the real PostgreSQL and Hasura managed-policy integration before release', () => {
    const workflow = readFileSync('.github/workflows/release.yml', 'utf8');

    expect(workflow).toContain('data-access-integration:');
    expect(workflow).toContain('image: postgres:17-alpine');
    expect(workflow).toContain('image: hasura/graphql-engine:v2.48.0');
    expect(workflow).toContain('tests/integration/data-access-generated-columns.test.ts');
    expect(workflow).toContain('DRUVIA_INTEGRATION_HASURA_ADMIN_SECRET: integration-hasura-secret');
    expect(workflow).toContain('needs: data-access-integration');
  });

  it('gates image publication on the Project Actor, Functions Worker, rollback, and SDK cutover', () => {
    const workflow = readFileSync('.github/workflows/release.yml', 'utf8');
    const actorGate = workflow.indexOf('name: Verify Project Actor RPC and Functions cutover');
    const denoGate = workflow.indexOf('name: Verify Deno Worker types');
    const firstImageBuild = workflow.indexOf('uses: docker/build-push-action');

    expect(actorGate).toBeGreaterThan(0);
    expect(denoGate).toBeGreaterThan(actorGate);
    expect(firstImageBuild).toBeGreaterThan(denoGate);
    for (const requiredTest of [
      'tests/unit/project-actor.test.ts',
      'tests/unit/api-keys-service.test.ts',
      'tests/unit/rpc-controller.test.ts',
      'tests/unit/rpc.test.ts',
      'tests/unit/functions-controller.test.ts',
      'tests/unit/functions-service.test.ts',
      'tests/unit/functions-internal-token.test.ts',
      'tests/unit/functions-internal-graphql.test.ts',
      'tests/unit/functions-internal-storage.test.ts',
      'tests/unit/deno-worker-auth.test.ts',
      'tests/unit/deno-worker-runtime.test.ts',
      'tests/unit/worker-compose-config.test.ts',
      'tests/unit/update-compose-command.test.ts',
      'tests/unit/updater-service.test.ts',
      'tests/sdk/client.test.ts',
      'tests/sdk/functions.test.ts',
    ]) {
      expect(workflow).toContain(requiredTest);
    }
    expect(workflow).toContain('denoland/deno:alpine-2.0.6');
    expect(workflow).toContain('deno check main.ts executor.ts');
  });

  it('builds release images for GHCR and the self-hosted registry with separate OTA manifests', () => {
    const workflow = readFileSync('.github/workflows/release.yml', 'utf8');

    expect(workflow).toContain("tags:\n      - 'v*'");
    expect(workflow).toContain('workflow_dispatch:');
    expect(workflow).toContain('GHCR_REGISTRY: ghcr.io');
    expect(workflow).toContain("SELF_HOSTED_REGISTRY: ${{ vars.DRUVIA_REGISTRY_HOST || 'druvia.forestpartner.com' }}");
    expect(workflow).toContain('GHCR_API_IMAGE: ghcr.io/${{ github.repository_owner }}/druvia-api');
    expect(workflow).toContain('SELF_HOSTED_API_IMAGE: ${{ vars.DRUVIA_REGISTRY_HOST || \'druvia.forestpartner.com\' }}/druvia/druvia-api');
    expect(workflow).toContain('secrets.DRUVIA_REGISTRY_USERNAME');
    expect(workflow).toContain('secrets.DRUVIA_REGISTRY_PASSWORD');
    expect(workflow).toContain('context: docker/deno-worker');
    expect(workflow).toContain('file: docker/Dockerfile.worker');
    expect(workflow).toContain('${{ env.GHCR_API_IMAGE }}:${{ env.RELEASE_VERSION }}');
    expect(workflow).toContain('${{ env.SELF_HOSTED_API_IMAGE }}:${{ env.RELEASE_VERSION }}');
    expect(workflow).toContain('${{ env.GHCR_ADMIN_IMAGE }}:${{ env.RELEASE_VERSION }}');
    expect(workflow).toContain('${{ env.SELF_HOSTED_ADMIN_IMAGE }}:${{ env.RELEASE_VERSION }}');
    expect(workflow).toContain('${{ env.GHCR_WORKER_IMAGE }}:${{ env.RELEASE_VERSION }}');
    expect(workflow).toContain('${{ env.SELF_HOSTED_WORKER_IMAGE }}:${{ env.RELEASE_VERSION }}');
    expect(workflow).toContain('${{ env.GHCR_UPDATER_IMAGE }}:${{ env.RELEASE_VERSION }}');
    expect(workflow).toContain('${{ env.SELF_HOSTED_UPDATER_IMAGE }}:${{ env.RELEASE_VERSION }}');
    expect(workflow).toContain('docker buildx imagetools inspect "${image}:${RELEASE_VERSION}"');
    expect(workflow).toContain('steps.resolve-digests.outputs.ghcr_api');
    expect(workflow).toContain('steps.resolve-digests.outputs.self_hosted_api');
    expect(workflow).toContain('scripts/release/generate-manifest.mjs');
    expect(workflow).toContain('release-manifest.json');
    expect(workflow).toContain('release-manifest.cn.json');
    expect(workflow).toContain('docker/docker-compose.release.yml');
  });

  it('keeps beta and nightly tags out of the stable latest release channel', () => {
    const workflow = readFileSync('.github/workflows/release.yml', 'utf8');

    expect(workflow).toContain('RELEASE_INPUT_VERSION: ${{ inputs.version }}');
    expect(workflow).toContain('RELEASE_INPUT_CHANNEL: ${{ inputs.channel }}');
    expect(workflow).toContain('run: node scripts/release/prepare-release.mjs');
    expect(workflow.match(/DRUVIA_RELEASE_CHANNEL: \$\{\{ env\.RELEASE_CHANNEL \}\}/g)).toHaveLength(2);
    expect(workflow).toContain('prerelease: ${{ env.RELEASE_PRERELEASE }}');
  });

  it('marks migration 025 as the safe default for tag and manual releases', () => {
    const workflow = readFileSync('.github/workflows/release.yml', 'utf8');

    expect(workflow).not.toContain("\n      migration_required:");
    expect(workflow).toContain("migration_from:\n        description: Current migration floor\n        required: true\n        default: '18'");
    expect(workflow).not.toContain("\n      migration_to:");
    expect(workflow).not.toContain("\n      migration_requires_backup:");
    expect(workflow).not.toContain("\n      migration_reversible:");
    expect(workflow.match(/DRUVIA_MIGRATION_REQUIRED: 'true'/g)).toHaveLength(2);
    expect(workflow.match(/DRUVIA_MIGRATION_FROM: \$\{\{ inputs\.migration_from \|\| '18' \}\}/g)).toHaveLength(2);
    expect(workflow.match(/DRUVIA_MIGRATION_TO: '25'/g)).toHaveLength(2);
    expect(workflow.match(/DRUVIA_MIGRATION_REQUIRES_BACKUP: 'true'/g)).toHaveLength(2);
    expect(workflow.match(/DRUVIA_MIGRATION_REVERSIBLE: 'false'/g)).toHaveLength(2);
  });

  it('gates release images on account deletion and restore fence regressions', () => {
    const workflow = readFileSync('.github/workflows/release.yml', 'utf8');
    const gate = workflow.indexOf('name: Verify Apple Project Auth provider');
    const firstImageBuild = workflow.indexOf('uses: docker/build-push-action');

    expect(gate).toBeGreaterThan(0);
    expect(gate).toBeLessThan(firstImageBuild);
    for (const requiredTest of [
      'tests/unit/project-account-deletion-schema.test.ts',
      'tests/unit/project-account-deletion-service.test.ts',
      'tests/unit/project-account-deletion.controller.test.ts',
      'tests/unit/project-account-deletion-hook.test.ts',
      'tests/unit/project-account-deletion-executor.test.ts',
      'tests/unit/project-account-deletion-restore.test.ts',
      'tests/unit/project-session-state.test.ts',
      'tests/unit/backup-service.test.ts',
    ]) {
      expect(workflow).toContain(requiredTest);
    }
  });

  it('gates release images on project membership authorization', () => {
    const workflow = readFileSync('.github/workflows/release.yml', 'utf8');
    const gate = workflow.indexOf('name: Verify project membership authorization');
    const firstImageBuild = workflow.indexOf('uses: docker/build-push-action');

    expect(gate).toBeGreaterThan(0);
    expect(gate).toBeLessThan(firstImageBuild);
    expect(workflow).toContain('tests/unit/project-members-schema.test.ts');
    expect(workflow).toContain('tests/unit/project-authorization.test.ts');
    expect(workflow).toContain('tests/unit/project-service.test.ts');
    expect(workflow).toContain('tests/unit/project-members.service.test.ts');
    expect(workflow).toContain('tests/unit/project-members.controller.test.ts');
    expect(workflow).toContain('tests/unit/admin/project-access.test.ts');
    expect(workflow).toContain('tests/unit/admin/project-members-ui.test.ts');
    expect(workflow).toContain('tests/unit/admin/project-read-only-ui.test.ts');
    expect(workflow).toContain('tests/unit/admin/project-api-page.test.tsx');
    expect(workflow).toContain('tests/unit/admin/tenant-backups-page.test.tsx');
    expect(workflow).toContain('tests/unit/admin/sidebar-nav.test.ts');
    expect(workflow).toContain('tests/unit/backup-authorization.test.ts');
  });

  it('runs the Project Storage actor gate before release image builds', () => {
    const workflow = readFileSync('.github/workflows/release.yml', 'utf8');
    const gate = workflow.indexOf('- name: Verify Project Storage actor and object access');
    const build = workflow.indexOf('- name: Build SDK');

    expect(gate).toBeGreaterThan(-1);
    expect(gate).toBeLessThan(build);
    expect(workflow).toContain('tests/unit/storage-project-access-schema.test.ts');
    expect(workflow).toContain('tests/unit/migration-sql.test.ts');
    expect(workflow).toContain('tests/unit/migration-runner-lock.test.ts');
    expect(workflow).toContain('tests/unit/storage-list-access.test.ts');
    expect(workflow).toContain('tests/sdk/storage.test.ts');
    expect(workflow).toContain('tests/sdk/fetch-adapter.test.ts');
    expect(workflow).toContain('tests/unit/admin/storage-bucket-access.test.ts');
  });
});
