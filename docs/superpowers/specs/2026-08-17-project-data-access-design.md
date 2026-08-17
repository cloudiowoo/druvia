# Project Data Access And Actor Design

Date: 2026-08-17

Status: Approved for phased implementation

## 1. Goal

Druvia must enforce project-user, anonymous API key, Realtime, Functions and future background-service access through one explicit project actor model without exposing Hasura implementation details as the product workflow.

The product-facing concepts are:

- data interface availability;
- authenticated-user access;
- anonymous access;
- row and column rules;
- realtime availability;
- application service identities.

Hasura role names, metadata commands and admin credentials remain internal implementation details. Advanced diagnostics may display generated role names, but normal configuration must not require users to understand Hasura metadata.

## 2. Current Problems

The current implementation has four unsafe or incomplete behaviors:

1. Tracking a table automatically creates unrestricted `user` CRUD permissions and anonymous write permissions.
2. The GraphQL proxy maps API key and project-user requests inconsistently and does not propagate a stable project-user row identity.
3. Realtime enabling creates unrestricted anonymous select permission, while disabling removes that permission.
4. SDK Realtime sends an empty `connection_init` payload and therefore cannot preserve the HTTP project actor.

Existing projects may depend on legacy `user` and `anonymous` metadata. These permissions must be inventoried and migrated explicitly instead of being silently deleted or copied into new scoped roles.

## 3. Data Scope

A physical Hasura role belongs to a data scope, not merely to a visible project alias.

The initial public runtime scope is the project's default production schema. Druvia environments already have independent schemas, but public API keys and project sessions do not yet select an environment. Phase A therefore follows these rules:

- scoped runtime roles are materialized only for the default project schema;
- Admin may continue managing non-production environment schemas with platform authorization;
- a non-production environment cannot reuse the default schema's scoped role;
- public environment access requires a later contract for environment-scoped API keys/session audience before roles are materialized there.

When public environment access is introduced, the data scope identity must include immutable `projectId + environmentId`. It must not derive from project alias, environment name or mutable schema name.

## 4. Logical Actors And Physical Roles

Application code works with logical actors:

| Logical actor | Initial purpose |
| --- | --- |
| `authenticated` | A project user with a stable `sub` |
| `anonymous` | A request authenticated by a project API key but without a project user |
| `service` | Reserved for a future explicitly-created project service principal |
| `platform` | Platform administration; never exposed as a project data role |

Physical role names are generated only by a central resolver. The versioned format is:

```text
druvia_v1_s_<scopeHash>_user
druvia_v1_s_<scopeHash>_anon
druvia_v1_s_<scopeHash>_r_<policyHash>
druvia_v1_s_<scopeHash>_svc_<principalHash>
```

Initial implementation creates only the first two names. Custom business roles and service principals are reserved extensions and do not enter the first rollout.

The resolver requirements are:

- use immutable IDs as hash input;
- use a version marker so a future naming algorithm can coexist during migration;
- return only lower-case ASCII role names;
- keep physical names out of SDK public APIs and normal Admin forms;
- maintain enough mapping information for diagnostics, cleanup and migration;
- reject unsupported actor/policy kinds rather than accepting arbitrary role strings.

The project user's business role remains separate from the physical enforcement role. A future business policy can either use a trusted session variable in row filters or map to an explicit scoped policy role when operations/columns differ. Clients cannot choose their own allowed Hasura role.

## 5. Session Variables

The canonical Hasura session context for a project user is:

```text
x-hasura-role=<scoped authenticated role>
x-hasura-user-id=<Project User sub>
x-hasura-project-id=<Project ID>
x-hasura-actor-type=project_user
x-hasura-business-role=<server-derived business role, when available>
```

The anonymous API key context is:

```text
x-hasura-role=<scoped anonymous role>
x-hasura-project-id=<Project ID>
x-hasura-actor-type=apikey
```

Platform users continue through management APIs. Hasura admin secret remains server-side and is not a project actor credential.

Trusted Backend Keys remain capability issuers. They do not become Hasura actors. A trusted backend may issue a standard project-user session for user-delegated work. Cross-user project service work requires the later service-principal lifecycle rather than a generic broad worker role.

## 6. Permission Model

Safe defaults:

- tracking a table creates no select/insert/update/delete permission;
- creating a table therefore exposes its GraphQL schema but grants no project-data access;
- anonymous writes are never generated automatically;
- unrestricted row filters are never generated automatically;
- explicit permission configuration is required before project actors can use a table.

Permission configuration is expressed in product terms:

- actor: authenticated user, anonymous client, or future application service;
- operations: select, insert, update, delete;
- columns;
- row filter and insert/update check;
- column presets;
- realtime readiness, derived from select access plus the realtime feature switch.

Hasura metadata remains the enforcement source of truth. Druvia stores only the logical configuration/migration state needed to produce, explain and reconcile that metadata.

## 7. Realtime

`_meta_tables.realtime_enabled` is an application capability switch only. It must not create, replace or delete Hasura select permissions.

A table is realtime-ready for a logical actor only when both conditions are true:

1. `realtime_enabled=true`;
2. that actor has an explicit select permission on the table.

Enabling Realtime without select permission is valid but reports `access_required`. Disabling Realtime does not alter GraphQL read permission.

The final Realtime authentication path is a Hasura-verifiable Project JWT:

