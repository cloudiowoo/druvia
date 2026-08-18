# Project Data Access Batch 3B Realtime Token Exchange Implementation Plan

**Status:** Implemented on 2026-08-18. Focused tests, SDK/API/Admin builds, Compose rendering, and local PostgreSQL/Hasura integration passed. The publishing `workflow_dispatch` rehearsal remains a deferred operational release step because it creates registry and GitHub Release artifacts; it is not the next development task.

> **Execution note:** This plan was implemented inline in the main checkout without worktrees, subagents, or automatic commits. The commit checkpoints below remain as proposed change boundaries; execution was consolidated after the user removed the per-subtask checkpoint requirement.

**Goal:** Make Druvia Realtime use short-lived, server-derived Hasura JWTs for project users and API-key callers, with SDK renewal/reconnect, truthful Admin readiness, and consistent Compose deployment configuration.

**Architecture:** Druvia API authenticates the long-lived application credential, resolves the active project data role, and exchanges it for a narrow HS256 Hasura token. The SDK obtains that token before every socket connection, renews it before expiry, and reconnects active channels through a generation-guarded state machine. Admin management stays platform-authenticated, but its connection test uses only an in-memory application credential and a real `graphql-ws` acknowledgment.

**Tech Stack:** Fastify 5, TypeScript, `jsonwebtoken`, Redis/ioredis, Hasura CE, `graphql-transport-ws`, `graphql-ws`, React 19, Next.js 16, Docker Compose, Vitest.

**Design:** `docs/plans/2026-08-17-project-data-access-realtime-token-exchange-design.md`

---

## Execution Rules

- Work directly in `/Users/cloudio/Developer/nodejs/Druvia`; do not use `.worktrees`.
- Follow TDD within every task: write the focused failing test, observe the expected failure, implement the smallest complete behavior, then rerun the focused suite.
- Preserve existing user changes and inspect `git diff` before every edit batch.
- Do not commit. At each checkpoint, report the listed Chinese commit message in the repository's existing style.
- No SQL migration is part of Batch 3B.
- Never log or persist an API key, Project access token, short-lived Hasura token, signing secret, or Authorization header.

## File Map

**API actor and token boundary**

- Create `apps/api/src/modules/realtime/realtime-actor.ts`: Realtime-specific compatibility/explicit role resolver.
- Create `apps/api/src/modules/realtime/realtime-token.service.ts`: signing configuration, JWT creation, public WebSocket URL, typed unavailable error.
- Modify `apps/api/src/config/index.ts`: parse the dedicated secret, fallback source, clamped TTL, and public Hasura origin.
- Modify `apps/api/src/middleware/ratelimit.ts`: fixed actor/project token-exchange limits.
- Modify `apps/api/src/modules/realtime/realtime.controller.ts`: project-actor token endpoint and mode-aware management targets.
- Modify `apps/api/src/modules/realtime/realtime.routes.ts`: register `POST /projects/:projectId/realtime/token`.

**Runtime readiness**

- Modify `apps/api/src/modules/realtime/realtime.service.ts`: inspect active compatibility/scoped roles and expose runtime availability.

**SDK**

- Create `packages/sdk/src/modules/realtime-token.ts`: token exchange provider and retry classification.
- Modify `packages/sdk/src/modules/realtime.ts`: authenticated connection lifecycle, renewal, reconnect, status callbacks, stale-generation guard.
- Modify `packages/sdk/src/DruviaClient.ts`: wire database identity precedence into Realtime.
- Modify `packages/sdk/src/types.ts` and `packages/sdk/src/index.ts`: export public status/error types without exposing token internals.

**Admin**

- Create `apps/admin/src/lib/realtime-connection-test.ts`: disposable `graphql-ws` acknowledgment probe.
- Modify `apps/admin/src/lib/api.ts`: application-credential-only token exchange method and updated Realtime response types.
- Modify `apps/admin/src/app/t/[tenantId]/p/[projectId]/realtime/page.tsx`: actor readiness labels, memory-only credential form, real connection state, non-production disablement.

**Deployment and docs**

- Modify `docker/docker-compose.yml`, `docker/docker-compose.dev.yml`, `docker/docker-compose.local.yml`, `docker/docker-compose.prod.yml`, `docker/docker-compose.release.yml`.
- Modify `.env.example`, `docker/.env.example`, `docker/.env.prod.example`, `docker/.env.release.example`.
- Create `scripts/release/verify-realtime-compose.mjs`: render every supported Compose mode with explicit/fallback secrets and validate public origins.
- Modify `.github/workflows/release.yml`: make rendered Realtime Compose verification a release prerequisite.
- Modify `AGENTS.md`, `apps/api/AGENTS.md`, `packages/sdk/AGENTS.md`, `apps/admin/AGENTS.md`, `docs/agent/design-decisions.md`, `docs/progress.md`, `docs/migration/supabase-compat.md`, `docs/003-version-release-guide.md`.

---

### Task 1: Add The Realtime Actor Resolver

**Files:**

- Create: `apps/api/src/modules/realtime/realtime-actor.ts`
- Create: `tests/unit/realtime-actor.test.ts`

- [ ] **Step 1: Write the resolver matrix tests**

Add tests covering both actors in both modes, trusted session variables, unknown-mode compatibility fallback, unsupported actor rejection, and cross-project rejection:

```typescript
expect(resolveRealtimeExecutionContext({
  projectId: 'proj_123',
  runtimeMode: 'compatibility',
  actor: projectUser,
})).toEqual({
  role: 'user',
  actorType: 'project_user',
  subject: 'usr_project_1',
  sessionVariables: {
    'x-hasura-user-id': 'usr_project_1',
    'x-hasura-project-id': 'proj_123',
    'x-hasura-actor-type': 'project_user',
  },
})

expect(resolveRealtimeExecutionContext({
  projectId: 'proj_123',
  runtimeMode: 'compatibility',
  actor: apiKey,
}).role).toBe('anonymous')

expect(resolveRealtimeExecutionContext({
  projectId: 'proj_123',
  runtimeMode: 'explicit',
  actor: projectUser,
}).role).toBe(resolveDataScopeRole({ projectId: 'proj_123', actor: 'authenticated' }))
```

- [ ] **Step 2: Run the focused test and observe the missing module failure**

Run:

```bash
pnpm vitest run tests/unit/realtime-actor.test.ts
```

Expected: FAIL because `realtime-actor.ts` does not exist.

- [ ] **Step 3: Implement the pure resolver**

Use these public contracts:

```typescript
export interface RealtimeExecutionContext {
  role: string
  actorType: 'project_user' | 'apikey'
  subject: string
  sessionVariables: Record<string, string>
}

export class RealtimeActorScopeError extends Error {}

export function isRealtimeActor(
  actor: RequestUser | undefined
): actor is ProjectJwtUser | ApiKeyIdentity

export function resolveRealtimeExecutionContext(input: {
  projectId: string
  runtimeMode: ProjectDataAccessMode | string | null | undefined
  actor: ProjectJwtUser | ApiKeyIdentity
}): RealtimeExecutionContext
```

Implementation rules:

- reject project mismatch before role resolution;
- map compatibility Project User to `user`;
- map compatibility API key to `anonymous`;
- map explicit actors only through `resolveDataScopeRole()`;
- always derive project/actor session variables on the server;
- use `apikey:${projectId}` as the API-key token subject;
- treat every mode other than exact `explicit` as compatibility.

- [ ] **Step 4: Run actor and existing HTTP actor tests**

```bash
pnpm vitest run tests/unit/realtime-actor.test.ts tests/unit/project-data-actor.test.ts
```

Expected: both files PASS and the HTTP compatibility mapping remains unchanged.

**Manual commit checkpoint:**

```text
feat(realtime): 新增项目实时订阅 actor 解析

  - 区分兼容模式下项目用户与匿名 API Key 角色
  - 显式模式统一复用项目级 scoped role
  - 服务端生成可信 Realtime session variables
```

---

### Task 2: Add Signing Configuration And Short-Lived Token Service

