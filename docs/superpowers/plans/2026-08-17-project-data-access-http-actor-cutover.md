# Project Data Access HTTP Actor Cutover Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist project data-access runtime mode and make the public HTTP GraphQL proxy execute only as a server-derived project actor.

**Architecture:** Migration `018` adds a conservative project runtime mode. A pure resolver converts `project_user` and `apikey` identities into compatibility or explicit Hasura contexts, while the route rejects platform JWTs before project loading. SDK database requests and the Admin Playground use application credentials only; RPC, Functions and WebSocket behavior stay unchanged.

**Tech Stack:** PostgreSQL 17 migrations, Fastify 5, TypeScript, Vitest, Next.js 16, React 19, `@druvia/sdk`, Hasura role impersonation.

---

### Task 1: Persist Project Runtime Mode

**Files:**
- Create: `migrations/018_project_data_access_mode.up.sql`
- Create: `migrations/018_project_data_access_mode.down.sql`
- Modify: `apps/api/src/cli/migrate.ts`
- Modify: `packages/shared/src/types/tenant.ts`
- Modify: `apps/api/src/modules/project/project.service.ts`
- Test: `tests/unit/project-data-access-mode-migration.test.ts`
- Test: `tests/unit/project-service.test.ts`

- [x] **Step 1: Write migration and project-service failing tests**

Add tests that require:

```typescript
expect(upSql).toContain('ADD COLUMN data_access_mode')
expect(upSql).toContain("DEFAULT 'compatibility'")
expect(upSql).toContain("CHECK (data_access_mode IN ('compatibility', 'explicit'))")
expect(downSql).toContain('DROP COLUMN data_access_mode')
expect(migrateSource).toContain("column_name = 'data_access_mode'")
```

Project service tests must assert that `createProject()` inserts `explicit`, row conversion maps `explicit`, and missing/unknown values normalize to `compatibility`.

- [x] **Step 2: Run the focused tests and verify RED**

Run:

```bash
pnpm test tests/unit/project-data-access-mode-migration.test.ts tests/unit/project-service.test.ts
```

Expected: failure because migration `018`, the shared type and runtime-mode conversion do not exist.

- [x] **Step 3: Implement the migration and service contract**

Add:

```typescript
export type ProjectDataAccessMode = 'compatibility' | 'explicit'
```

Extend `Project` and `ProjectRow`, add a `normalizeProjectDataAccessMode()` helper, and explicitly insert `data_access_mode` in `createProject()`:

```sql
INSERT INTO druvia_projects (project_id, tenant_id, alias, name, data_access_mode)
VALUES ($1, $2, $3, $4, 'explicit')
```

Add migration `018` up/down files and a `bootstrap.dataChecks[18]` information-schema column check.

- [x] **Step 4: Run the focused tests and verify GREEN**

Run the command from Step 2. Expected: all selected tests pass.

### Task 2: Report Persisted Runtime Mode

**Files:**
- Modify: `apps/api/src/modules/data-access/data-access.types.ts`
- Modify: `apps/api/src/modules/data-access/data-access-overview.ts`
- Modify: `apps/api/src/modules/data-access/data-access.service.ts`
- Test: `tests/unit/data-access-overview.test.ts`
- Test: `tests/unit/data-access-service.test.ts`

- [x] **Step 1: Write failing overview tests**

Change the overview builder contract to require:

```typescript
runtimeMode: ProjectDataAccessMode
```

Assert both `compatibility` and `explicit` are returned unchanged, and assert the service passes `project.dataAccessMode` into the builder.

- [x] **Step 2: Run the focused tests and verify RED**

```bash
pnpm test tests/unit/data-access-overview.test.ts tests/unit/data-access-service.test.ts
```

Expected: explicit-mode assertion fails because the builder hard-codes `compatibility`.

- [x] **Step 3: Pass normalized mode through the overview**

Add `runtimeMode` to `BuildProjectDataAccessOverviewInput`, return `input.runtimeMode`, and pass the persisted project mode from `getProjectDataAccessOverview()`.

- [x] **Step 4: Run the focused tests and verify GREEN**

Run the command from Step 2. Expected: all selected tests pass.

### Task 3: Resolve HTTP Project Actors And Secure The Proxy

