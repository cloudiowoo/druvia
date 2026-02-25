import type { FastifyRequest, FastifyReply } from 'fastify';
import * as backupService from './backup.service.js';

interface TenantParams {
  tenantId: string;
}

interface BackupParams {
  backupId: string;
}

interface CreateBackupBody {
  schemaName: string;
  projectId?: string;
}

// Create backup
export async function createBackup(
  request: FastifyRequest<{ Params: TenantParams; Body: CreateBackupBody }>,
  reply: FastifyReply
) {
  const { tenantId } = request.params;
  const { schemaName, projectId } = request.body;

  if (!schemaName) {
    return reply.status(400).send({
      success: false,
      error: { code: 'INVALID_INPUT', message: 'Schema name is required' },
    });
  }

  try {
    const backup = await backupService.createBackup(
      tenantId,
      schemaName,
      projectId,
      request.user?.uid
    );
    return reply.status(202).send({ success: true, data: backup });
  } catch (error) {
    const err = error as Error;
    return reply.status(400).send({
      success: false,
      error: { code: 'BACKUP_FAILED', message: err.message },
    });
  }
}

// Get backup
export async function getBackup(
  request: FastifyRequest<{ Params: BackupParams }>,
  reply: FastifyReply
) {
  const backup = await backupService.getBackupById(request.params.backupId);

  if (!backup) {
    return reply.status(404).send({
      success: false,
      error: { code: 'NOT_FOUND', message: 'Backup not found' },
    });
  }

  return reply.send({ success: true, data: backup });
}

// List backups
export async function listBackups(
  request: FastifyRequest<{ Params: TenantParams; Querystring: { limit?: string; offset?: string } }>,
  reply: FastifyReply
) {
  const limit = parseInt(request.query.limit || '50', 10);
  const offset = parseInt(request.query.offset || '0', 10);

  const backups = await backupService.listBackups(request.params.tenantId, limit, offset);

  return reply.send({
    success: true,
    data: backups,
    pagination: { limit, offset, count: backups.length },
  });
}

// Delete backup
export async function deleteBackup(
  request: FastifyRequest<{ Params: BackupParams }>,
  reply: FastifyReply
) {
  const deleted = await backupService.deleteBackup(request.params.backupId);

  if (!deleted) {
    return reply.status(404).send({
      success: false,
      error: { code: 'NOT_FOUND', message: 'Backup not found' },
    });
  }

  return reply.status(204).send();
}

// Restore backup
export async function restoreBackup(
  request: FastifyRequest<{ Params: BackupParams }>,
  reply: FastifyReply
) {
  try {
    await backupService.restoreBackup(request.params.backupId);
    return reply.send({ success: true, message: 'Restore initiated successfully' });
  } catch (error) {
    const err = error as Error;
    return reply.status(400).send({
      success: false,
      error: { code: 'RESTORE_FAILED', message: err.message },
    });
  }
}

// Get download URL
export async function getDownloadUrl(
  request: FastifyRequest<{ Params: BackupParams }>,
  reply: FastifyReply
) {
  const url = await backupService.getBackupDownloadUrl(request.params.backupId);

  if (!url) {
    return reply.status(404).send({
      success: false,
      error: { code: 'NOT_FOUND', message: 'Backup not found or not completed' },
    });
  }

  return reply.send({ success: true, data: { url } });
}
