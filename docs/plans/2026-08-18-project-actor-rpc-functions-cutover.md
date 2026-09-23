# Project Actor RPC And Functions Cutover

Date: 2026-08-18

Status: Implemented

> **2026-09-22 security amendment:** The legacy host-API `docker-compose.yml` and `docker-compose.dev.yml` no longer
> start the Deno worker. They are infrastructure-only modes and do not support Project Functions; the historical
> references below to loopback Worker publication are superseded by the Project GraphQL Actor Contract network boundary.

> **Execution rule:** Implement this document inline in the main checkout with TDD. Complete the slice tasks in order without per-task review checkpoints. Review the whole slice before commit. Do not use worktrees or subagents for this slice.

**Goal:** Establish one auditable project actor contract for application execution paths, remove the SDK platform-session fallback from RPC and Functions, propagate caller identity into PostgreSQL RPC and the Deno runtime, and enforce Project Data Access permissions for `druvia.graphql()`.

**Architecture:** A pure API-side actor module normalizes authenticated request identities into a versioned `ProjectActorContext`. RPC and Functions reuse that identity but retain capability-specific authorization: RPC remains authenticated-only, while Functions allows API keys only for `anon_allowed`. PostgreSQL receives transaction-local claims; the API authenticates every Worker execution request before sending a signed internal actor envelope; internal GraphQL executes under a server-derived Hasura role instead of unconstrained admin access.

**Tech stack:** Fastify 5, TypeScript, PostgreSQL 17, Hasura v2.48, Deno Worker, `@druvia/sdk`, Vitest, GitHub Actions.

---

## 1. Scope

This slice completes the next part of the Phase A Project User identity baseline after the GraphQL HTTP, Realtime, and legacy-project migration batches.

Included:

1. A canonical, project-scoped actor contract for `platform_user`, `project_user`, and `apikey` request identities.
2. Stable API-key identity fields for audit without exposing the secret.
3. RPC identity authorization, PostgreSQL transaction claims, and structured audit logs.
4. Functions invoke authorization through the common actor contract.
5. Versioned internal Function tokens, Worker caller context, compatibility headers, and structured logs.
6. Permission-enforced internal Function GraphQL execution for Project User and API Key actors.
7. Compatibility adaptation for the existing internal Function Storage helper token consumer, without adding a new Storage policy.
8. API-to-Worker request authentication, Worker health checks, and safe Worker port exposure across every Compose mode.
9. SDK RPC/Functions token selection without Platform Session fallback.
10. Unit, SDK, real PostgreSQL/Hasura integration, Compose, build, and release-gate coverage.
11. Synchronization of durable identity, migration-compatibility, and progress documentation.

Excluded:

- Direct end-user Storage routes, object ownership policy, bucket policy, and SDK Storage token cutover. The existing internal Function Storage helper is updated only to consume the new actor token safely.
- A generic PostgreSQL RLS framework or automatic authorization inside arbitrary RPC functions.
- Anonymous RPC execution or function-level RPC grants.
- Trusted Backend key lifecycle changes.
- MCP authentication changes.
- Non-default project environment identity.
- New Admin pages.
- Real GitHub release, image publication, Registry pull, OTA, or production deployment rehearsal.

## 2. Confirmed Decisions

1. The common actor contract normalizes identity; it does not make every actor valid for every capability.
2. The contract is API-owned. Worker transport uses a versioned serialized envelope and compatibility tests rather than importing Node workspace code into the Deno image.
3. A Project User is identified by immutable `projectId + projectUserId`; mutable provider or role labels are context, not identity.
4. An API Key actor includes database key ID and key prefix. The complete key and key hash never enter request context, tokens, Function payloads, or logs.
5. Platform User remains a management actor. It is never silently converted into a Project User.
6. RPC accepts same-project Project User and an explicitly authorized Platform User. It continues to reject API Key actors.
7. RPC claims make caller identity available to PostgreSQL functions but do not claim to enforce RLS or function business authorization.
8. Functions keeps the existing `jwt_required | anon_allowed` policy. `anon_allowed` is the only mode that admits an API Key actor.
9. A Platform User may explicitly invoke a Function for management/testing, but its Function helper cannot use `druvia.graphql()` as an application actor.
10. Internal GraphQL uses Hasura admin secret only for API-to-Hasura authentication. It always adds the server-derived `x-hasura-role` and session variables for Project User/API Key execution.
11. Existing schema-reference checks remain defense in depth. Hasura permissions become the primary authorization boundary.
12. Existing Function response shapes, RPC response shapes, and legacy `x-druvia-auth-type` Worker request header remain compatible.
13. Function execution metadata stops persisting the raw invocation payload. Audit records actor identity, function, execution ID, outcome, and duration only.
14. SDK Storage remains bound to Platform Session in this slice. RPC and Functions use a separate application fetch path and never fall back to Platform Session.
15. The Worker `/execute` route is not a public API. It must authenticate the API before reading/executing code. Local/production/release Compose must not publish port `7133`; legacy host-API Compose may bind it only to loopback.
16. `invokeFunction()` requires an explicit actor. Tests and internal callers must construct one intentionally; the service never defaults a missing caller to API Key. A future schedule runner requires a separately designed service-principal actor and cannot reuse an anonymous identity.
17. User Function code cannot read the Worker/API credential or other container environment variables. Function secrets remain compatible through an invocation-local `Deno.env` shim backed only by the Function's decrypted secret map.
18. Worker-auth rollout order is part of the OTA contract. Upgrade starts the new API before the new Worker; rollback restores the old Worker before the old API. A simultaneous unordered replacement is not accepted as rollback evidence.
19. Function invoke-mode authorization is enforced in the service against the same function record it executes. Controller-only prechecks and a second service lookup are not an authorization boundary.

## 3. Actor Contract

Create `apps/api/src/lib/project-actor.ts` as the canonical request-to-actor boundary.

