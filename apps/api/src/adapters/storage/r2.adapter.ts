import {
  S3Client,
  PutObjectCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  GetObjectCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { StorageAdapter, UploadOptions, UploadResult, R2StorageConfig } from './interface.js';

export class R2Adapter implements StorageAdapter {
  readonly name = 'r2';
  private client: S3Client;
  private bucket: string;
  private publicUrl: string;

  constructor(config: R2StorageConfig) {
    this.client = new S3Client({
      region: 'auto',
      endpoint: `https://${config.accountId}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId: config.accessKey,
        secretAccessKey: config.secretKey,
      },
    });
    this.bucket = config.bucket;
    this.publicUrl = config.publicUrl || `https://${config.bucket}.r2.dev`;
  }

  async upload(file: Buffer, path: string, options?: UploadOptions): Promise<UploadResult> {
    const command = new PutObjectCommand({
      Bucket: this.bucket,
      Key: path,
      Body: file,
      ContentType: options?.contentType,
      CacheControl: options?.cacheControl,
      Metadata: options?.metadata,
    });

    const result = await this.client.send(command);

    return {
      path,
      url: this.getPublicUrl(path),
      size: file.length,
      etag: result.ETag?.replace(/"/g, ''),
    };
  }

  async delete(path: string): Promise<void> {
    const command = new DeleteObjectCommand({
      Bucket: this.bucket,
      Key: path,
    });
    await this.client.send(command);
  }

  async exists(path: string): Promise<boolean> {
    try {
      const command = new HeadObjectCommand({
        Bucket: this.bucket,
        Key: path,
      });
      await this.client.send(command);
      return true;
    } catch {
      return false;
    }
  }

  getPublicUrl(path: string): string {
    return `${this.publicUrl}/${path}`;
  }

  async getSignedUrl(path: string, expiresIn = 3600): Promise<string> {
    const command = new GetObjectCommand({
      Bucket: this.bucket,
      Key: path,
    });
    return getSignedUrl(this.client, command, { expiresIn });
  }

  async list(prefix: string): Promise<string[]> {
    const files: string[] = [];
    let continuationToken: string | undefined;

    do {
      const command = new ListObjectsV2Command({
        Bucket: this.bucket,
        Prefix: prefix,
        ContinuationToken: continuationToken,
      });

      const result = await this.client.send(command);

      if (result.Contents) {
        for (const obj of result.Contents) {
          if (obj.Key) {
            files.push(obj.Key);
          }
        }
      }

      continuationToken = result.NextContinuationToken;
    } while (continuationToken);

    return files;
  }
}
