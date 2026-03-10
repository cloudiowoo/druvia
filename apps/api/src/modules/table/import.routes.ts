import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { pool } from '../../db/index.js';
import format from 'pg-format';
import { checkProjectAccess } from '../../lib/access.js';
import { createRateLimiter } from '../../middleware/ratelimit.js';

// Rate limiter for import endpoint (10 requests per minute)
const importRateLimiter = createRateLimiter({
  windowMs: 60 * 1000,
  maxRequests: 10,
  keyPrefix: 'ratelimit:import',
});

interface ImportRow {
  [key: string]: unknown;
}

interface ImportOptions {
  onError: 'skip' | 'abort';
  batchSize: number;
}

interface ImportRequest {
  rows: ImportRow[];
  options: ImportOptions;
}

interface ImportError {
  row: number;
  error: string;
}

interface ImportParams {
  schemaName: string;
  tableName: string;
}

// Maximum rows per import request
const MAX_IMPORT_ROWS = 10000;

// Sanitize database error messages to avoid leaking sensitive info
function sanitizeDbError(err: unknown): string {
  if (!(err instanceof Error)) return 'Unknown error';

  const msg = err.message;

  // Extract common PostgreSQL error types without exposing internals
  if (msg.includes('duplicate key')) return 'Duplicate key violation';
  if (msg.includes('foreign key')) return 'Foreign key constraint violation';
  if (msg.includes('not-null')) return 'Required field is null';
  if (msg.includes('check constraint')) return 'Value constraint violation';
  if (msg.includes('invalid input syntax')) {
    // Extract type info but not the actual value
    const typeMatch = msg.match(/invalid input syntax for (?:type )?(\w+)/);
    return typeMatch ? `Invalid ${typeMatch[1]} format` : 'Invalid data format';
  }

  // Generic fallback - don't expose raw error
  return 'Database error';
}

export async function importRoutes(fastify: FastifyInstance) {
  // POST /api/v1/schemas/:schemaName/tables/:tableName/import
  fastify.post<{
    Params: ImportParams;
    Body: ImportRequest;
  }>(
    '/:schemaName/tables/:tableName/import',
    {
      bodyLimit: 10 * 1024 * 1024, // 10MB body limit to match frontend validation
      preHandler: [
        async (request: FastifyRequest, reply: FastifyReply) => {
          const params = request.params as ImportParams;
          const userId = (request as any).user?.userId;
          if (!userId) {
            return reply.status(401).send({ error: 'Unauthorized' });
          }
          // Get project_id from schema name (schema name format: tenant_xxx_project_xxx)
          const projectResult = await pool.query(
            'SELECT project_id FROM druvia_projects WHERE schema_name = $1',
            [params.schemaName]
          );
          if (projectResult.rows.length === 0) {
            return reply.status(404).send({ error: 'Schema not found' });
          }
          const projectId = projectResult.rows[0].project_id;
          const hasAccess = await checkProjectAccess(userId, projectId);
          if (!hasAccess) {
            return reply.status(403).send({ error: 'Access denied' });
          }
        },
        importRateLimiter,
      ],
    },
    async (request, reply) => {
      const { schemaName, tableName } = request.params;
      const { rows, options } = request.body;
      const { onError = 'skip', batchSize = 100 } = options || {};

      if (!rows || rows.length === 0) {
        return reply.status(400).send({ error: 'No rows to import' });
      }

      // Server-side row limit validation
      if (rows.length > MAX_IMPORT_ROWS) {
        return reply.status(400).send({
          error: `Too many rows. Maximum ${MAX_IMPORT_ROWS} rows per request.`
        });
      }

      const errors: ImportError[] = [];
      let imported = 0;
      let skipped = 0;

      // Verify table exists in schema
      const tableCheck = await pool.query(
        `SELECT 1 FROM information_schema.tables
         WHERE table_schema = $1 AND table_name = $2`,
        [schemaName, tableName]
      );

      if (tableCheck.rows.length === 0) {
        return reply.status(404).send({ error: 'Table not found' });
      }

      // Get column names from first row
      const columns = Object.keys(rows[0]);

      // Validate columns exist in table
      const columnsResult = await pool.query(
        `SELECT column_name, is_nullable, column_default FROM information_schema.columns
         WHERE table_schema = $1 AND table_name = $2`,
        [schemaName, tableName]
      );
      const tableColumns = new Set(columnsResult.rows.map((r: { column_name: string }) => r.column_name));
      const invalidColumns = columns.filter(c => !tableColumns.has(c));
      if (invalidColumns.length > 0) {
        return reply.status(400).send({
          error: `Invalid columns: ${invalidColumns.join(', ')}`,
          validColumns: Array.from(tableColumns)
        });
      }

      // Check for missing required columns (NOT NULL without default)
      const requiredColumns = columnsResult.rows
        .filter((r: { column_name: string; is_nullable: string; column_default: string | null }) =>
          r.is_nullable === 'NO' && r.column_default === null
        )
        .map((r: { column_name: string }) => r.column_name);
      const missingRequired = requiredColumns.filter((c: string) => !columns.includes(c));
      if (missingRequired.length > 0) {
        return reply.status(400).send({
          error: `Missing required columns: ${missingRequired.join(', ')}`,
          requiredColumns
        });
      }

      // Process in batches
      for (let i = 0; i < rows.length; i += batchSize) {
        const batch = rows.slice(i, i + batchSize);

        for (let j = 0; j < batch.length; j++) {
          const row = batch[j];
          const rowIndex = i + j + 1;
          const values = columns.map(col => row[col]);

          try {
            // Use pg-format for identifier escaping, $N for value params
            const columnList = columns.map(c => format('%I', c)).join(', ');
            const placeholders = columns.map((_, idx) => `$${idx + 1}`).join(', ');
            const sql = format(
              'INSERT INTO %I.%I (%s) VALUES (%s)',
              schemaName,
              tableName,
              columnList,
              placeholders
            );
            await pool.query(sql, values);
            imported++;
          } catch (err) {
            const errorMsg = sanitizeDbError(err);
            errors.push({ row: rowIndex, error: errorMsg });

            if (onError === 'abort') {
              return reply.status(400).send({
                success: false,
                imported,
                skipped,
                errors,
                abortedAt: rowIndex
              });
            }
            skipped++;
          }
        }
      }

      return reply.send({
        success: true,
        imported,
        skipped,
        errors: errors.slice(0, 100)
      });
    }
  );
}
