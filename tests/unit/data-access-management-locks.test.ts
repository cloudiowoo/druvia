import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

function source(path: string): string {
  return readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8')
}

describe('data access migration management-write lock contracts', () => {
  it('serializes project schema and metadata mutations through the shared lock helper', () => {
    const table = source('apps/api/src/modules/table/table.controller.ts')
    const dataAccess = source('apps/api/src/modules/data-access/data-access.service.ts')
    const realtime = source('apps/api/src/modules/realtime/realtime.controller.ts')

    expect(table.match(/withSchemaDataAccessMutationLock/g)?.length).toBeGreaterThanOrEqual(9)
    expect(dataAccess).toContain('withProjectDataAccessMutationLock(projectId')
    expect(realtime).toContain('withProjectDataAccessMutationLock(projectId, configure)')
  })

  it('uses the deployment-wide exclusive mode for broad or destructive operations', () => {
    const sources = [
      source('apps/api/src/modules/sql/sql.controller.ts'),
      source('apps/api/src/modules/backup/backup.service.ts'),
      source('apps/api/src/modules/project/project.service.ts'),
      source('apps/api/src/modules/environment/environment.service.ts'),
      source('apps/api/src/modules/table/table.controller.ts'),
    ]

    for (const value of sources) {
      expect(value).toContain("globalMode: 'exclusive'")
    }
  })

  it('maps cooperative and database delete guards to the stable conflict boundary', () => {
    const project = source('apps/api/src/modules/project/project.controller.ts')
    const tenant = source('apps/api/src/modules/tenant/tenant.controller.ts')
    const lock = source('apps/api/src/modules/data-access/data-access-mutation-lock.ts')

    expect(project).toContain('isDataAccessMigrationDeleteGuardError(error)')
    expect(tenant).toContain('isDataAccessMigrationDeleteGuardError(error)')
    expect(project).toContain('DATA_ACCESS_MIGRATION_IN_PROGRESS')
    expect(tenant).toContain('DATA_ACCESS_MIGRATION_IN_PROGRESS')
    expect(lock).toContain("value?.code === '55006'")
    expect(lock).toContain("druvia_data_access_migrations_inflight_delete_guard")
  })
})
