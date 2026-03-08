// apps/api/src/modules/api-keys/api-keys.routes.ts
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { authenticate } from '../../middleware/auth.js';
import { checkProjectAccess } from '../../lib/access.js';
import * as apiKeysService from './api-keys.service.js';

interface CreateApiKeyBody {
  name?: string;
}

interface ApiKeyParams {
  projectId: string;
  keyId: string;
}

// Helper to verify project access
async function verifyProjectAccess(
  request: FastifyRequest<{ Params: { projectId: string } }>,
  reply: FastifyReply
): Promise<boolean> {
  const userId = (request as unknown as { userId?: string }).userId;
  if (!userId) {
    reply.status(401).send({
      success: false,
      error: { code: 'UNAUTHORIZED', message: 'Authentication required' },
    });
    return false;
  }

  const { projectId } = request.params;
  const hasAccess = await checkProjectAccess(userId, projectId);
  if (!hasAccess) {
    reply.status(403).send({
      success: false,
      error: { code: 'FORBIDDEN', message: 'No access to this project' },
    });
    return false;
  }

  return true;
}

export async function apiKeysRoutes(app: FastifyInstance) {
  // Public endpoint: Validate an API key (for MCP server)
  // This must be registered BEFORE the authenticate hook
  app.post(
    '/api-keys/validate',
    async (
      request: FastifyRequest<{ Body: { key: string } }>,
      reply: FastifyReply
    ) => {
      const { key } = request.body || {};
      if (!key) {
        return reply.status(400).send({
          success: false,
          error: { code: 'INVALID_REQUEST', message: 'API key is required' },
        });
      }
      const result = await apiKeysService.validateApiKey(key);
      return reply.send({ success: true, data: result });
    }
  );

  // Protected routes - require authentication
  app.register(async (protectedApp) => {
    protectedApp.addHook('preHandler', authenticate);

    // List API keys for a project
    protectedApp.get(
      '/projects/:projectId/api-keys',
      async (
        request: FastifyRequest<{ Params: { projectId: string } }>,
        reply: FastifyReply
      ) => {
        if (!(await verifyProjectAccess(request, reply))) return;
        const { projectId } = request.params;
        const keys = await apiKeysService.listApiKeys(projectId);
        return reply.send({ success: true, data: keys });
      }
    );

    // Create a new API key
    protectedApp.post(
      '/projects/:projectId/api-keys',
      async (
        request: FastifyRequest<{
          Params: { projectId: string };
          Body: CreateApiKeyBody;
        }>,
        reply: FastifyReply
      ) => {
        if (!(await verifyProjectAccess(request, reply))) return;
        const { projectId } = request.params;
        const { name } = request.body || {};
        const result = await apiKeysService.createApiKey(projectId, name);
        return reply.status(201).send({ success: true, data: result });
      }
    );

    // Delete an API key
    protectedApp.delete(
      '/projects/:projectId/api-keys/:keyId',
      async (
        request: FastifyRequest<{ Params: ApiKeyParams }>,
        reply: FastifyReply
      ) => {
        if (!(await verifyProjectAccess(request, reply))) return;
        const { projectId, keyId } = request.params;
        const deleted = await apiKeysService.deleteApiKey(
          parseInt(keyId, 10),
          projectId
        );
        if (!deleted) {
          return reply.status(404).send({
            success: false,
            error: { code: 'NOT_FOUND', message: 'API key not found' },
          });
        }
        return reply.status(204).send();
      }
    );
  });
}
