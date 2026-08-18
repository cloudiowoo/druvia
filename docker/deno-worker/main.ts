/// <reference lib="deno.unstable" />

import { createDenoLogger, getElapsedDurationMs } from "./logging.ts";
import {
  createWorkerHandler,
  type WorkerExecuteRequest,
  type WorkerExecuteResponse,
} from "./worker-handler.ts";
import { assertWorkerSecret } from "./worker-auth.ts";

const PORT = 7133;
const workerSecret = assertWorkerSecret(Deno.env.get("DENO_WORKER_SECRET"));
const runtimeEnv = Deno.env.get("DENO_ENV") ?? Deno.env.get("NODE_ENV");
const configuredApiBaseUrl = Deno.env.get("DRUVIA_API_URL");
const logger = createDenoLogger({
  service: "deno-worker",
  env: runtimeEnv,
  context: { module: "runtime" },
});

async function executeFunction(
  request: WorkerExecuteRequest,
): Promise<WorkerExecuteResponse> {
  const executionLogger = logger.child({
    projectId: request.caller.projectId,
    actorType: request.caller.actorType,
    actorSource: request.caller.actorSource,
    actorSubject: request.caller.actorSubject,
    functionName: request.functionName,
    executionId: request.executionId,
  });
  const startedAt = Date.now();
  const worker = new Worker(new URL("./executor.ts", import.meta.url).href, {
    type: "module",
    deno: {
      permissions: {
        net: true,
        env: false,
        read: ["/tmp"],
        write: ["/tmp"],
        run: false,
        ffi: false,
      },
    },
  });

  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      worker.terminate();
      const durationMs = getElapsedDurationMs(startedAt);
      executionLogger.error("function execution timed out", { durationMs });
      resolve({
        success: false,
        error: { message: `Function timeout after ${request.timeout}ms` },
        durationMs,
      });
    }, request.timeout);

    worker.onmessage = (event: MessageEvent) => {
      clearTimeout(timer);
      worker.terminate();
      if (event.data.error) {
        executionLogger.error("function worker returned error", undefined, event.data.error);
        resolve({
          success: false,
          error: { message: event.data.error },
          durationMs: event.data.durationMs,
        });
        return;
      }
      resolve({
        success: true,
        data: event.data.result,
        durationMs: event.data.durationMs,
      });
    };

    worker.onerror = (event: ErrorEvent) => {
      clearTimeout(timer);
      worker.terminate();
      const durationMs = getElapsedDurationMs(startedAt);
      executionLogger.error("function worker crashed", { durationMs }, event.message);
      resolve({
        success: false,
        error: { message: event.message || "Worker error" },
        durationMs,
      });
    };

    worker.postMessage({
      ...request,
      runtimeEnv,
      apiBaseUrl: request.apiBaseUrl ?? configuredApiBaseUrl,
    });
  });
}

const handler = createWorkerHandler({ workerSecret, logger, executeFunction });
Deno.serve({ port: PORT }, handler);
logger.info("deno worker listening", { port: PORT });
