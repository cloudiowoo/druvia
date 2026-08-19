export const MAX_STORAGE_OBJECT_BYTES = 50 * 1024 * 1024;
const MIME_TYPE_PATTERN = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/;

export class StorageValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StorageValidationError';
  }
}

export function normalizeStorageMimeType(value: string): string {
  if (typeof value !== 'string') throw new StorageValidationError('MIME type must be a string');
  const normalized = value.trim().toLowerCase();
  if (normalized.length === 0 || normalized.length > 255 || !MIME_TYPE_PATTERN.test(normalized)) {
    throw new StorageValidationError('Invalid MIME type');
  }
  return normalized;
}

export function safeStorageResponseMimeType(value: unknown): string {
  if (typeof value !== 'string') return 'application/octet-stream';
  try {
    return normalizeStorageMimeType(value);
  } catch {
    return 'application/octet-stream';
  }
}

export function normalizeAllowedStorageMimeTypes(values: string[] | null): string[] | null {
  if (values === null) return null;
  if (!Array.isArray(values) || values.length > 100) {
    throw new StorageValidationError('allowedMimeTypes must contain at most 100 values');
  }
  const normalized = [...new Set(values.map(normalizeStorageMimeType))];
  return normalized.length > 0 ? normalized : null;
}

export function normalizeStorageFileSizeLimit(value: number | null): number | null {
  if (value === null) return null;
  if (!Number.isSafeInteger(value) || value <= 0 || value > MAX_STORAGE_OBJECT_BYTES) {
    throw new StorageValidationError(`fileSizeLimit must be a positive integer up to ${MAX_STORAGE_OBJECT_BYTES}`);
  }
  return value;
}
