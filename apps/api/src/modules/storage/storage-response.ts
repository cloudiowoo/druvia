import type { StorageObject } from './storage.service.js';

export interface StorageObjectResponse {
  objectId: string;
  bucketId: string;
  name: string;
  size: number;
  mimeType: string | null;
  createdAt: string;
  updatedAt: string;
}

export function toStorageObjectResponse(object: StorageObject): StorageObjectResponse {
  return {
    objectId: object.objectId,
    bucketId: object.bucketId,
    name: object.name,
    size: object.size,
    mimeType: object.mimeType,
    createdAt: object.createdAt.toISOString(),
    updatedAt: object.updatedAt.toISOString(),
  };
}