```ts
export const PROJECT_ACTOR_CONTRACT_VERSION = 1 as const

export type ProjectActorType = 'platform_user' | 'project_user' | 'apikey'
export type ProjectActorSource = 'platform_session' | 'project_session' | 'project_api_key'

export type ProjectActorContext =
  | {
      version: 1
      actorType: 'platform_user'
      source: 'platform_session'
      projectId: string
      subject: string
      role: string
      platformUserId: string
      platformUid: number
      tenantId?: string
    }
  | {
      version: 1
      actorType: 'project_user'
      source: 'project_session'
      projectId: string
      subject: string
      role: 'authenticated'
      projectUserId: string
      provider: string
    }
  | {
      version: 1
      actorType: 'apikey'
      source: 'project_api_key'
      projectId: string
      subject: string
      role: 'anon'
      apiKeyId: number
      apiKeyPrefix: string
    }
```

Pure resolvers:

```ts
resolveScopedProjectActor(user, projectId)
resolvePlatformProjectActor(user, projectId)
toProjectActorAuditContext(actor)
toProjectActorClaims(actor)
```

`resolveScopedProjectActor` accepts only same-project `project_user`/`apikey`. `resolvePlatformProjectActor` accepts only a Platform User after the controller has completed `checkProjectAccess`; the pure resolver does not query the database or hide authorization I/O.

Role mapping is deterministic and preserves current compatibility: Platform User uses `user.role ?? 'authenticated'`, Project User is always `authenticated`, and API Key is always `anon`. A caller-supplied role never enters the resolver.

Stable subjects are fixed as follows:

- Platform User: `platform_user:<platformUserId>`
- Project User: `project_user:<projectUserId>`
- API Key: `apikey:<apiKeyId>`

No subject derives from display name, provider, key prefix, project alias, or another mutable field.

Cross-project identities throw a typed `ProjectActorScopeError`. Unsupported identities throw `ProjectActorRequiredError`. Controllers map these to the existing sanitized 401/403 response family and never return actor internals.

The API Key branch also validates that `apiKeyId` is a positive safe integer and `apiKeyPrefix` is non-empty. Type assertions or non-request probe data cannot be normalized into a request actor, signed into an internal Function token, or emitted as an authenticated audit subject.

The audit projection contains only:

```ts
{
  actorType,
  actorSource: source,
  actorSubject: subject,
  projectId,
  projectUserId?,
  platformUserId?,
  apiKeyId?,
  apiKeyPrefix?
}
```

Extend `StructuredLogContext` and Deno log context with these explicit optional fields instead of relying only on the open index signature.

## 4. API Key Identity

Change `validateApiKey()` to return the stable non-secret identity fields already stored in `druvia_api_keys`:

```ts
{
  valid: true,
  projectId,
  schemaName,
  apiKeyId,
  apiKeyPrefix,
}
```

The validation query returns `ak.id` and `ak.key_prefix` together with the current project fields. `authenticate` and `optionalAuth` create:

```ts
{
  kind: 'apikey',
  projectId,
  role: 'anon',
  apiKeyId,
  apiKeyPrefix,
}
```

Every authenticated API Key request now has these required fields. Realtime also changes its API Key subject from `apikey:<projectId>` to `apikey:<apiKeyId>` so newly issued Realtime tokens and logs identify the actual credential without exposing it. Existing short-lived Realtime tokens remain valid until expiry because Hasura authorization continues to use server-derived role/session variables.

The Data Access migration verifier is not an authenticated request and must not fabricate an `ApiKeyIdentity`. Replace its current `syntheticActors()` request objects with dedicated authenticated/anonymous migration probe context builders. Those builders reuse the same role/session-variable mapping primitives, but return `ProjectDataExecutionContext`/`RealtimeExecutionContext` directly; the anonymous Realtime probe uses a clearly non-actor subject such as `migration_probe:anonymous:<projectId>`. Probe data never enters `RequestUser`, `ProjectActorContext`, Function tokens, Worker transport, or request audit. Ordinary test request identities use positive fixture IDs and realistic non-secret prefixes. No database migration is required.

## 5. RPC Authorization And Claims

### 5.1 Authorization

RPC behavior remains:

| Identity | Same project | Result |
| --- | --- | --- |
| Project User | yes | allowed |
| Project User | no | `403 FORBIDDEN` |
| Platform User with project access | yes | allowed as explicit management actor |
| Platform User without project access | no | `403 FORBIDDEN` |
| API Key | yes/no | rejected; anonymous RPC is outside this slice |
| Missing/invalid credential | n/a | `401 UNAUTHORIZED` |

`verifyProjectAccess()` returns `{ projectId, schemaName, actor }`. `invokeRpc()` passes the actor into the service and emits one completion/failure log without arguments or result content.

### 5.2 Transaction-local PostgreSQL context

Refactor `callFunction()` to receive `ProjectActorContext` and execute discovery/call behavior without leaking claims across pooled connections.

The function invocation uses one checked-out client:

```sql
BEGIN;
SELECT set_config('request.jwt.claims', $1, true);
SELECT set_config('request.headers', $2, true);
SELECT set_config('druvia.actor', $3, true);
SELECT * FROM <quoted schema>.<quoted function>(...);
COMMIT;
```

On every error it executes `ROLLBACK` before releasing the client. The third argument to `set_config` remains `true`, so values are transaction-local. Signature discovery may keep the existing process cache, but the actual function call and all settings use the same client and transaction. Keep the public service API simple, but place execution behind an injectable client-provider/factory boundary so unit and integration tests run the same production transaction code. The real leakage test injects a dedicated integration `Pool({ max: 1 })`, invokes the RPC transaction, then checks out the same physical connection for a later transaction and proves all three settings are absent; relying on an unconstrained shared pool is not deterministic evidence.

`request.jwt.claims` is JSON:

```json
{
  "sub": "actor subject",
  "role": "authenticated or management role",
  "project_id": "project id",
  "actor_type": "project_user",
  "actor_source": "project_session",
  "project_user_id": "project user id when present",
  "provider": "provider when present"
}
```

The common keys are `sub`, `role`, `project_id`, `actor_type`, and `actor_source`. Project User additionally includes `project_user_id` and `provider`. Platform User additionally includes `platform_user_id`, `platform_uid`, and `tenant_id` only when present. RPC rejects API Key actors, so an API Key claim variant is not emitted by this path. Undefined optional values are omitted rather than serialized as `null`.

`request.headers` contains exactly the trusted actor projection below; it is not copied from inbound HTTP headers:

```json
{
  "x-druvia-actor-type": "project_user",
  "x-druvia-actor-source": "project_session",
  "x-druvia-actor-subject": "project_user:<project user id>",
  "x-druvia-project-id": "project id"
}
```

Project User adds `x-druvia-project-user-id`; Platform User adds `x-druvia-platform-user-id`; API Key adds only `x-druvia-api-key-id` and `x-druvia-api-key-prefix`. `druvia.actor` contains the full safe actor claims JSON. No token, complete API key, key hash, raw inbound headers, RPC args, or tenant secrets are included.

RPC documentation must state that an application function may read `current_setting('request.jwt.claims', true)::jsonb`, but it must still enforce its own authorization. Druvia does not enable PostgreSQL RLS for project schemas in this slice.

## 6. Functions Invoke And Worker Transport

### 6.1 Invoke policy

Replace the module-local `FunctionCallerContext` construction with `ProjectActorContext`:

- API Key: same project and function `anon_allowed` only.
- Project User: same project; both function modes are allowed.
- Platform User: project access required; both modes remain available for explicit management/test calls.

The controller verifies project existence/scope and Platform project access, resolves the actor, and passes it to `functionsService.invokeFunction()`. It no longer authorizes API Key mode from a separate earlier function read. The service fetches the function once, rejects actor/project mismatch, disabled/missing functions, and API Key + `jwt_required`, then executes that same record. Typed service errors map back to the existing sanitized 403/404 response semantics. Direct service callers therefore cannot bypass invoke mode, and a concurrent mode change cannot create a check/use split between two function records.

### 6.2 Internal token

The signed internal token carries:

```ts
interface InternalFunctionTokenPayload {
  tokenType: 'function_internal'
  actorContractVersion: 1
  projectId: string
  functionName: string
  actor: ProjectActorContext
  iat?: number
  exp?: number
}
```

Verification rejects missing/unknown `tokenType`, unsupported contract version, actor/project mismatch, and structurally invalid actor variants. The outer `actorContractVersion` must equal `actor.version`. Strict validation requires every discriminator/source/role combination and duplicated identity field to agree: `subject` must equal the canonical subject derived from the variant's concrete ID, Platform User must contain valid platform IDs, Project User must contain a project user ID/provider, and API Key must contain a positive safe integer ID/non-empty bounded prefix. Token TTL continues to use `FUNCTIONS_INTERNAL_TOKEN_TTL_SECONDS`.

Both existing token consumers must migrate atomically:

- `internal-graphql.routes.ts` uses the nested actor for Project Data Access execution.
- `internal-storage.routes.ts` uses the nested actor only to preserve its current project binding and upload audit mapping. This slice does not widen or redesign Function Storage authorization.

No API service call may sign a Function token without a `ProjectActorContext`. Existing direct integration calls pass an explicit synthetic Platform User actor. There is currently schedule CRUD but no schedule executor; a future executor must introduce an explicit service-principal design instead of calling `invokeFunction()` without an actor.

### 6.3 API-to-Worker authentication

Introduce `DENO_WORKER_SECRET` as a deployment-scoped API-to-Worker credential. API configuration may fall back to `FUNCTIONS_INTERNAL_TOKEN_SECRET`, then `JWT_SECRET`, for backward-compatible initialization, but Compose passes one resolved `DENO_WORKER_SECRET` value explicitly to both API and Worker using `${DENO_WORKER_SECRET:-${FUNCTIONS_INTERNAL_TOKEN_SECRET:-${JWT_SECRET}}}`. Containerized API modes also begin passing `FUNCTIONS_INTERNAL_TOKEN_SECRET: ${FUNCTIONS_INTERNAL_TOKEN_SECRET:-${JWT_SECRET}}`; otherwise a dedicated value in the host env is silently ignored by the current Compose files. Worker receives only `DENO_WORKER_SECRET`, never the Function-token signing secret. Production guidance recommends distinct random values for both credentials.

The API sends it only as:

```text
x-druvia-worker-secret: <secret>
```

The API and Worker require the resolved `DENO_WORKER_SECRET` to contain at least 32 UTF-8 bytes; both fail startup/config validation for missing or weaker values. The Worker reads it once during startup and checks the request header before parsing the request body. A missing/incorrect request secret returns `401` without creating a child Worker, parsing function code, or logging the credential. Comparison uses fixed-length SHA-256 digests and a full-byte constant-time comparison.

Route handling lives in a side-effect-free `worker-handler.ts`. It receives the configured secret, logger, and `executeFunction` callback as dependencies. `main.ts` only validates startup configuration and calls `Deno.serve(handler)`. Unit tests call the handler directly and use a request/dependency spy to prove authentication completes before `request.json()` and before execution. Source-text assertions alone are insufficient for this boundary.

After request authentication and JSON parsing, the handler validates the required execution envelope before creating a child Worker. `code`, `functionName`, `internalToken`, and a canonical versioned caller are required; actor discriminator/source/role/subject consistency follows the same transport contract as the API token. Invalid bodies return `400` and never execute. The Worker does not verify the JWT signature or receive `FUNCTIONS_INTERNAL_TOKEN_SECRET`; signature/project/function authorization remains at the API's internal helper routes.

