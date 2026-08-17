# Project Data Access HTTP Actor Cutover Design

Date: 2026-08-17

Status: Implemented

## 1. Goal

Batch 3A makes project data-access runtime mode durable and switches the HTTP GraphQL proxy to server-derived project actor contexts. Existing projects retain their current Project JWT and API-key compatibility behavior, while projects created by the Batch 3A service after migration `018` use the project-scoped permissions introduced in Batch 2.

This batch establishes the runtime resolver that Batch 3B can reuse when issuing short-lived Realtime tokens. It does not connect Project JWTs directly to Hasura.

## 2. Scope

Batch 3A includes:

- a persisted `compatibility | explicit` runtime mode on each project;
- compatibility backfill for every existing project;
- explicit mode for projects created through the Batch 3A service;
- one server-owned actor resolver for GraphQL HTTP requests;
- project-user and API-key mapping to scoped roles in explicit mode;
- trusted project-user session variables in explicit mode;
- rejection of platform JWTs on the project application GraphQL endpoint;
- SDK HTTP database requests that select only Project Session or API-key identity;
- an Admin GraphQL Playground that tests with an application credential instead of the platform session;
- an Admin API page that exposes the Druvia project GraphQL proxy URL rather than the direct Hasura URL;
- real runtime-mode reporting in the project data-access overview;
- migration, service, route and negative security tests;
- documentation of migration and rollout prerequisites.

Batch 3A does not include:

- an activation API or Admin activation control for existing projects;
- legacy permission migration, deletion or automatic repair;
- Realtime token issuance or SDK WebSocket changes;
- Hasura claims inside the long-lived Project JWT;
- Storage, RPC or Functions actor cutover;
- replacement of the existing Edge Functions internal GraphQL authority model;
- public access to non-production environment schemas;
- custom business roles or service principals.

Existing-project activation remains blocked until Batch 4 provides inventory, backup, dry-run, verification and rollback. Realtime authentication remains Batch 3B.

## 3. Persisted Runtime Mode

Migration `018_project_data_access_mode` adds a dedicated column:

```sql
ALTER TABLE druvia_projects
  ADD COLUMN data_access_mode VARCHAR(20) NOT NULL DEFAULT 'compatibility';

ALTER TABLE druvia_projects
  ADD CONSTRAINT druvia_projects_data_access_mode_check
  CHECK (data_access_mode IN ('compatibility', 'explicit'));
```

The migration default intentionally leaves every existing row in `compatibility`. `createProject()` must explicitly insert `data_access_mode='explicit'`; it must not change the database default to `explicit`, because the default is also the conservative fallback for old tooling and partial rollout windows.

The shared `Project` contract exposes:

```typescript
type ProjectDataAccessMode = 'compatibility' | 'explicit'

interface Project {
  // existing fields
  dataAccessMode: ProjectDataAccessMode
}
```

Database row conversion uses a normalizer that accepts only `explicit`; missing, null or unknown values resolve to `compatibility`. The database constraint remains the primary write guard, while the normalizer prevents an unsafe mode change during a mixed-version rollout.

There is no Batch 3A update method for this field. Existing project settings updates cannot change it.

## 4. Runtime Actor Resolver

Add one pure resolver under the data-access module. It receives the target project, normalized runtime mode and authenticated project actor, then returns a server-owned Hasura execution context.

The result has one project-actor path:

```typescript
type ProjectDataExecutionContext = {
  kind: 'project_actor'
  role: string
  sessionVariables: Record<string, string>
}
```

The resolver follows this matrix:

| Runtime mode | Request identity | Hasura execution context |
| --- | --- | --- |
| any | `platform_user` | rejected before resolver with `403 PROJECT_ACTOR_REQUIRED` |
| `compatibility` | `project_user` | legacy `user` role, no new session variables |
| `compatibility` | `apikey` | legacy `user` role, no new session variables |
| `explicit` | `project_user` | scoped authenticated role plus trusted user/project/actor variables |
| `explicit` | `apikey` | scoped anonymous role plus trusted project/actor variables |

Explicit project-user variables are:

```text
x-hasura-user-id=<Project User sub>
x-hasura-project-id=<Project ID>
x-hasura-actor-type=project_user
```

Explicit anonymous variables are:

```text
x-hasura-project-id=<Project ID>
x-hasura-actor-type=apikey
```

Scoped physical roles are generated only through `resolveDataScopeRole`; the literal `user` role exists only in the compatibility branch. The resolver never accepts a role string or session variable supplied by the client.

Both `project_user` and `apikey` identities must have the same `projectId` as the URL. A mismatch is rejected before Hasura is called. A `platform_user` is not passed to the resolver.

