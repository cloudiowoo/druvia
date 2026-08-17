import type { FastifyInstance } from 'fastify'
import { authenticate } from '../../middleware/auth.js'
import * as controller from './data-access.controller.js'

export async function dataAccessRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authenticate)

  app.get(
    '/projects/:projectId/data-access/tables/:tableName',
    controller.getTableDataAccess as never
  )
  app.put(
    '/projects/:projectId/data-access/tables/:tableName',
    controller.updateTableDataAccess as never
  )
}