- authenticated project users send their Project JWT in `connection_init`;
- anonymous SDK clients exchange a validated API key for a short-lived scoped Realtime token;
- the SDK uses the same project actor selection order for HTTP and WebSocket;
- empty `connection_init` is not accepted as completion of project-user Realtime support.

## 8. Worker Extension

Workers are classified by authority, not runtime language:

| Worker type | Authority path |
| --- | --- |
| Request-bound Edge Function | Internal proxy preserving the original caller actor |
| User-delegated background job | Standard Project Session for the target user |
| Project-wide application service | Future revocable service principal with explicit scoped permissions |
| Platform maintenance worker | Internal management path; not a project data role |

No worker receives Hasura admin secret merely because it runs in the deployment. Service principals require an explicit credential lifecycle, audit identity and permission policy before production use.

## 9. Admin Experience

Normal Admin pages avoid the term Hasura unless displaying diagnostics.

### 9.1 Data Tables

The Tables page presents:

- `Data API`: connected / access required / ready;
- `Realtime`: disabled / access required / ready;
- actions named `Sync Data Interface` and `Refresh Data Structure`.

Tracking and metadata reload remain implementation details behind those commands.

### 9.2 Table Access

Permission editing belongs to the selected table context. The table detail gains a `Data Access` section or tab containing actor, operation, column and row-rule configuration. It does not expose raw metadata command names.

### 9.3 Project Overview

Project settings may link to a compact `Data Access` overview showing:

- tables ready for authenticated users;
- tables explicitly open to anonymous clients;
- tables with Realtime enabled but missing read access;
- legacy broad permissions requiring migration;
- drift or failed synchronization.

Editing remains in the table context. The project overview is for status, migration and navigation.

### 9.4 Platform Diagnostics

Deployment-level settings may show Hasura health, metadata consistency and JWT configuration status. Secrets are never editable or revealed in Admin. Raw generated role names are available only in an advanced diagnostic disclosure.

## 10. Legacy Migration

The rollout supports coexistence and explicit activation:

1. Stop generating new legacy broad permissions.
2. Inventory existing `user` and `anonymous` permissions and classify exact old generated shapes separately from custom rules.
3. Back up exported metadata and show a dry-run migration report.
4. Let an administrator configure or approve scoped permissions.
5. Verify scoped HTTP and Realtime access with positive and negative actor tests.
6. Activate scoped mode for the project.
7. Remove legacy generated permissions only after successful verification.
8. Preserve custom legacy rules until explicitly mapped or removed.

The proxy must not switch an existing project to scoped roles before its scoped permissions are ready.

## 11. Phased Delivery

### Batch 1: Safe Metadata Baseline

- central versioned role resolver;
- no automatic CRUD permissions during table tracking;
- Realtime switch has no permission side effects;
- access-readiness status separates tracking, read permission and Realtime capability;
- simplified Tables and Realtime terminology.

This batch deliberately keeps existing request role behavior so production projects are not cut over without migration.

### Batch 2: Explicit Data Access Configuration

- table-level logical permission API;
- simplified Data Access editor;
- project access overview;
- scoped permission materialization for the default data scope.

Implementation status:

- Batch 2A is implemented for the default production schema only;
- authenticated CRUD uses constrained `none / all / owner` presets, with one owner column and `X-Hasura-User-Id` enforcement;
- anonymous access is select-only in the simplified editor;
- only the two project-scoped managed roles are replaced atomically; legacy roles are preserved;
- unsupported custom metadata on a managed scoped role is read-only and blocks replacement;
- materialized scoped permissions are not yet selected by HTTP or WebSocket runtime actors;
- Batch 2B project overview is implemented for the default production schema;
- the overview uses one side-effect-free PostgreSQL inventory and one default-source metadata export, reports actor-specific custom states, and exposes no physical role names;
- Admin provides read-only summary/filter/navigation under project settings, with explicit `scope=default` navigation back to table editing;
- Batch 2B remains in `compatibility` runtime mode, and legacy migration preview remains Batch 4.

### Batch 3: Actor Cutover

- Project JWT Hasura claims;
- HTTP proxy actor/session-variable mapping;
- short-lived anonymous Realtime token;
- SDK authenticated WebSocket connection;
- project activation state and compatibility behavior.

### Batch 4: Legacy Migration And Production Gate

- metadata inventory, backup, dry-run, apply and rollback;
- cross-actor and cross-project negative tests;
- existing-project migration rehearsal;
- release and OTA compatibility checks.

Storage, RPC and Functions actor propagation remains part of the wider Phase A exit and must be verified after the GraphQL/Realtime actor cutover.

## 12. Non-Goals

- exposing a Hasura Console clone in Druvia Admin;
- allowing users to edit Hasura admin/JWT secrets in Admin;
- implementing arbitrary custom roles in Batch 1;
- implementing a generic worker role or worker runtime;
- publicly exposing non-production environments before an environment identity contract exists;
- silently migrating or deleting existing custom permissions.

## 13. Acceptance Criteria

- New tables receive no automatic project-data CRUD permission.
- Realtime toggles never create or delete select permission.
- The UI describes application data access, not Hasura metadata mechanics.
- Physical roles are generated only through the versioned resolver.
- Existing projects are not switched to scoped roles without an explicit migration/activation step.
- The design can add environment scopes, business policies and service principals without changing SDK-facing role strings.
