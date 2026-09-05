import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

function read(path: string) {
  return readFileSync(path, 'utf8')
}

describe('admin project read-only UI', () => {
  it('blocks direct project routes that lack their server-provided capability', () => {
    const layout = read('apps/admin/src/app/t/[tenantId]/p/[projectId]/layout.tsx')
    expect(layout).toContain('requiredProjectCapability(pathname)')
    expect(layout).toContain('hasProjectCapability(currentProjectAccess, requiredCapability)')
  })

  it('keeps SQL import and DDL controls unavailable without database:write', () => {
    const page = read('apps/admin/src/app/t/[tenantId]/p/[projectId]/database/page.tsx')
    const importExport = read('apps/admin/src/components/SqlImportExport.tsx')
    expect(page).toContain("can('database:write')")
    expect(page).toContain('canImport={canWrite}')
    expect(importExport).toContain('canImport = true')
  })

  it('makes table structures and row data read-only for viewers', () => {
    const list = read('apps/admin/src/app/t/[tenantId]/p/[projectId]/tables/page.tsx')
    const structure = read('apps/admin/src/app/t/[tenantId]/p/[projectId]/tables/[tableName]/page.tsx')
    const data = read('apps/admin/src/app/t/[tenantId]/p/[projectId]/tables/[tableName]/data/page.tsx')
    const grid = read('apps/admin/src/components/SvarDataGrid.tsx')
    expect(list).toContain("can('database:write')")
    expect(structure).toContain('const canWrite = can(\'database:write\')')
    expect(data).toContain('readOnly={!canWrite}')
    expect(grid).toContain('readOnly = false')
  })
})
