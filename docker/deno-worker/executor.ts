// Druvia Edge Functions - Isolated Executor
// 在隔离的 Worker 中执行用户代码
// 支持两种模式：AsyncFunction（原有）和 Deno.serve() handler
import { createDruviaHelper, resolveDruviaApiBaseUrl } from "./druvia-helper.ts";

interface ExecuteMessage {
  code: string;
  secrets: Record<string, string>;
  payload?: unknown;
  internalToken?: string;
  apiBaseUrl?: string;
  caller?: {
    authType: "jwt" | "apikey";
    projectId: string;
    role: string;
    userId?: string;
    uid?: number;
    tenantId?: string;
  };
}

/** 检测代码是否使用 Deno.serve() 模式（排除注释中的匹配） */
function isServeMode(code: string): boolean {
  // 移除单行注释和多行注释后再检测
  const stripped = code.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
  return /Deno\s*\.\s*serve\s*\(/.test(stripped);
}

self.onmessage = async (e: MessageEvent<ExecuteMessage>) => {
  const { code, secrets, payload, caller, internalToken, apiBaseUrl } = e.data;

  try {
    // 注入 secrets 到环境变量
    for (const [key, value] of Object.entries(secrets)) {
      Deno.env.set(key, value);
    }

    if (isServeMode(code)) {
      await executeServeMode(code, payload, caller, internalToken, apiBaseUrl);
    } else {
      await executeLegacyMode(code, payload, caller, internalToken, apiBaseUrl);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    self.postMessage({ error: message });
  }
};

/**
 * Legacy mode: 通过 AsyncFunction 构造器执行代码字符串
 */
async function executeLegacyMode(
  code: string,
  payload: unknown,
  caller?: ExecuteMessage["caller"],
  internalToken?: string,
  apiBaseUrl?: string
) {
  const context = buildContext(payload, caller, internalToken, apiBaseUrl);

  const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
  const wrappedCode = `
    return (async () => {
      ${code}
    })();
  `;

  const fn = new AsyncFunction(...Object.keys(context), wrappedCode);
  const result = await fn(...Object.values(context));
  self.postMessage({ result });
}

/**
 * Serve mode: mock Deno.serve()，提取 handler，构造 synthetic Request，
 * 收集 Response 返回给 API 层。
 */
async function executeServeMode(
  code: string,
  payload: unknown,
  caller?: ExecuteMessage["caller"],
  internalToken?: string,
  apiBaseUrl?: string
) {
  let capturedHandler: ((req: Request) => Response | Promise<Response>) | null = null;

  // Mock Deno.serve() — 捕获 handler 而非启动真实服务器
  const mockDeno = new Proxy(Deno, {
    get(target, prop) {
      if (prop === "serve") {
        return (handlerOrOpts: unknown, maybeHandler?: unknown) => {
          // Deno.serve(handler) or Deno.serve(opts, handler)
          if (typeof handlerOrOpts === "function") {
            capturedHandler = handlerOrOpts as (req: Request) => Response | Promise<Response>;
          } else if (typeof maybeHandler === "function") {
            capturedHandler = maybeHandler as (req: Request) => Response | Promise<Response>;
          }
        };
      }
      return (target as unknown as Record<string | symbol, unknown>)[prop];
    },
  });

  const context = buildContext(payload, caller, internalToken, apiBaseUrl);
  context.Deno = mockDeno;

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

  // 构造 synthetic Request
  const syntheticReq = new Request("http://localhost/invoke", {
    method: "POST",
    headers: buildTrustedHeaders(caller),
    body: payload !== undefined ? JSON.stringify(payload) : undefined,
  });

  const response = await capturedHandler(syntheticReq);

  // 解析 Response
  const contentType = response.headers.get("content-type") ?? "";
  let result: unknown;
  if (contentType.includes("application/json")) {
    result = await response.json();
  } else {
    result = await response.text();
  }

  if (response.ok) {
    self.postMessage({ result });
  } else {
    self.postMessage({ error: typeof result === "string" ? result : JSON.stringify(result) });
  }
}

/** 构建共享执行上下文 */
function buildTrustedHeaders(caller?: ExecuteMessage["caller"]): Headers {
  const headers = new Headers({ "Content-Type": "application/json" });

  if (!caller) {
    return headers;
  }

  headers.set("x-druvia-auth-type", caller.authType);
  headers.set("x-druvia-project-id", caller.projectId);
  headers.set("x-druvia-role", caller.role);

  if (caller.userId) {
    headers.set("x-druvia-user-id", caller.userId);
  }
  if (caller.uid !== undefined) {
    headers.set("x-druvia-uid", String(caller.uid));
  }
  if (caller.tenantId) {
    headers.set("x-druvia-tenant-id", caller.tenantId);
  }

  return headers;
}

function buildContext(
  payload: unknown,
  caller?: ExecuteMessage["caller"],
  internalToken?: string,
  apiBaseUrl?: string
): Record<string, unknown> {
  const resolvedApiBaseUrl = resolveDruviaApiBaseUrl(
    apiBaseUrl,
    (name) => Deno.env.get(name)
  );
  const druvia = internalToken && resolvedApiBaseUrl
    ? createDruviaHelper({ apiBaseUrl: resolvedApiBaseUrl, internalToken, fetchFn: fetch })
    : undefined;

  return {
    Deno,
    fetch,
    console,
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
