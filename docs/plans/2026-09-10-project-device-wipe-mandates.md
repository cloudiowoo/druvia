# Project Device Wipe Mandates

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:test-driven-development` while implementing this document. Druvia uses the current main workspace and does not create `.worktrees` for this feature.

**Status:** Druvia platform implementation complete locally on 2026-09-11. PITCHETCH migration and real device acceptance remain external follow-up work.

**Goal:** Provide a project-scoped, session-independent and cryptographically signed device wipe mandate channel without giving applications Druvia platform credentials or exposing project-internal tables through Hasura.

**Architecture:** Druvia authenticates Project Sessions during binding registration, derives irreversible identifiers, issues a separate possession credential, signs immutable mandate envelopes with project-scoped Ed25519 keys, and accepts idempotent receipts. Project applications own the business tables and transaction boundaries that create wipe obligations, exposed only through three fixed security-definer Hook contracts.

**Tech Stack:** Fastify 5, PostgreSQL 17, Node.js 22 `node:crypto`, Vitest, Druvia Project Auth and migration/release pipeline.

---

## 1. Scope And Boundaries

### Druvia owns

- Project Session authentication for binding registration and rotation.
- Opaque binding handles and 256-bit lookup credentials.
- HMAC derivation for project-user and device-binding fingerprints.
- Encrypted Project User registration replay material for project-schema recovery.
- Project-scoped Ed25519 signing keys, public verification key publication, rotation and guarded retirement.
- Session-independent mandate query and receipt endpoints.
- Immutable signed envelope snapshots, receipt digests, cross-project isolation, rate limiting and audit-safe logs.
- Core migration, release migration ceiling and deployment configuration.

### Project application owns

- The raw Watch/device binding identity generation and secure device transfer.
- Project-schema binding, mandate and receipt tables.
- Transactional creation of account- and session-scope wipe obligations before business deletion commits.
- Actual Watch/local data erasure and receipt submission.
- Project migrations, restore verification and the three Hook implementations.

### Explicit exclusions

- Druvia does not store Apple credentials on the device-wipe path and does not require the Apple provider to be enabled.
- Druvia does not expose project-internal wipe tables through Hasura or grant client CRUD permissions.
- Binding HMAC is an identifier and is never accepted as a bearer credential.
- This batch does not modify the PITCHETCH repository or claim real Watch/iPhone acceptance.

## 2. Public API Contract

All responses retain the Druvia `{ success, data | error }` envelope. Unknown handle, wrong token and cross-project token use the same `DEVICE_WIPE_CREDENTIAL_INVALID` response.

### Register a binding

```http
POST /api/v1/projects/:projectId/device-wipe/bindings
Authorization: Bearer <Project Session access token>
Idempotency-Key: <UUID>
Content-Type: application/json

