import { randomBytes } from 'crypto';

export function generateId(prefix?: string): string {
  const id = randomBytes(12).toString('base64url');
  return prefix ? `${prefix}_${id}` : id;
}

export function generateTenantId(): string {
  return generateId('tenant');
}

export function generateUserId(): string {
  return generateId('user');
}

export function generateProjectId(): string {
  return generateId('proj');
}

export function generateBackupId(): string {
  return generateId('backup');
}

export function generateFileId(): string {
  return generateId('file');
}

export function generateApiKeyId(): string {
  return generateId('key');
}
