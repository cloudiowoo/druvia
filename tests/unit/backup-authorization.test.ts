import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  assertProjectCapability,
  assertTenantAccess,
  listAccessibleProjectIds,
  resolveSchemaProject,
  createBackup,
  getBackupById,
  getBackupDownloadUrl,
  restoreBackup,
  listBackups,
  listBackupsForProjects,
  getProjectById,
} = vi.hoisted(() => ({
  assertProjectCapability: vi.fn(),
  assertTenantAccess: vi.fn(),
  listAccessibleProjectIds: vi.fn(),
  resolveSchemaProject: vi.fn(),
  createBackup: vi.fn(),
  getBackupById: vi.fn(),
  getBackupDownloadUrl: vi.fn(),
  restoreBackup: vi.fn(),
  listBackups: vi.fn(),
  listBackupsForProjects: vi.fn(),
  getProjectById: vi.fn(),
}))

vi.mock('../../apps/api/src/lib/project-authorization.js', () => ({
  AuthorizationError: class AuthorizationError extends Error {},
  assertProjectCapability,
  assertTenantAccess,
  listAccessibleProjectIds,
  requireCurrentSuperAdmin: vi.fn(),
  resolveSchemaProject,
}))

vi.mock('../../apps/api/src/modules/backup/backup.service.js', () => ({
  createBackup,
  listBackups,
  listBackupsForProjects,
  getBackupById,
  deleteBackup: vi.fn(),
  restoreBackup,
  getBackupDownloadUrl,
  listAllBackups: vi.fn(),
}))

vi.mock('../../apps/api/src/modules/project/project.service.js', () => ({
  getProjectById,
}))

import * as controller from '../../apps/api/src/modules/backup/backup.controller.js'

function replyStub() {
  const reply = { status: vi.fn(), send: vi.fn() }
  reply.status.mockReturnValue(reply)
  reply.send.mockReturnValue(reply)
  return reply
}

const member = {
  kind: 'platform_user' as const,
  uid: 25,
  userId: 'usr_member',
  role: 'admin',
}

describe('backup authorization', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('rejects a tenant backup when the schema belongs to another workspace', async () => {
    assertTenantAccess.mockResolvedValue({
      tenantId: 'tenant_a', isWorkspaceOwner: true, isSuperAdmin: false,
    })
    resolveSchemaProject.mockResolvedValue('proj_b')
    getProjectById.mockResolvedValue({ projectId: 'proj_b', tenantId: 'tenant_b' })
    const reply = replyStub()

    await controller.createBackup({
      params: { tenantId: 'tenant_a' },
      body: { schemaName: 'dru_tenant_b_project' },
      user: member,
    } as never, reply as never)

    expect(reply.status).toHaveBeenCalledWith(400)
    expect(reply.send).toHaveBeenCalledWith(expect.objectContaining({
      error: expect.objectContaining({ code: 'BACKUP_SCOPE_MISMATCH' }),
    }))
    expect(createBackup).not.toHaveBeenCalled()
  })

  it('filters a project member backup list by backups:read', async () => {
    assertTenantAccess.mockResolvedValue({
      tenantId: 'default', isWorkspaceOwner: false, isSuperAdmin: false,
    })
    listAccessibleProjectIds.mockResolvedValue(['proj_pitch'])
    listBackupsForProjects.mockResolvedValue([])
    const reply = replyStub()

    await controller.listBackups({
      params: { tenantId: 'default' },
      query: {},
      user: member,
    } as never, reply as never)

    expect(listAccessibleProjectIds).toHaveBeenCalledWith(
      member, 'default', 'backups:read',
    )
    expect(listBackupsForProjects).toHaveBeenCalledWith(
      'default', ['proj_pitch'], 50, 0,
    )
    expect(listBackups).not.toHaveBeenCalled()
  })

  it('rejects historical project backups whose tenant, project and schema no longer match', async () => {
    getBackupById.mockResolvedValue({
      backupId: 'backup_mismatch',
      tenantId: 'tenant_a',
      projectId: 'proj_a',
      schemaName: 'dru_tenant_b_project',
    })
    assertProjectCapability.mockResolvedValue({ projectId: 'proj_a' })
    getProjectById.mockResolvedValue({ projectId: 'proj_a', tenantId: 'tenant_a' })
    resolveSchemaProject.mockResolvedValue('proj_b')

    for (const handler of [
      controller.getBackup,
      controller.getDownloadUrl,
      controller.deleteBackup,
      controller.restoreBackup,
    ]) {
      const reply = replyStub()
      await handler({
        params: { backupId: 'backup_mismatch' },
        user: member,
      } as never, reply as never)
      expect(reply.status).toHaveBeenCalledWith(409)
      expect(reply.send).toHaveBeenCalledWith(expect.objectContaining({
        error: expect.objectContaining({ code: 'BACKUP_SCOPE_MISMATCH' }),
      }))
    }

    expect(getBackupDownloadUrl).not.toHaveBeenCalled()
    expect(restoreBackup).not.toHaveBeenCalled()
  })

  it('rejects historical backups when schema ownership is ambiguous', async () => {
    getBackupById.mockResolvedValue({
      backupId: 'backup_ambiguous',
      tenantId: 'tenant_a',
      projectId: 'proj_a',
      schemaName: 'dru_tenant_shared',
    })
    assertProjectCapability.mockResolvedValue({ projectId: 'proj_a' })
    resolveSchemaProject.mockResolvedValue(null)
    const reply = replyStub()

    await controller.getDownloadUrl({
      params: { backupId: 'backup_ambiguous' },
      user: member,
    } as never, reply as never)

    expect(reply.status).toHaveBeenCalledWith(409)
    expect(getBackupDownloadUrl).not.toHaveBeenCalled()
  })

  it('rejects tenant-level backups whose schema belongs to another workspace', async () => {
    getBackupById.mockResolvedValue({
      backupId: 'backup_tenant_mismatch',
      tenantId: 'tenant_a',
      projectId: null,
      schemaName: 'dru_tenant_b_project',
    })
    assertTenantAccess.mockResolvedValue({
      tenantId: 'tenant_a', isWorkspaceOwner: true, isSuperAdmin: false,
    })
    resolveSchemaProject.mockResolvedValue('proj_b')
    getProjectById.mockResolvedValue({ projectId: 'proj_b', tenantId: 'tenant_b' })
    const reply = replyStub()

    await controller.getDownloadUrl({
      params: { backupId: 'backup_tenant_mismatch' },
      user: member,
    } as never, reply as never)

    expect(reply.status).toHaveBeenCalledWith(409)
    expect(getBackupDownloadUrl).not.toHaveBeenCalled()
  })
})
