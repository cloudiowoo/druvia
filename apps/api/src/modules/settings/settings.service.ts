// apps/api/src/modules/settings/settings.service.ts
import { query, queryOne } from '../../db/index.js';
import type { PlatformSettings } from '@druvia/shared';

interface SettingRow {
  key: string;
  value: unknown;
  updated_at: Date;
}

const SETTING_KEYS: (keyof PlatformSettings)[] = [
  'defaultPlan',
  'defaultStorageLimit',
  'defaultProjectLimit',
  'defaultUserLimit',
  'backupRetentionDays',
  'backupMaxCount',
];

// Convert camelCase to snake_case for DB
function toDbKey(key: string): string {
  return key.replace(/([A-Z])/g, '_$1').toLowerCase();
}

// Convert snake_case to camelCase
function toCamelCase(key: string): string {
  return key.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
}

export async function getSettings(): Promise<PlatformSettings> {
  const rows = await query<SettingRow>('SELECT * FROM druvia_settings');

  const settings: Record<string, unknown> = {};
  for (const row of rows) {
    const camelKey = toCamelCase(row.key);
    settings[camelKey] = row.value;
  }

  return settings as unknown as PlatformSettings;
}

export async function getSetting<K extends keyof PlatformSettings>(
  key: K
): Promise<PlatformSettings[K] | null> {
  const dbKey = toDbKey(key);
  const row = await queryOne<SettingRow>(
    'SELECT * FROM druvia_settings WHERE key = $1',
    [dbKey]
  );
  return row ? (row.value as PlatformSettings[K]) : null;
}

export async function updateSettings(
  updates: Partial<PlatformSettings>
): Promise<PlatformSettings> {
  for (const [key, value] of Object.entries(updates)) {
    if (!SETTING_KEYS.includes(key as keyof PlatformSettings)) continue;

    const dbKey = toDbKey(key);
    await query(
      `INSERT INTO druvia_settings (key, value)
       VALUES ($1, $2)
       ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = NOW()`,
      [dbKey, JSON.stringify(value)]
    );
  }

  return getSettings();
}