The main Worker process must not forward `DENO_WORKER_SECRET` in the child Worker message. The isolated child changes from `deno.permissions.env: true` to `env: false`, preventing user code from reading inherited container variables such as `DENO_WORKER_SECRET`, `JWT_SECRET`, or `DRUVIA_API_URL`.

To preserve the documented Function-secret behavior, `executor.ts` builds an invocation-local `Deno.env` shim from the `secrets` object already supplied by the API. The shim supports `get`, `has`, `set`, `delete`, and `toObject` against a private in-memory map. It never calls the real child `Deno.env`, and mutations live only for that invocation. Both legacy AsyncFunction and `Deno.serve()` modes receive a Deno proxy whose `env` property is this shim. Direct or indirect access to `globalThis.Deno.env` remains blocked by the child `env: false` permission and is covered by runtime tests. A Function secret named `DENO_WORKER_SECRET` is only application data in the shim and can never reveal or replace the real Worker credential.

Before creating the child, `main.ts` reads only the non-secret runtime label (`DENO_ENV`/`NODE_ENV`) and the configured internal API URL (`DRUVIA_API_URL`). It passes them as dedicated `runtimeEnv` and resolved `apiBaseUrl` message fields. `executor.ts` uses those fields for logging and `druvia.*` helper construction and contains no real `Deno.env.get()` calls. Neither value is added to the Function environment shim.

`GET /health` remains unauthenticated and reports only runtime health. It must not expose whether a supplied execution secret was close, valid, or configured. Every supported Compose file adds a Worker healthcheck against this endpoint so `docker compose ps` and dependency/operations tooling distinguish healthy execution service from a restart loop. The updater already polls `http://deno:7133/health` over the Compose network after apply; no updater URL change is required.

The Compose healthcheck is equivalent in every mode:

```yaml
healthcheck:
  test: ["CMD", "deno", "eval", "--allow-net=127.0.0.1:7133", "const r = await fetch('http://127.0.0.1:7133/health'); if (!r.ok) Deno.exit(1)"]
  interval: 30s
  timeout: 10s
  retries: 3
  start_period: 5s
```

Compose exposure is fixed by deployment shape:

- `docker-compose.local.yml`, `docker-compose.prod.yml`, and `docker-compose.release.yml`: API and Worker share a Compose network, so Worker has no host-published port.
- Legacy host-API modes `docker-compose.yml` and `docker-compose.dev.yml`: API/PM2 runs on the host, so Worker keeps only a loopback bind, `127.0.0.1:${DENO_PORT:-7133}:7133`.

All five files pass the same resolved Worker secret to Worker; containerized API modes also pass it to API and pass the independently resolved Function-token secret to API only. A host-run API reads both values from its host environment. Direct non-loopback Worker publication is unsupported.

The protocol transition is asymmetric: a new API can send the extra header to an old Worker, but an old API cannot call a new Worker. Release Compose therefore retains `deno.depends_on.api.condition: service_healthy` for upgrade ordering. The updater rollback path first runs a dedicated `docker compose up -d --no-deps deno` against the restored old Compose/env, then applies the full managed-service rollback. This makes the old permissive Worker available to both API generations before the API is reverted. Automatic and manual rollback use the same command builder, and unit tests assert the exact order. This updater code change is required even though a real OTA rehearsal remains outside this slice.

For rolling compatibility, the API-to-Worker request uses one required serialized caller shape:

```ts
interface FunctionWorkerCaller {
  actorContractVersion: 1
  actorType: ProjectActorType
  actorSource: ProjectActorSource
  actorSubject: string
  authType: ProjectActorType // legacy alias
  projectId: string
  role: string
  platformUserId?: string
  platformUid?: number
  userId?: string // legacy Platform alias
  uid?: number // legacy Platform alias
  tenantId?: string
  projectUserId?: string
  provider?: string
  apiKeyId?: number
  apiKeyPrefix?: string
}
```

The serializer derives every field from `ProjectActorContext`. Platform includes canonical IDs plus equal legacy `userId`/`uid` aliases; Project User includes only its user/provider fields; API Key includes only key ID/prefix. Validation rejects missing required fields, unequal aliases, and identity fields belonging to another actor variant.

The trusted synthetic request keeps `x-druvia-auth-type` and adds:

```text
x-druvia-actor-type
x-druvia-actor-source
x-druvia-actor-subject
x-druvia-actor-contract-version
```

All these headers are generated from the signed server actor. Caller payload headers cannot override them.

### 6.4 Function logs

API and Worker logs include the safe actor audit projection, `functionName`, `executionId`, `durationMs`, and success/failure. Persisted `druvia_function_logs.metadata` stores:

```ts
{
  actor: toProjectActorAuditContext(actor),
}
```

It no longer stores the raw invocation payload. Existing historical rows remain unchanged.

## 7. Internal Function GraphQL Cutover

`POST /api/internal/functions/graphql` verifies the internal token and resolves the project from token claims only. The project query must return both `schema_name` and `data_access_mode`.

Authorization matrix:

| Function actor | Internal GraphQL |
| --- | --- |
| Project User | execute with authenticated project data role and `x-hasura-user-id` |
| API Key | execute with the existing HTTP GraphQL API-key mapping |
| Platform User | reject with `403 PROJECT_ACTOR_REQUIRED` |

For Project User/API Key, reconstruct the corresponding request identity from the verified actor and call `resolveProjectDataExecutionContext({ projectId, runtimeMode, actor })`. The Hasura request includes:

```ts
{
  'Content-Type': 'application/json',
  'x-hasura-admin-secret': config.hasura.adminSecret,
  'x-hasura-default-schema': schemaName,
  'x-hasura-role': executionContext.role,
  ...executionContext.sessionVariables,
}
```

