import type { FastifyInstance } from 'fastify';
import * as controller from './realtime.controller.js';
import { authenticate } from '../../middleware/auth.js';

export async function realtimeRoutes(app: FastifyInstance) {
  // All realtime routes require authentication
  app.register(async (protectedApp) => {
    protectedApp.addHook('preHandler', authenticate);

    // ============================================
    // Subscriptions
    // ============================================

    // List all table subscriptions for a project
    protectedApp.get(
      '/projects/:projectId/realtime/subscriptions',
      controller.listSubscriptions as never
    );

    // Configure a table subscription
    protectedApp.post(
      '/projects/:projectId/realtime/subscriptions/:tableName',
      controller.configureSubscription as never
    );

    // ============================================
    // Configuration
    // ============================================

    // Get realtime configuration
    protectedApp.get(
      '/projects/:projectId/realtime/config',
      controller.getConfig as never
    );

    // ============================================
    // Code Examples
    // ============================================

    // Get subscription code example for a table
    protectedApp.get(
      '/projects/:projectId/realtime/subscriptions/:tableName/example',
      controller.getSubscriptionExample as never
    );

    // ============================================
    // Tables
    // ============================================

    // List all tables in project schema
    protectedApp.get(
      '/projects/:projectId/realtime/tables',
      controller.listTables as never
    );
  });
}
