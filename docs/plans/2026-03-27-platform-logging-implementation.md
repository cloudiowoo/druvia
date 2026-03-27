# Platform Logging Phase 1 Implementation Plan

> **Goal:** Establish Druvia Phase 1 platform logging so self-owned services emit consistent structured JSON logs to stdout/stderr without forcing any specific logging backend. Phase 2 will optionally add a recommended `Loki + Promtail + Grafana` deployment profile.
>
> **Architecture:** Keep logging backend-agnostic. Introduce a shared logging contract for API, Admin server-side, Deno Worker, and MCP Server. Reuse Fastify logger as the API anchor, then align other services around the same field and error conventions. Do not make centralized logging part of the minimum deployment path.
>
> **Tech Stack:** Fastify 5, Next.js 16 server runtime, Node.js 22, Deno 2, Docker Compose, pnpm
>
> **Spec:** `docs/plans/2026-03-27-platform-logging-design.md`

---

## File Structure

### Shared logging contract

- Create: Node-side shared logging helpers under `packages/shared/src/logging/*` or equivalent
- Modify: `packages/shared/src/index.ts` if needed
- Implement separately in `docker/deno-worker/*` for Deno-side parity when needed
- Create: `tests/unit/shared-logging.test.ts` if a shared helper module is introduced

Responsibility:
- define structured log shape
- define error serialization helper
- define logger context shape reused by Node services
- document the runtime-agnostic contract Deno must match

### API logging

- Modify: `apps/api/src/index.ts`
- Modify: `apps/api/src/modules/**/*` in focused high-value areas
- Modify: `apps/api/src/middleware/**/*` where raw `console.*` currently exists

Responsibility:
- standardize Fastify logger usage
- replace critical `console.warn/error` with consistent structured logging
- ensure request-scoped context is available where appropriate

### Deno Worker logging

- Modify: `docker/deno-worker/main.ts`
- Modify: `docker/deno-worker/executor.ts`
- Modify: `docker/deno-worker/druvia-helper.ts` only if execution context needs logging support

Responsibility:
- emit structured execution logs
- include project/function/execution identity
- avoid payload overlogging
- match the documented contract without depending on Node package reuse

### MCP Server logging

- Modify: `packages/mcp-server/src/index.ts`

Responsibility:
- replace startup/auth/fatal `console.error` with structured logging
- align fields with Phase 1 contract

### Admin server-side logging

- Modify: server-side utilities or API-facing server code under `apps/admin`

Responsibility:
- cover server-side operational logs only
- do not attempt full browser logging collection in Phase 1

### Docs and deployment guidance

- Modify: `docs/agent/project-memory.md`
- Modify: `docs/agent/design-decisions.md`
- Modify: `docs/progress.md`
- Modify: `AGENTS.md` only if a new working rule must be surfaced
- Optionally add later: `docker/docker-compose.*` for Phase 2 `with-logs` profile

Responsibility:
- record stdout-first logging model
- document that logging backend remains user-selectable
- preserve Phase 2 optional deployment direction

---

## Task 1: Define The Shared Structured Logging Contract

**Files:**
- Create: `packages/shared/src/logging/*`
- Create: `tests/unit/shared-logging.test.ts` if a shared helper is added

- [ ] **Step 1: Define the minimal logging schema**

Create a shared contract for:

- base fields: `ts`, `level`, `service`, `msg`
- optional context: `module`, `requestId`, `tenantId`, `projectId`, `userId`, `projectUserId`, `functionName`, `executionId`, `durationMs`
- error shape: `err.name`, `err.code`, `err.message`, `err.stack`

Keep the contract narrow. Do not over-model every possible service field in Phase 1.

- [ ] **Step 2: Separate contract from implementation reuse**

Document explicitly:

- Node services may share one implementation helper
- Deno Worker follows the same contract but can keep an independent implementation
- Phase 1 does not require cross-runtime source-code reuse

- [ ] **Step 3: Add an error serializer helper**

Implement a helper that normalizes:

- native `Error`
- code-bearing domain errors
- unknown thrown values

It must avoid empty `{}` error output and preserve message/code when available.

- [ ] **Step 4: Add focused unit coverage if a new helper module is created**

Verify:

- native `Error` serialization
- object-like error with `code`
- string / unknown fallback

Run:

```bash
pnpm test tests/unit/shared-logging.test.ts
```

Expected: PASS if the helper test file is created for this task

---

## Task 2: Define Context Propagation Rules Before Replacing Logs

**Files:**
- Modify: `docs/plans/2026-03-27-platform-logging-design.md` only if execution details need clarification during implementation
- Modify: API / worker entry files as needed during implementation

- [ ] **Step 1: Define API context sources**

Explicitly map how these fields are obtained:

- `requestId`
- `tenantId`
- `projectId`
- `userId`
- `projectUserId`
- `module`

Preferred rule:

- request-bound logs should come from `request.log.child({...})` or equivalent scoped logger
- downstream business logs should inherit request context instead of rebuilding it ad hoc

- [ ] **Step 2: Define Deno Worker context sources**

Explicitly map how worker logs obtain:

- `projectId`
- `functionName`
- `executionId`

These must come from trusted execution context injected by platform runtime, not function-authoring code.

- [ ] **Step 3: Define MCP context scope**

Clarify what MCP can and cannot reliably log in Phase 1:

- startup metadata
- project identity if known at process start
- request-level upstream failure context where available

Do not assume MCP has API-style request context.

---

## Task 3: Normalize API Logging Around Fastify

**Files:**
- Modify: `apps/api/src/index.ts`
- Modify: focused files currently using `console.*`

- [ ] **Step 1: Audit high-value raw console usage**

Start with modules that matter most operationally:

- `apps/api/src/middleware/ratelimit.ts`
- `apps/api/src/lib/redis.ts`
- `apps/api/src/modules/project/project.service.ts`
- `apps/api/src/modules/table/table.service.ts`
- `apps/api/src/modules/functions/functions.service.ts`
- `apps/api/src/modules/backup/backup.service.ts`

Do not attempt a repo-wide replacement in one pass.

- [ ] **Step 2: Configure Fastify logger shape explicitly**

Update `apps/api/src/index.ts` so API logs use a stable JSON shape and predictable level behavior.

Requirements:

- keep Fastify request logging
- ensure production-safe defaults
- avoid logging sensitive headers/body by default

- [ ] **Step 3: Introduce module-scoped logger access**

Where practical, use:

- `app.log.child(...)`
- or a thin shared logger helper

The goal is consistency, not deep framework abstraction.

- [ ] **Step 4: Replace focused raw `console.warn/error` calls**

Convert high-value operational logs first:

- Redis connection lifecycle
- rate limiter failures
- project deletion / cleanup failures
- table track / untrack warnings
- functions encryption-key warning
- backup subprocess stderr routing

Keep message semantics stable while converting output shape.

- [ ] **Step 5: Verify API behavior and typecheck**

Run:

```bash
pnpm test tests/unit/api-app.test.ts
pnpm exec tsc -p apps/api/tsconfig.json --noEmit
```

Expected: PASS

---

## Task 4: Add Structured Logs To The Deno Worker

**Files:**
- Modify: `docker/deno-worker/main.ts`
- Modify: `docker/deno-worker/executor.ts`

- [ ] **Step 1: Define worker log events**

At minimum:

- worker started
- function execution started
- function execution succeeded
- function execution failed

- [ ] **Step 2: Add execution context fields**

When available, include:

- `projectId`
- `functionName`
- `executionId`
- `durationMs`

Avoid logging full function code, request payloads, or secrets.

- [ ] **Step 3: Normalize error output**

Worker failures should emit the same `err` object shape as API logs where feasible.

- [ ] **Step 4: Add focused tests if helper behavior changes**

If runtime helper or executor behavior changes in testable ways, add or update:

- `tests/unit/druvia-helper.test.ts`
- any worker-focused tests that cover execution logging support

Run relevant focused tests.

---

## Task 5: Normalize MCP Server Logging

**Files:**
- Modify: `packages/mcp-server/src/index.ts`

- [ ] **Step 1: Replace startup and fatal console logs**

Cover:

- missing env
- invalid API key
- failed project info lookup
- startup success
- fatal exit

- [ ] **Step 2: Align with the shared logging contract**

Use:

- `service = "mcp-server"`
- stable `msg`
- structured `err`

- [ ] **Step 3: Run focused MCP verification**

Run:

```bash
pnpm --filter @druvia/mcp-server build
```

Expected: PASS

---

