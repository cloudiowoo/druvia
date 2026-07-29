export type ComposeAction = 'migrate' | 'up' | 'restart' | 'rollbackUp' | 'selfUpdate';

export interface ComposeOptions {
  projectDirectory: string;
  baseEnvFile: string;
  releaseEnvFile: string;
  composeFile: string;
  profiles: string[];
  managedServices: string[];
}

export function parseCsvEnv(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

export function buildComposeArgs(action: ComposeAction, options: ComposeOptions): string[] {
  const base = [
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
  const services = options.managedServices.length > 0
    ? options.managedServices
    : ['api', 'admin', 'deno', 'hasura'];

  if (action === 'migrate') {
    return [...base, 'run', '--rm', 'api', 'node', 'apps/api/dist/cli/migrate.js', 'up'];
  }
  if (action === 'up') {
    return [...base, 'up', '-d', '--remove-orphans', ...services];
  }
  if (action === 'rollbackUp') {
    return [...base, 'up', '-d', '--remove-orphans', ...services];
  }
  if (action === 'restart') {
    return [...base, 'restart', 'api', 'admin', 'deno'];
  }
  if (action === 'selfUpdate') {
    return [...base, 'up', '-d', 'updater'];
  }

  throw new Error(`Unsupported compose action: ${String(action)}`);
}

export function buildDockerImagePullArgs(imageRef: string): string[] {
  return ['image', 'pull', imageRef];
}
