export interface DatabaseConnectionConfig {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
}

export interface CommandSpec {
  command: string;
  args: string[];
  env?: NodeJS.ProcessEnv;
}

function buildPgEnv(password: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    PGPASSWORD: password,
  };
}

export function buildDirectPgDumpCommand(
  database: DatabaseConnectionConfig,
  schemaName: string
): CommandSpec {
  return {
    command: 'pg_dump',
    args: [
      '-h', database.host,
      '-p', String(database.port),
      '-U', database.user,
      '-d', database.database,
      '-n', schemaName,
      '-F', 'c',
      '--no-owner',
      '--no-acl',
    ],
    env: buildPgEnv(database.password),
  };
}

export function buildDirectPgRestoreCommand(
  database: DatabaseConnectionConfig,
  schemaName: string
): CommandSpec {
  return {
    command: 'pg_restore',
    args: [
      '-h', database.host,
      '-p', String(database.port),
      '-U', database.user,
      '-d', database.database,
      '-n', schemaName,
      '--no-owner',
      '--no-acl',
      '--clean',
      '--if-exists',
    ],
    env: buildPgEnv(database.password),
  };
}

export function buildDockerPgDumpCommand(
  containerName: string,
  database: DatabaseConnectionConfig,
  schemaName: string
): CommandSpec {
  return {
    command: 'docker',
    args: [
      'exec',
      containerName,
      'pg_dump',
      '-U', database.user,
      '-d', database.database,
      '-n', schemaName,
      '-F', 'c',
      '--no-owner',
      '--no-acl',
    ],
  };
}

export function buildDockerPgRestoreCommand(
  containerName: string,
  database: DatabaseConnectionConfig,
  schemaName: string
): CommandSpec {
  return {
    command: 'docker',
    args: [
      'exec',
      '-i',
      containerName,
      'pg_restore',
      '-U', database.user,
      '-d', database.database,
      '-n', schemaName,
      '--no-owner',
      '--no-acl',
      '--clean',
      '--if-exists',
    ],
  };
}

export async function runWithEnoentFallback<T>(
  primary: () => Promise<T>,
  fallback: () => Promise<T>
): Promise<T> {
  try {
    return await primary();
  } catch (error) {
    if (typeof error === 'object' && error && 'code' in error && error.code === 'ENOENT') {
      return fallback();
    }

    throw error;
  }
}
