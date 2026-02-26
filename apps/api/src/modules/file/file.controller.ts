import type { FastifyRequest, FastifyReply } from 'fastify';
import type { MultipartFile } from '@fastify/multipart';
import * as fileService from './file.service.js';

interface UploadParams {
  tenantId: string;
}

interface UploadQuery {
  bucket?: string;
  projectId?: string;
}

interface FileParams {
  fileId: string;
}

interface ListFilesQuery {
  bucket?: string;
  projectId?: string;
  limit?: string;
  offset?: string;
}

interface MultipartRequest extends FastifyRequest<{ Params: UploadParams; Querystring: UploadQuery }> {
  file(): Promise<MultipartFile | undefined>;
}

export async function uploadFile(
  request: MultipartRequest,
  reply: FastifyReply
) {
  const data = await request.file();

  if (!data) {
    return reply.status(400).send({
      success: false,
      error: { code: 'NO_FILE', message: 'No file uploaded' },
    });
  }

  const buffer = await data.toBuffer();
  const bucket = request.query.bucket || 'default';

  try {
    const file = await fileService.uploadFile(buffer, {
      tenantId: request.params.tenantId,
      projectId: request.query.projectId,
      bucket,
      filename: data.filename,
      contentType: data.mimetype,
      createdBy: request.user?.uid,
    });

    return reply.status(201).send({ success: true, data: file });
  } catch (error) {
    const err = error as Error;
    return reply.status(500).send({
      success: false,
      error: { code: 'UPLOAD_FAILED', message: err.message },
    });
  }
}

export async function getFile(
  request: FastifyRequest<{ Params: FileParams }>,
  reply: FastifyReply
) {
  const file = await fileService.getFileById(request.params.fileId);

  if (!file) {
    return reply.status(404).send({
      success: false,
      error: { code: 'NOT_FOUND', message: 'File not found' },
    });
  }

  return reply.send({ success: true, data: file });
}

export async function listFiles(
  request: FastifyRequest<{ Params: { tenantId: string }; Querystring: ListFilesQuery }>,
  reply: FastifyReply
) {
  const limit = parseInt(request.query.limit || '50', 10);
  const offset = parseInt(request.query.offset || '0', 10);

  const files = await fileService.listFiles(
    request.params.tenantId,
    request.query.bucket,
    request.query.projectId,
    limit,
    offset
  );

  return reply.send({
    success: true,
    data: files,
    pagination: { limit, offset, count: files.length },
  });
}

export async function deleteFile(
  request: FastifyRequest<{ Params: FileParams }>,
  reply: FastifyReply
) {
  const deleted = await fileService.deleteFile(request.params.fileId);

  if (!deleted) {
    return reply.status(404).send({
      success: false,
      error: { code: 'NOT_FOUND', message: 'File not found' },
    });
  }

  return reply.status(204).send();
}

export async function getSignedUrl(
  request: FastifyRequest<{ Params: FileParams; Querystring: { expiresIn?: string } }>,
  reply: FastifyReply
) {
  const expiresIn = parseInt(request.query.expiresIn || '3600', 10);
  const url = await fileService.getSignedUrl(request.params.fileId, expiresIn);

  if (!url) {
    return reply.status(404).send({
      success: false,
      error: { code: 'NOT_FOUND', message: 'File not found' },
    });
  }

  return reply.send({ success: true, data: { url, expiresIn } });
}
