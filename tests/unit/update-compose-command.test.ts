import { describe, expect, it } from 'vitest';
import {
  buildComposeArgs,
  buildDockerImagePullArgs,
  buildUpdaterFinalizerRunArgs,
  parseCsvEnv,
  type ComposeOptions,
} from '../../apps/updater/src/compose.js';

const options: ComposeOptions = {
  projectDirectory: '/deploy',
  baseEnvFile: '/deploy/.env.prod',
  releaseEnvFile: '/deploy/.env.release',
  composeFile: '/deploy/docker-compose.release.yml',
  profiles: [],
  managedServices: ['api', 'admin', 'deno', 'hasura'],
};

describe('updater Docker command builders', () => {
  it('builds core-service compose apply commands without optional nginx by default', () => {
    expect(buildComposeArgs('up', options)).toEqual([
      'compose',
      '--project-directory',
      '/deploy',
      '--env-file',
      '/deploy/.env.prod',
      '--env-file',
      '/deploy/.env.release',
      '-f',
      '/deploy/docker-compose.release.yml',
      'up',
      '-d',
      '--remove-orphans',
      'api',
      'admin',
      'deno',
      'hasura',
    ]);
  });

  it('adds configured profiles and managed services for built-in nginx deployments', () => {
    expect(buildComposeArgs('rollbackUp', {
      ...options,
      profiles: ['with-nginx'],
      managedServices: ['api', 'admin', 'deno', 'hasura', 'nginx'],
    })).toContain('nginx');
    expect(buildComposeArgs('rollbackUp', {
      ...options,
      profiles: ['with-nginx'],
      managedServices: ['api', 'admin', 'deno', 'hasura', 'nginx'],
    })).toContain('--profile');
  });

  it('builds image pull argv without shell interpolation', () => {
    expect(buildDockerImagePullArgs('ghcr.io/druvia/druvia-api@sha256:abc')).toEqual([
      'image',
      'pull',
      'ghcr.io/druvia/druvia-api@sha256:abc',
    ]);
  });

  it('builds a detached finalizer container command for updater self replacement', () => {
    const args = buildUpdaterFinalizerRunArgs({
      compose: {
        ...options,
        profiles: ['with-local-nginx'],
      },
      delaySeconds: 2,
      finalizerImage: 'ghcr.io/druvia/druvia-updater@sha256:abc',
      finalizerName: 'druvia-updater-finalizer-op-apply',
      targetVersion: '0.2.0',
      updaterContainerName: 'druvia-updater',
    });

    expect(args.slice(0, 7)).toEqual([
      'run',
      '-d',
      '--rm',
      '--name',
      'druvia-updater-finalizer-op-apply',
      '--label',
      'com.druvia.role=updater-finalizer',
    ]);
    expect(args).toContain('--volumes-from');
    expect(args).toContain('druvia-updater:rw');
    expect(args).toContain('--env');
    expect(args).toContain('DRUVIA_FINALIZER_STATE_PATH=/state/update-state.json');
    expect(args).toContain('DRUVIA_FINALIZER_TARGET_VERSION=0.2.0');
    expect(args).toContain('DRUVIA_FINALIZER_UPDATER_CONTAINER_NAME=druvia-updater');
    expect(args).toContain('DRUVIA_FINALIZER_DELAY_SECONDS=2');
    expect(args).toContain('ghcr.io/druvia/druvia-updater@sha256:abc');
    expect(args).toContain('node');
    expect(args).toContain('/app/apps/updater/dist/finalizer.js');
    expect(args).toContain('--');
    expect(args.join(' ')).toContain('docker compose --project-directory /deploy');
    expect(args.join(' ')).toContain('--profile with-local-nginx');
    expect(args.join(' ')).toContain('up -d updater');
  });

  it('parses comma separated environment values', () => {
    expect(parseCsvEnv(' api, admin,,deno ')).toEqual(['api', 'admin', 'deno']);
    expect(parseCsvEnv(undefined)).toEqual([]);
  });
});