This restriction is intentional. The Hasura admin secret bypasses role permissions, and `x-hasura-default-schema` is not an authorization boundary. Authorizing a platform user for one project and then forwarding arbitrary GraphQL with only the admin secret would allow the document to address tracked objects outside that project. Platform administration therefore remains outside this application-data endpoint; the authorization strength of each dedicated management API is a separate concern and is not expanded by Batch 3A.

## 5. HTTP GraphQL Proxy

The existing route remains:

```text
POST /api/v1/projects/:projectId/graphql
```

The request flow is:

1. `authenticate` selects the platform JWT, Project JWT or API-key identity using the existing precedence rules.
2. The route rejects `platform_user` with `403 PROJECT_ACTOR_REQUIRED` and accepts only `project_user` or `apikey`.
3. The route verifies that the accepted actor's `projectId` exactly matches the URL.
4. The route loads the project once and retains `schemaName`, `settings` and normalized `dataAccessMode` for the handler.
5. Existing project-level rate limits run with the same actor identity.
6. The runtime resolver produces the Hasura execution context.
7. The handler sends the GraphQL document to Hasura with the admin secret kept server-side and always attaches the server-generated role and session-variable headers.

The proxy may continue to set the target default schema for naming compatibility, but neither authorization nor project isolation may depend on that header. It never forwards client `x-hasura-*` headers, and a client cannot select an allowed role by placing Hasura claims in its bearer token.

Compatibility mode deliberately preserves the current HTTP behavior exactly: both Project JWT and API-key requests execute as legacy `user`, without newly introducing `x-hasura-user-id`. Fixing or migrating legacy owner-filter behavior belongs to the explicit migration workflow, not the compatibility path.

No runtime-mode cache is introduced in Batch 3A. The route already loads the project for each request, and reading the mode from that row avoids stale authorization after Batch 4 eventually activates a project.

### 5.1 Admin GraphQL Playground

The current Admin GraphQL Playground sends the platform login token to this route. Batch 3A must remove that behavior in the same change; otherwise the Playground becomes a broken caller and encourages reintroducing the unrestricted management path.

The Playground instead executes as an application actor selected by the operator:

- API-key mode sends only the entered project API key in the `apikey` header;
- project-user mode sends only the entered Project access token as a Bearer token;
- the execute action remains disabled until the selected credential is present;
- credentials live only in component memory and are cleared on mode change or unmount;
- credentials are not placed in URL state, browser storage, query history, telemetry or error messages;
- the platform login token is used for normal Admin management requests only and is never attached to a Playground execution.

This makes the Playground an application-permission tester. Platform operators continue to use the existing SQL, table-data and metadata management workflows for administrative work. Batch 3A does not add an admin-secret GraphQL endpoint or claim to harden those separate management workflows.

The API page's displayed and copied GraphQL endpoint must be the same Druvia proxy route:

```text
<public-api-base>/api/v1/projects/<projectId>/graphql
```

It must not advertise the direct Hasura `/v1/graphql` URL. Project JWT and API-key actor resolution occurs at Druvia API, and the direct Hasura endpoint is not the public application contract. The now-unused `hasuraUrl` Playground prop is removed rather than retained as a misleading compatibility input.

### 5.2 SDK HTTP Database Requests

The current `DruviaClient` database fetch path falls back from a missing Project Session to the cached platform session. That fallback must not reach the application GraphQL endpoint after this cutover.

Batch 3A introduces or wires a database-specific fetch path with this precedence:

1. when a Project Session exists, send its Project access token as Bearer and keep the project API key header;
2. otherwise, send the project API key without an Authorization header;
3. never use the platform session token for `from()` or `graphql()` requests.

When both headers are present, the Project access token is authoritative. An invalid or expired Project token returns `401`; the server and SDK must not silently downgrade that request to anonymous API-key access.

This HTTP-only change does not implement Batch 3B WebSocket authentication. It also must not silently change RPC or Functions authentication behavior: those modules may retain their existing fetch path until their actor cutover is designed. A client that previously relied on platform login to obtain unrestricted GraphQL behavior must migrate to Project Auth or explicit anonymous permissions; preserving that admin bypass is not a compatibility requirement.

## 6. Project JWT And Realtime Boundary

Project JWT remains a Druvia API credential signed by `PROJECT_AUTH_JWT_SECRET` or its existing fallback. Batch 3A does not add Hasura role claims to it.

This corrects the earlier assumption that authenticated Realtime should send the Project JWT directly to Hasura. Current deployments configure Hasura with `JWT_SECRET`, which may intentionally differ from `PROJECT_AUTH_JWT_SECRET`. Direct reuse would therefore be configuration-dependent and would also preserve an old runtime role until a long-lived Project JWT expired.

Batch 3B will use one token-exchange model for both actors:

