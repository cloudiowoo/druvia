import fs from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import type { StorageAdapter, UploadOptions, UploadResult, LocalStorageConfig } from './interface.js';

export class LocalAdapter implements StorageAdapter {
  readonly name = 'local';
  private basePath: string;
  private publicUrl: string;

  constructor(config: LocalStorageConfig) {
    this.basePath = config.basePath || '/data/storage';
    this.publicUrl = config.publicUrl || '/storage';
  }

  async upload(file: Buffer, filePath: string, options?: UploadOptions): Promise<UploadResult> {
    const fullPath = path.join(this.basePath, filePath);
    await fs.mkdir(path.dirname(fullPath), { recursive: true });
    await fs.writeFile(fullPath, file);

    // Calculate ETag (MD5 hash)
    const etag = crypto.createHash('md5').update(file).digest('hex');

    return {
      path: filePath,
      url: this.getPublicUrl(filePath),
      size: file.length,
      etag,
    };
  }

  async delete(filePath: string): Promise<void> {
    const fullPath = path.join(this.basePath, filePath);
    try {
      await fs.unlink(fullPath);
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err.code !== 'ENOENT') {
        throw error;
      }
    }
  }

  async exists(filePath: string): Promise<boolean> {
    const fullPath = path.join(this.basePath, filePath);
    try {
      await fs.access(fullPath);
      return true;
    } catch {
      return false;
    }
  }

  getPublicUrl(filePath: string): string {
    return `${this.publicUrl}/${filePath}`;
  }

  async getSignedUrl(filePath: string, _expiresIn?: number): Promise<string> {
    // Local storage doesn't support signed URLs, return public URL
    return this.getPublicUrl(filePath);
  }

  async list(prefix: string): Promise<string[]> {
    const dirPath = path.join(this.basePath, prefix);
    const files: string[] = [];

    try {
      const entries = await fs.readdir(dirPath, { withFileTypes: true });
      for (const entry of entries) {
        const entryPath = path.join(prefix, entry.name);
        if (entry.isFile()) {
          files.push(entryPath);
        } else if (entry.isDirectory()) {
          const subFiles = await this.list(entryPath);
          files.push(...subFiles);
        }
      }
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err.code !== 'ENOENT') {
        throw error;
      }
    }

    return files;
  }

  // Helper: Read file (for serving)
  async read(filePath: string): Promise<Buffer> {
    const fullPath = path.join(this.basePath, filePath);
    return fs.readFile(fullPath);
  }

  // Helper: Get file stats
  async stat(filePath: string): Promise<{ size: number; mtime: Date } | null> {
    const fullPath = path.join(this.basePath, filePath);
    try {
      const stats = await fs.stat(fullPath);
      return { size: stats.size, mtime: stats.mtime };
    } catch {
      return null;
    }
  }
}
