import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../apps/api/src/lib/access.js', () => ({ checkProjectAccess: vi.fn() }))
vi.mock('../../apps/api/src/modules/data-access/data-access.service.js', () => ({
  DataAccessConflictError: class DataAccessConflictError extends Error {},
  DataAccessNotFoundError: class DataAccessNotFoundError extends Error {},
  DataAccessUpstreamError: class DataAccessUpstreamError extends Error {},
  getProjectDataAccessOverview: vi.fn(), getTableDataAccess: vi.fn(), updateTableDataAccess: vi.fn(),
}))
vi.mock('../../apps/api/src/modules/data-access/data-access-migration.service.js', () => {
  class DataAccessMigrationNotFoundError extends Error { readonly code = 'DATA_ACCESS_MIGRATION_NOT_FOUND' }
  class DataAccessMigrationConflictError extends Error { constructor(message: string, readonly code = 'DATA_ACCESS_MIGRATION_CONFLICT') { super(message) } }
  class DataAccessMigrationInputError extends Error { readonly code = 'INVALID_DATA_ACCESS_MIGRATION_INPUT' }
  return {
    DataAccessMigrationNotFoundError, DataAccessMigrationConflictError, DataAccessMigrationInputError,
    getDataAccessMigration: vi.fn(), previewDataAccessMigration: vi.fn(), applyDataAccessMigration: vi.fn(),
    recoverDataAccessMigration: vi.fn(), previewDataAccessMigrationRollback: vi.fn(), rollbackDataAccessMigration: vi.fn(),
  }
})

import { checkProjectAccess } from '../../apps/api/src/lib/access.js'
import * as controller from '../../apps/api/src/modules/data-access/data-access.controller.js'
import * as migrationService from '../../apps/api/src/modules/data-access/data-access-migration.service.js'

function reply() {
  const value = { statusCode: 200, payload: undefined as unknown, status: vi.fn(), send: vi.fn() }
  value.status.mockImplementation((code) => { value.statusCode = code; return value })
  value.send.mockImplementation((payload) => { value.payload = payload; return value })
  return value
}

const user = { kind: 'platform_user' as const, userId: 'usr_1', uid: 7 }
const report = {
  migrationId: 'mig_1', projectId: 'proj_1', status: 'preview_ready', phase: 'preview',
  sourceDigest: 'a'.repeat(64), rollbackPreviewDigest: null, requiredRecoveryDigest: null,
  recoveryTarget: null, appliedAt: null, canApply: true, canRollback: false,
  summary: { totalTables: 1, migratedTables: 1, preservedScopedTables: 0, inferredOperationCount: 1, blockerCount: 0, destructiveChangeCount: 0 },
  blockers: [], destructiveChanges: [], tables: [], error: null,
}

describe('data access migration controller', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(checkProjectAccess).mockResolvedValue(true)
    vi.mocked(migrationService.getDataAccessMigration).mockResolvedValue(report as never)
    vi.mocked(migrationService.previewDataAccessMigration).mockResolvedValue(report as never)
    vi.mocked(migrationService.applyDataAccessMigration).mockResolvedValue({ ...report, status: 'applied' } as never)
    vi.mocked(migrationService.recoverDataAccessMigration).mockResolvedValue(report as never)
    vi.mocked(migrationService.previewDataAccessMigrationRollback).mockResolvedValue({ ...report, rollbackPreviewDigest: 'b'.repeat(64) } as never)
    vi.mocked(migrationService.rollbackDataAccessMigration).mockResolvedValue({ ...report, status: 'rolled_back' } as never)
  })

  it('returns null status and passes platform uid to preview', async () => {
    vi.mocked(migrationService.getDataAccessMigration).mockResolvedValueOnce(null)
    const getReply = reply()
    await controller.getDataAccessMigration({ params: { projectId: 'proj_1' }, user } as never, getReply as never)
    expect(getReply.payload).toEqual({ success: true, data: null })

    const previewReply = reply()
    await controller.previewDataAccessMigration({ params: { projectId: 'proj_1' }, body: {}, user } as never, previewReply as never)
    expect(migrationService.previewDataAccessMigration).toHaveBeenCalledWith('proj_1', 'usr_1', {})
  })

  it.each([
    ['applyDataAccessMigration', 'applyDataAccessMigration', { sourceDigest: 'a'.repeat(64), confirmInferredPolicies: true, confirmDestructiveChanges: false, projectAlias: 'demo' }],
    ['recoverDataAccessMigration', 'recoverDataAccessMigration', { expectedRecoveryDigest: 'a'.repeat(64), projectAlias: 'demo' }],
    ['rollbackDataAccessMigration', 'rollbackDataAccessMigration', { rollbackPreviewDigest: 'b'.repeat(64), projectAlias: 'demo' }],
  ])('routes %s with validated migration identity', async (handlerName, serviceName, body) => {
    const response = reply()
    await (controller[handlerName as keyof typeof controller] as never as Function)({
      params: { projectId: 'proj_1', migrationId: 'mig_1' }, body, user,
    }, response)
    expect(migrationService[serviceName as keyof typeof migrationService]).toHaveBeenCalledWith('proj_1', 'mig_1', body)
    expect(response.payload).toMatchObject({ success: true })
  })

  it('rejects non-platform actors before service calls', async () => {
    const response = reply()
    await controller.getDataAccessMigration({
      params: { projectId: 'proj_1' },
      user: {
        kind: 'apikey', projectId: 'proj_1', role: 'anon',
        apiKeyId: 42, apiKeyPrefix: 'dru_fixture1',
      },
    } as never, response as never)
    expect(response.statusCode).toBe(401)
    expect(migrationService.getDataAccessMigration).not.toHaveBeenCalled()
  })

  it('maps input, conflict, and not-found errors without leaking details', async () => {
    const cases = [
      [new migrationService.DataAccessMigrationInputError('secret input'), 400],
      [new migrationService.DataAccessMigrationConflictError('secret conflict'), 409],
      [new migrationService.DataAccessMigrationNotFoundError('secret missing'), 404],
    ] as const
    for (const [error, status] of cases) {
      vi.mocked(migrationService.getDataAccessMigration).mockRejectedValueOnce(error)
      const response = reply()
      await controller.getDataAccessMigration({ params: { projectId: 'proj_1' }, user } as never, response as never)
      expect(response.statusCode).toBe(status)
      expect(JSON.stringify(response.payload)).not.toContain('secret')
    }
  })

  it('never returns internal snapshots or physical roles', async () => {
    const response = reply()
    await controller.getDataAccessMigration({ params: { projectId: 'proj_1' }, user } as never, response as never)
    const json = JSON.stringify(response.payload)
    expect(json).not.toContain('sourceSnapshot')
    expect(json).not.toContain('druvia_v1_s_')
  })
})
