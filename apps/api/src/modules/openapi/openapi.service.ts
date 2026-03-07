import { pool } from '../../db/index.js';
import { generateOpenApiSchema } from './schema-to-openapi.js';

interface TableInfo {
  table_name: string;
}

interface ColumnInfo {
  column_name: string;
  data_type: string;
  is_nullable: string;
  column_default: string | null;
}

// Convert snake_case to PascalCase
function toPascalCase(str: string): string {
  return str
    .split('_')
    .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join('');
}

export async function generateProjectOpenApi(
  projectId: string,
  baseUrl: string
): Promise<object> {
  // Get schema name from project - note: project_id is VARCHAR
  const projectResult = await pool.query(
    'SELECT schema_name, name FROM druvia_projects WHERE project_id = $1',
    [projectId]
  );

  if (projectResult.rows.length === 0) {
    throw new Error('Project not found');
  }

  const schemaName = projectResult.rows[0].schema_name;
  const projectName = projectResult.rows[0].name;

  // Get all tables
  const tablesResult = await pool.query(
    `SELECT table_name FROM information_schema.tables
     WHERE table_schema = $1 AND table_type = 'BASE TABLE'`,
    [schemaName]
  );

  const tables = tablesResult.rows as TableInfo[];
  const paths: Record<string, unknown> = {};
  const schemas: Record<string, unknown> = {};

  for (const table of tables) {
    // Get columns for each table
    const columnsResult = await pool.query(
      `SELECT column_name, data_type, is_nullable, column_default
       FROM information_schema.columns
       WHERE table_schema = $1 AND table_name = $2`,
      [schemaName, table.table_name]
    );

    const columns = columnsResult.rows as ColumnInfo[];
    const tableName = table.table_name;
    const SchemaName = toPascalCase(tableName);

    // Generate schema
    const schema = generateOpenApiSchema(columns);
    schemas[SchemaName] = schema;
    schemas[`${SchemaName}Input`] = { ...schema, required: undefined };

    // Generate paths
    const basePath = `/api/v1/schemas/${schemaName}/tables/${tableName}`;

    paths[`${basePath}/rows`] = {
      get: {
        summary: `List ${tableName} rows`,
        tags: [tableName],
        parameters: [
          { name: 'limit', in: 'query', schema: { type: 'integer', default: 20 } },
          { name: 'offset', in: 'query', schema: { type: 'integer', default: 0 } },
          { name: 'orderBy', in: 'query', schema: { type: 'string' } },
        ],
        responses: {
          '200': {
            description: 'List of rows',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    rows: { type: 'array', items: { $ref: `#/components/schemas/${SchemaName}` } },
                    total: { type: 'integer' },
                  },
                },
              },
            },
          },
        },
      },
      post: {
        summary: `Create ${tableName} row`,
        tags: [tableName],
        requestBody: {
          content: {
            'application/json': {
              schema: { $ref: `#/components/schemas/${SchemaName}Input` },
            },
          },
        },
        responses: {
          '201': { description: 'Created' },
        },
      },
    };

    paths[`${basePath}/rows/{id}`] = {
      get: {
        summary: `Get ${tableName} row by ID`,
        tags: [tableName],
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: {
          '200': {
            description: 'Row data',
            content: {
              'application/json': {
                schema: { $ref: `#/components/schemas/${SchemaName}` },
              },
            },
          },
        },
      },
      patch: {
        summary: `Update ${tableName} row`,
        tags: [tableName],
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        requestBody: {
          content: {
            'application/json': {
              schema: { $ref: `#/components/schemas/${SchemaName}Input` },
            },
          },
        },
        responses: {
          '200': { description: 'Updated' },
        },
      },
      delete: {
        summary: `Delete ${tableName} row`,
        tags: [tableName],
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: {
          '204': { description: 'Deleted' },
        },
      },
    };
  }

  return {
    openapi: '3.0.3',
    info: {
      title: `${projectName} API`,
      version: '1.0.0',
      description: `Auto-generated API documentation for ${projectName}`,
    },
    servers: [{ url: baseUrl }],
    paths,
    components: {
      schemas,
      securitySchemes: {
        bearerAuth: {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'JWT',
          description: 'JWT token obtained from /api/v1/auth/login',
        },
      },
    },
    security: [{ bearerAuth: [] }],
  };
}
