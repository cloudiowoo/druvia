# RPC 代理端点 + Edge Functions 扩展 Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add RPC proxy endpoint to Druvia API (call PG functions in tenant schemas) and extend Deno Worker to support `Deno.serve()` handler pattern for taro-app Edge Functions migration.

**Architecture:** RPC module follows existing Fastify module pattern (routes + controller + service). Service queries `pg_proc` for function discovery, maps named args to positional params, executes via parameterized SQL. Deno Worker executor.ts extended to detect and handle `Deno.serve()` style functions by extracting the handler and invoking it with a synthetic Request.

**Tech Stack:** Fastify 5, PostgreSQL (pg_proc introspection), pg-format, Deno 2.x

**Spec:** `docs/plans/2026-03-17-taro-app-migration-design.md` sections 五 + 六

**Depends on:** None — this plan can be implemented independently of Plan 1 (@druvia/sdk).

---

## File Structure

```
apps/api/src/modules/rpc/
├── rpc.routes.ts          # POST /projects/:projectId/rpc/:functionName
├── rpc.controller.ts      # Request handler with project access verification
└── rpc.service.ts         # PG function discovery, arg mapping, execution

docker/deno-worker/
├── main.ts                # Modify: add /execute-handler route
└── executor.ts            # Modify: support Deno.serve() handler extraction

tests/
├── rpc/
│   └── rpc.test.ts        # RPC endpoint tests
└── deno-worker/
    └── executor.test.ts   # Deno.serve() handler detection tests (manual)
```

---

## Chunk 1: RPC Proxy Endpoint

### Task 1: RPC service — function discovery + execution

**Files:**
- Create: `apps/api/src/modules/rpc/rpc.service.ts`
- Create: `tests/rpc/rpc.test.ts`

- [ ] **Step 1: Write failing tests for RPC service**

```typescript
// tests/rpc/rpc.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

// We test the service logic in isolation by mocking the db module
vi.mock('../../apps/api/src/db/index.js', () => ({
  query: vi.fn(),
  queryOne: vi.fn(),
  pool: { connect: vi.fn() },
}))

import { discoverFunction, executeRpc } from '../../apps/api/src/modules/rpc/rpc.service.js'
import { query, queryOne } from '../../apps/api/src/db/index.js'

describe('rpc.service', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('discoverFunction', () => {
    it('returns function metadata from pg_proc', async () => {
      vi.mocked(queryOne).mockResolvedValue({
        proname: 'confirm_drafts',
        proargnames: ['match_id', 'user_id'],
        pronargs: 2,
      })

      const result = await discoverFunction('dru_taroapp', 'confirm_drafts')
      expect(result).toEqual({
        name: 'confirm_drafts',
        argNames: ['match_id', 'user_id'],
        argCount: 2,
      })
      expect(queryOne).toHaveBeenCalledWith(
        expect.stringContaining('pg_proc'),
        ['dru_taroapp', 'confirm_drafts']
      )
    })

    it('returns null for non-existent function', async () => {
      vi.mocked(queryOne).mockResolvedValue(null)
      const result = await discoverFunction('dru_taroapp', 'nonexistent')
      expect(result).toBeNull()
    })

    it('uses cache on second call', async () => {
      vi.mocked(queryOne).mockResolvedValue({
        proname: 'my_fn',
        proargnames: ['arg1'],
        pronargs: 1,
      })

      await discoverFunction('dru_taroapp', 'my_fn')
      await discoverFunction('dru_taroapp', 'my_fn')

      // Only one DB call — second was cached
      expect(queryOne).toHaveBeenCalledTimes(1)
    })
  })

  describe('executeRpc', () => {
    it('calls PG function with mapped positional args', async () => {
      // Mock discoverFunction result (already cached or mock queryOne)
      vi.mocked(queryOne).mockResolvedValueOnce({
        proname: 'confirm_drafts',
        proargnames: ['match_id', 'user_id'],
        pronargs: 2,
      })
      vi.mocked(query).mockResolvedValueOnce([{ id: 1, confirmed: true }])

      const result = await executeRpc('dru_taroapp', 'confirm_drafts', {
        match_id: 1,
        user_id: 'u123',
      })

      expect(result).toEqual({ data: [{ id: 1, confirmed: true }], error: null })
      expect(query).toHaveBeenCalledWith(
        expect.stringContaining('dru_taroapp'),
        [1, 'u123']
      )
    })

    it('returns error for non-existent function', async () => {
      vi.mocked(queryOne).mockResolvedValue(null)

      const result = await executeRpc('dru_taroapp', 'nonexistent', {})
      expect(result.data).toBeNull()
      expect(result.error?.code).toBe('FUNCTION_NOT_FOUND')
    })

    it('handles PG function with no args', async () => {
      vi.mocked(queryOne).mockResolvedValueOnce({
        proname: 'cleanup_data',
        proargnames: null,
        pronargs: 0,
      })
      vi.mocked(query).mockResolvedValueOnce([])

      const result = await executeRpc('dru_taroapp', 'cleanup_data', {})
      expect(result.error).toBeNull()
      expect(query).toHaveBeenCalledWith(
        expect.stringContaining('cleanup_data'),
        []
      )
    })

    it('handles PG execution error', async () => {
      vi.mocked(queryOne).mockResolvedValueOnce({
        proname: 'bad_fn',
        proargnames: ['x'],
        pronargs: 1,
      })
      vi.mocked(query).mockRejectedValueOnce(new Error('division by zero'))

      const result = await executeRpc('dru_taroapp', 'bad_fn', { x: 0 })
      expect(result.data).toBeNull()
      expect(result.error?.code).toBe('RPC_EXECUTION_ERROR')
      expect(result.error?.message).toContain('division by zero')
    })
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run tests/rpc/rpc.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement rpc.service.ts**

```typescript
// apps/api/src/modules/rpc/rpc.service.ts
import { query, queryOne } from '../../db/index.js';
import format from 'pg-format';

