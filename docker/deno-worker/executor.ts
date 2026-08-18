/// <reference no-default-lib="true" />
/// <reference lib="deno.worker" />

import { createDruviaHelper, resolveDruviaApiBaseUrl } from "./druvia-helper.ts";
import { createInvocationDeno } from "./function-environment.ts";
import { createDenoLogger, createExecutionConsole } from "./logging.ts";
import {
  buildTrustedHeaders,
  type FunctionWorkerCaller,
  type WorkerExecuteRequest,
} from "./worker-handler.ts";

interface ExecuteMessage extends Omit<WorkerExecuteRequest, "timeout"> {
  runtimeEnv?: string;
}

function isServeMode(code: string): boolean {
  const stripped = code.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
  return /Deno\s*\.\s*serve\s*\(/.test(stripped);
}

self.onmessage = async (event: MessageEvent<ExecuteMessage>) => {
  const {
    code,
    functionName,
    executionId,
    secrets,
    payload,
    caller,
    internalToken,
    apiBaseUrl,
    runtimeEnv,
  } = event.data;
  const logger = createDenoLogger({
    service: "deno-worker",
    env: runtimeEnv,
    context: {
      module: "executor",
      projectId: caller.projectId,
      actorType: caller.actorType,
      actorSource: caller.actorSource,
      actorSubject: caller.actorSubject,
      ...(caller.platformUserId ? { platformUserId: caller.platformUserId } : {}),
      ...(caller.projectUserId ? { projectUserId: caller.projectUserId } : {}),
      ...(caller.apiKeyId
        ? { apiKeyId: caller.apiKeyId, apiKeyPrefix: caller.apiKeyPrefix }
        : {}),
      functionName,
      executionId,
    },
  });
  const startTime = Date.now();

  try {
    logger.debug("executor received execution request", {
      runtimeMode: isServeMode(code) ? "serve" : "legacy",
    });
    if (isServeMode(code)) {
      await executeServeMode(
        code,
        payload,
        caller,
        secrets,
        internalToken,
        apiBaseUrl,
        runtimeEnv,
        logger,
      );
    } else {
      await executeLegacyMode(
        code,
        payload,
        caller,
        secrets,
        internalToken,
        apiBaseUrl,
        runtimeEnv,
        logger,
      );
    }
  } catch (error) {
    logger.error("executor failed to run function", {
      durationMs: Date.now() - startTime,
    }, error);
    const message = error instanceof Error ? error.message : String(error);
    self.postMessage({ error: message, durationMs: Date.now() - startTime });
  }
};

async function executeLegacyMode(
  code: string,
  payload: unknown,
  caller: FunctionWorkerCaller,
  secrets: Record<string, string>,
  internalToken: string,
  apiBaseUrl: string | undefined,
  runtimeEnv: string | undefined,
  logger: ReturnType<typeof createDenoLogger>,
) {
  const functionDeno = createInvocationDeno(Deno, secrets);
  const context = buildContext(
    functionDeno,
    payload,
    caller,
    internalToken,
    apiBaseUrl,
    runtimeEnv,
    logger,
  );
  const startTime = Date.now();
  const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
  const wrappedCode = `
    return (async () => {
      ${code}
    })();
  `;
  const fn = new AsyncFunction(...Object.keys(context), wrappedCode);
  const result = await fn(...Object.values(context));
  self.postMessage({ result, durationMs: Date.now() - startTime });
}

async function executeServeMode(
  code: string,
  payload: unknown,
  caller: FunctionWorkerCaller,
  secrets: Record<string, string>,
  internalToken: string,
  apiBaseUrl: string | undefined,
  runtimeEnv: string | undefined,
  logger: ReturnType<typeof createDenoLogger>,
) {
  let capturedHandler: ((request: Request) => Response | Promise<Response>) | null = null;
  const startTime = Date.now();
  const functionDeno = createInvocationDeno(Deno, secrets, {
    serve: (handlerOrOptions: unknown, maybeHandler?: unknown) => {
      if (typeof handlerOrOptions === "function") {
        capturedHandler = handlerOrOptions as (request: Request) => Response | Promise<Response>;
      } else if (typeof maybeHandler === "function") {
        capturedHandler = maybeHandler as (request: Request) => Response | Promise<Response>;
      }
    },
  });
  const context = buildContext(
    functionDeno,
    payload,
    caller,
    internalToken,
    apiBaseUrl,
    runtimeEnv,
    logger,
  );
  const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
  const wrappedCode = `
    return (async () => {
      ${code}
    })();
  `;
  const fn = new AsyncFunction(...Object.keys(context), wrappedCode);
  await fn(...Object.values(context));

  if (!capturedHandler) {
    throw new Error("Deno.serve() handler not found in function code");
  }
  const syntheticRequest = new Request("http://localhost/invoke", {
    method: "POST",
    headers: buildTrustedHeaders(caller),
    body: payload !== undefined ? JSON.stringify(payload) : undefined,
  });
  const response = await (capturedHandler as (request: Request) => Response | Promise<Response>)(syntheticRequest);
  const contentType = response.headers.get("content-type") ?? "";
  const result = contentType.includes("application/json")
    ? await response.json()
    : await response.text();

  if (response.ok) {
    self.postMessage({ result, durationMs: Date.now() - startTime });
  } else {
    self.postMessage({
      error: typeof result === "string" ? result : JSON.stringify(result),
      durationMs: Date.now() - startTime,
    });
  }
}

function buildContext(
  functionDeno: typeof Deno,
  payload: unknown,
  caller: FunctionWorkerCaller,
  internalToken: string,
  apiBaseUrl: string | undefined,
  runtimeEnv: string | undefined,
  logger: ReturnType<typeof createDenoLogger>,
): Record<string, unknown> {
  const resolvedApiBaseUrl = resolveDruviaApiBaseUrl(apiBaseUrl);
  const druvia = resolvedApiBaseUrl
    ? createDruviaHelper({
        apiBaseUrl: resolvedApiBaseUrl,
        internalToken,
        fetchFn: fetch,
      })
    : undefined;

  return {
    Deno: functionDeno,
    fetch,
    console: createExecutionConsole(logger ?? createDenoLogger({
      service: "deno-worker",
      env: runtimeEnv,
      context: {
        module: "function",
        projectId: caller.projectId,
        actorType: caller.actorType,
        actorSource: caller.actorSource,
        actorSubject: caller.actorSubject,
      },
    })),
    payload,
    caller,
    druvia,
    Response,
    Request,
    Headers,
    URL,
    URLSearchParams,
    JSON,
    TextEncoder,
    TextDecoder,
    btoa,
    atob,
  };
}
