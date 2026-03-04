import type { FastifyRequest, FastifyReply } from 'fastify';
import * as sqlService from './sql.service.js';
import * as projectService from '../project/project.service.js';
import { checkProjectAccess } from '../../lib/access.js';

interface ProjectParams {
  projectId: string;
}

interface ExportQuery {
  tables?: string;
  includeData?: string;
  includeDrops?: string;
}

interface ImportBody {
  sql?: string;
  atomic?: boolean;
}

// 辅助函数：验证项目访问权限
async function verifyProjectAccess(
  request: FastifyRequest<{ Params: ProjectParams }>,
  reply: FastifyReply
): Promise<{ project: NonNullable<Awaited<ReturnType<typeof projectService.getProjectById>>>; schemaName: string } | null> {
  const { projectId } = request.params;
  const userId = (request as unknown as { user?: { userId?: string } }).user?.userId;

  if (!userId) {
    reply.status(401).send({
      success: false,
      error: { code: 'UNAUTHORIZED', message: 'Not authenticated' },
    });
    return null;
  }

  // 获取项目信息
  const project = await projectService.getProjectById(projectId);
  if (!project) {
    reply.status(404).send({
      success: false,
      error: { code: 'NOT_FOUND', message: 'Project not found' },
    });
    return null;
  }

  // 检查 schema 是否存在
  if (!project.schemaName) {
    reply.status(400).send({
      success: false,
      error: { code: 'NO_SCHEMA', message: 'Project has no schema' },
    });
    return null;
  }

  // 检查访问权限
  const hasAccess = await checkProjectAccess(userId, projectId);
  if (!hasAccess) {
    reply.status(403).send({
      success: false,
      error: { code: 'FORBIDDEN', message: 'No access to this project' },
    });
    return null;
  }

  return { project, schemaName: project.schemaName };
}

/**
 * 导出 SQL
 */
export async function exportSql(
  request: FastifyRequest<{ Params: ProjectParams; Querystring: ExportQuery }>,
  reply: FastifyReply
) {
  const verified = await verifyProjectAccess(request, reply);
  if (!verified) return;

  const { schemaName } = verified;
  const { tables, includeData, includeDrops } = request.query;

  try {
    const sql = await sqlService.exportSchema(schemaName, {
      tables: tables ? tables.split(',') : undefined,
      includeData: includeData === 'true',
      includeDrops: includeDrops === 'true',
    });

    // 设置响应头为 SQL 文件下载
    const filename = `${schemaName}_${new Date().toISOString().split('T')[0]}.sql`;
    reply.header('Content-Type', 'application/sql');
    reply.header('Content-Disposition', `attachment; filename="${filename}"`);

    return reply.send(sql);
  } catch (error) {
    const err = error as Error;
    return reply.status(500).send({
      success: false,
      error: { code: 'EXPORT_FAILED', message: err.message },
    });
  }
}

/**
 * 导入 SQL
 */
export async function importSql(
  request: FastifyRequest<{ Params: ProjectParams; Body: ImportBody }>,
  reply: FastifyReply
) {
  const verified = await verifyProjectAccess(request, reply);
  if (!verified) return;

  const { schemaName } = verified;

  try {
    // 检查 Content-Type 决定处理方式
    const contentType = request.headers['content-type'] || '';

    if (contentType.includes('multipart/form-data')) {
      // 处理文件上传
      const data = await request.file();
      if (!data) {
        return reply.status(400).send({
          success: false,
          error: { code: 'NO_FILE', message: 'No file provided' },
        });
      }

      const buffer = await data.toBuffer();
      const sqlContent = buffer.toString('utf-8');
      const result = await sqlService.importSql(schemaName, sqlContent);

      return reply.send({
        success: result.errors.length === 0,
        data: result,
      });
    } else {
      // 处理 JSON body
      const body = request.body;
      if (!body?.sql) {
        return reply.status(400).send({
          success: false,
          error: { code: 'NO_SQL', message: 'No SQL content provided' },
        });
      }

      const result = await sqlService.importSql(schemaName, body.sql, {
        atomic: body.atomic ?? false,
      });
      return reply.send({ success: result.errors.length === 0, data: result });
    }
  } catch (error) {
    const err = error as Error;
    return reply.status(500).send({
      success: false,
      error: { code: 'IMPORT_FAILED', message: err.message },
    });
  }
}

/**
 * 获取可导出的表列表
 */
export async function listExportableTables(
  request: FastifyRequest<{ Params: ProjectParams }>,
  reply: FastifyReply
) {
  const verified = await verifyProjectAccess(request, reply);
  if (!verified) return;

  const { schemaName } = verified;

  try {
    const { query } = await import('../../db/index.js');
    const result = await query<{ table_name: string; row_count: string }>(
      `SELECT t.table_name,
              COALESCE(s.n_live_tup, 0) as row_count
       FROM information_schema.tables t
       LEFT JOIN pg_stat_user_tables s
         ON s.schemaname = t.table_schema AND s.relname = t.table_name
       WHERE t.table_schema = $1
         AND t.table_type = 'BASE TABLE'
         AND t.table_name NOT LIKE '_meta_%'
       ORDER BY t.table_name`,
      [schemaName]
    );

    return reply.send({
      success: true,
      data: result.map(r => ({
        name: r.table_name,
        rowCount: parseInt(r.row_count, 10),
      })),
    });
  } catch (error) {
    const err = error as Error;
    return reply.status(500).send({
      success: false,
      error: { code: 'LIST_FAILED', message: err.message },
    });
  }
}