**Files:**
- Create: `apps/api/src/modules/data-access/project-data-actor.ts`
- Modify: `apps/api/src/modules/openapi/openapi.routes.ts`
- Create: `tests/unit/project-data-actor.test.ts`
- Modify: `tests/unit/openapi-graphql-route.test.ts`

- [x] **Step 1: Write failing pure-resolver tests**

Cover this matrix:

```typescript
compatibility + project_user -> role user, no session variables
compatibility + apikey       -> role user, no session variables
explicit + project_user      -> scoped user role with user/project/actor variables
explicit + apikey            -> scoped anon role with project/actor variables
```

Also assert cross-project input throws `ProjectDataActorScopeError` and unknown runtime mode fails closed to compatibility.

- [x] **Step 2: Run resolver tests and verify RED**

```bash
pnpm test tests/unit/project-data-actor.test.ts
```

Expected: module-not-found failure for `project-data-actor.ts`.

- [x] **Step 3: Implement the pure resolver**

Export:

```typescript
export function resolveProjectDataExecutionContext(input: {
  projectId: string
  runtimeMode: ProjectDataAccessMode | string | null | undefined
  actor: ProjectJwtUser | ApiKeyIdentity
}): ProjectDataExecutionContext
```

Use `resolveDataScopeRole()` only for explicit roles and never consume request headers or client role strings.

- [x] **Step 4: Run resolver tests and verify GREEN**

Run the command from Step 2. Expected: all resolver tests pass.

- [x] **Step 5: Rewrite GraphQL route tests for the secure flow**

Tests must assert:

- platform JWT returns `403 PROJECT_ACTOR_REQUIRED` before project load/rate limit/fetch;
- actor project mismatch returns `403 PROJECT_SCOPE_MISMATCH` before project load;
- compatibility requests send `x-hasura-role: user` and no new session variables;
- explicit project users and API keys send exact server-derived headers;
- incoming `x-hasura-*` headers are ignored;
- project settings still reach the rate limiter;
- the project is loaded once.

- [x] **Step 6: Run route tests and verify RED**

```bash
pnpm test tests/unit/openapi-graphql-route.test.ts
```

Expected: platform denial and explicit header assertions fail against the existing admin passthrough.

- [x] **Step 7: Implement the route cutover**

Replace `isJwtUser()` branching with explicit identity-kind checks, retain the loaded project on the request including `dataAccessMode`, call the pure resolver, and construct Hasura headers only from the result. Return normal API error envelopes for both new `403` cases.

- [x] **Step 8: Run route and resolver tests and verify GREEN**

```bash
pnpm test tests/unit/project-data-actor.test.ts tests/unit/openapi-graphql-route.test.ts tests/unit/ratelimit-graphql.test.ts
```

Expected: all selected tests pass.

### Task 4: Separate SDK Database Identity

**Files:**
- Modify: `packages/sdk/src/DruviaClient.ts`
- Modify: `tests/sdk/client.test.ts`
- Verify: `tests/sdk/rpc.test.ts`
- Verify: `tests/sdk/functions.test.ts`

- [x] **Step 1: Write failing SDK token-selection tests**

Add assertions that:

```typescript
graphql + project session -> Authorization: Bearer project-token + apikey
graphql + platform only   -> apikey, no Authorization
rpc/functions platform fallback remains Authorization: Bearer platform-token
```

- [x] **Step 2: Run focused SDK tests and verify RED**

```bash
pnpm test tests/sdk/client.test.ts
```

Expected: platform-only GraphQL assertion fails because `projectFetch` falls back to the platform token.

- [x] **Step 3: Add a database-specific fetch path**

Create a fetch wrapper using only `cachedProjectToken` for `DruviaDatabase`. Keep the existing project fetch selection for RPC and Functions.

- [x] **Step 4: Run SDK tests and verify GREEN**

```bash
pnpm test tests/sdk/client.test.ts tests/sdk/database.test.ts tests/sdk/rpc.test.ts tests/sdk/functions.test.ts
```

Expected: all selected SDK tests pass.

### Task 5: Convert Admin Playground To Application Credentials

