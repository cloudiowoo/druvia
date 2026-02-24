import type { StorageAdapter, StorageConfig } from './interface.js';
import { LocalAdapter } from './local.adapter.js';
import { R2Adapter } from './r2.adapter.js';

export * from './interface.js';
export { LocalAdapter } from './local.adapter.js';
export { R2Adapter } from './r2.adapter.js';

export function createStorageAdapter(config: StorageConfig): StorageAdapter {
  switch (config.provider) {
    case 'local':
      return new LocalAdapter(config.local);
    case 'r2':
      return new R2Adapter(config.r2);
    case 's3':
      // S3 adapter uses same implementation as R2 with different endpoint
      throw new Error('S3 adapter not yet implemented');
    default:
      throw new Error(`Unknown storage provider: ${(config as StorageConfig).provider}`);
  }
}

// Default storage adapter based on environment
export function getDefaultStorageAdapter(): StorageAdapter {
  const provider = process.env.STORAGE_PROVIDER || 'local';

  if (provider === 'r2') {
    return new R2Adapter({
      accountId: process.env.R2_ACCOUNT_ID || '',
      accessKey: process.env.R2_ACCESS_KEY || '',
      secretKey: process.env.R2_SECRET_KEY || '',
      bucket: process.env.R2_BUCKET || 'druvia',
      publicUrl: process.env.R2_PUBLIC_URL,
    });
  }

  return new LocalAdapter({
    basePath: process.env.STORAGE_PATH || './data/storage',
    publicUrl: process.env.STORAGE_PUBLIC_URL || '/storage',
  });
}
