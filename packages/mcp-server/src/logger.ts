type StructuredLogLevel = 'debug' | 'info' | 'warn' | 'error';

interface SerializedError {
  name: string;
  message: string;
  code?: string;
  stack?: string;
}

interface StructuredLogContext {
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

interface StructuredLogEntry extends StructuredLogContext {
  ts: string;
  level: StructuredLogLevel;
  service: string;
  msg: string;
  err?: SerializedError;
}

interface CreateStructuredLogEntryInput {
  level: StructuredLogLevel;
  service: string;
  msg: string;
  env?: string;
  context?: StructuredLogContext;
  err?: unknown;
  ts?: string;
}

type McpLogWriter = (level: StructuredLogLevel, line: string) => void;

export interface McpLogger {
  debug(msg: string, context?: StructuredLogContext, err?: unknown): void;
  info(msg: string, context?: StructuredLogContext, err?: unknown): void;
  warn(msg: string, context?: StructuredLogContext, err?: unknown): void;
  error(msg: string, context?: StructuredLogContext, err?: unknown): void;
  child(context: StructuredLogContext): McpLogger;
}

interface CreateMcpLoggerOptions {
  service?: string;
  env?: string;
  context?: StructuredLogContext;
  write?: McpLogWriter;
}

function defaultWrite(level: StructuredLogLevel, line: string) {
  void level;
  process.stderr.write(`${line}\n`);
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

function serializeError(error: unknown): SerializedError {
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

function createStructuredLogEntry(input: CreateStructuredLogEntryInput): StructuredLogEntry {
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

export function createMcpLogger(options: CreateMcpLoggerOptions = {}): McpLogger {
  const service = options.service ?? 'mcp-server';
  const env = options.env ?? process.env.NODE_ENV;
  const baseContext = options.context ?? {};
  const write = options.write ?? defaultWrite;

  const emit = (
    level: StructuredLogLevel,
    msg: string,
    context?: StructuredLogContext,
    err?: unknown
  ) => {
    const entry = createStructuredLogEntry({
      level,
      service,
      msg,
      env,
      context: {
        ...baseContext,
        ...(context ?? {}),
      },
      ...(err !== undefined ? { err } : {}),
    });

    write(level, JSON.stringify(entry));
  };

  return {
    debug: (msg, context, err) => emit('debug', msg, context, err),
    info: (msg, context, err) => emit('info', msg, context, err),
    warn: (msg, context, err) => emit('warn', msg, context, err),
    error: (msg, context, err) => emit('error', msg, context, err),
    child: (context) => createMcpLogger({
      service,
      env,
      write,
      context: {
        ...baseContext,
        ...context,
      },
    }),
  };
}