**Files:**

- Modify: `apps/api/src/config/index.ts`
- Create: `apps/api/src/modules/realtime/realtime-token.service.ts`
- Create: `tests/unit/realtime-token-service.test.ts`

- [ ] **Step 1: Write configuration and token contract tests**

Test exact source selection, TTL clamp, valid JWT claims, API-key identity omission, URL conversion, and invalid configuration:

```typescript
expect(resolveRealtimeConfig({
  HASURA_JWT_SECRET: 'h'.repeat(32),
  JWT_SECRET: 'j'.repeat(32),
  HASURA_REALTIME_TOKEN_TTL_SECONDS: '30',
  HASURA_PUBLIC_URL: 'https://graphql.druvia.example.com/',
  API_BASE_URL: 'https://druvia.example.com/',
})).toMatchObject({
  tokenSecret: 'h'.repeat(32),
  tokenSecretSource: 'HASURA_JWT_SECRET',
  tokenTtlSeconds: 60,
  hasuraPublicUrl: 'https://graphql.druvia.example.com/',
  apiBaseUrl: 'https://druvia.example.com/',
})

expect(resolveRealtimeConfig({
  JWT_SECRET: 'j'.repeat(32),
  HASURA_REALTIME_TOKEN_TTL_SECONDS: '3600',
})).toMatchObject({
  tokenSecret: 'j'.repeat(32),
  tokenSecretSource: 'JWT_SECRET',
  tokenTtlSeconds: 900,
})
```

Decode a signed token with `jwt.verify(token, secret, { algorithms: ['HS256'], issuer: 'druvia', audience: 'druvia-hasura' })` and assert:

```typescript
expect(payload).toMatchObject({
  sub: 'usr_project_1',
  tokenType: 'druvia_realtime_access',
  projectId: 'proj_123',
  actorType: 'project_user',
  'https://hasura.io/jwt/claims': {
    'x-hasura-allowed-roles': ['user'],
    'x-hasura-default-role': 'user',
    'x-hasura-project-id': 'proj_123',
    'x-hasura-actor-type': 'project_user',
    'x-hasura-user-id': 'usr_project_1',
  },
})
```

Also assert that an API-key token has no `x-hasura-user-id`, the allowed-role list has exactly one value, `jti` is nonempty, and an invalid secret raises `RealtimeTokenUnavailableError` without including the secret in the message.

- [ ] **Step 2: Run the focused test and observe missing exports**

```bash
pnpm vitest run tests/unit/realtime-token-service.test.ts
```

Expected: FAIL for missing `resolveRealtimeConfig` and token service.

- [ ] **Step 3: Add normalized Realtime config**

Export a pure parser and add its result to `config`:

```typescript
export function resolveRealtimeConfig(env: NodeJS.ProcessEnv = process.env) {
  const rawTtl = Number.parseInt(env.HASURA_REALTIME_TOKEN_TTL_SECONDS || '300', 10)
  const ttl = Number.isFinite(rawTtl) ? Math.min(900, Math.max(60, rawTtl)) : 300
  const dedicated = env.HASURA_JWT_SECRET || ''
  const fallback = env.JWT_SECRET || ''

  return {
    tokenSecret: dedicated || fallback,
    tokenSecretSource: dedicated
      ? 'HASURA_JWT_SECRET' as const
      : fallback
        ? 'JWT_SECRET' as const
        : 'missing' as const,
    tokenTtlSeconds: ttl,
    hasuraPublicUrl: env.HASURA_PUBLIC_URL || '',
    apiBaseUrl: env.API_BASE_URL || '',
  }
}
```

The token service enforces secret validity. Emit the fallback warning only for `tokenSecretSource='JWT_SECRET'`; report missing/invalid configuration through `REALTIME_TOKEN_UNAVAILABLE` without claiming that a fallback occurred.

- [ ] **Step 4: Implement signing and URL derivation**

Create these contracts:

```typescript
export interface RealtimeTokenResult {
  token: string
  operationId: string
  expiresIn: number
  expiresAt: string
  websocketUrl: string
}

export class RealtimeTokenUnavailableError extends Error {
  readonly code = 'REALTIME_TOKEN_UNAVAILABLE'
}

export function derivePublicRealtimeUrl(input: {
  hasuraPublicUrl: string
  apiBaseUrl: string
  nodeEnv: string
  hasuraEndpoint: string
}): string

export function issueRealtimeAccessToken(input: {
  projectId: string
  context: RealtimeExecutionContext
  now?: Date
  operationId?: string
}): RealtimeTokenResult
```

Sign with fixed `HS256`, `issuer: 'druvia'`, `audience: 'druvia-hasura'`, `jwtid: operationId`, and configured seconds. Set `iat` from the injected/current clock and derive `exp=iat+ttl` so tests and returned `expiresAt` use the same instant. Use only the server-derived context in the Hasura claims namespace.

For the public URL, prefer `HASURA_PUBLIC_URL`, then use `API_BASE_URL` only as a same-origin fallback. Parse with `URL` and accept only an HTTP(S) origin with no credentials, query, fragment or path other than `/`; compare the normalized value with `url.origin`, then return `/v1/graphql` with `ws:` or `wss:`. Production invalidity throws unavailable; development may derive from `HASURA_ENDPOINT` under the same URL-shape validation. This separation keeps local API port `3001` from being returned as a Hasura WebSocket endpoint when Hasura is exposed on another port.

Emit the fallback warning once through `createApiLogger({ module: 'realtime-token' })`; include `secretSource: 'JWT_SECRET'`, never the value.

- [ ] **Step 5: Run focused tests and API build**

```bash
pnpm vitest run tests/unit/realtime-token-service.test.ts
pnpm --filter @druvia/api build
```

Expected: PASS; TypeScript reports no errors.

**Manual commit checkpoint:**

```text
feat(realtime): 新增短期 Hasura 令牌签发服务

  - 支持独立签名密钥及 JWT_SECRET 兼容回退
  - 固定令牌角色、签发方、受众和有效期边界
  - 校验生产环境公开 WebSocket 地址
```

---

### Task 3: Add Token Exchange Rate Limits

**Files:**

- Modify: `apps/api/src/middleware/ratelimit.ts`
- Create: `tests/unit/ratelimit-realtime-token.test.ts`

- [ ] **Step 1: Write actor/project limit tests**

Use the existing Redis mock style from `tests/unit/ratelimit-graphql.test.ts`. Assert keys and envelopes:

```typescript
await checkRealtimeTokenRateLimit(projectUserRequest, reply, 'proj_123')
expect(redisMock.incr).toHaveBeenNthCalledWith(
  1,
  'ratelimit:realtime-token:proj_123:project:usr_project_1'
)
expect(redisMock.incr).toHaveBeenNthCalledWith(
  2,
  'ratelimit:realtime-token:project:proj_123'
)
```

API-key identity must end in `anon-ip:198.51.100.24`. Request 31 and project request 301 must return:

```typescript
{
  success: false,
  error: {
    code: 'REALTIME_TOKEN_RATE_LIMIT_EXCEEDED',
    message: 'Realtime token rate limit exceeded',
  },
}
```

Assert `Retry-After`, `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset`, and Redis fail-open logging. Actor rejection must report the actor bucket's limit/TTL; project rejection must overwrite those headers with the project bucket's limit/TTL.

- [ ] **Step 2: Run the test and observe the missing limiter failure**

```bash
pnpm vitest run tests/unit/ratelimit-realtime-token.test.ts
```

Expected: FAIL because `checkRealtimeTokenRateLimit` is missing.

- [ ] **Step 3: Implement the fixed limiter**

Export:

```typescript
export async function checkRealtimeTokenRateLimit(
  request: FastifyRequest,
  reply: FastifyReply,
  projectId: string
): Promise<void>
```

Use a 60-second window, actor/IP maximum 30, project maximum 300. Stop after an actor-level rejection so over-limit actor traffic does not consume the project counter. On project rejection, replace previously written actor headers with project `limit=300`, remaining/reset and `Retry-After` values from the project key TTL. Reuse `request.ip` so existing `TRUST_PROXY` semantics stay intact. On Redis errors, log request/project context and allow the authenticated request to continue.

