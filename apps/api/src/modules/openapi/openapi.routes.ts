import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { generateProjectOpenApi } from './openapi.service.js';
import { authenticate } from '../../middleware/auth.js';
import { checkProjectAccess } from '../../lib/access.js';
import { createRateLimiter } from '../../middleware/ratelimit.js';
import { pool } from '../../db/index.js';
import YAML from 'yaml';

const HASURA_URL = process.env.HASURA_URL || 'http://localhost:8080';
const HASURA_ADMIN_SECRET = process.env.HASURA_ADMIN_SECRET || 'druvia-secret';

// Rate limiter for OpenAPI generation (10 requests per minute)
const openapiRateLimiter = createRateLimiter({
  windowMs: 60 * 1000,
  maxRequests: 10,
  keyPrefix: 'ratelimit:openapi',
});

// Rate limiter for GraphQL proxy (60 requests per minute)
const graphqlRateLimiter = createRateLimiter({
  windowMs: 60 * 1000,
  maxRequests: 60,
  keyPrefix: 'ratelimit:graphql',
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
          const userId = (request as any).user?.userId;
          if (!userId) {
            return reply.status(401).send({ error: 'Unauthorized' });
          }
          const hasAccess = await checkProjectAccess(userId, projectId);
          if (!hasAccess) {
            return reply.status(403).send({ error: 'Access denied' });
          }
        },
        graphqlRateLimiter,
      ],
    },
    async (request, reply) => {
      const { projectId } = request.params;
      const { query, variables, operationName } = request.body;

      // Get schema name for the project to set Hasura role header
      const projectResult = await pool.query(
        'SELECT schema_name FROM druvia_projects WHERE project_id = $1',
        [projectId]
      );

      if (projectResult.rows.length === 0) {
        return reply.status(404).send({ error: 'Project not found' });
      }

      const schemaName = projectResult.rows[0].schema_name;

      try {
        const response = await fetch(`${HASURA_URL}/v1/graphql`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-hasura-admin-secret': HASURA_ADMIN_SECRET,
            'x-hasura-default-schema': schemaName,
          },
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
