// apps/api/src/modules/environment/environment.routes.ts
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { authenticate } from '../../middleware/auth.js';
import type { JwtPayload } from '../../middleware/auth.js';
import { checkProjectAccess } from '../../lib/access.js';
import * as environmentService from './environment.service.js';

interface ProjectParams {
  projectId: string;
}

interface EnvParams extends ProjectParams {
  envName: string;
}

interface CreateEnvBody {
  envName: string;
  cloneData?: boolean;
}

// Helper to verify project access
async function verifyProjectAccess(
  request: FastifyRequest<{ Params: ProjectParams }>,
  reply: FastifyReply
): Promise<boolean> {
  const userId = (request.user as JwtPayload | undefined)?.userId;
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

export async function environmentRoutes(app: FastifyInstance) {
  // All routes require authentication
  app.addHook('preHandler', authenticate);

  // List environments for a project
  app.get(
    '/projects/:projectId/environments',
    async (request: FastifyRequest<{ Params: ProjectParams }>, reply: FastifyReply) => {
      if (!(await verifyProjectAccess(request, reply))) return;
      const { projectId } = request.params;

      try {
        const environments = await environmentService.listEnvironments(projectId);
        return reply.send({ success: true, data: environments });
      } catch (error) {
        request.log.error(error);
        return reply.status(500).send({
          success: false,
          error: { code: 'INTERNAL_ERROR', message: 'Failed to list environments' },
        });
      }
    }
  );

  // Create a new environment
  app.post(
    '/projects/:projectId/environments',
    async (
      request: FastifyRequest<{ Params: ProjectParams; Body: CreateEnvBody }>,
      reply: FastifyReply
    ) => {
      if (!(await verifyProjectAccess(request, reply))) return;
      const { projectId } = request.params;
      const { envName, cloneData } = request.body;

      if (!envName || !/^[a-z][a-z0-9_]*$/.test(envName)) {
        return reply.status(400).send({
          success: false,
          error: {
            code: 'INVALID_ENV_NAME',
            message: 'Environment name must start with a letter and contain only lowercase letters, numbers, and underscores',
          },
        });
      }

      if (envName === 'prod') {
        return reply.status(400).send({
          success: false,
          error: { code: 'RESERVED_NAME', message: 'Cannot create environment named "prod"' },
        });
      }

      try {
        const environment = await environmentService.createEnvironment(
          projectId,
          envName,
          cloneData ?? false
        );
        return reply.status(201).send({ success: true, data: environment });
      } catch (error) {
        request.log.error(error);
        if (error instanceof Error && error.message === 'Project not found') {
          return reply.status(404).send({
            success: false,
            error: { code: 'PROJECT_NOT_FOUND', message: 'Project not found' },
          });
        }
        return reply.status(500).send({
          success: false,
          error: { code: 'INTERNAL_ERROR', message: 'Failed to create environment' },
        });
      }
    }
  );

  // Delete an environment
  app.delete(
    '/projects/:projectId/environments/:envName',
    async (request: FastifyRequest<{ Params: EnvParams }>, reply: FastifyReply) => {
      if (!(await verifyProjectAccess(request, reply))) return;
      const { projectId, envName } = request.params;

      try {
        const deleted = await environmentService.deleteEnvironment(projectId, envName);
        if (!deleted) {
          return reply.status(404).send({
            success: false,
            error: { code: 'ENV_NOT_FOUND', message: 'Environment not found' },
          });
        }
        return reply.status(204).send();
      } catch (error) {
        request.log.error(error);
        if (error instanceof Error && error.message === 'Cannot delete production environment') {
          return reply.status(400).send({
            success: false,
            error: { code: 'CANNOT_DELETE_PROD', message: 'Cannot delete production environment' },
          });
        }
        return reply.status(500).send({
          success: false,
          error: { code: 'INTERNAL_ERROR', message: 'Failed to delete environment' },
        });
      }
    }
  );
}
