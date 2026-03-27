#!/usr/bin/env node
// packages/mcp-server/src/index.ts
// Druvia MCP Server - Model Context Protocol server for Druvia BaaS

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { createMcpLogger } from './logger.js';

const API_URL = process.env.DRUVIA_API_URL || 'http://localhost:3001';
const API_KEY = process.env.DRUVIA_API_KEY || '';
const logger = createMcpLogger({
  service: 'mcp-server',
  env: process.env.NODE_ENV,
  context: { module: 'server' },
});

interface ApiResponse<T> {
  success: boolean;
  data?: T;
  error?: { code: string; message: string };
}

async function apiRequest<T>(
  method: string,
  path: string,
  body?: unknown
): Promise<ApiResponse<T>> {
  const headers: Record<string, string> = {
    'X-API-Key': API_KEY,
  };
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
  }

  const response = await fetch(`${API_URL}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  if (response.status === 204) {
    return { success: true };
  }

  return response.json();
}

async function validateApiKey(): Promise<{ valid: boolean; projectId?: string }> {
  const res = await apiRequest<{ valid: boolean; projectId?: string }>(
    'POST',
    '/api/v1/api-keys/validate',
    { key: API_KEY }
  );
  return res.data || { valid: false };
}

// Create MCP Server
const server = new Server(
  {
    name: 'druvia-mcp-server',
    version: '0.1.0',
  },
  {
    capabilities: {
      tools: {},
      resources: {},
    },
  }
);

let projectId: string | null = null;
let schemaName: string | null = null;

// List available tools
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: 'list_tables',
        description: 'List all tables in the project database',
        inputSchema: {
          type: 'object',
          properties: {},
          required: [],
        },
      },
      {
        name: 'get_table_structure',
        description: 'Get the structure (columns) of a specific table',
        inputSchema: {
          type: 'object',
          properties: {
            tableName: {
              type: 'string',
              description: 'Name of the table',
            },
          },
          required: ['tableName'],
        },
      },
      {
        name: 'query_data',
        description: 'Query data from a table with optional filters',
        inputSchema: {
          type: 'object',
          properties: {
            tableName: {
              type: 'string',
              description: 'Name of the table to query',
            },
            limit: {
              type: 'number',
              description: 'Maximum number of rows to return (default: 100)',
            },
            offset: {
              type: 'number',
              description: 'Number of rows to skip',
            },
            orderBy: {
              type: 'string',
              description: 'Column to order by',
            },
            orderDir: {
              type: 'string',
              enum: ['asc', 'desc'],
              description: 'Order direction',
            },
          },
          required: ['tableName'],
        },
      },
      {
        name: 'insert_row',
        description: 'Insert a new row into a table',
        inputSchema: {
          type: 'object',
          properties: {
            tableName: {
              type: 'string',
              description: 'Name of the table',
            },
            data: {
              type: 'object',
              description: 'Row data as key-value pairs',
            },
          },
          required: ['tableName', 'data'],
        },
      },
      {
        name: 'execute_sql',
        description: 'Execute a read-only SQL query',
        inputSchema: {
          type: 'object',
          properties: {
            sql: {
              type: 'string',
              description: 'SQL query to execute (SELECT only)',
            },
          },
          required: ['sql'],
        },
      },
    ],
  };
});

// Handle tool calls
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  if (!projectId || !schemaName) {
    return {
      content: [{ type: 'text', text: 'Error: Not authenticated. Please check your API key.' }],
      isError: true,
    };
  }

  try {
    switch (name) {
      case 'list_tables': {
        const res = await apiRequest<Array<{ tableName: string; rowCount: number; sizeBytes: number }>>(
          'GET',
          `/api/v1/schemas/${schemaName}/tables`
        );
        if (!res.success) {
          return { content: [{ type: 'text', text: `Error: ${res.error?.message}` }], isError: true };
        }
        return {
          content: [{
            type: 'text',
            text: JSON.stringify(res.data, null, 2),
          }],
        };
      }

      case 'get_table_structure': {
        const tableName = (args as { tableName: string }).tableName;
        const res = await apiRequest<{
          tableName: string;
          columns: Array<{ name: string; type: string; nullable: boolean; primaryKey: boolean; defaultValue: string | null }>;
        }>('GET', `/api/v1/schemas/${schemaName}/tables/${tableName}`);
        if (!res.success) {
          return { content: [{ type: 'text', text: `Error: ${res.error?.message}` }], isError: true };
        }
        return {
          content: [{ type: 'text', text: JSON.stringify(res.data, null, 2) }],
        };
      }

      case 'query_data': {
        const { tableName, limit = 100, offset, orderBy, orderDir } = args as {
          tableName: string;
          limit?: number;
          offset?: number;
          orderBy?: string;
          orderDir?: 'asc' | 'desc';
        };
        const params = new URLSearchParams();
        params.set('limit', String(Math.min(limit, 1000)));
        if (offset) params.set('offset', String(offset));
        if (orderBy) params.set('order_by', orderBy);
        if (orderDir) params.set('order_dir', orderDir);

        const res = await apiRequest<{
          rows: Array<Record<string, unknown>>;
          total: number;
        }>('GET', `/api/v1/schemas/${schemaName}/tables/${tableName}/rows?${params}`);
        if (!res.success) {
          return { content: [{ type: 'text', text: `Error: ${res.error?.message}` }], isError: true };
        }
        return {
          content: [{ type: 'text', text: JSON.stringify(res.data, null, 2) }],
        };
      }

      case 'insert_row': {
        const { tableName, data } = args as { tableName: string; data: Record<string, unknown> };
        const res = await apiRequest<Record<string, unknown>>(
          'POST',
          `/api/v1/schemas/${schemaName}/tables/${tableName}/rows`,
          data
        );
        if (!res.success) {
          return { content: [{ type: 'text', text: `Error: ${res.error?.message}` }], isError: true };
        }
        return {
          content: [{ type: 'text', text: JSON.stringify(res.data, null, 2) }],
        };
      }

      case 'execute_sql': {
        const { sql } = args as { sql: string };
        // Strict SQL validation - only allow safe SELECT queries
        const normalizedSql = sql.trim().toLowerCase();

        // Must start with SELECT
        if (!normalizedSql.startsWith('select')) {
          return {
            content: [{ type: 'text', text: 'Error: Only SELECT queries are allowed' }],
            isError: true,
          };
        }

        // Block dangerous keywords that could be used for injection
        const dangerousPatterns = [
          /\b(insert|update|delete|drop|truncate|alter|create|grant|revoke)\b/i,
          /;\s*\w/,  // Multiple statements
          /\/\*.*\*\//,  // Block comments that might hide malicious code
          /--/,  // Line comments
        ];

        for (const pattern of dangerousPatterns) {
          if (pattern.test(sql)) {
            return {
              content: [{ type: 'text', text: 'Error: Query contains forbidden keywords or patterns' }],
              isError: true,
            };
          }
        }

        const res = await apiRequest<{
          rows: Array<Record<string, unknown>>;
          columns: Array<{ name: string; type: string }>;
          rowCount: number;
        }>('POST', `/api/v1/projects/${projectId}/query`, { sql });
        if (!res.success) {
          return { content: [{ type: 'text', text: `Error: ${res.error?.message}` }], isError: true };
        }
        return {
          content: [{ type: 'text', text: JSON.stringify(res.data, null, 2) }],
        };
      }

      default:
        return {
          content: [{ type: 'text', text: `Unknown tool: ${name}` }],
          isError: true,
        };
    }
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : 'Unknown error'}` }],
      isError: true,
    };
  }
});

