import { query, queryOne } from '../../db/index.js';
import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';
import { signInternalFunctionToken } from './internal-token.js';

// Types
export type FunctionInvokeAuthMode = 'jwt_required' | 'anon_allowed';

export interface FunctionCallerContext {
  authType: 'jwt' | 'apikey';
  projectId: string;
  role: string;
  userId?: string;
  uid?: number;
  tenantId?: string;
}

export interface EdgeFunction {
  id: string;
  projectId: string;
  name: string;
  code: string;
  runtime: string;
  status: 'active' | 'disabled';
  invokeAuthMode: FunctionInvokeAuthMode;
  description: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface FunctionSecret {
  id: string;
  projectId: string;
  key: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface FunctionSchedule {
  id: string;
  functionId: string;
  cronExpression: string;
  enabled: boolean;
  lastRunAt: Date | null;
  nextRunAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface FunctionLog {
  id: string;
  functionId: string;
  executionId: string;
  level: 'info' | 'warn' | 'error';
  message: string | null;
  durationMs: number | null;
  metadata: Record<string, unknown>;
  createdAt: Date;
}

export interface InvokeResult {
  success: boolean;
  data?: unknown;
  error?: { message: string };
  duration: number;
  executionId: string;
}

// Row mappers
function mapFunctionRow(row: Record<string, unknown>): EdgeFunction {
  return {
    id: row.id as string,
    projectId: row.project_id as string,
    name: row.name as string,
    code: row.code as string,
    runtime: row.runtime as string,
    status: row.status as 'active' | 'disabled',
    invokeAuthMode: ((row.invoke_auth_mode as FunctionInvokeAuthMode | undefined) ?? 'jwt_required'),
    description: row.description as string | null,
    createdAt: row.created_at as Date,
    updatedAt: row.updated_at as Date,
  };
}

function mapSecretRow(row: Record<string, unknown>): FunctionSecret {
  return {
    id: row.id as string,
    projectId: row.project_id as string,
    key: row.key as string,
    createdAt: row.created_at as Date,
    updatedAt: row.updated_at as Date,
  };
}

function mapScheduleRow(row: Record<string, unknown>): FunctionSchedule {
  return {
    id: row.id as string,
    functionId: row.function_id as string,
    cronExpression: row.cron_expression as string,
    enabled: row.enabled as boolean,
    lastRunAt: row.last_run_at as Date | null,
    nextRunAt: row.next_run_at as Date | null,
    createdAt: row.created_at as Date,
    updatedAt: row.updated_at as Date,
  };
}

function mapLogRow(row: Record<string, unknown>): FunctionLog {
  return {
    id: row.id as string,
    functionId: row.function_id as string,
    executionId: row.execution_id as string,
    level: row.level as 'info' | 'warn' | 'error',
    message: row.message as string | null,
    durationMs: row.duration_ms as number | null,
    metadata: (row.metadata || {}) as Record<string, unknown>,
    createdAt: row.created_at as Date,
  };
}

// ============================================
// Function CRUD
// ============================================

export async function listFunctions(projectId: string): Promise<EdgeFunction[]> {
  const rows = await query<Record<string, unknown>>(
    `SELECT * FROM druvia_functions WHERE project_id = $1 ORDER BY name`,
    [projectId]
  );
  return rows.map(mapFunctionRow);
}

export async function createFunction(
  projectId: string,
  data: { name: string; code: string; description?: string; invokeAuthMode?: FunctionInvokeAuthMode }
): Promise<EdgeFunction> {
  const row = await queryOne<Record<string, unknown>>(
    `INSERT INTO druvia_functions (project_id, name, code, invoke_auth_mode, description)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING *`,
    [projectId, data.name, data.code, data.invokeAuthMode ?? 'jwt_required', data.description || null]
  );
  if (!row) throw new Error('Failed to create function');
  return mapFunctionRow(row);
}

export async function getFunction(projectId: string, name: string): Promise<EdgeFunction | null> {
  const row = await queryOne<Record<string, unknown>>(
    `SELECT * FROM druvia_functions WHERE project_id = $1 AND name = $2`,
    [projectId, name]
  );
  return row ? mapFunctionRow(row) : null;
}

export async function getFunctionById(functionId: string): Promise<EdgeFunction | null> {
  const row = await queryOne<Record<string, unknown>>(
    `SELECT * FROM druvia_functions WHERE id = $1`,
    [functionId]
  );
  return row ? mapFunctionRow(row) : null;
}

export async function updateFunction(
  projectId: string,
  name: string,
  data: Partial<{ code: string; status: string; description: string; invokeAuthMode: FunctionInvokeAuthMode }>
): Promise<EdgeFunction | null> {
  const setClauses: string[] = [];
  const values: unknown[] = [];
  let paramIndex = 1;

  if (data.code !== undefined) {
    setClauses.push(`code = $${paramIndex++}`);
    values.push(data.code);
  }
  if (data.status !== undefined) {
    setClauses.push(`status = $${paramIndex++}`);
    values.push(data.status);
  }
  if (data.invokeAuthMode !== undefined) {
    setClauses.push(`invoke_auth_mode = $${paramIndex++}`);
    values.push(data.invokeAuthMode);
  }
  if (data.description !== undefined) {
    setClauses.push(`description = $${paramIndex++}`);
    values.push(data.description);
  }

  if (setClauses.length === 0) return getFunction(projectId, name);

  values.push(projectId, name);
  const row = await queryOne<Record<string, unknown>>(
    `UPDATE druvia_functions SET ${setClauses.join(', ')}
     WHERE project_id = $${paramIndex++} AND name = $${paramIndex}
     RETURNING *`,
    values
  );
  return row ? mapFunctionRow(row) : null;
}

export async function deleteFunction(projectId: string, name: string): Promise<boolean> {
  const row = await queryOne<{ id: string }>(
    `DELETE FROM druvia_functions WHERE project_id = $1 AND name = $2 RETURNING id`,
    [projectId, name]
  );
  return !!row;
}

// ============================================
// Function Invocation
// ============================================

const DENO_WORKER_URL = process.env.DENO_WORKER_URL || 'http://localhost:7133';
const API_BASE_URL = process.env.API_BASE_URL || process.env.DRUVIA_API_URL;

export async function invokeFunction(
  projectId: string,
  name: string,
  payload?: unknown,
  caller?: FunctionCallerContext
): Promise<InvokeResult> {
  const func = await getFunction(projectId, name);
  if (!func) throw new Error('Function not found');
  if (func.status !== 'active') throw new Error('Function is disabled');

  // 获取 secrets
  const secrets = await getSecretsDecrypted(projectId);
  const internalToken = signInternalFunctionToken({
    projectId,
    functionName: func.name,
    authType: caller?.authType ?? 'apikey',
  });
  const executionId = randomBytes(16).toString('hex');
  const startTime = Date.now();

  try {
    // 调用 Deno Worker
    const response = await fetch(`${DENO_WORKER_URL}/execute`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        code: func.code,
        functionName: func.name,
        secrets,
        payload,
        caller,
        internalToken,
        ...(API_BASE_URL ? { apiBaseUrl: API_BASE_URL } : {}),
        timeout: 30000,
      }),
    });

    const result = await response.json() as { success: boolean; data?: unknown; error?: { message: string } };
    const duration = Date.now() - startTime;

    // 记录日志
    await createLog(func.id, executionId, result.success ? 'info' : 'error',
      result.success ? 'Function executed successfully' : result.error?.message || 'Unknown error',
      duration, { payload, caller }
    );

    return { ...result, duration, executionId };
  } catch (error) {
    const duration = Date.now() - startTime;
    const message = error instanceof Error ? error.message : 'Unknown error';

    await createLog(func.id, executionId, 'error', message, duration, { payload, caller });

    return {
      success: false,
      error: { message },
      duration,
      executionId,
    };
  }
}