interface FunctionMeta {
  name: string;
  argNames: string[];
  argCount: number;
}

interface RpcResult {
  data: unknown;
  error: { code: string; message: string } | null;
}

// Cache: schema.functionName → FunctionMeta
const metaCache = new Map<string, { meta: FunctionMeta; expiry: number }>();
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

export async function discoverFunction(
  schemaName: string,
  functionName: string
): Promise<FunctionMeta | null> {
  const cacheKey = `${schemaName}.${functionName}`;
  const cached = metaCache.get(cacheKey);
  if (cached && cached.expiry > Date.now()) {
    return cached.meta;
  }

  const row = await queryOne<{
    proname: string;
    proargnames: string[] | null;
    pronargs: number;
  }>(
    `SELECT p.proname, p.proargnames, p.pronargs
     FROM pg_proc p
     JOIN pg_namespace n ON p.pronamespace = n.oid
     WHERE n.nspname = $1 AND p.proname = $2`,
    [schemaName, functionName]
  );

  if (!row) return null;

  const meta: FunctionMeta = {
    name: row.proname,
    argNames: row.proargnames ?? [],
    argCount: row.pronargs,
  };

  metaCache.set(cacheKey, { meta, expiry: Date.now() + CACHE_TTL });
  return meta;
}

export async function executeRpc(
  schemaName: string,
  functionName: string,
  args: Record<string, unknown>
): Promise<RpcResult> {
  try {
    const meta = await discoverFunction(schemaName, functionName);
    if (!meta) {
      return {
        data: null,
        error: { code: 'FUNCTION_NOT_FOUND', message: `Function "${functionName}" not found in schema "${schemaName}"` },
      };
    }

    // Map named args to positional params based on pg_proc arg order
    const positionalArgs: unknown[] = meta.argNames.map(name => args[name] ?? null);

    // Build parameterized query: SELECT * FROM schema."functionName"($1, $2, ...)
    const paramPlaceholders = positionalArgs.length > 0
      ? `(${positionalArgs.map((_, i) => `$${i + 1}`).join(', ')})`
      : '()';

    const sql = format('SELECT * FROM %I.%I', schemaName, functionName) + paramPlaceholders;
    const rows = await query<Record<string, unknown>>(sql, positionalArgs);

    return { data: rows, error: null };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      data: null,
      error: { code: 'RPC_EXECUTION_ERROR', message },
    };
  }
}