Clients cannot submit or override any `x-hasura-*` header. The internal helper body remains `{ query, variables, operationName }`.

The existing checks for references to `public`, another project schema, or another project's environment schema remain. They are defense in depth and error clarity, not a substitute for Hasura permissions.

This changes the behavior of existing Functions that relied on `druvia.graphql()` receiving admin access. Such functions must have explicit table Data Access permissions before this slice is deployed. The compatibility guide and release notes must call this out as a migration prerequisite; no automatic permission widening is allowed.

## 8. SDK Identity Selection

In `DruviaClient`, replace the shared fallback fetch used by RPC/Functions:

```ts
const applicationFetch = createFetchWrapper(
  apiBase,
  apiKey,
  rawFetch,
  () => cachedProjectToken,
)
```

Use `applicationFetch` for `DruviaRpc` and `DruviaFunctions`.

Expected behavior:

| SDK state | RPC | `jwt_required` Function | `anon_allowed` Function |
| --- | --- | --- | --- |
| Project Session present | Project bearer + API key | Project bearer + API key | Project bearer + API key |
| Only Platform Session present | API key only; server rejects | API key only; server rejects | API key only; allowed |
| No session | API key only; server rejects | API key only; server rejects | API key only; allowed |

`DruviaStorage` continues using `platformFetch` until the Storage authorization slice. GraphQL and Realtime retain their existing Project Session behavior.

No automatic retry may downgrade an invalid/expired selected Project Session to API-key-only invocation.

## 9. Errors And Compatibility

Preserve existing public response envelopes:

- RPC: `{ data, error }`.
- Functions: `{ success, data }` with the existing nested execution result.

Use existing public status semantics where possible:

- `401 UNAUTHORIZED`: missing/invalid credential or RPC presented only an API Key.
- `403 FORBIDDEN`: cross-project identity, missing platform project access, or API Key invoking `jwt_required`.
- `403 PROJECT_ACTOR_REQUIRED`: a Platform-invoked Function calls internal GraphQL.
- `404 NOT_FOUND`: project/function/RPC function does not exist.
- `502 GRAPHQL_PROXY_FAILED`: Hasura non-success response.
- `503 GRAPHQL_SERVICE_UNAVAILABLE`: Hasura transport failure.

Do not expose role names, actor claims, internal token errors, SQL text, API key prefix, or Hasura admin details in public error messages. Structured logs may include the safe audit projection.

## 10. File Map

Create:

- `apps/api/src/lib/project-actor.ts`: canonical actor types, resolvers, claims, and safe audit projection.
- `docker/deno-worker/worker-auth.ts`: Worker request-secret validation and constant-time comparison.
- `docker/deno-worker/worker-handler.ts`: side-effect-free health/execute request ordering and dependency boundary.
- `tests/unit/project-actor.test.ts`: actor normalization, scope, and audit redaction.
- `tests/unit/api-keys-service.test.ts`: API Key validation identity and secret-redaction contract.
- `tests/unit/deno-worker-auth.test.ts`: Worker missing/invalid/valid execution authentication and pre-body-parse ordering.
- `tests/unit/functions-worker-config.test.ts`: API/Worker secret resolution, minimum strength, and secret-separation contract.
- `tests/integration/project-actor-rpc-functions.test.ts`: real PostgreSQL claims and Hasura Function-helper permission verification.

Modify:

- `apps/api/src/middleware/auth.ts`: API Key identity fields and log context.
- `apps/api/src/modules/api-keys/api-keys.service.ts`: return key ID/prefix from validation.
- `apps/api/src/modules/data-access/data-access-migration-verifier.ts`: replace synthetic request identities with dedicated execution-context probes.
- `apps/api/src/modules/realtime/realtime-actor.ts`: use the stable API Key ID in newly issued Realtime subjects.
- `apps/api/src/modules/rpc/rpc.controller.ts`: resolve actor, pass it to RPC, and emit safe audit logs.
- `apps/api/src/modules/rpc/rpc.service.ts`: transaction-local claims and client-bound function execution.
- `apps/api/src/modules/functions/functions.controller.ts`: common actor authorization.
- `apps/api/src/modules/functions/functions.service.ts`: actor transport and payload-free audit metadata.
- `apps/api/src/modules/functions/internal-token.ts`: versioned actor envelope and strict verification.
- `apps/api/src/modules/functions/internal-graphql.routes.ts`: permission-enforced Hasura execution.
- `apps/api/src/modules/functions/internal-storage.routes.ts`: consume the nested actor while preserving existing Storage helper behavior.
- `apps/api/src/config/index.ts`: resolved Worker credential.
- `docker/deno-worker/main.ts`: canonical actor transport and logging fields.
- `docker/deno-worker/executor.ts`: canonical actor context, invocation-local environment shim, and compatibility headers.
- `docker/deno-worker/logging.ts`: explicit actor log context fields.
- `packages/shared/src/logging/index.ts`: explicit actor log context fields.
- `packages/sdk/src/DruviaClient.ts`: Project Session-only RPC/Functions bearer selection.
- `docker/docker-compose.local.yml`, `docker/docker-compose.prod.yml`, `docker/docker-compose.release.yml`: private Worker port, healthcheck, and shared secret.
- `docker/docker-compose.yml`, `docker/docker-compose.dev.yml`: loopback-only Worker port, healthcheck, and shared secret for host-run API development/legacy operation.
- `apps/updater/src/compose.ts`, `apps/updater/src/update-service.ts`: Worker-first rollback ordering for the request-auth protocol transition.
- `.env.example`, `docker/.env.example`, `docker/.env.prod.example`: host/container Worker and Function-token secret contracts and guidance. `.env.release.example` remains limited to image/update state and does not duplicate application secrets.
- `tests/unit/auth.test.ts`: API Key identity propagation.
- Existing unit/integration files that directly construct API Key request identities: replace incomplete objects with positive fixture IDs/prefixes; the migration verifier must no longer construct one.
- `tests/unit/rpc-controller.test.ts`: actor authorization and service call contract.
- `tests/unit/rpc.test.ts`: transaction claims, commit, rollback, and cleanup.
- `tests/unit/functions-controller.test.ts`: actor/function mode matrix.
- `tests/unit/functions-service.test.ts`: token transport and payload-free audit.
- `tests/unit/functions-internal-token.test.ts`: token schema and mismatch rejection.
- `tests/unit/functions-internal-graphql.test.ts`: Hasura roles/session variables and platform rejection.
- `tests/unit/functions-internal-storage.test.ts`: nested actor audit mapping and project binding compatibility.
- `tests/unit/deno-worker-logging.test.ts`: actor fields in Worker logs.
- `tests/unit/realtime-actor.test.ts`, `tests/integration/realtime-token.test.ts`: stable API Key Realtime subject and token compatibility.
- `tests/unit/worker-compose-config.test.ts`: Worker port, healthcheck, and secret contract for all five deployment modes.
- `tests/unit/release-compose-files.test.ts`: release Worker service contract remains present in OTA assets.
- `tests/unit/update-compose-command.test.ts`, `tests/unit/updater-service.test.ts`: automatic/manual rollback restores Worker before the full managed-service rollback.
- `tests/integration/functions.test.ts`: explicit actors and authenticated real Worker invocation.
- `tests/unit/druvia-helper.test.ts`: internal token remains the only helper credential.
- `tests/sdk/client.test.ts`: remove Platform Session fallback expectations.
- `tests/sdk/functions.test.ts`: anonymous and authenticated header behavior.
- `tests/unit/api-app.test.ts`: route and internal contract coverage.
- `.github/workflows/release.yml`: add the actor/RPC/Functions/Worker/Compose/updater/SDK gate before image builds.
- `apps/api/AGENTS.md`, `packages/sdk/AGENTS.md`, `docker/AGENTS.md`: durable module and deployment rules.
- `docs/agent/design-decisions.md`: lasting actor and helper authorization decisions.
- `docs/003-version-release-guide.md`: deployment prerequisite for Functions using internal GraphQL.
- `docs/migration/supabase-compat.md`: RPC claims and Functions permission prerequisite.
- `docs/progress.md`: milestone and next-step update after implementation.
- This document: checkboxes, verification evidence, and final status.

