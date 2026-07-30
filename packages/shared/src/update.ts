export const DRUVIA_RELEASE_CHANNELS = ['stable', 'beta', 'nightly'] as const;

export type DruviaReleaseChannel = (typeof DRUVIA_RELEASE_CHANNELS)[number];

export interface DruviaReleaseImage {
  repository: string;
  tag: string;
  digest: string;
}

export interface DruviaReleaseManifest {
  schemaVersion: 1;
  product: 'druvia';
  version: string;
  channel: DruviaReleaseChannel;
  createdAt: string;
  minUpdaterVersion: string;
  releaseNotesUrl: string;
  compose: {
    url: string;
    sha256: string;
  };
  images: {
    api: DruviaReleaseImage;
    admin: DruviaReleaseImage;
    worker: DruviaReleaseImage;
    updater: DruviaReleaseImage;
  };
  migrations: {
    required: boolean;
    from: number;
    to: number;
    requiresBackup: boolean;
    reversible: boolean;
  };
}

export type DruviaUpdatePhase =
  | 'idle'
  | 'checking'
  | 'available'
  | 'downloading'
  | 'ready_to_apply'
  | 'applying'
  | 'restarting'
  | 'verifying'
  | 'finalizing'
  | 'succeeded'
  | 'failed'
  | 'rolled_back';

export const DRUVIA_MUTATING_UPDATE_PHASES = [
  'checking',
  'downloading',
  'applying',
  'restarting',
  'verifying',
  'finalizing',
] as const satisfies readonly DruviaUpdatePhase[];

export interface DruviaUpdateStatus {
  enabled: boolean;
  phase: DruviaUpdatePhase;
  currentVersion: string;
  availableVersion: string | null;
  channel: DruviaReleaseChannel;
  releaseNotesUrl: string | null;
  migration: DruviaReleaseManifest['migrations'] | null;
  operationId: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  message: string | null;
  error: { code: string; message: string } | null;
}

export function isDruviaUpdateMutatingPhase(phase: DruviaUpdatePhase): boolean {
  return DRUVIA_MUTATING_UPDATE_PHASES.includes(phase as (typeof DRUVIA_MUTATING_UPDATE_PHASES)[number]);
}