- [ ] **Step 4: Run both limiter suites**

```bash
pnpm vitest run tests/unit/ratelimit-realtime-token.test.ts tests/unit/ratelimit-graphql.test.ts
```

Expected: PASS with no GraphQL limiter regression.

**Manual commit checkpoint:**

```text
feat(realtime): 限制项目令牌交换请求频率

  - 按项目用户或匿名来源限制令牌请求
  - 增加项目级总量保护和 Retry-After 响应
  - Redis 异常时保留认证边界并输出结构化日志
```

---

### Task 4: Expose The Project-Actor Token Endpoint

**Files:**

- Modify: `apps/api/src/modules/realtime/realtime.controller.ts`
- Modify: `apps/api/src/modules/realtime/realtime.routes.ts`
- Modify: `tests/unit/realtime-controller.test.ts`
- Modify: `tests/unit/api-app.test.ts`

- [ ] **Step 1: Add controller contract tests**

Mock `getProjectById`, `checkRealtimeTokenRateLimit`, actor resolution and token issuance. Cover:

- platform actor -> `403 PROJECT_ACTOR_REQUIRED`, no project load;
- cross-project actor -> `403 PROJECT_SCOPE_MISMATCH`, no project load;
- missing project/schema -> `404 PROJECT_NOT_FOUND`;
- project loaded exactly once;
- rate-limit rejection stops signing;
- unavailable signer -> `503 REALTIME_TOKEN_UNAVAILABLE`;
- success contains only token/expiry/websocket fields and does not expose role or secret.
- successful audit context contains request/operation/project/actor/mode/expiry fields but no token, API key, Authorization header, or signing secret.

Success assertion:

```typescript
expect(reply.send).toHaveBeenCalledWith({
  success: true,
  data: {
    token: 'signed-realtime-token',
    expiresIn: 300,
    expiresAt: '2026-08-17T12:00:00.000Z',
    websocketUrl: 'wss://druvia.example.com/v1/graphql',
  },
})
```

- [ ] **Step 2: Add route registration test**

In `tests/unit/api-app.test.ts`, inject an unauthenticated POST to `/api/v1/projects/proj_123/realtime/token` and expect `401`. This proves the route is registered under existing authentication.

- [ ] **Step 3: Run tests and observe route/handler failures**

```bash
pnpm vitest run tests/unit/realtime-controller.test.ts tests/unit/api-app.test.ts
```

Expected: FAIL until the controller and route exist.

- [ ] **Step 4: Implement `issueToken` in the exact request order**

```typescript
export async function issueToken(
  request: FastifyRequest<{ Params: ProjectParams }>,
  reply: FastifyReply
) {
  const actor = request.user
  const { projectId } = request.params

  if (!isRealtimeActor(actor)) {
    return reply.status(403).send({
      success: false,
      error: {
        code: 'PROJECT_ACTOR_REQUIRED',
        message: 'Project actor credential required',
      },
    })
  }
  if (actor.projectId !== projectId) {
    return reply.status(403).send({
      success: false,
      error: {
        code: 'PROJECT_SCOPE_MISMATCH',
        message: 'Project actor does not match the requested project',
      },
    })
  }

  const project = await getProjectById(projectId)
  if (!project?.schemaName) {
    return reply.status(404).send({
      success: false,
      error: {
        code: 'PROJECT_NOT_FOUND',
        message: 'Project not found',
      },
    })
  }

  await checkRealtimeTokenRateLimit(request, reply, projectId)
  if (reply.sent) return

  const context = resolveRealtimeExecutionContext({
    projectId,
    runtimeMode: project.dataAccessMode,
    actor,
  })
  const result = issueRealtimeAccessToken({ projectId, context })
  // Log IDs and mode only, then return the public response fields.
}
```

Register it in the authenticated route group with no body schema and no environment query.

- [ ] **Step 5: Verify Bearer precedence with the real auth middleware**

Add an API injection test that sends an invalid Bearer plus a syntactically present API key and expects existing `401 UNAUTHORIZED`. Do not mock authentication for this assertion; it protects the no-downgrade rule.

- [ ] **Step 6: Run API endpoint tests and build**

```bash
pnpm vitest run tests/unit/realtime-controller.test.ts tests/unit/api-app.test.ts tests/unit/auth.test.ts
pnpm --filter @druvia/api build
```

Expected: PASS.

**Manual commit checkpoint:**

```text
feat(realtime): 提供项目 actor 短期令牌交换接口

  - 仅允许同项目 Project Session 或 API Key 换取令牌
  - 在项目加载和签发前拒绝平台及跨项目身份
  - 返回受限 WebSocket 连接信息并记录安全审计上下文
```

---

### Task 5: Make Realtime Readiness Match Active Project Roles

**Files:**

- Modify: `apps/api/src/modules/realtime/realtime.service.ts`
- Modify: `apps/api/src/modules/realtime/realtime.controller.ts`
- Modify: `tests/unit/realtime-service.test.ts`
- Modify: `tests/unit/realtime-controller.test.ts`
- Modify: `tests/integration/realtime.test.ts`

- [ ] **Step 1: Replace legacy anonymous-only expectations**

Drive subscription classification with:

```typescript
interface RealtimeRuntimeScope {
  projectId: string
  runtimeMode: ProjectDataAccessMode
  environmentId?: number
}
```

Test compatibility roles (`user`, `anonymous`), production explicit roles, and non-production explicit roles from `resolveDataScopeRole({ projectId, environmentId, actor })`. Assert:

```typescript
expect(privateEvents).toMatchObject({
  hasAuthenticatedRead: true,
  hasAnonymousRead: false,
  hasSelectPermission: true,
  accessStatus: 'ready',
})
```

Also test enabled with neither active role -> `access_required`, metadata failure -> `unknown`, and disabled -> `disabled`.

Add assertions proving `getRealtimeConfig()` uses the same `HASURA_PUBLIC_URL` resolver as token issuance. Update `generateSubscriptionExample()` to show a Druvia API root ending in `/api/v1`, omit `realtimeUrl` by default, and rely on the token response's WebSocket URL. No generated text may claim that every SDK Realtime connection uses the legacy `anonymous` role.

- [ ] **Step 2: Run service tests and observe signature failures**

```bash
pnpm vitest run tests/unit/realtime-service.test.ts tests/unit/realtime-controller.test.ts
```

Expected: FAIL because runtime scope is not yet accepted.

- [ ] **Step 3: Implement mode-aware classification**

Change `getTableSubscriptions`, `getSubscriptionStats`, and `configureTableSubscription` to receive `RealtimeRuntimeScope`. Ensure `getSubscriptionStats` forwards the scope instead of calling the changed table function with only a schema. Resolve the two active roles once per call, then classify each table:

```typescript
const hasAuthenticatedRead = roles.includes(authenticatedRole)
const hasAnonymousRead = roles.includes(anonymousRole)
const hasSelectPermission = hasAuthenticatedRead || hasAnonymousRead
```

Do not expose role names in `TableSubscription`.

- [ ] **Step 4: Load one project runtime target in management controllers**

Replace schema-only lookup with a helper that returns:

```typescript
interface RealtimeRuntimeTarget {
  schemaName: string
  runtimeScope: RealtimeRuntimeScope
  runtimeAvailability: 'available' | 'environment_identity_required'
}
```

For default/prod, use the project's schema, omit `environmentId`, and return `available`. For another environment, query both its immutable numeric `id` and schema, set that ID on `runtimeScope`, keep the parent project's persisted mode, and return `environment_identity_required`. Pass runtime scope to list/configure operations. Environment scoped roles must use `environmentId`, never mutable environment name/schema. Add `runtimeAvailability` to config output.