{
  "bindingIdentity": "<22-128 base64url characters>",
  "bindingRevision": 1
}
```

The target Project User comes only from the verified Project Session. Druvia derives:

- `projectUserFingerprint = HMAC-SHA256(binding secret, domain + projectId + projectUserId)`
- `bindingIdentityHmac = HMAC-SHA256(binding secret, domain + projectId + bindingIdentity)`
- `lookupToken = HMAC-SHA256(credential secret, domain + projectId + bindingId)`

Only the lookup token SHA-256 digest is stored. The deterministic token lets an identical idempotent retry recover from a lost response without storing plaintext credentials.

Response:

```json
{
  "bindingHandle": "dwb_...",
  "bindingLookupToken": "...",
  "projectUserFingerprint": "...",
  "bindingIdentityHmac": "...",
  "bindingRevision": 1
}
```

The same raw binding identity cannot be registered to another Project User in the same project. A higher revision creates a new active binding and retires the preceding active revision only after the project Hook accepts the registration. A retired credential can retrieve only pending mandates already materialized in Druvia core; it cannot discover new obligations through the project Hook. Only a retry with the original registration idempotency key can recover the same registration response, so a new key cannot revive a retired credential.

### Query mandates without a Project Session

```http
POST /api/v1/projects/:projectId/device-wipe/bindings/:bindingHandle/mandates/query
X-Druvia-Binding-Token: <binding lookup token>
```

The endpoint first returns any pending immutable core snapshot. When none remains, it obtains project obligations through the query Hook, materializes each new command exactly once, signs canonical sorted-key JSON with the current project key, and returns stable envelopes on retries. This preserves delivery of an already-issued command during temporary Hook drift or project-schema unavailability.

```json
{
  "mandates": [
    {
      "version": 1,
      "keyID": "dwk_...",
      "command": {
        "version": 1,
        "deletionID": { "rawValue": "00000000-0000-4000-8000-000000000700" },
        "projectID": "proj_...",
        "projectUserFingerprint": "...",
        "bindingIdentityHMAC": "...",
        "bindingRevision": 1,
        "scope": { "kind": "account" }
      },
      "signature": "<base64url Ed25519 signature>"
    }
  ]
}
```

Session scope uses `{ "kind": "session", "sessionID": { "rawValue": "<UUID>" } }`. The signed bytes are sorted-key JSON of `{ "version", "keyID", "command" }`, matching PITCHETCH `CanonicalWireCodec` for this date-free payload.

### Submit an idempotent receipt

```http
POST /api/v1/projects/:projectId/device-wipe/bindings/:bindingHandle/mandates/:deletionId/receipts
X-Druvia-Binding-Token: <binding lookup token>
Content-Type: application/json

