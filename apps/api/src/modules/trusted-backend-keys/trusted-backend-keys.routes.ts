import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { authenticate } from '../../middleware/auth.js';
import type { JwtPayload } from '../../middleware/auth.js';
import { checkProjectAccess } from '../../lib/access.js';
import {
  createTrustedBackendKey,
  deleteTrustedBackendKey,
  listTrustedBackendKeys,
  TRUSTED_BACKEND_KEY_SCOPES,
  type TrustedBackendKeyScope,
} from './trusted-backend-keys.service.js';

interface CreateTrustedBackendKeyBody {
  name?: string;
  scopes?: TrustedBackendKeyScope[];
}

interface TrustedBackendKeyParams {
  projectId: string;
  keyId: string;
}

async function verifyProjectAccess(
  request: FastifyRequest<{ Params: { projectId: string } }>,
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

  const hasAccess = await checkProjectAccess(userId, request.params.projectId);
  if (!hasAccess) {
    reply.status(403).send({
      success: false,
      error: { code: 'FORBIDDEN', message: 'No access to this project' },
    });
    return false;
  }

  return true;
}

function isValidScopes(scopes: unknown): scopes is TrustedBackendKeyScope[] {
  if (scopes === undefined) return true;
  if (!Array.isArray(scopes)) return false;
  const allowed = new Set<string>(TRUSTED_BACKEND_KEY_SCOPES);
  return scopes.every((scope) => typeof scope === 'string' && allowed.has(scope));
}

export async function trustedBackendKeysRoutes(app: FastifyInstance) {
  app.register(async (protectedApp) => {
    protectedApp.addHook('preHandler', authenticate);

    protectedApp.get(
      '/projects/:projectId/trusted-backend-keys',
      async (
        request: FastifyRequest<{ Params: { projectId: string } }>,
        reply: FastifyReply
      ) => {
        if (!(await verifyProjectAccess(request, reply))) return;

        const keys = await listTrustedBackendKeys(request.params.projectId);
        return reply.send({ success: true, data: keys });
      }
    );

    protectedApp.post(
      '/projects/:projectId/trusted-backend-keys',
      async (
        request: FastifyRequest<{ Params: { projectId: string }; Body: CreateTrustedBackendKeyBody }>,
        reply: FastifyReply
      ) => {
        if (!(await verifyProjectAccess(request, reply))) return;

        const { name, scopes } = request.body || {};
        if (!isValidScopes(scopes)) {
          return reply.status(400).send({
            success: false,
            error: { code: 'INVALID_SCOPE', message: 'Invalid trusted backend key scopes' },
          });
        }

        const userId = (request.user as JwtPayload | undefined)?.userId;
        const result = await createTrustedBackendKey(request.params.projectId, {
          name,
          scopes,
          createdBy: userId,
        });
        return reply.status(201).send({ success: true, data: result });
      }
    );

    protectedApp.delete(
      '/projects/:projectId/trusted-backend-keys/:keyId',
      async (
        request: FastifyRequest<{ Params: TrustedBackendKeyParams }>,
        reply: FastifyReply
      ) => {
        if (!(await verifyProjectAccess(request, reply))) return;

        const deleted = await deleteTrustedBackendKey(
          parseInt(request.params.keyId, 10),
          request.params.projectId
        );

        if (!deleted) {
          return reply.status(404).send({
            success: false,
            error: { code: 'NOT_FOUND', message: 'Trusted backend key not found' },
          });
        }

        return reply.status(204).send();
      }
    );
  });
}
