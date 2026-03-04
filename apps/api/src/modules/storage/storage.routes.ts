import type { FastifyInstance } from 'fastify';
import * as controller from './storage.controller.js';
import { authenticate } from '../../middleware/auth.js';

export async function storageRoutes(app: FastifyInstance) {
  // ============================================
  // Public routes (no authentication required)
  // ============================================

  // Signed URL download (signature verification instead of JWT)
  app.get('/storage/download/*', controller.downloadSignedUrl as never);

  // Public bucket download (no authentication, checks bucket.public)
  app.get('/storage/public/:projectId/:bucketName/*', controller.downloadPublic as never);

  // ============================================
  // Protected routes (authentication required)
  // ============================================

  // All remaining storage routes require authentication
  app.register(async (protectedApp) => {
    protectedApp.addHook('preHandler', authenticate);

    // ============================================
    // Bucket routes
    // ============================================

    // List buckets
    protectedApp.get('/projects/:projectId/storage/buckets', controller.listBuckets as never);

    // Create bucket
    protectedApp.post('/projects/:projectId/storage/buckets', controller.createBucket as never);

    // Get bucket
    protectedApp.get('/projects/:projectId/storage/buckets/:bucketName', controller.getBucket as never);

    // Update bucket
    protectedApp.patch('/projects/:projectId/storage/buckets/:bucketName', controller.updateBucket as never);

    // Delete bucket
    protectedApp.delete('/projects/:projectId/storage/buckets/:bucketName', controller.deleteBucket as never);

    // ============================================
    // Object routes
    // ============================================

    // List objects
    protectedApp.get('/projects/:projectId/storage/buckets/:bucketName/objects', controller.listObjects as never);

    // Upload object
    protectedApp.post('/projects/:projectId/storage/buckets/:bucketName/objects', controller.uploadObject as never);

    // Download object (wildcard path)
    protectedApp.get('/projects/:projectId/storage/buckets/:bucketName/objects/*', controller.downloadObject as never);

    // Delete object (wildcard path)
    protectedApp.delete('/projects/:projectId/storage/buckets/:bucketName/objects/*', controller.deleteObject as never);

    // Get signed URL (use body for object path instead of wildcard)
    protectedApp.post('/projects/:projectId/storage/buckets/:bucketName/signed-url', controller.getSignedUrl as never);
  });
}