No SQL migration or Admin UI change is expected. Compose changes are limited to the Worker credential, dependency, health, and network exposure contract; updater changes are limited to protocol-safe rollback ordering.

## 11. Implementation Tasks

### Task 1: Canonical actor and API Key identity

- [x] Add failing actor tests covering all three variants, cross-project rejection, stable subjects, and absence of secret/key hash fields.
- [x] Extend API Key validation tests to require `apiKeyId` and `apiKeyPrefix`; reject zero/negative/non-integer IDs and empty prefixes at the canonical resolver boundary.
- [x] Run `pnpm vitest run tests/unit/project-actor.test.ts tests/unit/auth.test.ts tests/unit/api-keys-service.test.ts tests/unit/realtime-actor.test.ts` and confirm the new assertions fail for missing actor/key fields and the old Realtime subject.
- [x] Implement `project-actor.ts`, extend API Key validation, and populate `ApiKeyIdentity` from both authentication middleware paths.
- [x] Update Realtime to use `apikey:<apiKeyId>`. Update every direct API Key request fixture found under `apps/api/src` and `tests` with positive IDs/prefixes; remove synthetic request-identity construction from the migration verifier.
- [x] Add verifier tests proving dedicated authenticated/anonymous probe contexts retain Data Access/Realtime compatibility while no migration probe is shaped or typed as `RequestUser`/`ApiKeyIdentity` and none can enter canonical actor, Function transport, or request audit.
- [x] Extend shared/API log context fields without logging credentials.
- [x] Re-run the focused tests plus `tests/integration/realtime-token.test.ts`, and extend `tests/integration/api-keys.test.ts` to verify the real validation result contains the created key ID/prefix but no full key/hash.

### Task 2: RPC actor propagation

- [x] Add controller tests proving same-project Project User and authorized Platform User pass the canonical actor, while API Key and cross-project identities are rejected.
- [x] Add service tests with a fake pool client proving `BEGIN`, three transaction-local `set_config` calls, function execution, and `COMMIT` use one client.
- [x] Add the failure test proving function/query errors execute `ROLLBACK` and always release the client.
- [x] Run `pnpm vitest run tests/unit/rpc-controller.test.ts tests/unit/rpc.test.ts` and confirm the actor/transaction assertions fail.
- [x] Refactor controller/service with the smallest injectable client-provider/factory boundary needed to preserve signature caching and result normalization while letting the real integration test exercise production transaction code on a dedicated pool.
- [x] Add structured success/failure logs without args/results and re-run the focused tests.

### Task 3: Functions actor transport and audit

- [x] Replace Function controller expectations with the actor/function-mode matrix.
- [x] Add service-level policy tests proving API Key + `jwt_required` is rejected even through a direct service call, API Key + `anon_allowed` succeeds, same-project checks remain mandatory, and one fetched function record supplies both authorization and execution.
- [x] Add internal-token tests for contract version, token type, project mismatch, malformed actor variants, and expiry/invalid signature behavior.
- [x] Cover mismatched subject/type/source/role/concrete IDs and invalid API Key IDs/prefixes; strict verification must return a normalized trusted payload rather than a cast `jwt.verify()` result.
- [x] Add service tests proving the Worker receives canonical actor fields plus compatibility fields and that persisted log metadata omits payload.
- [x] Add internal Storage helper tests proving nested Project User/Platform/API Key actors preserve current project binding and audit types without accepting body-forged actor fields.
- [x] Run the focused Function tests and confirm they fail before implementation.
- [x] Replace `FunctionCallerContext` with a required common actor, move invoke-mode enforcement to the service's single function read, implement strict internal-token validation, adapt both internal helper consumers, and update Function logs.
- [x] Update every direct `invokeFunction()` integration call with an explicit test actor; add a source-contract assertion preventing the actor parameter from becoming optional again.
- [x] Re-run `tests/unit/functions-controller.test.ts`, `tests/unit/functions-service.test.ts`, `tests/unit/functions-internal-token.test.ts`, `tests/unit/functions-internal-storage.test.ts`, and `tests/integration/functions.test.ts` when the authenticated Worker is available.

