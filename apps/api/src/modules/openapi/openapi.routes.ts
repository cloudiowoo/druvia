import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { generateProjectOpenApi } from './openapi.service.js';
import { authenticate, isJwtUser } from '../../middleware/auth.js';
import { checkProjectAccess } from '../../lib/access.js';
import { checkProjectGraphqlRateLimit, createRateLimiter } from '../../middleware/ratelimit.js';
import { config } from '../../config/index.js';
import { getProjectById } from '../project/project.service.js';
import YAML from 'yaml';

const HASURA_URL = config.hasura.endpoint;
const HASURA_ADMIN_SECRET = config.hasura.adminSecret;

// Rate limiter for OpenAPI generation (10 requests per minute)
const openapiRateLimiter = createRateLimiter({
  windowMs: 60 * 1000,
  maxRequests: 10,
  keyPrefix: 'ratelimit:openapi',
});

export async function openapiRoutes(fastify: FastifyInstance) {
  // All openapi routes require authentication
  fastify.addHook('preHandler', authenticate);

  // POST /api/v1/projects/:projectId/graphql - GraphQL proxy
  // Proxies GraphQL requests to Hasura with admin secret (keeps secret server-side)
  fastify.post<{
    Params: { projectId: string };
    Body: { query: string; variables?: Record<string, unknown>; operationName?: string };
  }>(
    '/projects/:projectId/graphql',
    {
      bodyLimit: 1 * 1024 * 1024, // 1MB body limit for GraphQL queries
      preHandler: [
        async (request: FastifyRequest, reply: FastifyReply) => {
          const { projectId } = request.params as { projectId: string };
          const user = request.user;

          if (!user) {
            return reply.status(401).send({ error: 'Unauthorized' });
          }

          // apikey 认证：验证 projectId 匹配
          if (!isJwtUser(user)) {
            if (user.projectId !== projectId) {
              return reply.status(403).send({ error: 'API key does not match project' });
            }
          } else {
            // JWT 认证：原有逻辑
            const hasAccess = await checkProjectAccess(user.userId, projectId);
            if (!hasAccess) {
              return reply.status(403).send({ error: 'Access denied' });
            }
          }

          const project = await getProjectById(projectId);
          if (!project || !project.schemaName) {
            return reply.status(404).send({ error: 'Project not found' });
          }

          (request as FastifyRequest & {
            project?: {
              schemaName: string | null;
              settings: Record<string, unknown>;
            };
          }).project = {
            schemaName: project.schemaName,
            settings: project.settings,
          };

          const rateLimitConfig = (project.settings as Record<string, unknown> | undefined)
            ?.rateLimits as Record<string, unknown> | undefined;
          await checkProjectGraphqlRateLimit(
            request,
            reply,
            projectId,
            rateLimitConfig?.graphql as { perUser?: number; perProject?: number } | undefined
          );
          if (reply.sent) return;
        },
      ],
    },
    async (request, reply) => {
      const { query, variables, operationName } = request.body;
      const project = (request as FastifyRequest & {
        project?: { schemaName: string | null };
      }).project;

      if (!project?.schemaName) {
        return reply.status(404).send({ error: 'Project not found' });
      }

      const schemaName = project.schemaName;

      try {
        const hasuraHeaders: Record<string, string> = {
          'Content-Type': 'application/json',
          'x-hasura-admin-secret': HASURA_ADMIN_SECRET,
          'x-hasura-default-schema': schemaName,
        };

        // apikey 认证使用 user 角色（项目级授权），JWT 认证通过 admin-secret 透传
        if (!isJwtUser(request.user!)) {
          hasuraHeaders['x-hasura-role'] = 'user';
        }

        const response = await fetch(`${HASURA_URL}/v1/graphql`, {
          method: 'POST',
          headers: hasuraHeaders,
          body: JSON.stringify({ query, variables, operationName }),
        });

        if (!response.ok) {
          fastify.log.error({ status: response.status, statusText: response.statusText }, 'Hasura returned error status');
          return reply.status(response.status >= 500 ? 502 : response.status).send({
            error: 'GraphQL service error',
            message: response.statusText,
          });
        }

        const data = await response.json();
        return reply.send(data);
      } catch (err) {
        fastify.log.error(err, 'GraphQL proxy network error');
        return reply.status(503).send({
          error: 'GraphQL service unavailable',
          message: 'Unable to connect to GraphQL endpoint',
        });
      }
    }
  );

  // GET /api/v1/projects/:projectId/openapi
  // Optional query: ?format=yaml
  fastify.get<{
    Params: { projectId: string };
    Querystring: { format?: string };
  }>(
    '/projects/:projectId/openapi',
    {
      preHandler: [
        async (request: FastifyRequest, reply: FastifyReply) => {
          const { projectId } = request.params as { projectId: string };
          const userId = (request as any).user?.userId;
          if (!userId) {
            return reply.status(401).send({ error: 'Unauthorized' });
          }
          const hasAccess = await checkProjectAccess(userId, projectId);
          if (!hasAccess) {
            return reply.status(403).send({ error: 'Access denied' });
          }
        },
        openapiRateLimiter,
      ],
    },
    async (request, reply) => {
      const { projectId } = request.params;
      const { format } = request.query;
      const baseUrl = `${request.protocol}://${request.hostname}`;

      try {
        const openapi = await generateProjectOpenApi(projectId, baseUrl);

        if (format === 'yaml') {
          reply.header('Content-Type', 'application/x-yaml');
          return reply.send(YAML.stringify(openapi));
        }

        return reply.send(openapi);
      } catch (err) {
        if (err instanceof Error && err.message === 'Project not found') {
          return reply.status(404).send({ error: 'Project not found' });
        }
        throw err;
      }
    }
  );
}