Build management `websocketEndpoint` and `graphqlEndpoint` from the shared public-origin resolver in `realtime-token.service.ts`, not from a second `API_BASE_URL` implementation. Convert the resolved `ws:`/`wss:` URL back to `http:`/`https:` for the GraphQL endpoint. This keeps Admin diagnostics and token responses identical and prevents internal `hasura:8080` leakage in production. Generated SDK examples must not inject that endpoint as `realtimeUrl`; token exchange remains the default source of truth.

Map `RealtimeTokenUnavailableError` from the management config controller to the same `503 REALTIME_TOKEN_UNAVAILABLE` envelope as token exchange. Add a controller test for that path; do not expose the raw config value or downgrade the failure to generic `500`. Also assert that generated examples remain available without public-origin configuration because they no longer embed `realtimeUrl`.

- [ ] **Step 5: Update integration calls and run the focused suites**

Every direct service invocation supplies `{ projectId, runtimeMode }`. Then run:

```bash
pnpm vitest run tests/unit/realtime-service.test.ts tests/unit/realtime-controller.test.ts tests/integration/realtime.test.ts
```

Expected: unit tests PASS. Integration tests PASS when PostgreSQL/Hasura test dependencies are available; otherwise record the exact unavailable dependency and continue with unit/build evidence.

**Manual commit checkpoint:**

```text
feat(realtime): 按项目运行模式计算订阅就绪状态

  - 分别检测认证用户与匿名客户端读取权限
  - 显式模式使用项目 scoped role 判定可用性
  - 标记非生产环境缺少公开身份作用域
```

---

### Task 6: Add The SDK Realtime Token Provider

**Files:**

- Create: `packages/sdk/src/modules/realtime-token.ts`
- Create: `tests/sdk/realtime-token.test.ts`

- [ ] **Step 1: Write token provider response/error tests**

Define test responses for success, malformed JSON, `400`, `401`, `403`, `404`, `429` with `Retry-After`, `500`, and network error. The provider result is:

```typescript
export interface RealtimeAccessToken {
  token: string
  expiresIn: number
  expiresAt: string
  websocketUrl: string
}
```

Its thrown error must expose retry classification without credentials:

```typescript
export class RealtimeTokenRequestError extends Error {
  readonly code: string
  readonly retryable: boolean
  readonly retryAfterMs?: number
}
```

- [ ] **Step 2: Run the provider tests and observe the missing module failure**

```bash
pnpm vitest run tests/sdk/realtime-token.test.ts
```

Expected: FAIL because `realtime-token.ts` does not exist.

- [ ] **Step 3: Implement the provider**

Export:

```typescript
export type RealtimeTokenProvider = () => Promise<RealtimeAccessToken>

export function createRealtimeTokenProvider(input: {
  apiBase: string
  projectId: string
  fetchFn: FetchFn
}): RealtimeTokenProvider
```

POST with no body to `${apiBase}/projects/${projectId}/realtime/token`. Accept only a successful standard envelope with nonempty token, valid absolute `ws:`/`wss:` URL without credentials/query/fragment, positive expiry, and parseable future `expiresAt`. Classify every `4xx` other than `429` and malformed data as permanent; classify network/`429`/`5xx` as retryable and parse numeric or HTTP-date `Retry-After`.

- [ ] **Step 4: Run focused provider tests and SDK build**

```bash
pnpm vitest run tests/sdk/realtime-token.test.ts
pnpm --filter @druvia/sdk build
```

Expected: PASS. The provider is independently testable before the channel lifecycle consumes it.

**Manual commit checkpoint:**

```text
feat(sdk): 新增 Realtime 短期令牌客户端

  - 封装项目令牌交换请求和响应校验
  - 区分永久认证失败与可重试网络错误
  - 支持 Retry-After 重试时间解析
```

---

### Task 7: Implement SDK Renewal And Reconnect State Machine

**Files:**

- Modify: `packages/sdk/src/DruviaClient.ts`
- Modify: `packages/sdk/src/modules/realtime.ts`
- Modify: `packages/sdk/src/types.ts`
- Modify: `packages/sdk/src/index.ts`
- Modify: `tests/sdk/client.test.ts`
- Modify: `tests/sdk/realtime.test.ts`

- [ ] **Step 1: Add DruviaClient identity-precedence tests**

Create clients with storage containing:

1. project + platform session: token POST uses `Authorization: Bearer project-token` and `apikey: test-key`;
2. platform session only: token POST has no Authorization and keeps `apikey: test-key`;
3. invalid project response `401`: the channel reports a permanent error and does not issue a second API-key-only request.

Also drive `projectAuth` state changes and assert:

- a new/refresh `SIGNED_IN` event immediately closes the active old-identity socket, clears its snapshot, and exchanges with the new Project token;
- `SIGNED_OUT` immediately closes the authenticated socket and may reconnect with API key only;
- an invalid Project token that remains selected never triggers an API-key-only retry.

Trigger token acquisition by subscribing with a fake socket factory and flushing promises. Assert the URL is exactly `http://localhost:3001/api/v1/projects/proj_123/realtime/token` when the SDK base is `http://localhost:3001/api/v1`.

- [ ] **Step 2: Expand fake WebSocket and timer tests**

Use one mock socket per factory call and `vi.useFakeTimers()`. Cover:

- token fetched before socket creation;
- exact Authorization-only `connection_init` payload;
- subscriptions sent after `connection_ack` only;
- protocol `ping` -> matching `pong` payload;
- status sequence `CONNECTING -> SUBSCRIBED`;
- an opened socket without `connection_ack` closes and retries after 10 seconds;
- renewal at `expiresAt - 30s` closes/replaces socket and resubscribes;
- network close -> `RECONNECTING` with delays `1s, 2s, 4s, 8s, 15s, 30s` when `Math.random()` is fixed to remove jitter;
- acknowledgment resets retry attempt;
- stale socket callbacks cannot alter current state;
- token `4xx` errors other than `429` stop retries with `CHANNEL_ERROR`;
- retryable token errors retry;
- a GraphQL operation `error` closes the channel and reports `CHANNEL_ERROR` without reconnecting;
- permanent `CHANNEL_ERROR` has no retry timer but a later Project Auth identity event re-arms the still-active lifecycle;
- concurrent renewal/close/error signals never create more than one token request;
- temporary renewal failure closes the old socket no later than `expiresAt`;
- permanent renewal failure closes the old socket immediately;
- unsubscribe cancels timers/pending generations, reports `CLOSED` once, and an explicit later subscribe obtains a fresh token/socket while retaining `.on()` handlers;
- subscribe while already active is rejected without creating another token request/socket;
- removeChannel permanently disposes the channel and blocks later subscribe;
- Project Auth identity changes close the old socket before token exchange and reconnect active channels with the current actor;
- first post-reconnect result resets snapshot and emits no synthetic change event.

- [ ] **Step 3: Run tests and observe lifecycle failures**

```bash
pnpm vitest run tests/sdk/realtime.test.ts tests/sdk/client.test.ts
```

Expected: FAIL against the current immediate anonymous socket implementation.

- [ ] **Step 4: Add public status contracts**

```typescript
export type RealtimeChannelStatus =
  | 'CONNECTING'
  | 'SUBSCRIBED'
  | 'RECONNECTING'
  | 'CHANNEL_ERROR'
  | 'CLOSED'

export type RealtimeChannelStatusCallback = (
  status: RealtimeChannelStatus,
  error?: DruviaError
) => void

export interface RealtimeSubscription {
  unsubscribe: () => void
}
```

Export the types from `packages/sdk/src/index.ts`. Keep `subscribe(callback?)` synchronous and preserve `unsubscribe()`.

- [ ] **Step 5: Wire database identity precedence into Realtime**

In `DruviaClient`, create the provider with the same wrapper used by Database:

```typescript
const realtimeFetch = createFetchWrapper(
  apiBase,
  apiKey,
  rawFetch,
  () => cachedProjectToken
)
const tokenProvider = createRealtimeTokenProvider({
  apiBase,
  projectId: options.projectId,
  fetchFn: realtimeFetch,
})
```

