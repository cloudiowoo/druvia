import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../apps/api/src/db/index.js', () => ({ queryOne: vi.fn() }))

import { queryOne } from '../../apps/api/src/db/index.js'
import {
  claimLatestCompletedProjectionRecovery,
  createProjectionOperation,
  getEffectiveFailClosedProjectionOperationWithClient,
  getActiveProjectionOperation,
  getProjectionOperation,
  renewProjectionOperationWriterLease,
  transitionProjectionOperation,
} from '../../apps/api/src/modules/data-access/data-access-projection-operation.repository.js'

const now = new Date('2026-09-16T00:00:00Z')
const row = {
  id: '1', operation_id: 'dapo_1', project_id: 'proj_1', schema_name: 'dru_proj_1',
  status: 'preview_ready', phase: 'preview', contract: {}, baseline_revisions: { orders: '2' },
  source_metadata: { version: 3 }, target_metadata: { version: 3 },
  dependency_snapshot: { digest: 'a'.repeat(64) }, dependency_digest: 'a'.repeat(64),
  source_digest: 'b'.repeat(64), target_digest: 'c'.repeat(64), source_resource_version: '7',
  target_resource_version: null, request_digest: 'd'.repeat(64), writer_epoch: null,
  write_deadline_at: null, created_by: 'usr_1', error_code: null, error_message: null,
  created_at: now, started_at: null, completed_at: null, updated_at: now,
}

describe('data access projection operation repository', () => {
  beforeEach(() => vi.clearAllMocks())

  it('persists the immutable batch payload', async () => {
    const client = { query: vi.fn().mockResolvedValue({ rows: [row] }) }
    await createProjectionOperation(client as never, {
      operationId: 'dapo_1', projectId: 'proj_1', schemaName: 'dru_proj_1',
      contract: {} as never, baselineRevisions: { orders: '2' },
      sourceMetadata: { version: 3 }, targetMetadata: { version: 3 },
      dependencySnapshot: { digest: 'a'.repeat(64) } as never,
      dependencyDigest: 'a'.repeat(64), sourceDigest: 'b'.repeat(64),
      targetDigest: 'c'.repeat(64), sourceResourceVersion: 7n,
      requestDigest: 'd'.repeat(64), createdBy: 'usr_1',
    })
    expect(client.query).toHaveBeenCalledWith(
      expect.stringContaining('druvia_data_access_projection_operations'),
      expect.arrayContaining(['dapo_1', 'proj_1', 'dru_proj_1', '7'])
    )
  })

  it('loads operations only within project scope', async () => {
    vi.mocked(queryOne).mockResolvedValueOnce(row as never)
    await expect(getProjectionOperation('proj_1', 'dapo_1')).resolves.toMatchObject({
      operationId: 'dapo_1', sourceResourceVersion: 7n,
    })
    expect(queryOne).toHaveBeenCalledWith(
      expect.stringContaining('project_id = $1 AND operation_id = $2'),
      ['proj_1', 'dapo_1']
    )
  })

  it('loads fail-closed provenance unless a newer completed batch replaced it', async () => {
    const client = { query: vi.fn().mockResolvedValue({ rows: [row] }) }
    await expect(getEffectiveFailClosedProjectionOperationWithClient(client as never, 'proj_1'))
      .resolves.toMatchObject({ operationId: 'dapo_1' })
    expect(client.query).toHaveBeenCalledWith(
      expect.stringMatching(/error_code = \$2[\s\S]*NOT EXISTS[\s\S]*newer\.status = 'completed'/),
      ['proj_1', 'DATA_ACCESS_PROJECTION_FAILED_CLOSED']
    )
  })

  it('claims recovery only when the operation is the latest completed batch', async () => {
    const client = { query: vi.fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [row] })
      .mockResolvedValueOnce({ rows: [] }) }
    await expect(claimLatestCompletedProjectionRecovery(
      client as never,
      'proj_1',
      'dapo_1',
      'writer_1',
      new Date('2026-09-16T00:00:30Z')
    )).resolves.toMatchObject({ operationId: 'dapo_1' })
    expect(client.query.mock.calls[0]).toEqual(['BEGIN'])
    expect(client.query.mock.calls[1]).toEqual([
      expect.stringMatching(/status = 'superseded'[\s\S]*status = 'preview_ready'/),
      ['proj_1', 'dapo_1'],
    ])
    expect(client.query.mock.calls[2]).toEqual([
      expect.stringMatching(
        /current\.status = 'completed'[\s\S]*NOT EXISTS[\s\S]*newer\.target_resource_version IS NOT NULL/
      ),
      ['proj_1', 'dapo_1', 'writer_1', new Date('2026-09-16T00:00:30Z')],
    ])
    expect(client.query.mock.calls[3]).toEqual(['COMMIT'])
  })

  it('prefers unresolved writers and successful apply evidence over failed previews', async () => {
    vi.mocked(queryOne).mockResolvedValueOnce(row as never)
    await getActiveProjectionOperation('proj_1')
    expect(queryOne).toHaveBeenCalledWith(
      expect.stringMatching(
        /status IN \('applying', 'recovering', 'recovery_required'\)[\s\S]*target_resource_version IS NOT NULL[\s\S]*DATA_ACCESS_PROJECTION_FAILED_CLOSED/
      ),
      ['proj_1']
    )
  })

  it('uses status CAS and writer epoch lease renewal', async () => {
    const client = { query: vi.fn()
      .mockResolvedValueOnce({ rows: [{ ...row, status: 'applying' }] })
      .mockResolvedValueOnce({ rows: [{ ...row, status: 'applying' }] }) }
    await transitionProjectionOperation(client as never, 'dapo_1', ['preview_ready'], {
      status: 'applying', phase: 'source_check', writerEpoch: 'writer_1',
    })
    await renewProjectionOperationWriterLease(
      client as never, 'dapo_1', 'applying', 'writer_1', new Date('2026-09-16T00:00:30Z')
    )
    expect(client.query.mock.calls[0][0]).toContain('status = ANY($2::text[])')
    expect(client.query.mock.calls[1][0]).toMatch(/writer_epoch = \$3[\s\S]*write_deadline_at > NOW\(\)/)
  })
})