// List resources (tables as resources)
server.setRequestHandler(ListResourcesRequestSchema, async () => {
  if (!schemaName) {
    return { resources: [] };
  }

  try {
    const res = await apiRequest<Array<{ tableName: string; rowCount: number }>>(
      'GET',
      `/api/v1/schemas/${schemaName}/tables`
    );
    if (!res.success || !res.data) {
      return { resources: [] };
    }

    return {
      resources: res.data.map((table) => ({
        uri: `druvia://tables/${table.tableName}`,
        name: table.tableName,
        description: `Table with ${table.rowCount} rows`,
        mimeType: 'application/json',
      })),
    };
  } catch {
    return { resources: [] };
  }
});

// Read resource content
server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
  const { uri } = request.params;

  if (!schemaName) {
    throw new Error('Not authenticated');
  }

  const match = uri.match(/^druvia:\/\/tables\/(.+)$/);
  if (!match) {
    throw new Error(`Invalid resource URI: ${uri}`);
  }

  const tableName = match[1];
  const res = await apiRequest<{
    rows: Array<Record<string, unknown>>;
    total: number;
  }>('GET', `/api/v1/schemas/${schemaName}/tables/${tableName}/rows?limit=100`);

  if (!res.success) {
    throw new Error(res.error?.message || 'Failed to read resource');
  }

  return {
    contents: [
      {
        uri,
        mimeType: 'application/json',
        text: JSON.stringify(res.data, null, 2),
      },
    ],
  };
});

// Main entry point
async function main() {
  if (!API_KEY) {
    logger.error('missing DRUVIA_API_KEY environment variable');
    process.exit(1);
  }

  // Validate API key and get project info
  const validation = await validateApiKey();
  if (!validation.valid || !validation.projectId) {
    logger.error('invalid api key');
    process.exit(1);
  }

  projectId = validation.projectId;

  // Get project info to get schema name
  const projectRes = await apiRequest<{ schemaName: string }>(
    'GET',
    `/api/v1/projects/${projectId}`
  );
  if (!projectRes.success || !projectRes.data) {
    logger.error('failed to get project info', { projectId });
    process.exit(1);
  }

  schemaName = projectRes.data.schemaName;

  // Start server
  const transport = new StdioServerTransport();
  await server.connect(transport);

  logger.info('mcp server started', { projectId, schemaName });
}

main().catch((error) => {
  logger.error('fatal error', undefined, error);
  process.exit(1);
});
