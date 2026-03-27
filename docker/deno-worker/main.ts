// Druvia Edge Functions - Deno Worker Server
// 提供隔离的函数执行环境
import { createDenoLogger, getElapsedDurationMs } from "./logging.ts";

interface ExecuteRequest {
  code: string;
  functionName: string;
  executionId?: string;
  secrets?: Record<string, string>;
  payload?: unknown;
  internalToken?: string;
  apiBaseUrl?: string;
  caller?: {
    authType: "platform_user" | "project_user" | "apikey";
    projectId: string;
    role: string;
    userId?: string;
    uid?: number;
    tenantId?: string;
    projectUserId?: string;
    provider?: string;
  };
  timeout?: number;
}

interface ExecuteResponse {
  success: boolean;
  data?: unknown;
  error?: { message: string };
  durationMs?: number;
}

const PORT = 7133;
const logger = createDenoLogger({
  service: "deno-worker",
  env: Deno.env.get("DENO_ENV") ?? Deno.env.get("NODE_ENV"),
  context: { module: "runtime" },
});

Deno.serve({ port: PORT }, async (req: Request): Promise<Response> => {
  // Health check
  if (req.method === "GET" && new URL(req.url).pathname === "/health") {
    return Response.json({ status: "ok", runtime: "deno" });
  }

  // Only accept POST /execute
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  const url = new URL(req.url);
  if (url.pathname !== "/execute") {
    return new Response("Not found", { status: 404 });
  }

  try {
    const body = await req.json() as ExecuteRequest;
    const {
      code,
      functionName,
      executionId,
      secrets = {},
      payload,
      caller,
      internalToken,
      apiBaseUrl,
      timeout = 30000,
    } = body;
    const executionLogger = logger.child({
      projectId: caller?.projectId,
      functionName,
      executionId,
    });

    if (!code) {
      return Response.json({
        success: false,
        error: { message: "Code is required" }
      }, { status: 400 });
    }

    executionLogger.info("function execution started");

    const result = await executeFunction(
      code,
      functionName,
      executionId,
      secrets,
      payload,
      caller,
      internalToken,
      apiBaseUrl,
      timeout,
    );
    executionLogger.info(
      result.success ? "function execution succeeded" : "function execution failed",
      {
        durationMs: result.durationMs,
      },
      result.success ? undefined : result.error?.message,
    );
    return Response.json(result);
  } catch (error) {
    logger.error("worker request failed", undefined, error);
    const message = error instanceof Error ? error.message : "Unknown error";
    return Response.json({
      success: false,
      error: { message }
    }, { status: 500 });
  }
});

logger.info("deno worker listening", { port: PORT });

async function executeFunction(
  code: string,
  functionName: string,
  executionId: string | undefined,
  secrets: Record<string, string>,
  payload: unknown,
  caller: ExecuteRequest["caller"],
  internalToken: string | undefined,
  apiBaseUrl: string | undefined,
  timeout: number
): Promise<ExecuteResponse> {
  const executionLogger = logger.child({
    projectId: caller?.projectId,
    functionName,
    executionId,
  });
  const startedAt = Date.now();
  // 创建隔离的 Worker
  const worker = new Worker(
    new URL("./executor.ts", import.meta.url).href,
    {
      type: "module",
      deno: {
        permissions: {
          net: true,          // 允许网络请求（fetch external APIs）
          env: true,          // 允许环境变量（用于 secrets）
          read: ["/tmp"],     // 只读 /tmp
          write: ["/tmp"],    // 只写 /tmp
          run: false,         // 禁止运行子进程
          ffi: false,         // 禁止 FFI
        }
      }
    }
  );

  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      worker.terminate();
      const durationMs = getElapsedDurationMs(startedAt);
      executionLogger.error("function execution timed out", { durationMs });
      resolve({
        success: false,
        error: { message: `Function timeout after ${timeout}ms` },
        durationMs,
      });
    }, timeout);

    worker.onmessage = (e: MessageEvent) => {
      clearTimeout(timer);
      worker.terminate();

      if (e.data.error) {
        executionLogger.error("function worker returned error", undefined, e.data.error);
        resolve({
          success: false,
          error: { message: e.data.error },
          durationMs: e.data.durationMs,
        });
      } else {
        executionLogger.debug("function worker returned result", {
          durationMs: e.data.durationMs,
        });
        resolve({
          success: true,
          data: e.data.result,
          durationMs: e.data.durationMs,
        });
      }
    };

    worker.onerror = (e: ErrorEvent) => {
      clearTimeout(timer);
      worker.terminate();
      const durationMs = getElapsedDurationMs(startedAt);
      executionLogger.error("function worker crashed", { durationMs }, e.message);
      resolve({
        success: false,
        error: { message: e.message || "Worker error" },
        durationMs,
      });
    };

    // 发送执行请求到 Worker
    worker.postMessage({
      code,
      functionName,
      executionId,
      secrets,
      payload,
      caller,
      internalToken,
      apiBaseUrl,
    });
  });
}
