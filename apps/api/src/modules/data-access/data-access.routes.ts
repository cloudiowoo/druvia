import type { FastifyInstance } from 'fastify'
import { authenticate } from '../../middleware/auth.js'
import * as controller from './data-access.controller.js'
import { requireProjectCapability } from '../../lib/project-authorization.js'

export async function dataAccessRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authenticate)
  app.addHook('preHandler', requireProjectCapability('data_access:manage'))

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
    '/projects/:projectId/data-access/authorization-projection',
    controller.getActiveAuthorizationProjection as never
  )
  app.post(
    '/projects/:projectId/data-access/authorization-projection/preview',
    controller.previewAuthorizationProjection as never
  )
  app.post(
    '/projects/:projectId/data-access/authorization-projection/:operationId/apply',
    controller.applyAuthorizationProjection as never
  )
  app.post(
    '/projects/:projectId/data-access/authorization-projection/:operationId/recover',
    controller.recoverAuthorizationProjection as never
  )
  app.post(
    '/projects/:projectId/data-access/tables/:tableName/adoption/preview',
    controller.previewPolicyAdoption as never
  )
  app.post(
    '/projects/:projectId/data-access/tables/:tableName/adoption/apply',
    controller.applyPolicyAdoption as never
  )
  app.post(
    '/projects/:projectId/data-access/tables/:tableName/reconcile/preview',
    controller.previewPolicyReconcile as never
  )
  app.post(
    '/projects/:projectId/data-access/tables/:tableName/reconcile/apply',
    controller.applyPolicyReconcile as never
  )
  app.get(
    '/projects/:projectId/data-access/policy-operation',
    controller.getActivePolicyOperation as never
  )
  app.post(
    '/projects/:projectId/data-access/policy-operations/:operationId/recover',
    controller.recoverPolicyOperation as never
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
