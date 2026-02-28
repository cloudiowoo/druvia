// packages/shared/src/types/settings.ts
export interface PlatformSettings {
  defaultPlan: string;
  defaultStorageLimit: number;
  defaultProjectLimit: number;
  defaultUserLimit: number;
  backupRetentionDays: number;
  backupMaxCount: number;
}

export type SettingKey = keyof PlatformSettings;
