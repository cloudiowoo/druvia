export class StoragePathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StoragePathError';
  }
}

function assertLength(value: string): void {
  if (value.length > 1024) {
    throw new StoragePathError('Storage path must not exceed 1024 characters');
  }
}

function normalizeSeparators(value: string): string {
  return value.replace(/\\/g, '/').replace(/^\/+/, '').normalize('NFC');
}

function assertSegments(value: string, allowTrailingSlash: boolean): void {
  if (/\p{Cc}/u.test(value)) {
    throw new StoragePathError('Storage path must not contain control characters');
  }
  if (value.includes('//')) {
    throw new StoragePathError('Storage path must not contain empty segments');
  }
  if (!allowTrailingSlash && value.endsWith('/')) {
    throw new StoragePathError('Storage object path must not end with a slash');
  }

  const segments = value.split('/');
  const checked = allowTrailingSlash && segments.at(-1) === '' ? segments.slice(0, -1) : segments;
  if (checked.some((segment) => segment === '.' || segment === '..')) {
    throw new StoragePathError('Storage path must not contain dot segments');
  }
}

export function normalizeStorageObjectPath(value: string): string {
  if (typeof value !== 'string') {
    throw new StoragePathError('Storage object path is required');
  }
  const normalized = normalizeSeparators(value);
  assertLength(normalized);
  if (!normalized) {
    throw new StoragePathError('Storage object path is required');
  }
  assertSegments(normalized, false);
  return normalized;
}

export function normalizeStoragePathPrefix(value: string): string {
  if (typeof value !== 'string') {
    throw new StoragePathError('Storage path prefix must be a string');
  }
  const normalized = normalizeSeparators(value);
  assertLength(normalized);
  if (!normalized) return '';
  assertSegments(normalized, true);
  return normalized;
}

export function normalizeTrustedStoragePathPrefix(value: string): string {
  const normalized = normalizeStoragePathPrefix(value);
  if (!normalized) {
    throw new StoragePathError('Trusted storage path prefix is required');
  }
  return normalized.endsWith('/') ? normalized : `${normalized}/`;
}

export function storageLikePrefix(prefix: string): string {
  return `${prefix.replace(/[\\%_]/g, (character) => `\\${character}`)}%`;
}

export function encodeStorageObjectPath(value: string): string {
  return normalizeStorageObjectPath(value).split('/').map(encodeURIComponent).join('/');
}
