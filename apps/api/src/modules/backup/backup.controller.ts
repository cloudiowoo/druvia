import type { FastifyRequest, FastifyReply } from 'fastify';
import type { JwtPayload } from '../../middleware/auth.js';
import * as backupService from './backup.service.js';
import { DataAccessMutationLockedError } from '../data-access/data-access-mutation-lock.js';
import {
  assertProjectCapability,
  assertTenantAccess,
  AuthorizationError,
  listAccessibleProjectIds,
  requireCurrentSuperAdmin,
  resolveSchemaProject,
} from '../../lib/project-authorization.js';
import { isPlatformUser } from '../../middleware/auth.js';
import * as projectService from '../project/project.service.js';

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

function sendAuthorizationError(reply: FastifyReply, error: unknown) {
  if (!(error instanceof AuthorizationError)) throw error;
  return reply.status(error.statusCode).send({
    success: false,
    error: { code: error.code, message: error.message },
  });
}

async function authorizeBackup(
  request: FastifyRequest,
  reply: FastifyReply,
  backupId: string,
  capability: 'backups:read' | 'backups:restore',
) {
  const backup = await backupService.getBackupById(backupId);
  if (!backup) {
    reply.status(404).send({
      success: false,
      error: { code: 'NOT_FOUND', message: 'Backup not found' },
    });
    return null;
  }
  try {
    if (backup.projectId) {
      await assertProjectCapability(request.user, backup.projectId, capability);
    } else {
      await assertTenantAccess(request.user, backup.tenantId, { ownerOnly: true });
    }

    const schemaProjectId = await resolveSchemaProject(backup.schemaName);
    const schemaProject = schemaProjectId
      ? await projectService.getProjectById(schemaProjectId)
      : null;
    const scopeMatches = Boolean(
      schemaProject
      && schemaProject.tenantId === backup.tenantId
      && (backup.projectId === null || backup.projectId === schemaProjectId),
    );
    if (!scopeMatches) {
      reply.status(409).send({
        success: false,
        error: {
          code: 'BACKUP_SCOPE_MISMATCH',
          message: 'Backup scope no longer matches its workspace, project and schema',
        },
      });
      return null;
    }
    return backup;
  } catch (error) {
    sendAuthorizationError(reply, error);
    return null;
  }
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
    if (projectId) {
      await assertProjectCapability(request.user, projectId, 'backups:create');
      const project = await projectService.getProjectById(projectId);
      const schemaProjectId = await resolveSchemaProject(schemaName);
      if (!project || project.tenantId !== tenantId || schemaProjectId !== projectId) {
        return reply.status(400).send({
          success: false,
          error: { code: 'BACKUP_SCOPE_MISMATCH', message: 'Workspace, project and schema must match' },
        });
      }
    } else {
      await assertTenantAccess(request.user, tenantId, { ownerOnly: true });
      const schemaProjectId = await resolveSchemaProject(schemaName);
      const project = schemaProjectId
        ? await projectService.getProjectById(schemaProjectId)
        : null;
      if (!project || project.tenantId !== tenantId) {
        return reply.status(400).send({
          success: false,
          error: { code: 'BACKUP_SCOPE_MISMATCH', message: 'Workspace and schema must match' },
        });
      }
    }
    const backup = await backupService.createBackup(
      tenantId,
      schemaName,
      projectId,
      (request.user as JwtPayload | undefined)?.uid
    );
    return reply.status(202).send({ success: true, data: backup });
  } catch (error) {
    if (error instanceof AuthorizationError) return sendAuthorizationError(reply, error);
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
  const backup = await authorizeBackup(request, reply, request.params.backupId, 'backups:read');
  if (!backup) return;

  return reply.send({ success: true, data: backup });
}

// List backups
export async function listBackups(
  request: FastifyRequest<{ Params: TenantParams; Querystring: { limit?: string; offset?: string } }>,
  reply: FastifyReply
) {
  const limit = parseInt(request.query.limit || '50', 10);
  const offset = parseInt(request.query.offset || '0', 10);

  if (!request.user || !isPlatformUser(request.user)) {
    return reply.status(401).send({
      success: false,
      error: { code: 'UNAUTHORIZED', message: 'Platform authentication required' },
    });
  }
  let projectIds: string[] | undefined;
  try {
    const access = await assertTenantAccess(request.user, request.params.tenantId);
    if (!access.isWorkspaceOwner && !access.isSuperAdmin) {
      projectIds = await listAccessibleProjectIds(
        request.user, request.params.tenantId, 'backups:read',
      );
    }
  } catch (error) {
    return sendAuthorizationError(reply, error);
  }
  const backups = projectIds
    ? await backupService.listBackupsForProjects(request.params.tenantId, projectIds, limit, offset)
    : await backupService.listBackups(request.params.tenantId, limit, offset);

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
  if (!(await authorizeBackup(request, reply, request.params.backupId, 'backups:restore'))) return;
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
    if (!(await authorizeBackup(request, reply, request.params.backupId, 'backups:restore'))) return;
    await backupService.restoreBackup(request.params.backupId);
    return reply.send({ success: true, message: 'Restore initiated successfully' });
  } catch (error) {
    if (error instanceof DataAccessMutationLockedError) {
      return reply.status(409).send({
        success: false,
        error: { code: error.code, message: 'Project data changes are temporarily locked' },
      });
    }
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
  if (!(await authorizeBackup(request, reply, request.params.backupId, 'backups:read'))) return;
  const url = await backupService.getBackupDownloadUrl(request.params.backupId);

  if (!url) {
    return reply.status(404).send({
      success: false,
      error: { code: 'NOT_FOUND', message: 'Backup not found or not completed' },
    });
  }

  return reply.send({ success: true, data: { url } });
}

// List all backups (admin)
export async function listAllBackups(
  request: FastifyRequest<{
    Querystring: { tenantId?: string; projectId?: string; limit?: string; offset?: string };
  }>,
  reply: FastifyReply
) {
  try {
    await requireCurrentSuperAdmin(request.user);
  } catch (error) {
    return sendAuthorizationError(reply, error);
  }
  const { tenantId, projectId, limit, offset } = request.query;
  const result = await backupService.listAllBackups(
    tenantId || undefined,
    projectId || undefined,
    parseInt(limit || '50', 10),
    parseInt(offset || '0', 10)
  );

  return reply.send({ success: true, data: result });
}
