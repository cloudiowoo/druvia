import type { FastifyRequest, FastifyReply } from 'fastify';
import * as dataService from './data.service.js';
import type { Filter, ListRowsOptions } from './data.service.js';

interface TableParams {
  schema: string;
  table: string;
}

interface ListRowsQuery {
  limit?: string;
  offset?: string;
  order_by?: string;
  order_dir?: string;
  filters?: string;
}

interface UpdateRowBody {
  primaryKey: Record<string, unknown>;
  data: Record<string, unknown>;
}

interface DeleteRowBody {
  primaryKey: Record<string, unknown>;
}

interface BatchDeleteBody {
  primaryKeys: Array<Record<string, unknown>>;
}

interface ExportQuery {
  format?: string;
  filters?: string;
}

// Parse filters from JSON string
function parseFilters(filtersStr?: string): Filter[] | undefined {
  if (!filtersStr) return undefined;
  try {
    const parsed = JSON.parse(filtersStr);
    if (!Array.isArray(parsed)) return undefined;
    return parsed as Filter[];
  } catch {
    return undefined;
  }
}

// List rows
export async function listRows(
  request: FastifyRequest<{ Params: TableParams; Querystring: ListRowsQuery }>,
  reply: FastifyReply
) {
  const { schema, table } = request.params;
  const { limit, offset, order_by, order_dir, filters } = request.query;

  try {
    const options: ListRowsOptions = {
      limit: limit ? parseInt(limit, 10) : 50,
      offset: offset ? parseInt(offset, 10) : 0,
      orderBy: order_by,
      orderDir: order_dir === 'desc' ? 'desc' : 'asc',
      filters: parseFilters(filters),
    };

    const result = await dataService.listRows(schema, table, options);
    return reply.send({ success: true, data: result });
  } catch (error) {
    const err = error as Error;
    return reply.status(400).send({
      success: false,
      error: { code: 'LIST_FAILED', message: err.message },
    });
  }
}

// Create row
export async function createRow(
  request: FastifyRequest<{ Params: TableParams; Body: Record<string, unknown> }>,
  reply: FastifyReply
) {
  const { schema, table } = request.params;
  const data = request.body;

  if (!data || Object.keys(data).length === 0) {
    return reply.status(400).send({
      success: false,
      error: { code: 'INVALID_INPUT', message: 'Request body is required' },
    });
  }

  try {
    const row = await dataService.insertRow(schema, table, data);
    return reply.status(201).send({ success: true, data: row });
  } catch (error) {
    const err = error as Error;
    return reply.status(400).send({
      success: false,
      error: { code: 'INSERT_FAILED', message: err.message },
    });
  }
}

// Update row
export async function updateRow(
  request: FastifyRequest<{ Params: TableParams; Body: UpdateRowBody }>,
  reply: FastifyReply
) {
  const { schema, table } = request.params;
  const { primaryKey, data } = request.body || {};

  if (!primaryKey || Object.keys(primaryKey).length === 0) {
    return reply.status(400).send({
      success: false,
      error: { code: 'INVALID_INPUT', message: 'primaryKey is required' },
    });
  }

  if (!data || Object.keys(data).length === 0) {
    return reply.status(400).send({
      success: false,
      error: { code: 'INVALID_INPUT', message: 'data is required' },
    });
  }

  try {
    const row = await dataService.updateRow(schema, table, primaryKey, data);
    return reply.status(200).send({ success: true, data: row });
  } catch (error) {
    const err = error as Error;
    const status = err.message.includes('not found') ? 404 : 400;
    return reply.status(status).send({
      success: false,
      error: { code: 'UPDATE_FAILED', message: err.message },
    });
  }
}

// Delete row
export async function deleteRow(
  request: FastifyRequest<{ Params: TableParams; Body: DeleteRowBody }>,
  reply: FastifyReply
) {
  const { schema, table } = request.params;
  const { primaryKey } = request.body || {};

  if (!primaryKey || Object.keys(primaryKey).length === 0) {
    return reply.status(400).send({
      success: false,
      error: { code: 'INVALID_INPUT', message: 'primaryKey is required' },
    });
  }

  try {
    const deleted = await dataService.deleteRow(schema, table, primaryKey);
    if (!deleted) {
      return reply.status(404).send({
        success: false,
        error: { code: 'NOT_FOUND', message: 'Row not found' },
      });
    }
    return reply.status(200).send({ success: true });
  } catch (error) {
    const err = error as Error;
    return reply.status(400).send({
      success: false,
      error: { code: 'DELETE_FAILED', message: err.message },
    });
  }
}

// Batch delete rows
export async function batchDeleteRows(
  request: FastifyRequest<{ Params: TableParams; Body: BatchDeleteBody }>,
  reply: FastifyReply
) {
  const { schema, table } = request.params;
  const { primaryKeys } = request.body || {};

  if (!primaryKeys || !Array.isArray(primaryKeys) || primaryKeys.length === 0) {
    return reply.status(400).send({
      success: false,
      error: { code: 'INVALID_INPUT', message: 'primaryKeys array is required' },
    });
  }

  try {
    const deleted = await dataService.deleteRows(schema, table, primaryKeys);
    return reply.status(200).send({ success: true, data: { deleted } });
  } catch (error) {
    const err = error as Error;
    return reply.status(400).send({
      success: false,
      error: { code: 'BATCH_DELETE_FAILED', message: err.message },
    });
  }
}

// Export data
export async function exportData(
  request: FastifyRequest<{ Params: TableParams; Querystring: ExportQuery }>,
  reply: FastifyReply
) {
  const { schema, table } = request.params;
  const { format = 'json', filters } = request.query;

  if (format !== 'csv' && format !== 'json') {
    return reply.status(400).send({
      success: false,
      error: { code: 'INVALID_INPUT', message: 'format must be csv or json' },
    });
  }

  try {
    const parsedFilters = parseFilters(filters);
    const contentType = format === 'csv' ? 'text/csv' : 'application/json';
    const filename = `${table}_export_${Date.now()}.${format}`;

    reply.header('Content-Type', contentType);
    reply.header('Content-Disposition', `attachment; filename="${filename}"`);

    // Stream the response
    const generator = dataService.exportRows(schema, table, format, parsedFilters);
    let content = '';
    for await (const chunk of generator) {
      content += chunk;
    }
    return reply.send(content);
  } catch (error) {
    const err = error as Error;
    return reply.status(400).send({
      success: false,
      error: { code: 'EXPORT_FAILED', message: err.message },
    });
  }
}
