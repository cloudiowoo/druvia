import {
  createStructuredLogEntry,
  serializeError,
  type StructuredLogContext,
  type StructuredLogLevel,
} from '@druvia/shared';
import { config } from '../config/index.js';
import { getApiLogContext } from './log-context.js';

type ApiLogWriter = (level: StructuredLogLevel, line: string) => void;

export interface ApiLogger {
  debug(msg: string, context?: StructuredLogContext, err?: unknown): void;
  info(msg: string, context?: StructuredLogContext, err?: unknown): void;
  warn(msg: string, context?: StructuredLogContext, err?: unknown): void;
  error(msg: string, context?: StructuredLogContext, err?: unknown): void;
  child(context: StructuredLogContext): ApiLogger;
}

export interface FastifySerializedError {
  [key: string]: unknown;
  type: string;
  name: string;
  message: string;
  stack: string;
  code?: string;
}

interface CreateApiLoggerOptions {
  service?: string;
  env?: string;
  module?: string;
  context?: StructuredLogContext;
  write?: ApiLogWriter;
}

function defaultWrite(level: StructuredLogLevel, line: string) {
  if (level === 'warn' || level === 'error') {
    process.stderr.write(`${line}\n`);
    return;
  }
  process.stdout.write(`${line}\n`);
}

export function toFastifySerializedError(error: unknown): FastifySerializedError {
  const serialized = serializeError(error);
  return {
    type: serialized.name,
    name: serialized.name,
    message: serialized.message,
    stack: serialized.stack ?? '',
    ...(serialized.code ? { code: serialized.code } : {}),
  };
}

export function createApiLogger(options: CreateApiLoggerOptions = {}): ApiLogger {
  const service = options.service ?? 'api';
  const env = options.env ?? config.nodeEnv;
  const baseContext: StructuredLogContext = {
    ...(options.module ? { module: options.module } : {}),
    ...(options.context ?? {}),
  };
  const write = options.write ?? defaultWrite;

  const emit = (
    level: StructuredLogLevel,
    msg: string,
    context?: StructuredLogContext,
    err?: unknown
  ) => {
    const activeContext = getApiLogContext();
    const entry = createStructuredLogEntry({
      level,
      service,
      msg,
      env,
      context: {
        ...activeContext,
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
    child: (context) =>
      createApiLogger({
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

export const apiLogger = createApiLogger();
