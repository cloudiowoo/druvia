import type { FetchFn, DruviaResponse, StorageRemoveTicket, StorageUploadTicket } from '../types.js'

export interface StorageObject {
  objectId: string
  bucketId: string
  name: string
  size: number
  mimeType: string | null
  createdAt: string
}

export class BucketClient {
  private baseUrl: string
  private projectId: string
  private bucketName: string
  private fetchFn: FetchFn

  constructor(baseUrl: string, projectId: string, bucketName: string, fetchFn: FetchFn) {
    this.baseUrl = baseUrl
    this.projectId = projectId
    this.bucketName = bucketName
    this.fetchFn = fetchFn
  }

  private objectUrl(path: string): string {
    return `${this.baseUrl}/projects/${this.projectId}/storage/buckets/${this.bucketName}/objects/${path}`
  }

  private uploadUrl(path: string): string {
    return `${this.baseUrl}/projects/${this.projectId}/storage/buckets/${this.bucketName}/objects?path=${encodeURIComponent(path)}`
  }

  async upload(path: string, file: Blob | File | ArrayBuffer, options?: { contentType?: string }): Promise<DruviaResponse<{ path: string }>> {
    try {
      const formData = new FormData()
      const contentType = options?.contentType
      let blob: Blob | File
      if (file instanceof ArrayBuffer) {
        blob = new Blob([file], contentType ? { type: contentType } : undefined)
      } else if (contentType && !(file instanceof File)) {
        blob = new Blob([file], { type: contentType })
      } else {
        blob = file
      }
      formData.append('file', blob, path.split('/').pop() || 'file')
      const response = await this.fetchFn(this.uploadUrl(path), {
        method: 'POST',
        body: formData as any,
      })
      const json = await response.json()
      if (!response.ok) {
        return { data: null, error: json.error ?? { code: 'STORAGE_ERROR', message: 'Upload failed' } }
      }
      return { data: json.data ?? { path }, error: null }
    } catch (err) {
      return { data: null, error: { code: 'NETWORK_ERROR', message: err instanceof Error ? err.message : String(err) } }
    }
  }

  async list(options?: { prefix?: string; limit?: number; offset?: number }): Promise<DruviaResponse<StorageObject[]>> {
    try {
      const params = new URLSearchParams()
      if (options?.prefix) params.set('prefix', options.prefix)
      if (options?.limit) params.set('limit', String(options.limit))
      if (options?.offset) params.set('offset', String(options.offset))
      const query = params.toString()
      const url = `${this.baseUrl}/projects/${this.projectId}/storage/buckets/${this.bucketName}/objects${query ? `?${query}` : ''}`
      const response = await this.fetchFn(url, { method: 'GET' })
      const json = await response.json()
      if (!response.ok) {
        return { data: null, error: json.error ?? { code: 'STORAGE_ERROR', message: 'List failed' } }
      }
      return { data: json.data ?? [], error: null }
    } catch (err) {
      return { data: null, error: { code: 'NETWORK_ERROR', message: err instanceof Error ? err.message : String(err) } }
    }
  }

  async remove(path: string): Promise<DruviaResponse<null>> {
    try {
      const response = await this.fetchFn(this.objectUrl(path), { method: 'DELETE' })
      if (!response.ok) {
        const text = await response.text()
        const error = text ? JSON.parse(text).error : { code: 'STORAGE_ERROR', message: 'Delete failed' }
        return { data: null, error }
      }
      return { data: null, error: null }
    } catch (err) {
      return { data: null, error: { code: 'NETWORK_ERROR', message: err instanceof Error ? err.message : String(err) } }
    }
  }

  async download(path: string): Promise<DruviaResponse<Blob>> {
    try {
      const response = await this.fetchFn(this.objectUrl(path), { method: 'GET' })
      if (!response.ok) {
        const json = await response.json()
        return { data: null, error: json.error ?? { code: 'STORAGE_ERROR', message: 'Download failed' } }
      }
      const blob = await response.blob()
      return { data: blob, error: null }
    } catch (err) {
      return { data: null, error: { code: 'NETWORK_ERROR', message: err instanceof Error ? err.message : String(err) } }
    }
  }

  getPublicUrl(path: string): { data: { publicUrl: string } } {
    const publicUrl = `${this.baseUrl}/storage/public/${this.projectId}/${this.bucketName}/${path}`
    return { data: { publicUrl } }
  }

  async createSignedUrl(path: string, expiresIn: number): Promise<DruviaResponse<{ signedUrl: string }>> {
    try {
      const response = await this.fetchFn(
        `${this.baseUrl}/projects/${this.projectId}/storage/buckets/${this.bucketName}/signed-url`,
        {
          method: 'POST',
          body: JSON.stringify({ path, expiresIn }),
        }
      )
      const json = await response.json()
      if (!response.ok) {
        return { data: null, error: json.error ?? { code: 'STORAGE_ERROR', message: 'Failed to create signed URL' } }
      }
      return { data: json.data ?? json, error: null }
    } catch (err) {
      return { data: null, error: { code: 'NETWORK_ERROR', message: err instanceof Error ? err.message : String(err) } }
    }
  }
}

