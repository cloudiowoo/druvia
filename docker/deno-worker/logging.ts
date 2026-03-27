export type DenoLogLevel = "debug" | "info" | "warn" | "error";

export interface DenoSerializedError {
  name: string;
  message: string;
  code?: string;
  stack?: string;
}

export interface DenoLogContext {
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
  [key: string]: string | number | boolean | DenoSerializedError | undefined;
}

interface CreateDenoLogEntryInput {
  level: DenoLogLevel;
  service: string;
  msg: string;
  env?: string;
  context?: DenoLogContext;
  err?: unknown;
  ts?: string;
}

export interface DenoLogEntry extends DenoLogContext {
  ts: string;
  level: DenoLogLevel;
  service: string;
  msg: string;
  err?: DenoSerializedError;
}

type DenoLogWriter = (level: DenoLogLevel, line: string) => void;

export interface DenoLogger {
  debug(msg: string, context?: DenoLogContext, err?: unknown): void;
  info(msg: string, context?: DenoLogContext, err?: unknown): void;
  warn(msg: string, context?: DenoLogContext, err?: unknown): void;
  error(msg: string, context?: DenoLogContext, err?: unknown): void;
  child(context: DenoLogContext): DenoLogger;
}

interface CreateDenoLoggerOptions {
  service?: string;
  env?: string;
  context?: DenoLogContext;
  write?: DenoLogWriter;
}

function isObjectLike(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function safeJsonStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return "[unserializable object]";
  }
}

export function serializeDenoError(error: unknown): DenoSerializedError {
  if (error instanceof Error) {
    const serialized: DenoSerializedError = {
      name: error.name || "Error",
      message: error.message || "Unknown error",
    };

    const code = Reflect.get(error, "code");
    if (typeof code === "string") {
      serialized.code = code;
    }
    if (typeof error.stack === "string" && error.stack.length > 0) {
      serialized.stack = error.stack;
    }
    return serialized;
  }

  if (isObjectLike(error)) {
    return {
      name: typeof error.name === "string" ? error.name : "Error",
      ...(typeof error.code === "string" ? { code: error.code } : {}),
      message: typeof error.message === "string" ? error.message : safeJsonStringify(error),
    };
  }

  return {
    name: "Error",
    message: typeof error === "string" ? error : String(error),
  };
}

function createDenoLogEntry(input: CreateDenoLogEntryInput): DenoLogEntry {
  return {
    ts: input.ts ?? new Date().toISOString(),
    level: input.level,
    service: input.service,
    msg: input.msg,
    ...(input.env ? { env: input.env } : {}),
    ...(input.context ?? {}),
    ...(input.err !== undefined ? { err: serializeDenoError(input.err) } : {}),
  };
}

function defaultWrite(level: DenoLogLevel, line: string) {
  const output = new TextEncoder().encode(`${line}\n`);
  if (level === "warn" || level === "error") {
    Deno.stderr.writeSync(output);
    return;
  }
  Deno.stdout.writeSync(output);
}

export function getElapsedDurationMs(startedAt: number, endedAt = Date.now()): number {
  return Math.max(0, endedAt - startedAt);
}

function stringifyLogArg(arg: unknown): string {
  if (typeof arg === "string") {
    return arg;
  }

  try {
    return JSON.stringify(arg);
  } catch {
    return String(arg);
  }
}

function normalizeConsoleArgs(args: unknown[]): { msg: string; err?: unknown } {
  let errorValue: unknown;
  const messageParts: string[] = [];

  for (const arg of args) {
    if (arg instanceof Error) {
      errorValue = arg;
      messageParts.push(arg.message);
      continue;
    }

    messageParts.push(stringifyLogArg(arg));
  }

  return {
    msg: messageParts.join(" ").trim() || "console output",
    ...(errorValue !== undefined ? { err: errorValue } : {}),
  };
}

export function createDenoLogger(options: CreateDenoLoggerOptions = {}): DenoLogger {
  const service = options.service ?? "deno-worker";
  const env = options.env;
  const baseContext = options.context ?? {};
  const write = options.write ?? defaultWrite;

  const emit = (
    level: DenoLogLevel,
    msg: string,
    context?: DenoLogContext,
    err?: unknown,
  ) => {
    const entry = createDenoLogEntry({
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
    debug: (msg, context, err) => emit("debug", msg, context, err),
    info: (msg, context, err) => emit("info", msg, context, err),
    warn: (msg, context, err) => emit("warn", msg, context, err),
    error: (msg, context, err) => emit("error", msg, context, err),
    child: (context) => createDenoLogger({
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

export function createExecutionConsole(
  logger: DenoLogger,
  baseConsole: Console = console
): Console {
  const executionConsole = Object.create(baseConsole) as Console;

  executionConsole.log = (...args: unknown[]) => {
    const { msg, err } = normalizeConsoleArgs(args);
    logger.info(msg, undefined, err);
  };
  executionConsole.info = (...args: unknown[]) => {
    const { msg, err } = normalizeConsoleArgs(args);
    logger.info(msg, undefined, err);
  };
  executionConsole.warn = (...args: unknown[]) => {
    const { msg, err } = normalizeConsoleArgs(args);
    logger.warn(msg, undefined, err);
  };
  executionConsole.error = (...args: unknown[]) => {
    const { msg, err } = normalizeConsoleArgs(args);
    logger.error(msg, undefined, err);
  };
  executionConsole.debug = (...args: unknown[]) => {
    const { msg, err } = normalizeConsoleArgs(args);
    logger.debug(msg, undefined, err);
  };

  return executionConsole;
}
