export type StructuredLogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface SerializedError {
  name: string;
  message: string;
  code?: string;
  stack?: string;
}

export interface StructuredLogContext {
  module?: string;
  env?: string;
  requestId?: string;
  tenantId?: string;
  projectId?: string;
  userId?: string;
  projectUserId?: string;
  platformUserId?: string;
  apiKeyId?: number;
  apiKeyPrefix?: string;
  actorType?: string;
  actorSource?: string;
  actorSubject?: string;
  functionName?: string;
  executionId?: string;
  durationMs?: number;
  [key: string]: string | number | boolean | SerializedError | undefined;
}

export interface StructuredLogEntry extends StructuredLogContext {
  ts: string;
  level: StructuredLogLevel;
  service: string;
  msg: string;
  err?: SerializedError;
}

export interface CreateStructuredLogEntryInput {
  level: StructuredLogLevel;
  service: string;
  msg: string;
  env?: string;
  context?: StructuredLogContext;
  err?: unknown;
  ts?: string;
}

function isObjectLike(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function safeJsonStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return '[unserializable object]';
  }
}

const SENSITIVE_ASSIGNMENT = new RegExp(
  '((?:["\']?)(?:authorization|api[_-]?key|apikey|admin[_-]?secret|x-hasura-admin-secret|password|secret|token|refresh[_-]?token|access[_-]?token|id[_-]?token|identity[_-]?token|authorization[_-]?code|raw[_-]?nonce|provider[_-]?refresh[_-]?token)(?:["\']?)\\s*[:=]\\s*)'
    + '(?:"[^"\\r\\n]*"|\'[^\'\\r\\n]*\'|(?:Basic|Bearer)\\s+[^\\s,;}]+|[^\\s,;}]+)',
  'gi'
);

export function redactSensitiveText(value: string): string {
  return value
    .replace(/\b(Basic|Bearer)\s+[^\s,;}]+/gi, '$1 [REDACTED]')
    .replace(SENSITIVE_ASSIGNMENT, '$1[REDACTED]')
    .replace(/(https?:\/\/)[^/\s:@]+:[^/@\s]+@/gi, '$1[REDACTED]@');
}

export function serializeError(error: unknown): SerializedError {
  if (error instanceof Error) {
    const serialized: SerializedError = {
      name: error.name || 'Error',
      message: redactSensitiveText(error.message || 'Unknown error'),
    };

    const code = Reflect.get(error, 'code');
    if (typeof code === 'string') {
      serialized.code = code;
    }
    if (typeof error.stack === 'string' && error.stack.length > 0) {
      serialized.stack = redactSensitiveText(error.stack);
    }
    return serialized;
  }

  if (isObjectLike(error)) {
    return {
      name: typeof error.name === 'string' ? error.name : 'Error',
      ...(typeof error.code === 'string' ? { code: error.code } : {}),
      message: redactSensitiveText(
        typeof error.message === 'string' ? error.message : safeJsonStringify(error)
      ),
    };
  }

  return {
    name: 'Error',
    message: redactSensitiveText(typeof error === 'string' ? error : String(error)),
  };
}

export function createStructuredLogEntry(
  input: CreateStructuredLogEntryInput
): StructuredLogEntry {
  return {
    ts: input.ts ?? new Date().toISOString(),
    level: input.level,
    service: input.service,
    msg: input.msg,
    ...(input.env ? { env: input.env } : {}),
    ...(input.context ?? {}),
    ...(input.err !== undefined ? { err: serializeError(input.err) } : {}),
  };
}