export class DruviaStorage {
  private baseUrl: string
  private projectId: string
  private fetchFn: FetchFn

  constructor(baseUrl: string, projectId: string, fetchFn: FetchFn) {
    this.baseUrl = baseUrl
    this.projectId = projectId
    this.fetchFn = fetchFn
  }

  from(bucketName: string): BucketClient {
    return new BucketClient(this.baseUrl, this.projectId, bucketName, this.fetchFn)
  }

  async issueUploadTicket(params: {
    userId: string
    bucket: string
    pathPrefix: string
    trustedBackendKey: string
    contentTypes?: string[]
    maxBytes?: number
    expiresIn?: number
  }): Promise<DruviaResponse<StorageUploadTicket>> {
    try {
      const response = await this.fetchFn(`${this.baseUrl}/projects/${this.projectId}/storage/trusted/upload-ticket`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-druvia-trusted-backend-key': params.trustedBackendKey,
        },
        body: JSON.stringify({
          userId: params.userId,
          bucket: params.bucket,
          pathPrefix: params.pathPrefix,
          contentTypes: params.contentTypes,
          maxBytes: params.maxBytes,
          expiresIn: params.expiresIn,
        }),
      })
      const json = await response.json()
      if (!response.ok) {
        return { data: null, error: json.error ?? { code: 'STORAGE_TICKET_ERROR', message: 'Failed to issue upload ticket' } }
      }
      return { data: json.data ?? json, error: null }
    } catch (err) {
      return { data: null, error: { code: 'NETWORK_ERROR', message: err instanceof Error ? err.message : String(err) } }
    }
  }

  async issueRemoveTicket(params: {
    userId: string
    bucket: string
    path: string
    trustedBackendKey: string
    expiresIn?: number
  }): Promise<DruviaResponse<StorageRemoveTicket>> {
    try {
      const response = await this.fetchFn(`${this.baseUrl}/projects/${this.projectId}/storage/trusted/remove-ticket`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-druvia-trusted-backend-key': params.trustedBackendKey,
        },
        body: JSON.stringify({
          userId: params.userId,
          bucket: params.bucket,
          path: params.path,
          expiresIn: params.expiresIn,
        }),
      })
      const json = await response.json()
      if (!response.ok) {
        return { data: null, error: json.error ?? { code: 'STORAGE_TICKET_ERROR', message: 'Failed to issue remove ticket' } }
      }
      return { data: json.data ?? json, error: null }
    } catch (err) {
      return { data: null, error: { code: 'NETWORK_ERROR', message: err instanceof Error ? err.message : String(err) } }
    }
  }

  async uploadWithTicket(
    ticket: string,
    file: Blob | File | ArrayBuffer,
    options: { path: string; contentType?: string }
  ): Promise<DruviaResponse<{ path: string; publicUrl: string | null; object: StorageObject }>> {
    try {
      const formData = new FormData()
      let blob: Blob | File
      if (file instanceof ArrayBuffer) {
        blob = new Blob([file], options.contentType ? { type: options.contentType } : undefined)
      } else if (options.contentType && !(file instanceof File)) {
        blob = new Blob([file], { type: options.contentType })
      } else {
        blob = file
      }
      formData.append('file', blob, options.path.split('/').pop() || 'file')

      const response = await this.fetchFn(`${this.baseUrl}/storage/upload-with-ticket?path=${encodeURIComponent(options.path)}`, {
        method: 'POST',
        headers: {
          'x-druvia-storage-ticket': ticket,
        },
        body: formData as any,
      })
      const json = await response.json()
      if (!response.ok) {
        return { data: null, error: json.error ?? { code: 'STORAGE_ERROR', message: 'Upload with ticket failed' } }
      }
      return { data: json.data ?? json, error: null }
    } catch (err) {
      return { data: null, error: { code: 'NETWORK_ERROR', message: err instanceof Error ? err.message : String(err) } }
    }
  }

  async removeWithTicket(ticket: string, path: string): Promise<DruviaResponse<{ removed: boolean }>> {
    try {
      const response = await this.fetchFn(`${this.baseUrl}/storage/remove-with-ticket`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-druvia-storage-ticket': ticket,
        },
        body: JSON.stringify({ path }),
      })
      const json = await response.json()
      if (!response.ok) {
        return { data: null, error: json.error ?? { code: 'STORAGE_ERROR', message: 'Remove with ticket failed' } }
      }
      return { data: json.data ?? json, error: null }
    } catch (err) {
      return { data: null, error: { code: 'NETWORK_ERROR', message: err instanceof Error ? err.message : String(err) } }
    }
  }
}