**Files:**
- Modify: `apps/admin/src/app/t/[tenantId]/p/[projectId]/api/components/GraphQLEditor.tsx`
- Modify: `apps/admin/src/app/t/[tenantId]/p/[projectId]/api/components/GraphQLPlayground.tsx`
- Modify: `apps/admin/src/app/t/[tenantId]/p/[projectId]/api/page.tsx`
- Replace: `tests/unit/admin/graphql-editor.test.ts`
- Modify: `tests/unit/admin/api-documentation.test.ts`

- [x] **Step 1: Write failing presentation and credential-header tests**

Extract testable helpers that build:

```typescript
buildGraphqlCredentialHeaders('apikey', value)
buildGraphqlCredentialHeaders('project_user', value)
buildProjectGraphqlEndpoint(apiBaseUrl, projectId)
```

Assert API-key mode sends only `apikey`, project-user mode sends only Bearer, empty credentials return no executable headers, and the endpoint is the Druvia proxy URL rather than Hasura.

- [x] **Step 2: Run Admin tests and verify RED**

```bash
pnpm test tests/unit/admin/graphql-editor.test.ts tests/unit/admin/api-documentation.test.ts
```

Expected: helper imports or new credential assertions fail.

- [x] **Step 3: Implement the credential control and endpoint correction**

Use a segmented mode control, masked `Input`, reveal icon with tooltip/title, and clear state on mode change. Disable execute until a trimmed credential exists. The fetcher must never call `api.getToken()`. Remove the unused `hasuraUrl` prop and display/copy:

```text
${getPublicApiBaseUrl()}/api/v1/projects/${projectId}/graphql
```

- [x] **Step 4: Run Admin tests and verify GREEN**

Run the command from Step 2. Expected: all selected tests pass.

### Task 6: Synchronize Durable Documentation

**Files:**
- Modify: `apps/api/AGENTS.md`
- Modify: `packages/sdk/AGENTS.md`
- Modify: `apps/admin/AGENTS.md`
- Modify: `docs/agent/design-decisions.md`
- Modify: `docs/progress.md`
- Modify: `docs/superpowers/specs/2026-08-17-project-data-access-design.md`
- Modify: `docs/migration/supabase-compat.md`
- Modify: `docs/003-version-release-guide.md`

- [x] **Step 1: Remove stale identity claims**

Replace direct Project JWT-to-Hasura Realtime wording with Batch 3B token exchange, and replace the SDK rule requiring database GraphQL to fall back to platform tokens.

- [x] **Step 2: Record migration and rollback prerequisites**

Document migration `018`, existing-project compatibility mode, new-project explicit mode, the prohibition on automatic `018 down`, and the platform-token GraphQL breaking security change.

- [x] **Step 3: Retain residual security risks**

Keep the internal Functions GraphQL admin-secret/query-scan issue and free-form management SQL boundary visible until separate work resolves them.

### Task 7: Final Verification And Review

**Files:** all changed files

- [x] **Step 1: Run focused feature tests**

```bash
pnpm test tests/unit/project-data-access-mode-migration.test.ts tests/unit/project-service.test.ts tests/unit/data-access-overview.test.ts tests/unit/data-access-service.test.ts tests/unit/project-data-actor.test.ts tests/unit/openapi-graphql-route.test.ts tests/unit/ratelimit-graphql.test.ts tests/sdk/client.test.ts tests/sdk/database.test.ts tests/sdk/rpc.test.ts tests/sdk/functions.test.ts tests/unit/admin/graphql-editor.test.ts tests/unit/admin/api-documentation.test.ts
```

- [x] **Step 2: Run production builds**

```bash
pnpm --filter @druvia/api build
pnpm --filter @druvia/sdk build
pnpm --filter @druvia/admin build
```

- [x] **Step 3: Run broader regression tests**

```bash
pnpm test tests/unit tests/sdk
```

Result: the full command reported one pre-existing OTA contract drift in `tests/unit/update-contract.test.ts` (`finalizing` is present in the shared contract but absent from the expected array). Running the same suite with that unrelated test excluded passed all 516 tests.

- [x] **Step 4: Check diff hygiene and requirements**

```bash
git diff --check
git status --short
```

Re-read every acceptance criterion in the approved design and verify it against code or a named test. Do not commit automatically; leave the reviewed working tree for the user's manual commit workflow.
