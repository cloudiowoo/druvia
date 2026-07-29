import { promises as fs } from 'node:fs';
import { dirname } from 'node:path';
import type { DruviaReleaseChannel, DruviaUpdateStatus } from '@druvia/shared';

export interface CreateDefaultUpdateStatusInput {
  currentVersion: string;
  channel: DruviaReleaseChannel;
}

export function createDefaultUpdateStatus(input: CreateDefaultUpdateStatusInput): DruviaUpdateStatus {
  return {
    enabled: true,
    phase: 'idle',
    currentVersion: input.currentVersion,
    availableVersion: null,
    channel: input.channel,
    releaseNotesUrl: null,
    migration: null,
    operationId: null,
    startedAt: null,
    finishedAt: null,
    message: null,
    error: null,
  };
}

export async function readUpdateState(
  statePath: string,
  fallback: DruviaUpdateStatus
): Promise<DruviaUpdateStatus> {
  try {
    const content = await fs.readFile(statePath, 'utf8');
    return JSON.parse(content) as DruviaUpdateStatus;
  } catch (error) {
    if (typeof error === 'object' && error && 'code' in error && error.code === 'ENOENT') {
      return fallback;
    }
    throw error;
  }
}

export async function writeUpdateState(
  statePath: string,
  state: DruviaUpdateStatus
): Promise<void> {
  await fs.mkdir(dirname(statePath), { recursive: true });
  const tempPath = `${statePath}.tmp`;
  await fs.writeFile(tempPath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  await fs.rename(tempPath, statePath);
}
