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

export function serializeError(error: unknown): SerializedError {
  if (error instanceof Error) {
    const serialized: SerializedError = {
      name: error.name || 'Error',
      message: error.message || 'Unknown error',
    };

    const code = Reflect.get(error, 'code');
    if (typeof code === 'string') {
      serialized.code = code;
    }
    if (typeof error.stack === 'string' && error.stack.length > 0) {
      serialized.stack = error.stack;
    }
    return serialized;
  }

  if (isObjectLike(error)) {
    return {
      name: typeof error.name === 'string' ? error.name : 'Error',
      ...(typeof error.code === 'string' ? { code: error.code } : {}),
      message: typeof error.message === 'string' ? error.message : safeJsonStringify(error),
    };
  }

  return {
    name: 'Error',
    message: typeof error === 'string' ? error : String(error),
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