- a Project JWT authenticates a project user to Druvia API;
- an API key authenticates an anonymous project client to Druvia API;
- Druvia resolves the current runtime mode and actor context;
- Druvia issues a short-lived Hasura-verifiable token signed for the configured Hasura JWT verifier;
- SDK WebSocket `connection_init` sends that short-lived token.

The initial Realtime token lifetime target is five minutes. Its detailed endpoint, refresh behavior and SDK contract belong to Batch 3B.

## 7. Data-Access Overview

`GET /api/v1/projects/:projectId/data-access/overview` keeps its current public shape but returns the persisted mode:

```typescript
runtimeMode: 'compatibility' | 'explicit'
```

The overview builder receives normalized mode as input instead of hard-coding `compatibility`. Admin continues to show the compatibility warning only for compatibility projects. Batch 3A does not add a toggle, activation button or migration command.

The per-table status remains scoped-permission readiness. On a compatibility project, configured rows are still displayed as prepared configuration and the warning explains that application requests have not switched. On an explicit project, the same statuses describe the active HTTP project actor policy.

## 8. Error Handling And Security

- Missing projects or project schemas keep the existing `404` behavior.
- Platform JWTs on the application GraphQL endpoint return `403 PROJECT_ACTOR_REQUIRED` before project loading, rate limiting or Hasura execution.
- Project-user and API-key project mismatches return `403 PROJECT_SCOPE_MISMATCH` before rate-limit or Hasura execution.
- Unknown runtime-mode values normalize to `compatibility`.
- Hasura admin secret, physical role details and upstream response bodies do not enter normal client errors.
- GraphQL request headers cannot override server-derived role or session variables.
- Explicit anonymous requests never receive a user-id session variable.
- Compatibility mode receives no new session variables and therefore does not silently broaden or alter a legacy policy.
- SDK database calls never fall back to a cached platform session.
- An invalid or expired Project access token never degrades to anonymous API-key execution.
- The resolver has no database, network or metadata side effects.

New route-owned authorization errors use the normal API envelope, for example:

```json
{
  "success": false,
  "error": {
    "code": "PROJECT_ACTOR_REQUIRED",
    "message": "Project actor credential required"
  }
}
```

### 8.1 Residual Security Boundaries

`POST /api/internal/functions/graphql` remains outside Batch 3A. It currently executes with the Hasura admin secret and attempts to reject foreign schemas by scanning GraphQL text. That scan is not an authorization boundary: custom root fields, relationships or unprefixed `public` fields can escape schema-name matching.

The Batch 3A resolver and its security claims apply only to `POST /api/v1/projects/:projectId/graphql`. Implementation must not reuse the internal route's query-text scanning as project isolation. Release notes must not claim that all GraphQL paths are project-scoped, and multi-tenant production readiness for untrusted user-authored Functions remains blocked until the Functions actor cutover replaces admin execution with a role-enforced capability model.

Platform management APIs are also a separate trust surface. In particular, setting a project schema as PostgreSQL `search_path` does not prevent a qualified SQL query from naming another schema. Batch 3A does not certify those APIs as multi-tenant isolation boundaries; that requires a dedicated management-plane security audit before Druvia enables mutually untrusted tenants.

## 9. Migration And Deployment

Release deployment order is mandatory:

1. deploy the release files and images;
2. run migration `018_project_data_access_mode`;
3. start the Batch 3A API;
4. verify an existing compatibility project and a newly created explicit project;
5. verify API-key and Project access-token execution from the Admin Playground;
6. verify that a platform JWT cannot execute the application GraphQL endpoint.

The migration CLI discovers `018` from the up/down filenames. Its `bootstrap` `dataChecks` map must detect the `druvia_projects.data_access_mode` column so a manually provisioned database with that column is not later given a duplicate `ALTER TABLE`. Release and OTA documentation must list migration `018` as a prerequisite for creating new projects on Batch 3A code.

Migration `018` is additive and compatible with the previous API. A production code rollback leaves migration `018` applied. The previous API ignores the extra column, and preserving it retains the explicit-project inventory for a later forward deployment.

Rolling back to the pre-Batch-3A API also restores its unsafe platform-token GraphQL behavior and maps explicit projects back to legacy `user`. It is therefore not a transparent live-traffic rollback. Before starting the old API, operators must either block `POST /api/v1/projects/:projectId/graphql` at the ingress or deploy an emergency build that retains platform-token rejection. Explicit projects remain blocked until their legacy-role behavior is verified or the Batch 3A API is restored. Release documentation must make this security consequence visible rather than presenting rollback as a normal zero-downtime downgrade.

The `018` down migration exists for controlled development reset or permanent feature removal only. Before running it, operators must stop project creation and export every project's `data_access_mode`. Dropping the column without that inventory permanently loses which projects were explicit and can make a later redeployment treat them as compatibility projects. The release/OTA rollback path must not run this down migration automatically.

