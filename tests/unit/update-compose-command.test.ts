import { describe, expect, it } from 'vitest';
import {
  buildComposeArgs,
  buildDockerImagePullArgs,
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

  it('parses comma separated environment values', () => {
    expect(parseCsvEnv(' api, admin,,deno ')).toEqual(['api', 'admin', 'deno']);
    expect(parseCsvEnv(undefined)).toEqual([]);
  });
});