{
  "version": 1,
  "deletionID": { "rawValue": "00000000-0000-4000-8000-000000000700" },
  "scope": { "kind": "account" },
  "bindingIdentityHMAC": "...",
  "completedAt": "2026-09-10T00:00:00.000Z",
  "result": "erased"
}
```

Druvia validates the receipt against the immutable command and credential, calls the acknowledge Hook, and persists a canonical receipt digest in the same database transaction. An identical replay returns the original acknowledgment; a conflicting receipt returns `DEVICE_WIPE_RECEIPT_CONFLICT`.

### Verification keys and management

```http
GET  /api/v1/projects/:projectId/device-wipe/verification-keys
GET  /api/v1/projects/:projectId/device-wipe
PUT  /api/v1/projects/:projectId/device-wipe
POST /api/v1/projects/:projectId/device-wipe/signing-keys/rotate
POST /api/v1/projects/:projectId/device-wipe/signing-keys/:keyId/retire
```

Verification keys are public and return Ed25519 JWK `x` values for active and verification-only keys. Management endpoints require a Platform Session with project `auth:manage`. Enabling validates secrets and all Hook contracts, then creates the first signing key if needed. Rotation makes the previous active key verification-only. Retirement fails while a pending signed mandate still uses the key.

## 3. Project Hook Contract

Hook names are reserved in core persistence for future controlled migration and are snapshotted into each binding. The MVP management API exposes only enablement and uses these fixed names:

```sql
druvia_register_device_wipe_binding(text, text, bigint) RETURNS jsonb
druvia_list_device_wipe_mandates(text, bigint) RETURNS jsonb
druvia_ack_device_wipe_mandate(text, bigint, uuid, jsonb) RETURNS jsonb
```

Arguments are respectively the Project User ID, binding HMAC and revision for registration; binding HMAC/revision for query; and binding HMAC/revision/deletion ID/canonical receipt for acknowledgment.

Each function must:

- be owned by the project's unprivileged, non-replication `db_user`;
- be `SECURITY DEFINER` with immutable `search_path=pg_catalog,<project_schema>`;
- expose no `PUBLIC` or non-owner `EXECUTE` grant;
- inherit no other role and be directly or indirectly assumable by no non-superuser role;
- have no non-extension relation, column or sequence privileges and no `CREATE` privilege in any other non-system schema;
- have no executable non-extension `SECURITY DEFINER` function in another non-system schema;
- return JSONB with the exact expected shape.

Registration returns `{ "registered": true }`. Query returns a JSON array of `{ "deletionId", "scope", "sessionId" }`, where scope is `account` or `session` and only session scope has `sessionId`. Acknowledge returns `{ "acknowledged": true }`. Druvia treats malformed output or contract drift as unavailable and does not expose database details to the caller.

Objects owned by a database-admin-installed PostgreSQL extension, such as PostGIS catalog relations, are excluded from the business cross-schema check. Trigger-only functions returning `trigger` or `event_trigger` are also excluded from the cross-schema definer-execute check because PostgreSQL cannot invoke them through ordinary SQL; cross-schema relation `TRIGGER` privilege remains prohibited. Role isolation is checked in both directions: the owner cannot inherit another role, and no non-superuser role can inherit or assume the owner. The MVP deliberately fails closed when one `db_user` spans multiple project/environment schemas or can execute another callable business schema security-definer function. Such a project must leave Device Wipe disabled. A dedicated NOLOGIN Hook-owner role and its create/restore/drop lifecycle are deferred to a separate migration; operators must not weaken the checks as a deployment workaround.

## 4. Core Persistence And Recovery

Migration `026_project_device_wipe_mandates` adds:

- `druvia_project_device_wipe_configs`: enablement, fixed Hook names and purpose-separated irreversible secret verification tags.
- `druvia_project_device_wipe_signing_keys`: project key ID, public JWK, encrypted private JWK and lifecycle state.
- `druvia_project_device_wipe_bindings`: idempotency key, irreversible fingerprints, encrypted Project User registration replay material, handle, lookup-token hash, Hook snapshot, revision and lifecycle state.
- `druvia_project_device_wipe_mandates`: immutable signed command snapshot, signature, key and pending/acknowledged state.

Core records deliberately outlive Project User deletion. A restored project mandate cannot reappear after acknowledgment because Druvia's acknowledged immutable snapshot suppresses it. Project deletion is blocked while device-wipe bindings or mandates exist; no implicit cascade may remove pending safety records.

The down migration refuses rollback when any device-wipe config, key, binding or mandate exists. Release manifests move their migration ceiling to `26` and remain backup-required and irreversible.

## 5. Security And Error Semantics

- `DEVICE_WIPE_BINDING_SECRET` and `DEVICE_WIPE_CREDENTIAL_SECRET` are each at least 32 UTF-8 bytes, differ from one another and from JWT, Hasura Admin, Function/Worker, Storage, Account Deletion, Updater, PostgreSQL and object-storage credentials, and are required only when enabling or serving this feature.
- Private Ed25519 JWK values use the dedicated `SECRETS_ENCRYPTION_KEY`; plaintext private keys never enter API responses or logs.
- Raw binding identity, binding lookup token and Project User ID are redacted and never logged; Project User ID is persisted only as dedicated-key encrypted restore material.
- Binding handles are fail-closed classified anywhere in the raw or decoded URL and replaced in the Fastify request URL serializer before access logging, including query-only, off-namespace, malformed-percent, arbitrarily nested `%25` encoding, repeated separators and unknown routes. Ordinary API request logs also omit query strings, and the default 404 response does not echo URLs. Bundled Nginx applies the same access-log classification and omits query strings and referers. Because its error log cannot be selected from a query-sensitive map, the bundled public proxy retains only global `crit` error logging and disables URI-bearing errors in the sensitive location; routine diagnosis uses redacted access status, API structured logs, health checks and metrics.
- All binding lookup comparisons use fixed-length digests and timing-safe equality.
- Registration, query and receipt rate limits atomically increment and establish/repair TTL through one Redis Lua operation. Query and receipt use layered IP, project+IP and irreversible handle-digest+IP budgets without exposing whether a handle exists; random handles cannot bypass the project-level budget. Redis failures return the same sanitized retryable 503 and never fail open.
- Project/session/binding mismatch, malformed Hook output and unsupported wire versions fail closed.
- Registration, re-enable and key rotation verify persisted binding/credential secret tags and fail closed on deployment secret replacement; query and receipt remain available from stored credentials and snapshots.
- Registration, query, receipt, configuration writes and key changes acquire the same project-auth project lock as project-schema restore. After locking and before touching binding/core/Hook state, they check the runtime gate on the same database connection; both `restoring` and `recovery_required` return `503 PROJECT_RESTORE_IN_PROGRESS`. Pending snapshots remain unavailable until replay succeeds and the gate is cleared.
- Project-schema restore validates every binding's persisted three-Hook snapshot, replays registrations in immutable binding identity and numeric revision order, then account-deletion fences, then acknowledged receipts before clearing the runtime gate. Binding `created_at` is immutable but is not used to infer revision order. Registration and receipt failures persist `DEVICE_WIPE_BINDING_REPLAY_REQUIRED` or `DEVICE_WIPE_RECEIPT_REPLAY_REQUIRED` respectively. Normal Hook transactions use a bounded 5-second default timeout; restore replay uses an independently bounded 30-second default and persists `DEVICE_WIPE_RESTORE_TIMEOUT` without clearing the gate when PostgreSQL cancels a statement.
- Bundled Nginx overwrites inbound `X-Forwarded-For` with trusted `$remote_addr`; deployments behind a trusted CDN/Ingress must establish real IP from explicit upstream CIDRs instead of forwarding untrusted client headers.
- Production and release Compose bind the host API diagnostic port to loopback, preventing public clients from bypassing the bundled proxy; local Compose keeps its development port.
- Standalone project database-user deletion and full project deletion share the project-auth lock and reject with `DEVICE_WIPE_DECOMMISSION_REQUIRED` before transferring Hook ownership or changing roles whenever binding/mandate state exists. Full project deletion reuses its outer lock connection rather than waiting on itself through another session.
- Database transport, rate-limit dependency failure and Hook timeout remain retryable server errors; invalid credentials remain a stable 401; conflicting immutable state is 409.

## 6. Implementation Tasks

### Task 1: Migration and release safety

- [x] Add failing schema/release tests for migration `026`, non-cascading safety records and rollback refusal.
- [x] Add migration up/down files with immutable identity constraints and pending-key retirement protection.
- [x] Register migration `026` in bootstrap and set release manifest/workflow ceiling to `26`.

### Task 2: Cryptographic and wire primitives

- [x] Add failing tests for secret validation, domain-separated HMACs, deterministic lookup credentials and timing-safe verification.
- [x] Add failing cross-language fixture tests for sorted-key command payload and Ed25519 signature verification.
- [x] Implement focused crypto and wire modules using `node:crypto` and encrypted private JWK storage.

### Task 3: Hook inspection and repository

- [x] Add failing tests for all three Hook signatures, owner/search-path/ACL validation and malformed outputs.
- [x] Implement contract inspection and same-transaction Hook execution.
- [x] Implement binding, key, signed mandate and receipt repository operations with immutable conflict detection.

### Task 4: Service and public routes

- [x] Add failing service tests for idempotent registration, cross-user rejection, stable signed query, account/session scopes, tokenless operation after Session invalidation and receipt replay/conflict.
- [x] Add failing controller/route tests for actor boundaries, body validation, uniform credential errors and redacted headers.
- [x] Implement management, registration, query, receipt and public verification-key endpoints.

### Task 5: Deployment and durable documentation

- [x] Pass device-wipe secrets, bounded Hook timeouts and all deployment credentials used by secret-isolation checks through local, production and release API environments; update env examples.
- [x] Add release-gate tests and commands.
- [x] Update nearest `AGENTS.md`, design decisions, playbook, progress and this document with final evidence.
- [x] Run focused tests, API/Admin builds, repository test inventory, `git diff --check`, Compose rendering and migration status checks.

## 7. Acceptance Criteria

- Two Project Users cannot claim the same project binding identity.
- A binding can query after its Project Session is expired, revoked or deleted using only its handle and lookup token.
- A handle/token from another project or binding returns the same generic rejection.
- Repeated query returns byte-equivalent signed envelopes for an already materialized mandate.
- Account and session mandates cannot widen or cross scope.
- Identical receipt replay is successful; conflicting replay is rejected and does not change project state.
- Rotation publishes both active and verification-only public keys; unsafe key retirement is rejected.
- Internal project tables remain absent from Hasura client permissions.
- Database-user deletion cannot transfer Hook ownership or drop the project role while device-wipe lifecycle state exists.
- A restored acknowledged project mandate is not reissued.
- Apple-disabled local projects can complete registration, session-scope mandate query and receipt tests.
- Migration `026` is required by local/prod/release/OTA artifacts before the new API starts.

## 8. External PITCHETCH Follow-up

PITCHETCH must add a forward migration after V10 that upgrades its V8 device-wipe tables and implements the three Hook contracts. It must preserve the existing transaction order that inserts mandates before account/session deletion, encode the same 32-byte HMAC as base64url on the wire (hex is acceptable only as an internal DB representation), and add a Druvia/PITCHETCH shared fixture for canonical JSON and Ed25519 verification.

The current local shared database also requires ACL cleanup before enablement: `dru_default_pitchetch_user` can presently execute non-extension `SECURITY DEFINER` functions exposed by `dru_default_taroapp` through `PUBLIC`. Druvia correctly rejects that Hook owner. The owning application/database migration must revoke those public grants and verify its intended callers; PITCHETCH must not receive cross-project grants as a workaround.

Real Apple account-deletion and Watch/iPhone acceptance remain deferred until the Apple Developer account is available. Session-scope deletion, session-independent lookup, receipt idempotency, restore suppression and cross-user isolation are testable locally without Apple.

## 9. Local Verification Evidence

- `pnpm vitest run tests/unit tests/sdk --silent=passed-only --reporter=dot`: 174 files and 1363 tests passed.
- `pnpm --filter @druvia/api build` and `pnpm --filter @druvia/admin build`: passed.
- Local, production and release Compose configurations rendered successfully; production/release API host ports are loopback-only.
- `docker exec druvia-nginx nginx -t`: passed after the sensitive-route logging and forwarding changes.
- Live Nginx probes confirmed malformed request targets do not emit raw or multiply encoded handles; valid off-namespace and query-only handle paths are logged only as `[REDACTED]`. The rebuilt API likewise redacts query-only, off-namespace and deeply encoded handles before Fastify request logging.
- The rebuilt local API and Admin containers report healthy; direct API and Nginx-proxied health checks both return HTTP 200.
- Local API receives the bounded 5-second/30-second Hook timeout defaults and connects to `postgres-postgis`; the two Device Wipe secrets remain absent from the private local env, so project enablement intentionally stays unavailable until operators provision stable distinct values.
- Active local PostGIS reports migration version `26`; the inactive ordinary PostgreSQL remains at `25` and must be migrated if selected again.
- Isolated PostGIS migration verification completed the full up path through `026` and the empty-state down path back to `025`.
- Four critical-review rounds closed timeout/error-chain, Compose secret propagation, Redis fail-open, database-user lifecycle and trigger-only contract-inspection gaps; the final independent review reported no reproducible Critical or Important findings.
- `git diff --check`: passed.

The broader repository integration run is not a clean release signal in the current shared development environment: 187 files passed, 19 failed and 3 were skipped before the active PostGIS database was advanced to `026`. The remaining failures were tied to unavailable Redis, mismatched Hasura/JWT environment state and stale shared-database fixtures rather than the focused device-wipe unit suite. Stable release still requires the production-like integration and PITCHETCH acceptance work listed above.
