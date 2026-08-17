import { describe, expect, it } from 'vitest'
import { resolveDataScopeRole } from '../../apps/api/src/modules/data-access/data-scope-role.js'

describe('resolveDataScopeRole', () => {
  it('generates a deterministic versioned role for a project production scope', () => {
    const role = resolveDataScopeRole({
      projectId: 'proj_123',
      actor: 'authenticated',
    })

    expect(role).toMatch(/^druvia_v1_s_[a-f0-9]{20}_user$/)
    expect(role).toBe(resolveDataScopeRole({
      projectId: 'proj_123',
      actor: 'authenticated',
    }))
  })

  it('separates anonymous, project, and environment scopes', () => {
    const user = resolveDataScopeRole({
      projectId: 'proj_123',
      actor: 'authenticated',
    })
    const anon = resolveDataScopeRole({
      projectId: 'proj_123',
      actor: 'anonymous',
    })
    const otherProject = resolveDataScopeRole({
      projectId: 'proj_456',
      actor: 'authenticated',
    })
    const development = resolveDataScopeRole({
      projectId: 'proj_123',
      environmentId: 42,
      actor: 'authenticated',
    })

    expect(anon).toMatch(/_anon$/)
    expect(anon).not.toBe(user)
    expect(otherProject).not.toBe(user)
    expect(development).not.toBe(user)
  })

  it('rejects unsupported actor values at runtime', () => {
    expect(() => resolveDataScopeRole({
      projectId: 'proj_123',
      actor: 'worker',
    } as never)).toThrow('Unsupported data scope actor')
  })

  it('rejects invalid immutable scope identifiers', () => {
    expect(() => resolveDataScopeRole({
      projectId: '  ',
      actor: 'authenticated',
    })).toThrow('Project ID is required')

    expect(() => resolveDataScopeRole({
      projectId: 'proj_123',
      environmentId: 0,
      actor: 'authenticated',
    })).toThrow('Environment ID must be a positive integer')
  })
})
