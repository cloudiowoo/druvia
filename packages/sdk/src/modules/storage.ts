import type { FetchFn, DruviaResponse } from '../types.js'

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

  async upload(path: string, file: Blob | File | ArrayBuffer, options?: { contentType?: string }): Promise<DruviaResponse<{ path: string }>> {
    try {
      const headers: Record<string, string> = {}
      if (options?.contentType) headers['Content-Type'] = options.contentType
      const response = await this.fetchFn(this.objectUrl(path), {
        method: 'POST',
        body: file as any,
        headers,
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
}