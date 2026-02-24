import type { FastifyInstance } from 'fastify';
import * as controller from './file.controller.js';
import { authenticate } from '../../middleware/auth.js';

export async function fileRoutes(app: FastifyInstance) {
  // All file routes require authentication
  app.addHook('preHandler', authenticate);

  // Upload file
  app.post('/tenants/:tenantId/files', controller.uploadFile as never);

  // List files
  app.get('/tenants/:tenantId/files', controller.listFiles as never);

  // Get file by ID
  app.get('/files/:fileId', controller.getFile);

  // Get signed URL
  app.get('/files/:fileId/signed-url', controller.getSignedUrl as never);

  // Delete file
  app.delete('/files/:fileId', controller.deleteFile);
}
