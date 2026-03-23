import type { FastifyInstance } from 'fastify';
import { pool } from '../../db/index.js';
import { config } from '../../config/index.js';
import { verifyInternalFunctionToken } from './internal-token.js';

const INTERNAL_TOKEN_HEADER = 'x-druvia-internal-token';

interface InternalGraphqlBody {
  query: string;
  variables?: Record<string, unknown>;
  operationName?: string;
}

function buildSchemaPrefixMatchers(schemaName: string): RegExp[] {
  const escaped = schemaName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return [
    new RegExp(`\\b${escaped}_`, 'i'),
    new RegExp(`\\binsert_${escaped}_`, 'i'),
    new RegExp(`\\bupdate_${escaped}_`, 'i'),
    new RegExp(`\\bdelete_${escaped}_`, 'i'),
  ];
}

function queryReferencesSchema(query: string, schemaName: string): boolean {
  return buildSchemaPrefixMatchers(schemaName).some((pattern) => pattern.test(query));
}

export async function internalFunctionsGraphqlRoutes(app: FastifyInstance) {
  app.post<{
    Body: InternalGraphqlBody;
  }>('/internal/functions/graphql', async (request, reply) => {
    const token = request.headers[INTERNAL_TOKEN_HEADER] as string | undefined;

    if (!token) {
      return reply.status(401).send({
        success: false,
        error: { code: 'UNAUTHORIZED', message: 'Missing internal token' },
      });
    }

    let tokenPayload;
    try {
      tokenPayload = verifyInternalFunctionToken(token);
    } catch (error) {
      return reply.status(401).send({
        success: false,
        error: {
          code: 'UNAUTHORIZED',
          message: error instanceof Error ? error.message : 'Invalid internal token',
        },
      });
    }

    const { query, variables, operationName } = request.body ?? {};
    if (!query) {
      return reply.status(400).send({
        success: false,
        error: { code: 'BAD_REQUEST', message: 'GraphQL query is required' },
      });
    }

    const projectResult = await pool.query(
      'SELECT schema_name FROM druvia_projects WHERE project_id = $1',
      [tokenPayload.projectId]
    );

    if (projectResult.rows.length === 0) {
      return reply.status(404).send({
        success: false,
        error: { code: 'NOT_FOUND', message: 'Project not found' },
      });
    }

    const schemaName = projectResult.rows[0].schema_name as string;
    const forbiddenProjectSchemaResult = await pool.query(
      'SELECT schema_name FROM druvia_projects WHERE project_id <> $1',
      [tokenPayload.projectId]
    );
    const forbiddenEnvironmentSchemaResult = await pool.query(
      'SELECT schema_name FROM druvia_project_environments WHERE project_id <> $1',
      [tokenPayload.projectId]
    );

    const forbiddenSchemas = [
      'public',
      ...forbiddenProjectSchemaResult.rows
        .map((row) => row.schema_name as string | null)
        .filter((schema): schema is string => !!schema && schema !== schemaName),
      ...forbiddenEnvironmentSchemaResult.rows
        .map((row) => row.schema_name as string | null)
        .filter((schema): schema is string => !!schema && schema !== schemaName),
    ];

    const forbiddenSchema = forbiddenSchemas.find((schema) => queryReferencesSchema(query, schema));
    if (forbiddenSchema) {
      return reply.status(403).send({
        success: false,
        error: {
          code: 'FORBIDDEN',
          message: `GraphQL query cannot reference schema "${forbiddenSchema}"`,
        },
      });
    }

    try {
      const response = await fetch(`${config.hasura.endpoint}/v1/graphql`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-hasura-admin-secret': config.hasura.adminSecret,
          'x-hasura-default-schema': schemaName,
        },
        body: JSON.stringify({ query, variables, operationName }),
      });

      if (!response.ok) {
        const message = response.statusText || 'GraphQL service error';
        return reply.status(response.status >= 500 ? 502 : response.status).send({
          success: false,
          error: { code: 'GRAPHQL_PROXY_FAILED', message },
        });
      }

      const data = await response.json();
      return reply.send(data);
    } catch (error) {
      return reply.status(503).send({
        success: false,
        error: {
          code: 'GRAPHQL_SERVICE_UNAVAILABLE',
          message: error instanceof Error ? error.message : 'Unable to connect to GraphQL endpoint',
        },
      });
    }
  });
}