// ============================================
// Secrets CRUD
// ============================================

// 加密密钥：生产环境必须配置 SECRETS_ENCRYPTION_KEY (64 位十六进制字符串)
const ENCRYPTION_KEY = process.env.SECRETS_ENCRYPTION_KEY;
if (!ENCRYPTION_KEY || ENCRYPTION_KEY.length !== 64) {
  console.warn('[Functions] SECRETS_ENCRYPTION_KEY not configured or invalid. Secrets encryption will use a development key.');
}
const EFFECTIVE_KEY = ENCRYPTION_KEY && ENCRYPTION_KEY.length === 64 ? ENCRYPTION_KEY : '0'.repeat(64);

function encrypt(text: string): string {
  const iv = randomBytes(16);
  const cipher = createCipheriv('aes-256-gcm', Buffer.from(EFFECTIVE_KEY, 'hex'), iv);
  let encrypted = cipher.update(text, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  const authTag = cipher.getAuthTag();
  return iv.toString('hex') + ':' + authTag.toString('hex') + ':' + encrypted;
}

function decrypt(encrypted: string): string {
  const [ivHex, authTagHex, encryptedText] = encrypted.split(':');
  const decipher = createDecipheriv('aes-256-gcm', Buffer.from(EFFECTIVE_KEY, 'hex'), Buffer.from(ivHex, 'hex'));
  decipher.setAuthTag(Buffer.from(authTagHex, 'hex'));
  let decrypted = decipher.update(encryptedText, 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  return decrypted;
}

export async function listSecrets(projectId: string): Promise<FunctionSecret[]> {
  const rows = await query<Record<string, unknown>>(
    `SELECT id, project_id, key, created_at, updated_at FROM druvia_function_secrets WHERE project_id = $1 ORDER BY key`,
    [projectId]
  );
  return rows.map(mapSecretRow);
}

export async function createSecret(projectId: string, key: string, value: string): Promise<FunctionSecret> {
  const encryptedValue = encrypt(value);
  const row = await queryOne<Record<string, unknown>>(
    `INSERT INTO druvia_function_secrets (project_id, key, value_encrypted)
     VALUES ($1, $2, $3)
     ON CONFLICT (project_id, key) DO UPDATE SET value_encrypted = $3, updated_at = NOW()
     RETURNING id, project_id, key, created_at, updated_at`,
    [projectId, key, encryptedValue]
  );
  if (!row) throw new Error('Failed to create secret');
  return mapSecretRow(row);
}

export async function deleteSecret(projectId: string, key: string): Promise<boolean> {
  const row = await queryOne<{ id: string }>(
    `DELETE FROM druvia_function_secrets WHERE project_id = $1 AND key = $2 RETURNING id`,
    [projectId, key]
  );
  return !!row;
}

async function getSecretsDecrypted(projectId: string): Promise<Record<string, string>> {
  const rows = await query<{ key: string; value_encrypted: string }>(
    `SELECT key, value_encrypted FROM druvia_function_secrets WHERE project_id = $1`,
    [projectId]
  );

  const secrets: Record<string, string> = {};
  for (const row of rows) {
    try {
      secrets[row.key] = decrypt(row.value_encrypted);
    } catch {
      // Skip invalid secrets
    }
  }
  return secrets;
}

// ============================================
// Schedules CRUD
// ============================================

export async function listSchedules(functionId: string): Promise<FunctionSchedule[]> {
  const rows = await query<Record<string, unknown>>(
    `SELECT * FROM druvia_function_schedules WHERE function_id = $1 ORDER BY created_at`,
    [functionId]
  );
  return rows.map(mapScheduleRow);
}

export async function createSchedule(functionId: string, cronExpression: string): Promise<FunctionSchedule> {
  const row = await queryOne<Record<string, unknown>>(
    `INSERT INTO druvia_function_schedules (function_id, cron_expression)
     VALUES ($1, $2)
     RETURNING *`,
    [functionId, cronExpression]
  );
  if (!row) throw new Error('Failed to create schedule');
  return mapScheduleRow(row);
}

export async function updateSchedule(
  scheduleId: string,
  data: Partial<{ cronExpression: string; enabled: boolean }>
): Promise<FunctionSchedule | null> {
  const setClauses: string[] = [];
  const values: unknown[] = [];
  let paramIndex = 1;

  if (data.cronExpression !== undefined) {
    setClauses.push(`cron_expression = $${paramIndex++}`);
    values.push(data.cronExpression);
  }
  if (data.enabled !== undefined) {
    setClauses.push(`enabled = $${paramIndex++}`);
    values.push(data.enabled);
  }

  if (setClauses.length === 0) {
    const row = await queryOne<Record<string, unknown>>(
      `SELECT * FROM druvia_function_schedules WHERE id = $1`,
      [scheduleId]
    );
    return row ? mapScheduleRow(row) : null;
  }

  values.push(scheduleId);
  const row = await queryOne<Record<string, unknown>>(
    `UPDATE druvia_function_schedules SET ${setClauses.join(', ')}
     WHERE id = $${paramIndex}
     RETURNING *`,
    values
  );
  return row ? mapScheduleRow(row) : null;
}

export async function deleteSchedule(scheduleId: string): Promise<boolean> {
  const row = await queryOne<{ id: string }>(
    `DELETE FROM druvia_function_schedules WHERE id = $1 RETURNING id`,
    [scheduleId]
  );
  return !!row;
}

// ============================================
// Logs
// ============================================

async function createLog(
  functionId: string,
  executionId: string,
  level: 'info' | 'warn' | 'error',
  message: string,
  durationMs: number,
  metadata: Record<string, unknown>
): Promise<void> {
  await query(
    `INSERT INTO druvia_function_logs (function_id, execution_id, level, message, duration_ms, metadata)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [functionId, executionId, level, message, durationMs, JSON.stringify(metadata)]
  );
}

export async function getLogs(
  functionId: string,
  options: { limit?: number; offset?: number; level?: string } = {}
): Promise<FunctionLog[]> {
  const { limit = 50, offset = 0, level } = options;

  let sql = `SELECT * FROM druvia_function_logs WHERE function_id = $1`;
  const values: unknown[] = [functionId];
  let paramIndex = 2;

  if (level) {
    sql += ` AND level = $${paramIndex++}`;
    values.push(level);
  }

  sql += ` ORDER BY created_at DESC LIMIT $${paramIndex++} OFFSET $${paramIndex}`;
  values.push(limit, offset);

  const rows = await query<Record<string, unknown>>(sql, values);
  return rows.map(mapLogRow);
}
