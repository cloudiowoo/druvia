import type { FastifyInstance } from 'fastify';
import * as controller from './auth-admin.controller.js';
import { authenticate } from '../../middleware/auth.js';

export async function authAdminRoutes(app: FastifyInstance) {
  // All auth admin routes require authentication
  app.register(async (protectedApp) => {
    protectedApp.addHook('preHandler', authenticate);

    // ============================================
    // Supported Providers (read-only)
    // ============================================

    // List all supported auth providers
    protectedApp.get('/auth/providers/supported', controller.getSupportedProviders as never);

    // ============================================
    // Provider Configuration
    // ============================================

    // List configured providers for a project
    protectedApp.get('/projects/:projectId/auth/providers', controller.listProviders as never);

    // Create/configure a provider
    protectedApp.post('/projects/:projectId/auth/providers', controller.createProvider as never);

    // Get provider details
    protectedApp.get('/projects/:projectId/auth/providers/:provider', controller.getProvider as never);

    // Update provider configuration
    protectedApp.patch('/projects/:projectId/auth/providers/:provider', controller.updateProvider as never);

    // Delete/remove provider
    protectedApp.delete('/projects/:projectId/auth/providers/:provider', controller.deleteProvider as never);

    // ============================================
    // Auth Configuration
    // ============================================

    // Get auth config
    protectedApp.get('/projects/:projectId/auth/config', controller.getAuthConfig as never);

    // Update auth config
    protectedApp.put('/projects/:projectId/auth/config', controller.updateAuthConfig as never);

    // ============================================
    // User Management
    // ============================================

    // List users
    protectedApp.get('/projects/:projectId/auth/users', controller.listUsers as never);

    // Get user
    protectedApp.get('/projects/:projectId/auth/users/:userId', controller.getUser as never);

    // Update user (status)
    protectedApp.patch('/projects/:projectId/auth/users/:userId', controller.updateUser as never);

    // Delete user
    protectedApp.delete('/projects/:projectId/auth/users/:userId', controller.deleteUser as never);
  });
}