Do not use `projectFetch`, because it still falls back to the platform token for RPC/Functions. Pass the provider and optional URL override into `DruviaRealtime`.

After updating `cachedProjectToken` in the existing Project Auth listener, notify `DruviaRealtime` of the identity change. For every active channel, invalidate generations, close the old socket, clear active operations/snapshot, and then exchange a fresh token. Do not leave the old identity connected while the replacement request is pending. Idle unsubscribed and permanently disposed channels do nothing.

Normalize `options.realtimeUrl` as an absolute `ws:`/`wss:` URL without credentials, query or fragment. Trim trailing slashes and append `/v1/graphql` unless the value already ends in `/v1/graphql`; reject invalid overrides before opening a socket. The override replaces only the token response's `websocketUrl`; it never bypasses token exchange.

- [ ] **Step 6: Implement one-socket-per-channel lifecycle**

`RealtimeChannel` must own:

```typescript
private generation = 0
private subscribed = false
private disposed = false
private retryHalted = false
private reconnectAttempt = 0
private reconnectTimer: ReturnType<typeof setTimeout> | null = null
private ackTimer: ReturnType<typeof setTimeout> | null = null
private renewalTimer: ReturnType<typeof setTimeout> | null = null
private expiryTimer: ReturnType<typeof setTimeout> | null = null
private tokenRequest: Promise<void> | null = null
private tokenRequestGeneration = 0
private statusCallback: RealtimeChannelStatusCallback | null = null
private activeOperationIds = new Set<string>()
```

The asynchronous connection path first coalesces concurrent triggers through `tokenRequest`. It captures a token-request generation, obtains a token, validates request generation/subscription state, and only then increments the socket generation immediately before replacing the socket. Every socket callback checks its captured generation. A successful replacement closes the previous socket after its generation is stale, so that close callback cannot schedule a duplicate reconnect. On open, send:

```typescript
{
  type: 'connection_init',
  payload: {
    headers: { Authorization: `Bearer ${access.token}` },
  },
}
```

Immediately after sending `connection_init`, start `ackTimer` for 10 seconds. A matching `connection_ack` clears it; timeout invalidates/closes that socket and schedules a temporary reconnect. On acknowledgment, clear `retryHalted`, reset backoff, clear snapshot, create fresh operation IDs, send all configured subscriptions, report `SUBSCRIBED`, schedule renewal at `max(1000, expiresAt - now - 30000)`, and schedule an expiry guard at `max(0, expiresAt - now)`. Installing a replacement clears the previous acknowledgment, renewal and expiry timers.

- [ ] **Step 7: Implement retry, expiry, and cleanup rules**

Use base delays `[1000, 2000, 4000, 8000, 15000, 30000]`, cap later attempts at `30000`, and apply multiplier `0.8 + Math.random() * 0.4`. Respect token error `retryAfterMs` when larger than calculated delay. Treat GraphQL transport operation `error` messages and close codes `4401`/`4403` as permanent failures; close the channel and do not reconnect.

Permanent failure keeps the lifecycle active in a retry-halted state with no reconnect timer. A later Project Auth identity-change notification may clear that halt and start one fresh token exchange; `unsubscribe()` still terminates it. This is the recovery path for a corrected Project Session after a prior `401`, not an API-key downgrade of the invalid session.

When the active socket closes or is invalidated, clear its acknowledgment, renewal and expiry timers before scheduling any retry. This prevents a stale renewal or expiry callback from racing the replacement connection.

On a temporary renewal failure, leave the current socket alive only while its expiry guard is pending. Retry timing still respects backoff and a larger server `Retry-After`; if that delay extends past expiry, the guard closes the old socket first and the channel remains disconnected until the permitted retry. On a permanent renewal failure, invalidate/close the current socket immediately and report `CHANNEL_ERROR` without retrying.

The subscription handle's `unsubscribe()` must mark the current lifecycle inactive before invalidating both generations, clear reconnect/acknowledgment/renewal/expiry timers, invalidate the in-flight token result, send `complete` for active IDs when possible, close, clear active operation IDs and snapshots, emit `CLOSED` once, and only then clear the lifecycle status callback. Keep `.on()` configurations/data callbacks so a later explicit `subscribe()` starts a fresh lifecycle. Reject `subscribe()` while already active.

`removeChannel()` first runs idempotent lifecycle cleanup, then marks `disposed`, clears `.on()` configurations/data callbacks, and removes the channel from the parent set. A disposed channel rejects later `subscribe()` calls. Both paths must invalidate stale callbacks before closing the socket so neither can reconnect after returning.

- [ ] **Step 8: Run SDK regression suites and build**

```bash
pnpm vitest run tests/sdk/realtime.test.ts tests/sdk/client.test.ts tests/sdk/project-auth.test.ts tests/sdk/database.test.ts
pnpm --filter @druvia/sdk build
```

Expected: PASS.

**Manual commit checkpoint:**

```text
feat(sdk): 接入 Realtime 身份续期与断线重连

  - 复用 Project Session 优先级获取短期连接令牌
  - 到期前自动换取并以有界退避恢复活动订阅
  - 增加请求与 socket 代际保护及本地过期守卫
```

---

### Task 8: Replace Admin's Simulated Realtime Test

**Files:**

- Create: `apps/admin/src/lib/realtime-connection-test.ts`
- Modify: `apps/admin/src/lib/api.ts`
- Modify: `apps/admin/src/app/t/[tenantId]/p/[projectId]/realtime/page.tsx`
- Create: `tests/unit/admin/realtime-connection-test.test.ts`
- Create: `tests/unit/admin/realtime-page.test.tsx`

- [ ] **Step 1: Test the application-credential API method**

Add a public method with an explicit discriminated credential:

```typescript
type RealtimeTestCredential =
  | { kind: 'apikey'; value: string }
  | { kind: 'project_token'; value: string }

issueRealtimeToken(projectId: string, credential: RealtimeTestCredential)
```

The tests must assert API-key requests contain only `apikey`, Project token requests contain only `Authorization`, and neither path reads or sends `ApiClient.token`. Responses use the same token result shape as the API.

- [ ] **Step 2: Test a disposable real connection probe**

Mock `graphql-ws` and assert:

```typescript
createClient({
  url: 'wss://druvia.example.com/v1/graphql',
  lazy: false,
  retryAttempts: 0,
  connectionAckWaitTimeout: 10_000,
  connectionParams: {
    headers: { Authorization: 'Bearer signed-realtime-token' },
  },
  on: expect.objectContaining({
    connected: expect.any(Function),
    closed: expect.any(Function),
    error: expect.any(Function),
  }),
})
```

The returned `dispose()` must call the GraphQL WS client disposal exactly once and prevent later callbacks from changing UI state. Test close code `4504` (acknowledgment timeout) and authorization close codes as `failed`; only an expected normal close may report `disconnected`.

- [ ] **Step 3: Add UI behavior tests**

Render the page with mocked API/store and verify:

- separate authenticated/anonymous readiness labels;
- API Key / Project Token segmented mode;
- credential input uses `type="password"` and remains React state only;
- real test transitions through connecting/connected/failed/disconnected;
- unmount disposes the probe;
- non-production `environment_identity_required` shows an unavailable state and disables connect;
- page source contains no `api.getToken()` Realtime path and no simulated-test copy.

- [ ] **Step 4: Run tests and observe current simulated behavior failure**

```bash
pnpm vitest run tests/unit/admin/realtime-connection-test.test.ts tests/unit/admin/realtime-page.test.tsx
```

Expected: FAIL until helper/API/UI changes are implemented.

- [ ] **Step 5: Implement the helper and API method**

Alias the dependency import to avoid conflict with the Druvia SDK naming:

```typescript
import { createClient as createGraphqlWsClient } from 'graphql-ws'

function normalizeRealtimeProbeError(error: unknown): Error {
  if (error instanceof Error) return error
  if (error && typeof error === 'object' && 'reason' in error) {
    return new Error(String((error as { reason?: unknown }).reason || 'Realtime connection failed'))
  }
  return new Error(typeof error === 'string' ? error : 'Realtime connection failed')
}

export function startRealtimeConnectionTest(input: {
  websocketUrl: string
  token: string
  onState: (state: 'connecting' | 'connected' | 'failed' | 'disconnected', error?: Error) => void
}) {
  let disposed = false
  input.onState('connecting')
  const client = createGraphqlWsClient({
    url: input.websocketUrl,
    lazy: false,
    retryAttempts: 0,
    connectionAckWaitTimeout: 10_000,
    connectionParams: {
      headers: { Authorization: `Bearer ${input.token}` },
    },
    on: {
      connected: () => { if (!disposed) input.onState('connected') },
      closed: (event) => {
        if (disposed) return
        const close = event as { code?: number; reason?: string }
        if (close.code === 1000) {
          input.onState('disconnected')
          return
        }
        input.onState('failed', new Error(close.reason || 'Realtime connection closed'))
      },
      error: (error) => {
        if (!disposed) input.onState('failed', normalizeRealtimeProbeError(error))
      },
    },
  })
  return {
    dispose: () => {
      if (disposed) return
      disposed = true
      void client.dispose()
    },
  }
}
```

The Admin API method must use direct `fetch` with only the supplied application credential, because the generic private request method injects the platform Admin token.

- [ ] **Step 6: Implement the page behavior**

Remove `testTable`, fake log entries, and instructional panel. Add:

- actor-specific badges in the table list;
- a segmented actor selector;
- password credential input;
- connect/disconnect commands with `Play`, `Square`, and live status icons;
- a compact connection result panel;
- `useRef` for the active probe;
- cleanup on unmount and before every new attempt;
- credential/token clearing on disconnect;
- non-production limitation based on `runtimeAvailability`.

Do not display/copy the short-lived token and do not persist either credential.

- [ ] **Step 7: Run Admin tests, lint, and build**

```bash
pnpm vitest run tests/unit/admin/realtime-connection-test.test.ts tests/unit/admin/realtime-page.test.tsx tests/unit/admin/data-interface-status.test.tsx
pnpm --filter @druvia/admin lint
pnpm --filter @druvia/admin build
```

Expected: PASS. If the full Admin lint/build exposes an unrelated pre-existing failure, record its exact file/error and still require all new focused tests to pass.

**Manual commit checkpoint:**

```text
feat(admin): 提供真实 Realtime 连接测试

  - 分开展示认证用户与匿名客户端订阅就绪状态
  - 使用内存中的应用凭证换取短期连接令牌
  - 以真实 WebSocket 握手替换模拟测试反馈
```

---

### Task 9: Align Hasura JWT Configuration Across Compose Modes

**Files:**

- Modify: `docker/docker-compose.yml`
- Modify: `docker/docker-compose.dev.yml`
- Modify: `docker/docker-compose.local.yml`
- Modify: `docker/docker-compose.prod.yml`
- Modify: `docker/docker-compose.release.yml`
- Modify: `.env.example`
- Modify: `docker/.env.example`
- Modify: `docker/.env.prod.example`
- Modify: `docker/.env.release.example`
- Create: `scripts/release/verify-realtime-compose.mjs`
- Modify: `.github/workflows/release.yml`
- Modify: `tests/unit/release-compose-files.test.ts`
- Modify: `tests/unit/release-pipeline.test.ts`
- Create: `tests/unit/realtime-compose-config.test.ts`

- [ ] **Step 1: Add source-level Compose contract tests**

For every supported Compose file, extract API and Hasura service blocks and assert:

```typescript
expect(hasuraBlock).toContain(
  '"key":"${HASURA_JWT_SECRET:-${JWT_SECRET}}"'
)
expect(hasuraBlock).toContain('"issuer":"druvia"')
expect(hasuraBlock).toContain('"audience":"druvia-hasura"')
expect(apiBlock).toContain(
  'HASURA_JWT_SECRET: ${HASURA_JWT_SECRET:-${JWT_SECRET}}'
)
expect(apiBlock).toContain(
  'HASURA_REALTIME_TOKEN_TTL_SECONDS: ${HASURA_REALTIME_TOKEN_TTL_SECONDS:-300}'
)
```

Also assert that every API service receives `HASURA_PUBLIC_URL`. Base/dev/local files may default it to the host-exposed Hasura port. Prod/release must resolve it from explicit `HASURA_PUBLIC_URL` or required same-origin `API_BASE_URL`, and must not contain `API_BASE_URL:-http://localhost:3001`. Keep `HASURA_GRAPHQL_UNAUTHORIZED_ROLE=anonymous` asserted for compatibility.

In `tests/unit/release-pipeline.test.ts`, add failing ordering assertions that the workflow sets up pnpm before cached Node setup, installs with `pnpm install --frozen-lockfile`, runs the focused Realtime test gate, builds `@druvia/sdk`, and invokes `node scripts/release/verify-realtime-compose.mjs` before the first `docker/build-push-action` occurrence.

- [ ] **Step 2: Run tests and observe mismatch failures**

```bash
pnpm vitest run tests/unit/realtime-compose-config.test.ts tests/unit/release-compose-files.test.ts tests/unit/release-pipeline.test.ts
```

Expected: FAIL against current `JWT_SECRET`-only JSON.

- [ ] **Step 3: Update all service environments**

Use this exact Hasura verifier JSON in each Compose mode:

```yaml
HASURA_GRAPHQL_JWT_SECRET: '{"type":"HS256","key":"${HASURA_JWT_SECRET:-${JWT_SECRET}}","issuer":"druvia","audience":"druvia-hasura"}'
```

Pass the same effective key to API:

```yaml
HASURA_JWT_SECRET: ${HASURA_JWT_SECRET:-${JWT_SECRET}}
HASURA_REALTIME_TOKEN_TTL_SECONDS: ${HASURA_REALTIME_TOKEN_TTL_SECONDS:-300}
```

For base/dev/local split-port operation, inject a browser-reachable Hasura origin such as:

```yaml
HASURA_PUBLIC_URL: ${HASURA_PUBLIC_URL:-http://localhost:${HASURA_PORT:-8080}}
```

For prod/release, require a real public origin and allow same-origin fallback:

```yaml
API_BASE_URL: ${API_BASE_URL:?Set API_BASE_URL to the public Druvia origin}
HASURA_PUBLIC_URL: ${HASURA_PUBLIC_URL:-${API_BASE_URL}}
```

The local nginx profile may override `HASURA_PUBLIC_URL` with `http://localhost:${HTTP_PORT:-8088}`. Release-mode local OTA rehearsal must persist `HASURA_PUBLIC_URL=http://localhost:8088` (or its chosen `LOCAL_HTTP_PORT`) in untracked `.env.release`; a one-shot shell assignment is insufficient because updater-initiated Compose commands run later. Do not derive a WebSocket URL from internal `http://hasura:8080` in production.

Do not remove the unauthorized role in Batch 3B.

- [ ] **Step 4: Document example values without secrets**

Each applicable example contains:

```dotenv
# Dedicated HS256 key shared only by Druvia API token issuance and Hasura verification.
# Existing deployments may temporarily omit this to fall back to JWT_SECRET.
HASURA_JWT_SECRET=change_me_to_a_distinct_32_char_min_secret
HASURA_REALTIME_TOKEN_TTL_SECONDS=300
HASURA_PUBLIC_URL=https://druvia.example.com
```

For `docker/.env.example`, use the directly exposed local Hasura origin and explain the local nginx override. For `docker/.env.prod.example`, use the production public site origin. Keep production secret/origin configuration in `.env.prod`. In `.env.release.example`, document the optional local-OTA-only override and that updater preserves existing extra keys when merging image/version values. Keep real `.env`, `.env.prod`, and `.env.release` files untracked and untouched.

- [ ] **Step 5: Prove Compose interpolation for explicit and fallback secrets**