/** Clear function metadata cache */
export function clearCache(schemaName?: string, functionName?: string): void {
  if (schemaName && functionName) {
    metaCache.delete(`${schemaName}.${functionName}`);
  } else {
    metaCache.clear();
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run tests/rpc/rpc.test.ts`
Expected: All PASS

---

### Task 2: RPC controller + routes

**Files:**
- Create: `apps/api/src/modules/rpc/rpc.controller.ts`
- Create: `apps/api/src/modules/rpc/rpc.routes.ts`
- Modify: `apps/api/src/index.ts`

- [ ] **Step 1: Create rpc.controller.ts**

```typescript
// apps/api/src/modules/rpc/rpc.controller.ts
import type { FastifyRequest, FastifyReply } from 'fastify';
import * as rpcService from './rpc.service.js';
import * as projectService from '../project/project.service.js';
import { checkProjectAccess } from '../../lib/access.js';

interface RpcParams {
  projectId: string;
  functionName: string;
}

interface RpcBody {
  args?: Record<string, unknown>;
}

async function verifyProjectAccess(
  request: FastifyRequest<{ Params: { projectId: string } }>,
  reply: FastifyReply
): Promise<{ projectId: string; schemaName: string } | null> {
  const { projectId } = request.params;
  const userId = (request as unknown as { user?: { userId?: string } }).user?.userId;

  if (!userId) {
    reply.status(401).send({
      success: false,
      error: { code: 'UNAUTHORIZED', message: 'Not authenticated' },
    });
    return null;
  }

  const project = await projectService.getProjectById(projectId);
  if (!project) {
    reply.status(404).send({
      success: false,
      error: { code: 'NOT_FOUND', message: 'Project not found' },
    });
    return null;
  }

  const hasAccess = await checkProjectAccess(userId, projectId);
  if (!hasAccess) {
    reply.status(403).send({
      success: false,
      error: { code: 'FORBIDDEN', message: 'No access to this project' },
    });
    return null;
  }

  return { projectId, schemaName: project.schema_name };
}

export async function callRpc(
  request: FastifyRequest<{ Params: RpcParams; Body: RpcBody }>,
  reply: FastifyReply
) {
  const verified = await verifyProjectAccess(request, reply);
  if (!verified) return;

  const { functionName } = request.params;
  const { args = {} } = request.body || {};

  // Validate function name — alphanumeric + underscore only
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(functionName)) {
    return reply.status(400).send({
      success: false,
      error: { code: 'INVALID_FUNCTION_NAME', message: 'Function name contains invalid characters' },
    });
  }

  const result = await rpcService.executeRpc(verified.schemaName, functionName, args);

  if (result.error) {
    const status = result.error.code === 'FUNCTION_NOT_FOUND' ? 404 : 500;
    return reply.status(status).send({
      success: false,
      error: result.error,
    });
  }

  return reply.send({ success: true, data: result.data, error: null });
}
```

- [ ] **Step 2: Create rpc.routes.ts**

```typescript
// apps/api/src/modules/rpc/rpc.routes.ts
import type { FastifyInstance } from 'fastify';
import * as controller from './rpc.controller.js';
import { authenticate } from '../../middleware/auth.js';

const auth = { preHandler: authenticate };

export async function rpcRoutes(fastify: FastifyInstance) {
  fastify.post('/projects/:projectId/rpc/:functionName', auth, controller.callRpc as never);
}
```

- [ ] **Step 3: Register routes in index.ts**

Add to `apps/api/src/index.ts`:

```typescript
// After existing imports, add:
import { rpcRoutes } from './modules/rpc/rpc.routes.js';

// After existing registrations, add:
app.register(rpcRoutes, { prefix: '/api/v1' });
```

- [ ] **Step 4: Verify build**

Run: `cd /Users/cloudio/Developer/nodejs/Druvia && pnpm --filter @druvia/shared build && pnpm --filter api build`
Expected: Build succeeds

---

## Chunk 2: Edge Functions — Deno Worker `Deno.serve()` Handler 支持

### Task 3: executor.ts — 检测并执行 `Deno.serve()` handler

**Files:**
- Modify: `docker/deno-worker/executor.ts`

**背景:** 当前 executor 仅支持 AsyncFunction 模式（直接执行代码块）。taro-app 的 Edge Functions 使用 `Deno.serve()` handler 模式，需要扩展 executor 以检测此模式并提取 handler 调用。

- [ ] **Step 1: Extend executor to detect `Deno.serve()` and invoke handler with synthetic Request**

```typescript
// docker/deno-worker/executor.ts
// 完整替换

interface ExecuteMessage {
  code: string;
  secrets: Record<string, string>;
  payload?: unknown;
  // 新增：handler 模式参数
  method?: string;       // HTTP method, default GET
  path?: string;         // URL path
  headers?: Record<string, string>;
  body?: string;         // raw body string
}

self.onmessage = async (e: MessageEvent<ExecuteMessage>) => {
  const { code, secrets, payload, method, path, headers, body } = e.data;

  try {
    // 注入 secrets 到环境变量
    for (const [key, value] of Object.entries(secrets)) {
      Deno.env.set(key, value);
    }

    // 检测是否为 Deno.serve() handler 模式
    const isServeHandler = /Deno\.serve\s*\(/.test(code);

    if (isServeHandler) {
      // Handler 模式：拦截 Deno.serve()，提取 handler，用 synthetic Request 调用
      await executeServeHandler(code, { method, path, headers, body });
    } else {
      // 传统模式：AsyncFunction 直接执行
      await executeLegacy(code, payload);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    self.postMessage({ error: message });
  }
};

/** Deno.serve() handler 模式 */
async function executeServeHandler(
  code: string,
  opts: { method?: string; path?: string; headers?: Record<string, string>; body?: string }
) {
  let capturedHandler: ((req: Request) => Response | Promise<Response>) | null = null;

  // 创建 Deno.serve 拦截器 — 捕获 handler 而非启动服务器
  const fakeServe = (
    handlerOrOptions: unknown,
    maybeHandler?: (req: Request) => Response | Promise<Response>
  ) => {
    if (typeof handlerOrOptions === 'function') {
      // Deno.serve(handler)
      capturedHandler = handlerOrOptions as (req: Request) => Response | Promise<Response>;
    } else if (typeof maybeHandler === 'function') {
      // Deno.serve(options, handler)
      capturedHandler = maybeHandler;
    }
    // 返回 fake server 对象
    return { finished: Promise.resolve(), ref() {}, unref() {}, shutdown() { return Promise.resolve(); } };
  };

  // 构建带拦截的 Deno 代理
  const denoProxy = new Proxy(Deno, {
    get(target, prop) {
      if (prop === 'serve') return fakeServe;
      return Reflect.get(target, prop);
    },
  });

  // 执行代码（Deno.serve 被拦截）
  const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
  const fn = new AsyncFunction(
    'Deno', 'fetch', 'console', 'Response', 'Request', 'Headers',
    'URL', 'URLSearchParams', 'JSON', 'TextEncoder', 'TextDecoder', 'btoa', 'atob',
    `return (async () => { ${code} })();`
  );
  await fn(
    denoProxy, fetch, console, Response, Request, Headers,
    URL, URLSearchParams, JSON, TextEncoder, TextDecoder, btoa, atob
  );

  if (!capturedHandler) {
    throw new Error('Deno.serve() handler not found in function code');
  }

  // 构建 synthetic Request
  const reqUrl = `http://localhost${opts.path || '/'}`;
  const reqInit: RequestInit = {
    method: opts.method || 'POST',
    headers: opts.headers || { 'content-type': 'application/json' },
  };
  if (opts.body && opts.method !== 'GET' && opts.method !== 'HEAD') {
    reqInit.body = opts.body;
  }
  const syntheticReq = new Request(reqUrl, reqInit);

  // 调用 handler
  const response = await capturedHandler(syntheticReq);

  // 提取 Response 内容返回
  const contentType = response.headers.get('content-type') || '';
  let data: unknown;
  if (contentType.includes('application/json')) {
    data = await response.json();
  } else {
    data = await response.text();
  }

  self.postMessage({
    result: {
      status: response.status,
      headers: Object.fromEntries(response.headers.entries()),
      body: data,
    },
  });
}

/** 传统 AsyncFunction 模式（保持原有行为） */
async function executeLegacy(code: string, payload: unknown) {
  const context = {
    Deno, fetch, console, payload,
    Response, Request, Headers, URL, URLSearchParams,
    JSON, TextEncoder, TextDecoder, btoa, atob,
  };

  const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
  const wrappedCode = `return (async () => { ${code} })();`;
  const fn = new AsyncFunction(...Object.keys(context), wrappedCode);
  const result = await fn(...Object.values(context));

  self.postMessage({ result });
}
```

- [ ] **Step 2: Verify Deno Worker builds**

Run: `cd /Users/cloudio/Developer/nodejs/Druvia/docker/deno-worker && deno check executor.ts`
Expected: No type errors

---

### Task 4: main.ts — 新增 `/execute-handler` 路由

**Files:**
- Modify: `docker/deno-worker/main.ts`

**背景:** 现有 `/execute` 路由传递 `payload` 给 AsyncFunction 模式。新增 `/execute-handler` 路由，传递 HTTP 请求信息（method/path/headers/body）给 handler 模式。API 层 `functions.service.ts` 的 `invokeFunction` 已调用 `/execute`，handler 模式函数需走新路由。

- [ ] **Step 1: Add `/execute-handler` route to main.ts**

在 `main.ts` 的 `Deno.serve` handler 中，`/execute` 路由之后添加：

```typescript
// 在 if (url.pathname !== "/execute") 判断之前，添加 /execute-handler 路由

// POST /execute-handler — Deno.serve() handler 模式
if (req.method === "POST" && url.pathname === "/execute-handler") {
  try {
    const body = await req.json() as ExecuteHandlerRequest;
    const { code, functionName, secrets = {}, timeout = 30000,
            method: reqMethod = "POST", path: reqPath = "/",
            headers: reqHeaders = {}, body: reqBody } = body;

    if (!code) {
      return Response.json({
        success: false,
        error: { message: "Code is required" }
      }, { status: 400 });
    }

    console.log(`[${new Date().toISOString()}] Executing handler: ${functionName}`);

    const result = await executeFunction(code, secrets, undefined, timeout, {
      method: reqMethod,
      path: reqPath,
      headers: reqHeaders,
      body: reqBody,
    });
    return Response.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error(`[${new Date().toISOString()}] Handler error:`, message);
    return Response.json({
      success: false,
      error: { message }
    }, { status: 500 });
  }
}
```

- [ ] **Step 2: Update interfaces and `executeFunction` signature**

在 `main.ts` 顶部添加新接口，并扩展 `executeFunction`：

```typescript
// 新增接口
interface ExecuteHandlerRequest {
  code: string;
  functionName: string;
  secrets?: Record<string, string>;
  timeout?: number;
  method?: string;
  path?: string;
  headers?: Record<string, string>;
  body?: string;
}

// 修改 executeFunction 签名，增加 handlerOpts 参数
async function executeFunction(
  code: string,
  secrets: Record<string, string>,
  payload: unknown,
  timeout: number,
  handlerOpts?: { method?: string; path?: string; headers?: Record<string, string>; body?: string }
): Promise<ExecuteResponse> {
  const worker = new Worker(
    new URL("./executor.ts", import.meta.url).href,
    {
      type: "module",
      deno: {
        permissions: {
          net: true,
          env: true,
          read: ["/tmp"],
          write: ["/tmp"],
          run: false,
          ffi: false,
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
        resolve({ success: false, error: { message: e.data.error } });
      } else {
        resolve({ success: true, data: e.data.result });
      }
    };

    worker.onerror = (e: ErrorEvent) => {
      clearTimeout(timer);
      worker.terminate();
      resolve({ success: false, error: { message: e.message || "Worker error" } });
    };

    // 发送执行请求 — 包含 handler 模式参数
    worker.postMessage({
      code,
      secrets,
      payload,
      ...(handlerOpts || {}),
    });
  });
}
```

- [ ] **Step 3: Verify Deno Worker builds**

Run: `cd /Users/cloudio/Developer/nodejs/Druvia/docker/deno-worker && deno check main.ts`
Expected: No type errors

---

### Task 5: API 层 — functions.service.ts 支持 handler 调用

**Files:**
- Modify: `apps/api/src/modules/functions/functions.service.ts`

**背景:** 当前 `invokeFunction` 只调用 `/execute`。需要根据函数代码是否包含 `Deno.serve()` 来选择调用 `/execute` 或 `/execute-handler`。

- [ ] **Step 1: Add handler invocation path**

在 `functions.service.ts` 的 `invokeFunction` 函数中，检测代码模式并选择路由：

```typescript
// 在 invokeFunction 中，fetch 调用之前添加判断
const isServeHandler = /Deno\.serve\s*\(/.test(func.code);
const endpoint = isServeHandler ? '/execute-handler' : '/execute';

const requestBody = isServeHandler
  ? {
      code: func.code,
      functionName: func.name,
      secrets,
      timeout: 30000,
      method: (payload as Record<string, unknown>)?.method || 'POST',
      path: (payload as Record<string, unknown>)?.path || '/',
      headers: (payload as Record<string, unknown>)?.headers || {},
      body: typeof (payload as Record<string, unknown>)?.body === 'string'
        ? (payload as Record<string, unknown>).body
        : JSON.stringify((payload as Record<string, unknown>)?.body ?? payload),
    }
  : {
      code: func.code,
      functionName: func.name,
      secrets,
      payload,
      timeout: 30000,
    };

const resp = await fetch(`${DENO_WORKER_URL}${endpoint}`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(requestBody),
});
```

- [ ] **Step 2: Verify build**

Run: `cd /Users/cloudio/Developer/nodejs/Druvia && pnpm --filter @druvia/shared build && pnpm --filter api build`
Expected: Build succeeds

---

### Task 6: 手动集成测试

- [ ] **Step 1: 启动开发环境**

```bash
make dev-up
pnpm dev
```

- [ ] **Step 2: 测试 RPC 代理**

```bash
# 1. 在租户 schema 中创建测试函数
curl -X POST http://localhost:3001/api/v1/projects/<projectId>/sql \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{"sql": "CREATE OR REPLACE FUNCTION dru_taroapp.echo_test(msg text) RETURNS text AS $$ SELECT msg; $$ LANGUAGE sql;"}'

# 2. 调用 RPC
curl -X POST http://localhost:3001/api/v1/projects/<projectId>/rpc/echo_test \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{"args": {"msg": "hello druvia"}}'

# Expected: {"success":true,"data":[{"echo_test":"hello druvia"}],"error":null}
```

- [ ] **Step 3: 测试 Edge Function handler 模式**

```bash
# 1. 创建一个使用 Deno.serve() 的 Edge Function
curl -X POST http://localhost:3001/api/v1/projects/<projectId>/functions \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "hello-handler",
    "code": "Deno.serve((req) => { return new Response(JSON.stringify({ hello: \"world\" }), { headers: { \"content-type\": \"application/json\" } }); });"
  }'

# 2. 调用
curl -X POST http://localhost:3001/api/v1/projects/<projectId>/functions/hello-handler/invoke \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{}'

# Expected: {"success":true,"data":{"status":200,"headers":{...},"body":{"hello":"world"}}}
```

- [ ] **Step 4: 测试传统模式未受影响**

```bash
# 调用一个已有的传统 Edge Function，确认行为不变
curl -X POST http://localhost:3001/api/v1/projects/<projectId>/functions/<existing-fn>/invoke \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{"payload": "test"}'
```

---

## Summary

| Chunk | Task | 产物 | 说明 |
|-------|------|------|------|
| 1 | Task 1 | `rpc.service.ts` + tests | PG 函数发现 + 参数化执行 |
| 1 | Task 2 | `rpc.controller.ts` + `rpc.routes.ts` | RPC 代理端点 |
| 2 | Task 3 | `executor.ts` 修改 | 检测 `Deno.serve()` + handler 提取 |
| 2 | Task 4 | `main.ts` 修改 | `/execute-handler` 路由 |
| 2 | Task 5 | `functions.service.ts` 修改 | API 层路由分发 |
| 2 | Task 6 | 手动测试 | RPC + handler 模式验证 |
