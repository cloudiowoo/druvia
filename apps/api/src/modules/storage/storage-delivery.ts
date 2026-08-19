import type { FastifyReply } from 'fastify';
import { safeStorageResponseMimeType } from './storage-validation.js';

const INLINE_PUBLIC_IMAGE_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
  'image/avif',
]);

export interface StorageDeliveryOptions {
  mimeType: string | null;
  logicalName: string;
  public: boolean;
}

export function encodeStorageDownloadFilename(filename: string): string {
  return encodeURIComponent(filename).replace(/['()*]/g, (character) =>
    `%${character.charCodeAt(0).toString(16).toUpperCase()}`
  );
}

export function storageContentDisposition(logicalName: string, inline: boolean): string {
  const filename = logicalName.split('/').at(-1) || 'download';
  const ascii = filename.replace(/[^\x20-\x7e]|["\\]/g, '_');
  return `${inline ? 'inline' : 'attachment'}; filename="${ascii}"; filename*=UTF-8''${encodeStorageDownloadFilename(filename)}`;
}

export function applyStorageDeliveryHeaders(
  reply: FastifyReply,
  options: StorageDeliveryOptions
): void {
  const mimeType = safeStorageResponseMimeType(options.mimeType);
  const inline = options.public && INLINE_PUBLIC_IMAGE_TYPES.has(mimeType);
  reply.header('Content-Type', mimeType);
  reply.header('X-Content-Type-Options', 'nosniff');
  reply.header('Content-Security-Policy', "sandbox; default-src 'none'");
  reply.header('Content-Disposition', storageContentDisposition(options.logicalName, inline));
  reply.header(
    'Cache-Control',
    options.public ? 'public, max-age=300, must-revalidate' : 'private, no-store'
  );
}