Create `scripts/release/verify-realtime-compose.mjs`. It must call `docker compose config` with `shell: false` for base/dev/local/prod/release, supplying only synthetic non-secret values. Create a temporary empty env file and pass it explicitly with `--env-file`; build a sanitized child environment from an allowlist such as `PATH`, `HOME`, `DOCKER_CONFIG`, `TMPDIR` plus synthetic Compose values, so Compose cannot auto-load or inherit real `.env`, `.env.prod`, `.env.release`, secret, image, or origin values from the developer machine. Remove the temporary directory in `finally`. For each file it renders:

1. dedicated `HASURA_JWT_SECRET` plus a different `JWT_SECRET` and verifies API/Hasura both contain the dedicated value;
2. empty `HASURA_JWT_SECRET` plus `JWT_SECRET` and verifies both contain the fallback value;
3. expected browser-reachable `HASURA_PUBLIC_URL` for that mode;
4. issuer `druvia` and audience `druvia-hasura` in Hasura JSON.

It must also render prod/release with missing `API_BASE_URL` and `HASURA_PUBLIC_URL`, require a nonzero exit, and reject any successful output containing `HASURA_PUBLIC_URL: http://localhost:3001`. The script exits nonzero on a missing Docker Compose CLI rather than silently skipping a release prerequisite.

Before registry login and image builds, add Node 22/pnpm setup, a frozen install, the focused test gate, SDK build, and rendered Compose gate. The focused command covers all Batch 3B unit/SDK/Admin tests available through Task 9:

```yaml
- name: Setup pnpm
  uses: pnpm/action-setup@v4
  with:
    version: 9.0.0
    run_install: false

- name: Setup Node.js
  uses: actions/setup-node@v4
  with:
    node-version: 22
    cache: pnpm

- name: Install dependencies
  run: pnpm install --frozen-lockfile

- name: Verify Realtime behavior
  run: >-
    pnpm vitest run
    tests/unit/realtime-actor.test.ts
    tests/unit/project-data-actor.test.ts
    tests/unit/realtime-token-service.test.ts
    tests/unit/ratelimit-realtime-token.test.ts
    tests/unit/ratelimit-graphql.test.ts
    tests/unit/realtime-controller.test.ts
    tests/unit/realtime-service.test.ts
    tests/unit/api-app.test.ts
    tests/unit/auth.test.ts
    tests/sdk/realtime-token.test.ts
    tests/sdk/realtime.test.ts
    tests/sdk/client.test.ts
    tests/sdk/project-auth.test.ts
    tests/sdk/database.test.ts
    tests/unit/admin/realtime-connection-test.test.ts
    tests/unit/admin/realtime-page.test.tsx
    tests/unit/admin/data-interface-status.test.tsx
    tests/unit/realtime-compose-config.test.ts
    tests/unit/release-compose-files.test.ts
    tests/unit/release-pipeline.test.ts

- name: Build SDK
  run: pnpm --filter @druvia/sdk build

- name: Verify Realtime Compose contracts
  run: node scripts/release/verify-realtime-compose.mjs
```

Exercise the final gate once through `workflow_dispatch` before relying on tag-triggered publication.

- [ ] **Step 6: Run automated render verification**

```bash
node scripts/release/verify-realtime-compose.mjs
pnpm vitest run \
  tests/unit/realtime-compose-config.test.ts \
  tests/unit/release-compose-files.test.ts \
  tests/unit/release-pipeline.test.ts
```

Expected: all source and rendered contracts PASS.

- [ ] **Step 7: Keep representative manual commands for diagnosis**

For each relevant file, render once with both values and once with only `JWT_SECRET`. At minimum run these representative local/release commands, then repeat for base/dev/prod using their required existing example values:

```bash
HASURA_JWT_SECRET=hasura_realtime_secret_1234567890ab \
JWT_SECRET=legacy_platform_secret_1234567890ab \
HASURA_PUBLIC_URL=http://localhost:8080 \
docker compose --env-file docker/.env.example \
  -f docker/docker-compose.local.yml config

HASURA_JWT_SECRET= \
JWT_SECRET=legacy_platform_secret_1234567890ab \
HASURA_PUBLIC_URL=http://localhost:8080 \
docker compose --env-file docker/.env.example \
  -f docker/docker-compose.local.yml config
```

Inspect rendered API `HASURA_JWT_SECRET`, `HASURA_PUBLIC_URL` and Hasura JWT JSON. Explicit render must use `hasura_realtime_secret_1234567890ab` in both signing locations; fallback render must use `legacy_platform_secret_1234567890ab` in both. Local public URL must remain `http://localhost:8080`. Separately render the local nginx profile with `HASURA_PUBLIC_URL=http://localhost:8088`. Prod/release rendering without both `HASURA_PUBLIC_URL` and `API_BASE_URL` must fail instead of producing `localhost:3001`.

- [ ] **Step 8: Run Compose tests and whitespace checks**

```bash
pnpm vitest run tests/unit/realtime-compose-config.test.ts tests/unit/release-compose-files.test.ts tests/unit/release-pipeline.test.ts
git diff --check
```

Expected: PASS.

**Manual commit checkpoint:**

```text
feat(docker): 统一 Realtime JWT 签名配置

  - 为 API 与 Hasura 注入相同的独立签名密钥
  - 保留 JWT_SECRET 回退和旧匿名连接兼容路径
  - 补充各部署模式的令牌有效期与环境示例
```

---

### Task 10: Add Real Hasura Token Verification Coverage

**Files:**

- Modify: `package.json`
- Modify: `pnpm-lock.yaml`
- Modify: `tests/integration/realtime.test.ts`
- Create: `tests/integration/realtime-token.test.ts`

- [ ] **Step 1: Make the WebSocket test client a declared root test dependency**

The Admin workspace already uses `graphql-ws`, but root Vitest files cannot rely on another workspace's strict pnpm dependency boundary. Add the matching major version explicitly:

```bash
pnpm add -Dw graphql-ws@^6.0.7
```

Expected: root `package.json` and `pnpm-lock.yaml` record the test dependency; no application package dependency changes.

- [ ] **Step 2: Add integration setup with a temporary project role**

Use the existing integration database/Hasura helpers. Require the test process `HASURA_JWT_SECRET` to match the running Hasura verifier key and require Hasura JWT JSON to use issuer `druvia` and audience `druvia-hasura`; fail setup with an actionable message when this contract is absent. Create isolated project/schema/table fixtures, track the table, install select permissions for the expected compatibility and scoped roles, and mark the table Realtime-enabled. Generate tokens only through `issueRealtimeAccessToken()`. Build the acknowledgment helper with `lazy: false`, `retryAttempts: 0`, a bounded acknowledgment timeout, and disposal in `finally`; a lazy client without an operation is not evidence of a connection. In `afterAll`, drop test permissions/metadata before schemas and project rows so repeated runs leave no tracked-table or database residue.

- [ ] **Step 3: Test new-connection verification**

Open `graphql-transport-ws` connections and assert:

- a valid token receives `connection_ack`;
- a token whose first signature-segment character is deterministically changed is rejected;
- an expired token is rejected;
- a legacy empty `connection_init` receives acknowledgment and can subscribe through the retained `anonymous` permission;
- a token for project A cannot subscribe to project B's scoped table;
- compatibility API-key token uses legacy `anonymous` permission;
- explicit Project User and API-key tokens use their scoped permissions.

The test may use the installed `graphql-ws` client and must set `retryAttempts: 0` so expected authentication rejection is observed once without hidden client retries. It must dispose every connection in `afterEach`/`finally`.

Cross-project denial is asserted only for explicit scoped roles. Do not add a false compatibility isolation assertion: legacy `user`/`anonymous` role permissions are global Hasura role names and remain Batch 4 migration debt.

- [ ] **Step 4: Run integration coverage**

```bash
HASURA_JWT_SECRET="$LOCAL_HASURA_JWT_SECRET" \
HASURA_GRAPHQL_JWT_SECRET="$LOCAL_HASURA_JWT_SECRET_JSON" \
HASURA_PUBLIC_URL="http://localhost:${HASURA_PORT:-8180}" \
DRUVIA_INTEGRATION_HASURA_ADMIN_SECRET="$LOCAL_HASURA_ADMIN_SECRET" \
pnpm vitest run tests/integration/realtime-token.test.ts tests/integration/realtime.test.ts
```

