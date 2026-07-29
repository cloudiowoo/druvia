import { spawn } from 'node:child_process';

export interface CommandResult {
  stdout: string;
  stderr: string;
}

export interface CommandRunnerOptions {
  env?: NodeJS.ProcessEnv;
}

export type CommandRunner = (
  command: string,
  args: string[],
  options?: CommandRunnerOptions
) => Promise<CommandResult>;

export class CommandError extends Error {
  constructor(
    public readonly command: string,
    public readonly args: string[],
    public readonly exitCode: number | null,
    public readonly stdout: string,
    public readonly stderr: string
  ) {
    super(`${command} ${args.join(' ')} failed${exitCode === null ? '' : ` with exit code ${exitCode}`}: ${stderr || stdout}`);
    this.name = 'CommandError';
  }
}

export const runCommand: CommandRunner = (command, args, options = {}) => new Promise((resolve, reject) => {
  const child = spawn(command, args, {
    env: options.env ?? process.env,
    shell: false,
  });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];

  child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
  child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
  child.on('error', reject);
  child.on('close', (exitCode) => {
    const stdoutText = Buffer.concat(stdout).toString('utf8');
    const stderrText = Buffer.concat(stderr).toString('utf8');
    if (exitCode === 0) {
      resolve({ stdout: stdoutText, stderr: stderrText });
      return;
    }
    reject(new CommandError(command, args, exitCode, stdoutText, stderrText));
  });
});
