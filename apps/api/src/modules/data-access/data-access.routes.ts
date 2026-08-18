import type { FastifyInstance } from 'fastify'
import { authenticate } from '../../middleware/auth.js'
import * as controller from './data-access.controller.js'

export async function dataAccessRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authenticate)

  app.get(
    '/projects/:projectId/data-access/overview',
    controller.getProjectDataAccessOverview as never
  )
  app.get(
    '/projects/:projectId/data-access/tables/:tableName',
    controller.getTableDataAccess as never
  )
  app.put(
    '/projects/:projectId/data-access/tables/:tableName',
    controller.updateTableDataAccess as never
  )
  app.get(
    '/projects/:projectId/data-access/migration',
    controller.getDataAccessMigration as never
  )
  app.post(
    '/projects/:projectId/data-access/migration/preview',
    controller.previewDataAccessMigration as never
  )
  app.post(
    '/projects/:projectId/data-access/migration/:migrationId/apply',
    controller.applyDataAccessMigration as never
  )
  app.post(
    '/projects/:projectId/data-access/migration/:migrationId/recover',
    controller.recoverDataAccessMigration as never
  )
  app.post(
    '/projects/:projectId/data-access/migration/:migrationId/rollback-preview',
    controller.previewDataAccessMigrationRollback as never
  )
  app.post(
    '/projects/:projectId/data-access/migration/:migrationId/rollback',
    controller.rollbackDataAccessMigration as never
  )
}