### Task 4: Deno Worker actor context

- [x] Add API/Worker configuration tests rejecting missing or sub-32-byte Worker secrets. Add Worker-auth tests proving `/execute` rejects missing/invalid secrets before parsing code and accepts the configured secret; keep `/health` public and non-sensitive. After valid authentication, malformed or missing canonical caller/internal-token fields must return `400` before child execution.
- [x] Add source-contract tests for canonical caller fields, trusted compatibility headers, and actor fields in runtime/executor logs.
- [x] Add runtime tests proving Function code can read only its supplied Function secrets, direct/indirect `globalThis.Deno.env` access cannot read inherited `DENO_WORKER_SECRET`/`JWT_SECRET`/`DRUVIA_API_URL`, and shim mutations cannot persist into a later invocation.
- [x] Confirm user-provided Function headers cannot replace generated `x-druvia-*` actor headers.
- [x] Add the API Worker header, implement constant-time Worker authentication, set child `env: false`, provide the invocation-local Deno environment shim, and update actor logging while preserving `x-druvia-auth-type`.
- [x] Update all five Compose files and env examples; assert local/prod/release do not publish `7133`, legacy host-API modes bind only `127.0.0.1`, every Worker has a healthcheck, API/Worker receive the same resolved Worker secret, and only API receives the independently resolved Function-token signing secret.
- [x] Add updater command/service tests for Worker-first automatic and manual rollback, then implement the dedicated `--no-deps deno` rollback step before the existing full rollback apply. Assert release Compose still starts Worker only after API health during upgrade.
- [x] Run Worker/helper/logging tests, `deno check docker/deno-worker/main.ts docker/deno-worker/executor.ts`, and `docker build -f docker/Dockerfile.worker docker/deno-worker`; require zero failures.

### Task 5: Internal GraphQL permissions

- [x] Rewrite route tests so the project query returns `schema_name + data_access_mode`.
- [x] Add Project User assertions for scoped authenticated role, project/user session variables, and no client Hasura-header passthrough.
- [x] Add API Key assertions for the existing HTTP GraphQL compatibility/explicit mapping.
- [x] Add Platform User rejection and cross-project/malformed internal actor tests.
- [x] Run `pnpm vitest run tests/unit/functions-internal-graphql.test.ts tests/unit/project-data-actor.test.ts` and confirm the new role assertions fail.
- [x] Implement the resolver-backed Hasura request and keep schema-reference checks.
- [x] Re-run the focused tests and require all to pass.

### Task 6: SDK token cutover

- [x] Change SDK client tests so RPC/Functions with only Platform Session send no Authorization header and retain the API Key.
- [x] Preserve tests proving a Project Session is preferred and invalid selected Project Session is not downgraded.
- [x] Run `pnpm vitest run tests/sdk/client.test.ts tests/sdk/functions.test.ts tests/sdk/project-auth.test.ts` and confirm old fallback behavior fails the new assertions.
- [x] Introduce the application fetch path and bind RPC/Functions to it; leave Storage unchanged.
- [x] Re-run focused SDK tests and `pnpm --filter @druvia/sdk build`.

### Task 7: Real integration and release gate

- [x] Add a test PostgreSQL function that returns parsed `request.jwt.claims` and `druvia.actor`; verify Project User and Platform management claims. Use a dedicated `max: 1` integration pool to prove a later transaction on the same physical connection sees none of the three local settings.
- [x] Add a real Hasura test in an explicit project where internal Function GraphQL allows only the Project User's owned rows, applies API Key read policy, rejects Platform actor, and rejects cross-project access.
- [x] Make integration cleanup idempotent and audit that no test project/function/schema remains.
- [x] Add focused actor/RPC/Functions/internal-helper/Worker/Compose/updater/SDK tests to a named release workflow step before image builds.
- [x] Extend `tests/unit/release-pipeline.test.ts` so omission of any critical identity, Worker-auth, deployment, or rollback-order test fails locally.
- [x] Run the focused integration and workflow contract tests.

### Task 8: Documentation and final verification

- [x] Update API/SDK `AGENTS.md`, design decisions, Supabase compatibility, and progress without creating another memory file or split design document.
- [x] Record that Storage remains outside the completed identity paths and is the next separate authorization design.
- [x] Run the exact release actor gate locally.
- [x] Run `pnpm test -- tests/unit tests/sdk tests/api`.
- [x] Build `@druvia/shared`, `@druvia/sdk`, `@druvia/api`, and `@druvia/admin` as affected by shared contracts.
- [x] Run the real PostgreSQL/Hasura integration test and post-test residue audit.
- [x] Parse `.github/workflows/release.yml`, run `git diff --check`, and confirm `docs/superpowers` does not exist.
- [x] Review the complete uncommitted slice until no important findings remain.
- [x] Update this document to `Implemented` with exact verification evidence.

## 12. Test Matrix

| Path | Platform User | Project User | API Key | Cross-project |
| --- | --- | --- | --- | --- |
| RPC | allowed after project access check | allowed | rejected | rejected |
| Function `jwt_required` | allowed for explicit management call | allowed | rejected | rejected |
| Function `anon_allowed` | allowed for explicit management call | allowed | allowed | rejected |
| Function internal GraphQL | rejected | permission-enforced | permission-enforced | rejected |
| SDK RPC/Functions bearer | never selected implicitly | selected | absent | n/a |

