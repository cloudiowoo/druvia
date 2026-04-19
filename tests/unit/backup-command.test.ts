import { describe, expect, it, vi } from 'vitest';
import {
  buildDirectPgDumpCommand,
  buildDirectPgRestoreCommand,
  runWithEnoentFallback,
} from '../../apps/api/src/modules/backup/backup-command.js';

describe('backup command helpers', () => {
  it('builds direct pg_dump command with database connection args and password env', () => {
    const command = buildDirectPgDumpCommand(
      {
        host: 'postgres',
        port: 5432,
        user: 'postgres',
        password: 'secret',
        database: 'druvia',
      },
      'dru_default_taroapp'
    );

    expect(command).toEqual({
      command: 'pg_dump',
      args: [
        '-h', 'postgres',
        '-p', '5432',
        '-U', 'postgres',
        '-d', 'druvia',
        '-n', 'dru_default_taroapp',
        '-F', 'c',
        '--no-owner',
        '--no-acl',
      ],
      env: expect.objectContaining({
        PGPASSWORD: 'secret',
      }),
    });
  });

  it('builds direct pg_restore command with database connection args and password env', () => {
    const command = buildDirectPgRestoreCommand(
      {
        host: 'postgres',
        port: 5432,
        user: 'postgres',
        password: 'secret',
        database: 'druvia',
      },
      'dru_default_taroapp'
    );

    expect(command).toEqual({
      command: 'pg_restore',
      args: [
        '-h', 'postgres',
        '-p', '5432',
        '-U', 'postgres',
        '-d', 'druvia',
        '-n', 'dru_default_taroapp',
        '--no-owner',
        '--no-acl',
        '--clean',
        '--if-exists',
      ],
      env: expect.objectContaining({
        PGPASSWORD: 'secret',
      }),
    });
  });

  it('falls back only when the primary command is missing', async () => {
    const fallback = vi.fn(async () => Buffer.from('dump'));

    const result = await runWithEnoentFallback(
      async () => {
        const error = Object.assign(new Error('spawn pg_dump ENOENT'), { code: 'ENOENT' });
        throw error;
      },
      fallback
    );

    expect(result.equals(Buffer.from('dump'))).toBe(true);
    expect(fallback).toHaveBeenCalledTimes(1);
  });

  it('does not hide non-ENOENT errors behind the fallback', async () => {
    const fallback = vi.fn(async () => Buffer.from('dump'));

    await expect(
      runWithEnoentFallback(
        async () => {
          throw new Error('connection refused');
        },
        fallback
      )
    ).rejects.toThrow('connection refused');

    expect(fallback).not.toHaveBeenCalled();
  });
});
