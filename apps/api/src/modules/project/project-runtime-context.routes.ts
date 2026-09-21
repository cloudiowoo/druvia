import type { FastifyInstance } from 'fastify'
import { authenticate } from '../../middleware/auth.js'
import { requireProjectCapability } from '../../lib/project-authorization.js'
import {
  disableRuntimeContext,
  getRuntimeContext,
  setRuntimeContext,
} from './project-runtime-context.controller.js'

export async function projectRuntimeContextRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authenticate)

  app.get('/projects/:projectId/runtime-context', {
    preHandler: requireProjectCapability('project:read'),
  }, getRuntimeContext as never)
  app.put('/projects/:projectId/runtime-context', {
    preHandler: requireProjectCapability('runtime_context:manage'),
  }, setRuntimeContext as never)
  app.delete('/projects/:projectId/runtime-context', {
    preHandler: requireProjectCapability('runtime_context:manage'),
  }, disableRuntimeContext as never)
}
