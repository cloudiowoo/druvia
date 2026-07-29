import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { buildPgDumpCommand } from '../../apps/updater/src/postgres-backup.js';

describe('updater postgres backup command', () => {
  it('builds a direct full database pg_dump command with password env', () => {
    const command = buildPgDumpCommand(
      {
        host: 'postgres',
        port: 5432,
        user: 'postgres',
        password: 'secret',
        database: 'druvia',
      },
      '/state/backups/op_123/postgres.dump'
    );

    expect(command).toEqual({
      command: 'pg_dump',
      args: [
        '-h', 'postgres',
        '-p', '5432',
        '-U', 'postgres',
        '-d', 'druvia',
        '-F', 'c',
        '--no-owner',
        '--no-acl',
        '-f', '/state/backups/op_123/postgres.dump',
      ],
      env: expect.objectContaining({
        PGPASSWORD: 'secret',
      }),
    });
  });

  it('hashes database dump files as a stream instead of reading the whole dump into memory', () => {
    const source = readFileSync('apps/updater/src/update-service.ts', 'utf8');

    expect(source).toContain('createReadStream');
    expect(source).not.toContain('fs.readFile(dumpPath)');
  });
});
