type AdminLogLevel = 'debug' | 'info' | 'warn' | 'error';

interface SerializedError {
  name: string;
  message: string;
  code?: string;
  stack?: string;
}

interface AdminLogContext {
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
  method?: string;
  path?: string;
  statusCode?: number;
  errorCode?: string;
  [key: string]: string | number | boolean | SerializedError | undefined;
}

interface AdminLogEntry extends AdminLogContext {
  ts: string;
  level: AdminLogLevel;
  service: string;
  msg: string;
  err?: SerializedError;
}

type AdminLogWriter = (level: AdminLogLevel, line: string) => void;

interface CreateAdminServerLoggerOptions {
  service?: string;
  env?: string;
  module?: string;
  context?: AdminLogContext;
  write?: AdminLogWriter;
}

export interface AdminServerLogger {
  debug(msg: string, context?: AdminLogContext, err?: unknown): void;
  info(msg: string, context?: AdminLogContext, err?: unknown): void;
  warn(msg: string, context?: AdminLogContext, err?: unknown): void;
  error(msg: string, context?: AdminLogContext, err?: unknown): void;
  child(context: AdminLogContext): AdminServerLogger;
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

function defaultWrite(level: AdminLogLevel, line: string) {
  if (level === 'warn' || level === 'error') {
    process.stderr.write(`${line}\n`);
    return;
  }
  process.stdout.write(`${line}\n`);
}

export function createAdminServerLogger(
  options: CreateAdminServerLoggerOptions = {}
): AdminServerLogger {
  const service = options.service ?? 'admin';
  const env = options.env ?? process.env.NODE_ENV;
  const baseContext: AdminLogContext = {
    ...(options.module ? { module: options.module } : {}),
    ...(options.context ?? {}),
  };
  const write = options.write ?? defaultWrite;

  const emit = (
    level: AdminLogLevel,
    msg: string,
    context?: AdminLogContext,
    err?: unknown
  ) => {
    const entry: AdminLogEntry = {
      ts: new Date().toISOString(),
      level,
      service,
      msg,
      ...(env ? { env } : {}),
      ...baseContext,
      ...(context ?? {}),
      ...(err !== undefined ? { err: serializeError(err) } : {}),
    };

    write(level, JSON.stringify(entry));
  };

  return {
    debug: (msg, context, err) => emit('debug', msg, context, err),
    info: (msg, context, err) => emit('info', msg, context, err),
    warn: (msg, context, err) => emit('warn', msg, context, err),
    error: (msg, context, err) => emit('error', msg, context, err),
    child: (context) => createAdminServerLogger({
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
