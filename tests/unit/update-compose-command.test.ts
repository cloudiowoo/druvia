import { describe, expect, it } from 'vitest';
import {
  buildComposeArgs,
  buildDockerImagePullArgs,
  buildProjectionRollbackCheckSql,
  buildProjectionRollbackCheckArgs,
  buildProjectionRollbackGateArgs,
  buildProjectionRollbackGateSql,
  buildProjectionRollbackLockHolderArgs,
  buildProjectionRollbackLockReadyArgs,
  buildProjectionRollbackLockReleaseWaitArgs,
  buildProjectionRollbackLockReleaseWaitSql,
  buildRollbackStopArgs,
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
      '--no-deps',
      '--remove-orphans',
      'api',
      'admin',
      'deno',
      'hasura',
    ]);
  });

  it('does not reconcile PostgreSQL dependencies during managed-service updates', () => {
    for (const action of ['migrate', 'up', 'rollbackUp'] as const) {
      const args = buildComposeArgs(action, options);

      expect(args).toContain('--no-deps');
      expect(args).not.toContain('postgres');
    }
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

  it('builds a dedicated Worker-first rollback command without dependency replacement', () => {
    expect(buildComposeArgs('rollbackWorker', options)).toEqual([
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
      '--no-deps',
      'deno',
    ]);
  });

  it('checks active v2 projection state before a migration 027 rollback', () => {
    const args = buildProjectionRollbackCheckArgs(options, {
      user: 'druvia_owner',
      database: 'druvia_platform',
    });

    expect(args).toContain('exec');
    expect(args).toContain('druvia-postgres');
    expect(args).not.toContain('compose');
    expect(args).toContain('psql');
    expect(args).toContain('druvia_owner');
    expect(args).toContain('druvia_platform');
    expect(args.join(' ')).toContain('policy_version = 2');
    expect(args.join(' ')).toContain("to_jsonb(managed_policy)->>'dependency_snapshot' IS NOT NULL");
    expect(args.join(' ')).not.toContain("status IN");
    expect(args.join(' ')).toContain('prevents file-only rollback');
    expect(args.join(' ')).toContain('pg_advisory_xact_lock');
    expect(args.join(' ')).toContain("gate_name = 'file_rollback'");
  });

  it('stops release containers without parsing the active Compose file', () => {
    expect(buildRollbackStopArgs()).toEqual([
      'stop', '--time', '10', 'druvia-api', 'druvia-admin', 'druvia-deno',
    ]);
  });

  it('builds persistent rollback gate enable and disable commands', () => {
    const database = { user: 'druvia_owner', database: 'druvia_platform' };
    const enable = buildProjectionRollbackGateArgs(options, database, 'enable');
    const disable = buildProjectionRollbackGateArgs(options, database, 'disable');

    expect(enable.join(' ')).toContain('druvia_data_access_runtime_gates');
    expect(enable.join(' ')).toContain('TRUE');
    expect(disable.join(' ')).toContain('druvia_data_access_runtime_gates');
    expect(disable.join(' ')).toContain('FALSE');
    expect(buildProjectionRollbackGateSql('enable', 'rollback_gate_test'))
      .toContain("to_regclass('rollback_gate_test.druvia_data_access_runtime_gates')")
    expect(buildProjectionRollbackGateSql('disable', 'rollback_gate_test', true))
      .toContain('druvia-holder:rollback_gate_test');
    expect(() => buildProjectionRollbackGateSql('enable', 'invalid-schema')).toThrow(/schema/i);
  });

  it('builds a detached rollback lock holder and readiness/release probes', () => {
    const database = { user: 'druvia_owner', database: 'druvia_platform' };
    const holder = buildProjectionRollbackLockHolderArgs(options, database);
    const ready = buildProjectionRollbackLockReadyArgs(options, database);
    const released = buildProjectionRollbackLockReleaseWaitArgs(options, database);

    expect(holder).toContain('-d');
    expect(holder.join(' ')).toContain(
      "pg_advisory_lock(hashtextextended('data-access-mutation:global', 0))"
    );
    expect(holder.join(' ')).toContain("gate_name = 'file_rollback' AND active");
    expect(ready.join(' ')).toContain('pg_try_advisory_lock_shared');
    expect(released.join(' ')).toContain('pg_advisory_lock_shared');
  });

  it('retires a stale holder while keeping an active gate in place', () => {
    const sql = buildProjectionRollbackLockReleaseWaitSql('rollback_gate_test', false, true);
    expect(sql).not.toContain('file rollback gate is still active');
    expect(sql).toContain('pg_terminate_backend');
  });

  it('builds a pre-027 compatible rollback query for an isolated schema', () => {
    const sql = buildProjectionRollbackCheckSql('rollback_gate_test');

    expect(sql).toContain("to_regclass('rollback_gate_test.druvia_data_access_managed_policies')");
    expect(sql).toContain('FROM "rollback_gate_test".druvia_data_access_managed_policies AS managed_policy');
    expect(sql).not.toMatch(/\bdependency_(?:snapshot|digest) IS NOT NULL/);
    expect(() => buildProjectionRollbackCheckSql('invalid-schema')).toThrow(/schema/i);
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
