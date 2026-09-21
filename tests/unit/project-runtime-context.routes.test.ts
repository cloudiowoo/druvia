import { describe, expect, it, vi } from 'vitest'

const { authenticate, requireProjectCapability } = vi.hoisted(() => ({
  authenticate: vi.fn(),
  requireProjectCapability: vi.fn(() => vi.fn()),
}))

vi.mock('../../apps/api/src/middleware/auth.js', () => ({ authenticate }))
vi.mock('../../apps/api/src/lib/project-authorization.js', () => ({ requireProjectCapability }))
vi.mock('../../apps/api/src/modules/project/project-runtime-context.controller.js', () => ({
  getRuntimeContext: vi.fn(),
  setRuntimeContext: vi.fn(),
  disableRuntimeContext: vi.fn(),
}))

import { projectRuntimeContextRoutes } from '../../apps/api/src/modules/project/project-runtime-context.routes.js'

describe('project runtime context routes', () => {
  it('binds owner-controlled mutations separately from project-readable state', async () => {
    const app = {
      addHook: vi.fn(),
      get: vi.fn(),
      put: vi.fn(),
      delete: vi.fn(),
    }

    await projectRuntimeContextRoutes(app as never)

    expect(app.addHook).toHaveBeenCalledWith('preHandler', authenticate)
    expect(requireProjectCapability).toHaveBeenCalledWith('project:read')
    expect(requireProjectCapability).toHaveBeenCalledWith('runtime_context:manage')
    expect(app.get).toHaveBeenCalledWith(
      '/projects/:projectId/runtime-context',
      expect.objectContaining({ preHandler: expect.any(Function) }),
      expect.any(Function),
    )
    expect(app.put).toHaveBeenCalledWith(
      '/projects/:projectId/runtime-context',
      expect.objectContaining({ preHandler: expect.any(Function) }),
      expect.any(Function),
    )
    expect(app.delete).toHaveBeenCalledWith(
      '/projects/:projectId/runtime-context',
      expect.objectContaining({ preHandler: expect.any(Function) }),
      expect.any(Function),
    )
  })
})