Additional mandatory cases:

- invalid/expired Project Session does not retry as API Key;
- invalid/expired internal token never reaches Hasura;
- missing/invalid Worker request secret never parses or executes submitted code;
- upgrade ordering starts the request-auth-capable API before Worker replacement, while automatic/manual rollback restores the old Worker before the old API;
- Function code cannot read the real Worker credential or unrelated container environment, while configured Function secrets remain available;
- every direct Function service invocation has an explicit actor; no missing actor defaults to API Key;
- direct Function service invocation cannot bypass `invoke_auth_mode`, and authorization/execution use one function record;
- unknown actor contract version is rejected;
- mismatched actor subject/type/source/role/identity fields are rejected by internal-token and Worker-envelope validation;
- API Key secret/hash never appears in actor, logs, Worker body, or token;
- migration verification uses execution-context probes and never fabricates, signs, transports, or logs an authenticated API Key actor;
- newly issued API Key Realtime subjects use the real non-secret key ID rather than only the project ID;
- RPC transaction rollback and client release occur on every error;
- transaction-local claims do not remain on a reused connection;
- Function log metadata does not contain invocation payload;
- internal Function Storage upload/remove preserves project binding and audit attribution after the token schema change;
- Hasura role/session variables are server-derived;
- explicit Project User owner filters apply through `druvia.graphql()`;
- platform Function invocation cannot recover previous admin-level internal GraphQL behavior.

## 13. Release And Rollback

This slice has no database migration and does not add a Compose service. It changes runtime and service-network behavior across API, SDK, and Worker:

1. Set one resolved `DENO_WORKER_SECRET` of at least 32 UTF-8 bytes for API and Worker before replacing either container. Compose may derive it from an existing sufficiently strong Function/JWT secret during migration, but a dedicated random value is recommended.
2. Deploy API and Worker from the same release manifest. Release Compose starts the new API first and starts/replaces Worker only after API health, so the new header is available before Worker begins requiring it.
3. Existing Functions using `druvia.graphql()` must have explicit Data Access policies before deployment; otherwise they fail closed under Hasura permissions.
4. Applications that accidentally relied on an SDK Platform Session for RPC/Functions must establish a Project Session. Anonymous Functions continue to work through API Key when configured `anon_allowed`.
5. Local/prod/release no longer expose host port `7133`; legacy host-API modes bind it to loopback only. External callers must never depend on that internal endpoint.
6. Automatic/manual rollback first restores the previous Worker with `up -d --no-deps deno`, then restores the full previous API/Worker/SDK and Compose set. No schema rollback is needed; restoring the old port publication is not required for Druvia operation.
7. Do not widen Hasura permissions as a rollback shortcut. If a Function is incompatible, rollback the application release or update that Function's intended Data Access policy.

Actual release and OTA rehearsal remain deferred by current project direction.

## 14. Completion Criteria

The slice is complete only when:

- RPC and Functions no longer construct independent, conflicting caller identities.
- Function invoke mode is enforced at the service execution boundary without a controller/service check-use race.
- RPC exposes transaction-local actor claims and proves no pooled-connection leakage.
- SDK RPC/Functions never use Platform Session implicitly.
- Worker and API logs carry the same safe actor identity fields.
- Worker execution requests are authenticated before code parsing/execution; local/prod/release do not publish the Worker port, and legacy host-API modes bind it only to loopback.
- OTA upgrade and both rollback paths apply API/Worker in a protocol-compatible order.
- the isolated Function runtime has no real environment permission and exposes only invocation-local Function secrets.
- Existing internal Function Storage helpers continue to bind project/audit identity from the signed nested actor.
- Function internal GraphQL enforces the same Project Data Access role/session mapping as the public HTTP data path.
- Platform Function invocation cannot use internal GraphQL as admin.
- API Key identity is auditable without secret disclosure.
- raw Function payload is absent from new persisted execution logs.
- the complete authorization matrix, real PostgreSQL/Hasura paths, builds, and release workflow gate pass.
- documentation accurately states that Storage identity authorization is still pending.

## 15. Verification Evidence

Implemented in the main checkout on 2026-08-18. Verification evidence:

- Release actor gate: the exact `Verify Project Actor RPC and Functions cutover` Vitest command passed `21` files and `171` tests.
- Full unit/API/SDK regression: `pnpm test -- tests/unit tests/sdk tests/api` passed `116` files and `791` tests.
- Real PostgreSQL/Hasura actor integration: `DRUVIA_RUN_PROJECT_ACTOR_INTEGRATION=1 ... tests/integration/project-actor-rpc-functions.test.ts` passed `3/3`; the final residue audit found no test project, tenant, user, schema, or RPC function.
- Real API Key integration passed `10/10`, including stable ID/prefix and absence of full key/hash in validation results.
- Real authenticated Deno Worker Functions integration passed `30/30`.
- `@druvia/shared`, `@druvia/sdk`, `@druvia/api`, `@druvia/updater`, and `@druvia/admin` builds passed.
- Locked Deno `2.0.6` check passed for `main.ts` and `executor.ts`; `docker build -f docker/Dockerfile.worker -t druvia-worker:actor-cutover docker/deno-worker` passed.
- Runtime container probe returned only the configured Function `APP_SECRET`; the real Worker secret was absent and inherited `JWT_SECRET` access was denied.
- All five Compose modes rendered with `docker compose ... config --quiet`; the existing dev `version` and local missing optional Storage secret warnings do not affect rendering.
- Release workflow YAML parsed successfully, `git diff --check` passed, no sensitive credential pattern was found in the diff, and `docs/superpowers` is absent.

No real GitHub release, image publication, Registry pull, OTA, or production deployment rehearsal was executed; those exercises are intentionally excluded from this slice.
