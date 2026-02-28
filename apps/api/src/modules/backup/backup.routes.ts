import type { FastifyInstance } from 'fastify';
import * as controller from './backup.controller.js';
import { authenticate } from '../../middleware/auth.js';

export async function backupRoutes(app: FastifyInstance) {
  // All backup routes require authentication
  app.addHook('preHandler', authenticate);

  // Global backup routes (admin)
  app.get('/backups', controller.listAllBackups as never);

  // Create backup
  app.post('/tenants/:tenantId/backups', controller.createBackup as never);

  // List backups
  app.get('/tenants/:tenantId/backups', controller.listBackups as never);

  // Get backup
  app.get('/backups/:backupId', controller.getBackup as never);

  // Delete backup
  app.delete('/backups/:backupId', controller.deleteBackup as never);

  // Restore backup
  app.post('/backups/:backupId/restore', controller.restoreBackup as never);

  // Get download URL
  app.get('/backups/:backupId/download', controller.getDownloadUrl as never);
}
