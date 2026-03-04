// Storage Adapter Interface

export interface UploadOptions {
  contentType?: string;
  cacheControl?: string;
  acl?: 'private' | 'public-read';
  metadata?: Record<string, string>;
}

export interface UploadResult {
  path: string;
  url: string;
  size: number;
  etag?: string;
}

export interface StorageAdapter {
  readonly name: string;

  upload(file: Buffer, path: string, options?: UploadOptions): Promise<UploadResult>;
  download(path: string): Promise<Buffer>;
  delete(path: string): Promise<void>;
  exists(path: string): Promise<boolean>;
  getPublicUrl(path: string): string;
  getSignedUrl(path: string, expiresIn?: number): Promise<string>;
  list(prefix: string): Promise<string[]>;
}

// Configuration types
export interface LocalStorageConfig {
  basePath: string;
  publicUrl: string;
}

export interface R2StorageConfig {
  accountId: string;
  accessKey: string;
  secretKey: string;
  bucket: string;
  publicUrl?: string;
}

export interface S3StorageConfig {
  region: string;
  accessKey: string;
  secretKey: string;
  bucket: string;
  endpoint?: string;
  publicUrl?: string;
}

export type StorageConfig =
  | { provider: 'local'; local: LocalStorageConfig }
  | { provider: 'r2'; r2: R2StorageConfig }
  | { provider: 's3'; s3: S3StorageConfig };
