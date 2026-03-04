// Druvia Edge Functions - Deno Worker Server
// 提供隔离的函数执行环境

interface ExecuteRequest {
  code: string;
  functionName: string;
  secrets?: Record<string, string>;
  payload?: unknown;
  timeout?: number;
}

interface ExecuteResponse {
  success: boolean;
  data?: unknown;
  error?: { message: string };
}

const PORT = 7133;

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
    const { code, functionName, secrets = {}, payload, timeout = 30000 } = body;

    if (!code) {
      return Response.json({
        success: false,
        error: { message: "Code is required" }
      }, { status: 400 });
    }

    console.log(`[${new Date().toISOString()}] Executing function: ${functionName}`);

    const result = await executeFunction(code, secrets, payload, timeout);
    return Response.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error(`[${new Date().toISOString()}] Error:`, message);
    return Response.json({
      success: false,
      error: { message }
    }, { status: 500 });
  }
});

console.log(`Druvia Deno Worker listening on port ${PORT}`);

async function executeFunction(
  code: string,
  secrets: Record<string, string>,
  payload: unknown,
  timeout: number
): Promise<ExecuteResponse> {
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
      resolve({
        success: false,
        error: { message: `Function timeout after ${timeout}ms` }
      });
    }, timeout);

    worker.onmessage = (e: MessageEvent) => {
      clearTimeout(timer);
      worker.terminate();

      if (e.data.error) {
        resolve({
          success: false,
          error: { message: e.data.error }
        });
      } else {
        resolve({
          success: true,
          data: e.data.result
        });
      }
    };

    worker.onerror = (e: ErrorEvent) => {
      clearTimeout(timer);
      worker.terminate();
      resolve({
        success: false,
        error: { message: e.message || "Worker error" }
      });
    };

    // 发送执行请求到 Worker
    worker.postMessage({ code, secrets, payload });
  });
}