## Task 6: Add Admin Server-Side Logging Guidance And Minimal Coverage

**Files:**
- Modify: relevant server-side code under `apps/admin`

- [ ] **Step 1: Identify actual server-side execution points**

Only cover:

- route handlers
- server-side API wrappers
- startup/server failures where applicable

Do not attempt to normalize browser console usage in Phase 1.

- [ ] **Step 2: Add minimal structured server-side logs**

Focus on:

- upstream API failures
- SSR/server action failures
- critical operational warnings

- [ ] **Step 3: Verify Admin still typechecks**

Run:

```bash
pnpm exec tsc -p apps/admin/tsconfig.json --noEmit
```

Current repository caveat:

- this command is already blocked by a pre-existing unrelated error at
  `apps/admin/src/app/t/[tenantId]/p/[projectId]/tables/page.tsx`
- the known issue is `EnvironmentContext` only exposes `envName`, while the page still references `currentEnv?.name`

Phase 1 execution rule:

- if Admin server-side logging code changes, run the command and record whether the output is unchanged except for the known unrelated error
- do not treat that existing Admin typecheck failure as a blocker for the logging task unless the output introduces new errors

---

## Task 7: Document The Stdout-First Logging Model

**Files:**
- Modify: `docs/agent/project-memory.md`
- Modify: `docs/agent/design-decisions.md`
- Modify: `docs/progress.md`
- Optionally modify: `AGENTS.md`

- [ ] **Step 1: Record the durable architectural rule**

Document that Druvia logging is:

- structured stdout/stderr first
- backend-agnostic
- officially compatible with multiple third-party logging systems

- [ ] **Step 2: Record the recommended deployment guidance**

Document that:

- `Loki + Promtail + Grafana` is the official recommended combo
- it remains optional
- it does not become a minimum deployment dependency

- [ ] **Step 3: Update progress/memory only with durable facts**

Do not turn progress docs into a task log. Record only the stable architecture decision and implementation milestone.

---

## Task 8: Phase 2 Optional Logging Stack

**Status:** planned, not part of Phase 1 completion

**Likely Files:**
- Modify: `docker/docker-compose.prod.yml`
- Modify: `docker/docker-compose.local.yml`
- Possibly create: `docker/promtail/*`, `docker/loki/*`, Grafana provisioning files

- [ ] **Step 1: Add a `with-logs` profile**

Keep it optional and isolated from the minimal deployment path.

- [ ] **Step 2: Provide Loki / Promtail / Grafana example configuration**

Requirements:

- collect container stdout/stderr
- support the services currently present in official compose:
  - API
  - Admin
  - Deno
  - Hasura
  - Postgres
  - Redis
  - Nginx
- avoid coupling app boot to log stack availability

Note:

- MCP is not currently part of official compose deployment
- if MCP is added to official compose later, extend the Phase 2 log stack to collect it as well

- [ ] **Step 3: Provide a minimal usage guide**

Include:

- startup commands
- sample queries
- sample dashboards or labels

---

## Verification

- [ ] Run focused tests for any new shared logging helper:

```bash
pnpm test tests/unit/shared-logging.test.ts
```

- [ ] If no shared helper test file is added in this phase, explicitly record that this verification item is not applicable
- [ ] Run:

```bash
pnpm test tests/unit/api-app.test.ts
pnpm exec tsc -p apps/api/tsconfig.json --noEmit
```

- [ ] If Admin server-side code changes, run:

```bash
pnpm exec tsc -p apps/admin/tsconfig.json --noEmit
```

Treat the existing `EnvironmentContext` / `currentEnv?.name` failure as a known non-logging blocker unless new Admin errors appear.

- [ ] If MCP server code changes, run:

```bash
pnpm --filter @druvia/mcp-server build
```
- [ ] Manually verify representative logs from:
  - API startup
  - one request log
  - one business warning/error log
  - one Deno function execution log
  - one MCP startup/fatal path log

---

## Completion Criteria

Phase 1 is complete when:

1. API, Deno Worker, MCP Server, and Admin server-side critical paths have a unified structured logging contract
2. High-value operational `console.*` usage is reduced or normalized in the touched modules
3. Logs remain backend-agnostic and stdout-first
4. No external logging backend is required for Druvia to run
5. Docs clearly state that centralized logging is optional and backend choice remains with the deployer
