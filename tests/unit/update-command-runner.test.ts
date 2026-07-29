import { describe, expect, it } from 'vitest';
import { runCommand } from '../../apps/updater/src/command.js';

describe('updater command runner', () => {
  it('runs argv commands without a shell and captures stdout', async () => {
    const result = await runCommand(process.execPath, ['-e', 'process.stdout.write("ok")']);
    expect(result.stdout).toBe('ok');
    expect(result.stderr).toBe('');
  });

  it('rejects failed commands with stderr in the error message', async () => {
    await expect(runCommand(process.execPath, ['-e', 'process.stderr.write("bad"); process.exit(7)']))
      .rejects.toThrow(/bad/);
  });
});