Batch 3A does not change the OTA mechanism itself.

## 10. Testing

Pure runtime resolver tests cover:

- compatibility project-user and API-key mapping to legacy `user`;
- explicit project-user mapping to the scoped authenticated role;
- explicit API-key mapping to the scoped anonymous role;
- exact explicit session variables;
- absence of user-id for anonymous actors;
- cross-project rejection;
- role generation through the central resolver;
- unknown-mode compatibility fallback.

The route, rather than the pure resolver, owns the negative platform-user case.

Project service and migration tests cover:

- snake-case row conversion to `dataAccessMode`;
- existing or missing values normalizing to compatibility;
- project creation explicitly writing `explicit`;
- migration default, constraint and down migration;
- migration file discovery and `bootstrap` detection for version `018`.

GraphQL route tests cover:

- one project load per request;
- explicit project-user headers;
- explicit API-key headers;
- compatibility request headers without new session variables;
- platform JWT denial before project loading, rate limiting and Hasura execution;
- project-user and API-key cross-project denial;
- exact `PROJECT_ACTOR_REQUIRED` and `PROJECT_SCOPE_MISMATCH` error envelopes;
- client role/session-variable injection being ignored;
- existing rate-limit configuration still receiving the project settings;
- Hasura not being called after an authorization failure.

Admin Playground tests cover API-key and Project access-token headers, disabled execution without a credential, credential clearing, and absence of the platform login token from GraphQL requests.

Admin API page tests confirm that the displayed/copied endpoint is the Druvia project proxy and that no direct Hasura GraphQL URL is presented as the application endpoint.

SDK HTTP tests cover Project Session precedence, anonymous API-key use when no Project Session exists, absence of the platform token from database calls, and unchanged RPC/Functions fetch behavior. API integration tests cover the no-downgrade behavior for an invalid or expired Project access token sent together with an API key.

Overview tests cover both runtime modes and confirm that raw physical roles remain absent from the public response.

Verification includes focused unit tests, the existing GraphQL proxy regression suite, API production build, documentation drift checks and `git diff --check`.

## 11. Documentation Updates

Implementation completion updates the smallest durable targets:

- `apps/api/AGENTS.md` for server-derived project actor and compatibility rules;
- `packages/sdk/AGENTS.md` for the database-specific token selection rule;
- `apps/admin/AGENTS.md` for application-credential-only Playground execution;
- `docs/agent/design-decisions.md` for the persisted mode and no-direct-Project-JWT decision;
- `docs/progress.md` for Batch 3A milestone status and Batch 3B as the next step;
- `docs/superpowers/specs/2026-08-17-project-data-access-design.md` for the platform GraphQL boundary, SDK HTTP selection and short-lived Realtime token exchange;
- taro-app/Supabase compatibility documentation to state that existing projects remain compatible until an explicit Batch 4 migration;
- SDK migration notes to state that platform sessions no longer grant application GraphQL access.

The durable API notes and progress entry also retain the internal Functions GraphQL residual risk until its separate actor cutover is complete.

No parallel project-memory file is created.

## 12. Acceptance Criteria

- Migration `018` leaves all existing projects in compatibility mode.
- Every project created through the Batch 3A project service is persisted in explicit mode.
- Existing compatibility Project JWT and API-key GraphQL behavior remains unchanged.
- Explicit project users and API keys execute through their project-scoped roles.
- Explicit project-user requests include stable user, project and actor session variables.
- Explicit anonymous requests include no user identity.
- Platform JWTs cannot execute the project application GraphQL endpoint.
- The Admin GraphQL Playground executes only with an in-memory application credential and never sends the platform login token.
- The Admin API page exposes the Druvia project GraphQL proxy URL, not the direct Hasura URL.
- SDK `from()` and `graphql()` select a Project Session or API key and never fall back to the platform session.
- Invalid or expired Project access tokens fail authentication and do not downgrade to anonymous access.
- RPC and Functions do not change authentication behavior as a side effect of the SDK database fix.
- Platform management does not become a project data role or regain access through the application GraphQL endpoint.
- Batch 3A is described as securing the public project GraphQL proxy only; the internal Functions GraphQL path remains an explicit production risk and later gate.
- Batch 3A does not claim that free-form SQL or other management APIs provide a complete multi-tenant isolation boundary.
- Clients cannot choose a Hasura role or session variable.
- The project overview reports the real persisted runtime mode.
- Existing projects cannot activate explicit mode through Batch 3A API or Admin.
- Project JWT and Hasura JWT signing keys may remain independent.
- Realtime and SDK WebSocket behavior remain unchanged until Batch 3B.
