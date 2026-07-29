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

export function buildPgDumpCommand(
  database: DatabaseConnectionConfig,
  outputPath: string
): CommandSpec {
  return {
    command: 'pg_dump',
    args: [
      '-h', database.host,
      '-p', String(database.port),
      '-U', database.user,
      '-d', database.database,
      '-F', 'c',
      '--no-owner',
      '--no-acl',
      '-f', outputPath,
    ],
    env: {
      ...process.env,
      PGPASSWORD: database.password,
    },
  };
}
