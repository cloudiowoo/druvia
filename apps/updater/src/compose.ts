export type ComposeAction =
  | 'migrate'
  | 'up'
  | 'restart'
  | 'rollbackWorker'
  | 'rollbackUp'
  | 'selfUpdate';

export interface ComposeOptions {
  projectDirectory: string;
  baseEnvFile: string;
  releaseEnvFile: string;
  composeFile: string;
  profiles: string[];
  managedServices: string[];
}

export interface UpdaterFinalizerOptions {
  compose: ComposeOptions;
  delaySeconds: number;
  finalizerImage: string;
  finalizerName: string;
  targetVersion: string;
  updaterContainerName: string;
}

export interface ProjectionRollbackDatabase {
  user: string;
  database: string;
}

export type ProjectionRollbackGateAction = 'enable' | 'disable';

export function parseCsvEnv(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function buildComposeBaseArgs(options: ComposeOptions): string[] {
  return [
    'compose',
    '--project-directory',
    options.projectDirectory,
    '--env-file',
    options.baseEnvFile,
    '--env-file',
    options.releaseEnvFile,
    '-f',
    options.composeFile,
    ...options.profiles.flatMap((profile) => ['--profile', profile]),
  ];
}

export function buildComposeArgs(action: ComposeAction, options: ComposeOptions): string[] {
  const base = buildComposeBaseArgs(options);
  const services = options.managedServices.length > 0
    ? options.managedServices
    : ['api', 'admin', 'deno', 'hasura'];

  if (action === 'migrate') {
    return [...base, 'run', '--rm', '--no-deps', 'api', 'node', 'apps/api/dist/cli/migrate.js', 'up'];
  }
  if (action === 'up') {
    return [...base, 'up', '-d', '--no-deps', '--remove-orphans', ...services];
  }
  if (action === 'rollbackWorker') {
    return [...base, 'up', '-d', '--no-deps', 'deno'];
  }
  if (action === 'rollbackUp') {
    return [...base, 'up', '-d', '--no-deps', '--remove-orphans', ...services];
  }
  if (action === 'restart') {
    return [...base, 'restart', 'api', 'admin', 'deno'];
  }
  if (action === 'selfUpdate') {
    return [...base, 'up', '-d', 'updater'];
  }

  throw new Error(`Unsupported compose action: ${String(action)}`);
}

export function buildRollbackStopArgs(): string[] {
  return ['stop', '--time', '10', 'druvia-api', 'druvia-admin', 'druvia-deno'];
}

export function buildProjectionRollbackCheckArgs(
  options: ComposeOptions,
  database: ProjectionRollbackDatabase
): string[] {
  return buildProjectionRollbackDatabaseArgs(
    options,
    database,
    buildProjectionRollbackCheckSql()
  );
}

export function buildProjectionRollbackGateArgs(
  options: ComposeOptions,
  database: ProjectionRollbackDatabase,
  action: ProjectionRollbackGateAction,
  requireHolder = false
): string[] {
  return buildProjectionRollbackDatabaseArgs(
    options,
    database,
    buildProjectionRollbackGateSql(action, 'public', requireHolder)
  );
}

export function buildProjectionRollbackLockHolderArgs(
  options: ComposeOptions,
  database: ProjectionRollbackDatabase
): string[] {
  return buildProjectionRollbackDatabaseArgs(
    options,
    database,
    buildProjectionRollbackLockHolderSql(),
    true
  );
}

export function buildProjectionRollbackLockReadyArgs(
  options: ComposeOptions,
  database: ProjectionRollbackDatabase
): string[] {
  return buildProjectionRollbackDatabaseArgs(
    options,
    database,
    buildProjectionRollbackLockReadySql()
  );
}

export function buildProjectionRollbackLockReleaseWaitArgs(
  options: ComposeOptions,
  database: ProjectionRollbackDatabase,
  requireHolder = false
): string[] {
  return buildProjectionRollbackDatabaseArgs(
    options,
    database,
    buildProjectionRollbackLockReleaseWaitSql('public', requireHolder)
  );
}

export function buildProjectionRollbackStaleHolderReleaseArgs(
  options: ComposeOptions,
  database: ProjectionRollbackDatabase
): string[] {
  return buildProjectionRollbackDatabaseArgs(
    options,
    database,
    buildProjectionRollbackLockReleaseWaitSql('public', false, true)
  );
}

function buildProjectionRollbackDatabaseArgs(
  _options: ComposeOptions,
  database: ProjectionRollbackDatabase,
  sql: string,
  detached = false
): string[] {
  return [
    'exec',
    ...(detached ? ['-d'] : []),
    'druvia-postgres',
    'psql',
    '-X',
    '-U',
    database.user,
    '-d',
    database.database,
    '-v',
    'ON_ERROR_STOP=1',
    '-c',
    sql,
  ];
}

export function buildProjectionRollbackGateSql(
  action: ProjectionRollbackGateAction,
  schemaName = 'public',
  requireHolder = false
): string {
  assertRollbackGateSchemaName(schemaName);
  const schema = `"${schemaName}"`;
  if (action === 'enable') {
    return `DO $rollback_gate$
     BEGIN
       IF to_regclass('${schemaName}.druvia_data_access_runtime_gates') IS NOT NULL THEN
         INSERT INTO ${schema}.druvia_data_access_runtime_gates (gate_name, active, updated_at)
         VALUES ('file_rollback', TRUE, NOW())
         ON CONFLICT (gate_name) DO UPDATE
         SET active = TRUE, updated_at = EXCLUDED.updated_at;
       END IF;
     END
     $rollback_gate$;`;
  }
  return `DO $rollback_gate$
     BEGIN
       ${requireHolder ? `IF NOT ${namedRollbackHolderExistsSql(schemaName)} THEN
         RAISE EXCEPTION 'file rollback lock holder is not ready';
       END IF;` : ''}
       IF to_regclass('${schemaName}.druvia_data_access_runtime_gates') IS NOT NULL THEN
         UPDATE ${schema}.druvia_data_access_runtime_gates
         SET active = FALSE, updated_at = NOW()
         WHERE gate_name = 'file_rollback';
       END IF;
     END
     $rollback_gate$;`;
}

export function buildProjectionRollbackCheckSql(schemaName = 'public'): string {
  assertRollbackGateSchemaName(schemaName);
  const schema = `"${schemaName}"`;
  return `DO $rollback$
     DECLARE active_v2 boolean := false;
     DECLARE rollback_gate_active boolean := false;
     BEGIN
       PERFORM pg_advisory_xact_lock(hashtextextended('data-access-mutation:global', 0));
       IF to_regclass('${schemaName}.druvia_data_access_runtime_gates') IS NOT NULL THEN
         EXECUTE $query$SELECT EXISTS (
           SELECT 1 FROM ${schema}.druvia_data_access_runtime_gates
           WHERE gate_name = 'file_rollback' AND active
         )$query$ INTO rollback_gate_active;
         IF NOT rollback_gate_active THEN
           RAISE EXCEPTION 'file rollback gate is not active';
         END IF;
       END IF;
       IF to_regclass('${schemaName}.druvia_data_access_managed_policies') IS NOT NULL THEN
         EXECUTE $query$SELECT EXISTS (
           SELECT 1 FROM ${schema}.druvia_data_access_managed_policies AS managed_policy
           WHERE policy_version = 2
              OR to_jsonb(managed_policy)->>'dependency_snapshot' IS NOT NULL
              OR to_jsonb(managed_policy)->>'dependency_digest' IS NOT NULL
         )$query$ INTO active_v2;
       END IF;
       IF NOT active_v2
          AND to_regclass('${schemaName}.druvia_data_access_projection_operations') IS NOT NULL THEN
         EXECUTE $query$SELECT EXISTS (
           SELECT 1 FROM ${schema}.druvia_data_access_projection_operations
         )$query$ INTO active_v2;
       END IF;
       IF active_v2 THEN
         RAISE EXCEPTION 'active Data Access v2 projection state prevents file-only rollback';
       END IF;
     END
     $rollback$;`;
}

export function buildProjectionRollbackLockHolderSql(schemaName = 'public'): string {
  assertRollbackGateSchemaName(schemaName);
  const schema = `"${schemaName}"`;
  return `SELECT set_config('application_name', 'druvia-holder:${schemaName}', false);
SELECT pg_advisory_lock(hashtextextended('data-access-mutation:global', 0));
DO $rollback_lock$
BEGIN
  IF to_regclass('${schemaName}.druvia_data_access_runtime_gates') IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1 FROM ${schema}.druvia_data_access_runtime_gates
      WHERE gate_name = 'file_rollback' AND active
    ) THEN
      RAISE EXCEPTION 'file rollback gate is not active';
    END IF;
    LOOP
      EXIT WHEN NOT EXISTS (
        SELECT 1 FROM ${schema}.druvia_data_access_runtime_gates
        WHERE gate_name = 'file_rollback' AND active
      );
      PERFORM pg_sleep(0.1);
    END LOOP;
  ELSE
    LOOP
      PERFORM pg_sleep(0.1);
    END LOOP;
  END IF;
END
$rollback_lock$;
SELECT pg_advisory_unlock(hashtextextended('data-access-mutation:global', 0));`;
}

export function buildProjectionRollbackLockReadySql(schemaName = 'public'): string {
  assertRollbackGateSchemaName(schemaName);
  const schema = `"${schemaName}"`;
  return `DO $rollback_lock_ready$
DECLARE lock_acquired boolean := false;
BEGIN
  IF NOT ${namedRollbackHolderExistsSql(schemaName)} THEN
    RAISE EXCEPTION 'file rollback lock holder is not ready';
  END IF;
  IF to_regclass('${schemaName}.druvia_data_access_runtime_gates') IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1 FROM ${schema}.druvia_data_access_runtime_gates
      WHERE gate_name = 'file_rollback' AND active
    ) THEN
      RAISE EXCEPTION 'file rollback gate is not active';
    END IF;
  END IF;
  SELECT pg_try_advisory_lock_shared(
    hashtextextended('data-access-mutation:global', 0)
  ) INTO lock_acquired;
  IF lock_acquired THEN
    PERFORM pg_advisory_unlock_shared(
      hashtextextended('data-access-mutation:global', 0)
    );
    RAISE EXCEPTION 'file rollback lock holder is not ready';
  END IF;
END
$rollback_lock_ready$;`;
}

export function buildProjectionRollbackLockReleaseWaitSql(
  schemaName = 'public', requireHolder = false, allowActiveGate = false
): string {
  assertRollbackGateSchemaName(schemaName);
  return `SET lock_timeout = '10s';
DO $rollback_lock_release$
DECLARE holder_pid integer;
BEGIN
  ${allowActiveGate ? '' : `IF to_regclass('${schemaName}.druvia_data_access_runtime_gates') IS NOT NULL THEN
    IF EXISTS (
      SELECT 1 FROM "${schemaName}".druvia_data_access_runtime_gates
      WHERE gate_name = 'file_rollback' AND active
    ) THEN
      RAISE EXCEPTION 'file rollback gate is still active';
    END IF;
  END IF;`}
  SELECT activity.pid INTO holder_pid FROM pg_stat_activity AS activity
    JOIN pg_locks AS held ON held.pid = activity.pid
    WHERE activity.application_name = 'druvia-holder:${schemaName}'
      AND held.locktype = 'advisory' AND held.mode = 'ExclusiveLock' AND held.granted
      AND held.classid = ((hashtextextended('data-access-mutation:global', 0) >> 32) & 4294967295)::oid
      AND held.objid = (hashtextextended('data-access-mutation:global', 0) & 4294967295)::oid;
  ${requireHolder ? `IF holder_pid IS NULL
    AND to_regclass('${schemaName}.druvia_data_access_runtime_gates') IS NULL THEN
      RAISE EXCEPTION 'file rollback lock holder is not ready';
    END IF;` : ''}
  IF holder_pid IS NOT NULL AND NOT pg_terminate_backend(holder_pid, 5000) THEN
    RAISE EXCEPTION 'file rollback lock holder could not be stopped';
  END IF;
  PERFORM pg_advisory_lock_shared(hashtextextended('data-access-mutation:global', 0));
  PERFORM pg_advisory_unlock_shared(hashtextextended('data-access-mutation:global', 0));
  IF ${namedRollbackHolderExistsSql(schemaName)} THEN
    RAISE EXCEPTION 'file rollback lock holder has not exited';
  END IF;
END
$rollback_lock_release$;`;
}

function namedRollbackHolderExistsSql(schemaName: string): string {
  return `EXISTS (
    SELECT 1 FROM pg_stat_activity AS activity
    JOIN pg_locks AS held ON held.pid = activity.pid
    WHERE activity.application_name = 'druvia-holder:${schemaName}'
      AND held.locktype = 'advisory' AND held.mode = 'ExclusiveLock' AND held.granted
      AND held.classid = ((hashtextextended('data-access-mutation:global', 0) >> 32) & 4294967295)::oid
      AND held.objid = (hashtextextended('data-access-mutation:global', 0) & 4294967295)::oid
  )`;
}

function assertRollbackGateSchemaName(schemaName: string): void {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(schemaName)) {
    throw new Error('Invalid rollback gate schema name');
  }
}

export function buildDockerImagePullArgs(imageRef: string): string[] {
  return ['image', 'pull', imageRef];
}

export function buildUpdaterFinalizerRunArgs(options: UpdaterFinalizerOptions): string[] {
  return [
    'run',
    '-d',
    '--rm',
    '--name',
    options.finalizerName,
    '--label',
    'com.druvia.role=updater-finalizer',
    '--volumes-from',
    `${options.updaterContainerName}:rw`,
    '-w',
    options.compose.projectDirectory,
    '--env',
    'DRUVIA_FINALIZER_STATE_PATH=/state/update-state.json',
    '--env',
    `DRUVIA_FINALIZER_TARGET_VERSION=${options.targetVersion}`,
    '--env',
    `DRUVIA_FINALIZER_UPDATER_CONTAINER_NAME=${options.updaterContainerName}`,
    '--env',
    `DRUVIA_FINALIZER_DELAY_SECONDS=${options.delaySeconds}`,
    options.finalizerImage,
    'node',
    '/app/apps/updater/dist/finalizer.js',
    '--',
    'docker',
    ...buildComposeArgs('selfUpdate', options.compose),
  ];
}