`LOCAL_HASURA_JWT_SECRET`、`LOCAL_HASURA_JWT_SECRET_JSON` 和 `LOCAL_HASURA_ADMIN_SECRET` 必须与正在运行的本地 Hasura 容器一致；JSON verifier 必须包含 issuer `druvia` 和 audience `druvia-hasura`。Expected: PASS when PostgreSQL and Hasura integration dependencies are running. Do not turn an unavailable local dependency into a skipped production assertion; report it and run the test in the Docker validation environment before release.

- [ ] **Step 5: Record the residual expiry boundary**

Do not add a test claiming Hasura forcibly closes every already-open socket exactly at JWT expiry unless the pinned Hasura version demonstrably does so. Batch 3B tests token validity for new connections and cooperative SDK renewal only.

**Manual commit checkpoint:**

```text
test(realtime): 验证 Hasura 短期令牌边界

  - 覆盖有效、篡改和过期令牌的新连接行为
  - 验证跨项目 scoped role 无法读取目标表
  - 保留兼容匿名订阅的集成回归测试
```

---

### Task 11: Synchronize Durable Documentation And Run The Release Gate

**Files:**

- Modify: `AGENTS.md`
- Modify: `apps/api/AGENTS.md`
- Modify: `packages/sdk/AGENTS.md`
- Modify: `apps/admin/AGENTS.md`
- Modify: `docs/agent/design-decisions.md`
- Modify: `docs/progress.md`
- Modify: `docs/migration/supabase-compat.md`
- Modify: `docs/003-version-release-guide.md`
- Modify: `docs/plans/2026-08-14-project-update-direction-analysis.md`

- [ ] **Step 1: Update stable module rules**

Replace every statement that says SDK Realtime still connects anonymously with the completed Batch 3B contract:

- API exchanges only same-project Project Session/API key actors;
- compatibility API key maps to `anonymous`, compatibility Project User maps to `user`;
- explicit actors use scoped roles;
- SDK never sends long-lived credentials to Hasura;
- Admin tests with application credentials held in memory;
- non-production runtime remains unavailable until environment identity exists.

Keep both residual limitations explicit: already-open malicious socket revocation and the absence of cross-project isolation guarantees for global compatibility roles. State that Batch 4 activation/removal of legacy permissions is the isolation closure.

- [ ] **Step 2: Update migration compatibility guidance**

Document that Supabase/taro-app consumers should continue calling `channel().on().subscribe()`, but Druvia now performs asynchronous token exchange before socket creation. Record status callback availability, automatic reconnect, snapshot reset/no event replay, and the requirement that client base URL be the Druvia API root such as `https://host/api/v1`.

- [ ] **Step 3: Update release and rollback procedure**

Add this order to `docs/003-version-release-guide.md`:

1. inventory custom clients that send platform/custom JWTs directly to Hasura and flag tokens without the new issuer/audience;
2. configure a dedicated `HASURA_JWT_SECRET` on the target;
3. configure browser-reachable `HASURA_PUBLIC_URL` in `.env.prod` (or use the same origin as required `API_BASE_URL`);
4. render Compose and prove API/Hasura use the same effective key and public origin;
5. let the signed release manifest stage/replace `docker-compose.release.yml`, then recreate Hasura and API with issuer/audience settings;
6. deploy Admin/SDK consumers;
7. test compatibility API key and explicit actors;
8. on rollback, restore the previous Hasura JWT JSON if an older custom JWT workflow depends on it.

State that durable signing/public-origin values belong in `.env.prod`, because OTA rewrites the release compose and merges image/version values into `.env.release`. Temporary fallback to `JWT_SECRET` is transitional and emits a warning. It does not make old direct JWTs without `iss=druvia` and `aud=druvia-hasura` valid after the Hasura verifier change; only legacy no-token anonymous connections retain compatibility automatically.

- [ ] **Step 4: Mark progress accurately**

Move Batch 3B from Current Next Steps to Recent Milestones. Keep Batch 4 migration activation as the next Project Data Access step. Do not claim hard immediate socket revocation or non-production environment support.

- [ ] **Step 5: Run documentation drift scans**

```bash
grep -R -n "SDK WebSocket still\|仍以 Hasura.*anonymous\|Realtime.*等待 Batch 3B\|当前 SDK WebSocket" \
  AGENTS.md apps/api/AGENTS.md packages/sdk/AGENTS.md apps/admin/AGENTS.md docs
grep -R -n "HASURA_JWT_SECRET\|HASURA_PUBLIC_URL" \
  .env.example docker/.env.example docker/.env.prod.example docker/.env.release.example \
  docs/003-version-release-guide.md
```

Expected: no stale Batch 3B-pending statements remain; all supported deployment examples and release docs mention the new key.

- [ ] **Step 6: Run the complete verification gate**

```bash
pnpm vitest run \
  tests/unit/realtime-actor.test.ts \
  tests/unit/project-data-actor.test.ts \
  tests/unit/realtime-token-service.test.ts \
  tests/unit/ratelimit-realtime-token.test.ts \
  tests/unit/ratelimit-graphql.test.ts \
  tests/unit/realtime-controller.test.ts \
  tests/unit/realtime-service.test.ts \
  tests/unit/api-app.test.ts \
  tests/unit/auth.test.ts \
  tests/sdk/realtime-token.test.ts \
  tests/sdk/realtime.test.ts \
  tests/sdk/client.test.ts \
  tests/sdk/project-auth.test.ts \
  tests/sdk/database.test.ts \
  tests/unit/admin/realtime-connection-test.test.ts \
  tests/unit/admin/realtime-page.test.tsx \
  tests/unit/admin/data-interface-status.test.tsx \
  tests/unit/realtime-compose-config.test.ts \
  tests/unit/release-compose-files.test.ts \
  tests/unit/release-pipeline.test.ts

pnpm --filter @druvia/api build
pnpm --filter @druvia/sdk build
pnpm --filter @druvia/admin lint
pnpm --filter @druvia/admin build
node scripts/release/verify-realtime-compose.mjs
git diff --check
git status --short
```

Expected: all focused tests and builds PASS; only intended Batch 3B files are modified/untracked.

- [ ] **Step 7: Run runtime smoke checks in Docker**

After applying a non-production dedicated secret, recreate API and Hasura, then verify:

```bash
curl -fsS http://localhost:3001/health
curl -fsS http://localhost:8088/health
```

Use an API key to request a token, establish a compatibility anonymous subscription, then use a Project Session to establish an authenticated subscription. Advance fake/short TTL only in a dedicated test deployment and observe the SDK reconnect with no application resubscribe call.

**Manual commit checkpoint:**

```text
docs(realtime): 归档 Batch 3B 令牌交换与部署规则

  - 更新项目权限、SDK 迁移和管理端使用约束
  - 补充独立签名密钥发布及回滚流程
  - 将短期令牌和自动重连纳入当前项目进度
```

---

## Completion Criteria

The plan is complete only when:

- every focused unit/SDK/Admin/Compose test passes;
- API, SDK and Admin build successfully;
- supported Compose files render one identical effective key for API and Hasura in explicit and fallback modes;
- local split-port, local nginx and production same-origin configurations return browser-reachable Hasura WebSocket URLs;
- a real Hasura deployment accepts a valid token and rejects modified, expired and explicit-role cross-project tokens on new connections;
- cross-project denial claims are limited to explicit scoped roles; compatibility behavior is documented as legacy migration debt;
- an SDK channel renews/reconnects without caller resubscription, cannot reconnect automatically after unsubscribe, and can restart only through an explicit fresh subscribe;
- Admin uses no platform token for the Realtime test and shows no false non-production availability;
- documentation removes stale anonymous-only/Batch 3B-pending statements while preserving the residual open-socket revocation risk;
- no secret or real `.env` file appears in `git status`.
