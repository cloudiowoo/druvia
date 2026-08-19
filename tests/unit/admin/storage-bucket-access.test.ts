import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const source = readFileSync(
  resolve(process.cwd(), 'apps/admin/src/components/storage/BucketAccessSettingsDialog.tsx'),
  'utf8'
)
const pageSource = readFileSync(
  resolve(process.cwd(), 'apps/admin/src/app/t/[tenantId]/p/[projectId]/storage/page.tsx'),
  'utf8'
)

describe('bucket access settings UI contract', () => {
  it.each(['仅管理员', '仅本人', '登录可读，个人可写'])(
    'contains the user-facing preset label %s',
    (label) => expect(source).toContain(label)
  )

  it('keeps public access independent and submits only dirty fields', () => {
    expect(source).toContain('公开访问')
    expect(source).toContain('const patch: BucketSettingsPatch = {}')
    expect(source).toContain('Object.keys(patch).length === 0')
    expect(source).toContain('disabled={!isDirty || !isSizeValid || submitting}')
    expect(source).toContain('单文件上限必须大于 0 且不超过 50 MB')
  })

  it('allows size and MIME restrictions to be set during bucket creation', () => {
    expect(pageSource).toContain('newBucketSizeMb')
    expect(pageSource).toContain('newBucketMimeTypes')
    expect(pageSource).toContain('fileSizeLimit: normalizedNewBucketSize')
    expect(pageSource).toContain('allowedMimeTypes: normalizedNewBucketMimes')
    expect(pageSource).toContain('<Switch')
  })
})
