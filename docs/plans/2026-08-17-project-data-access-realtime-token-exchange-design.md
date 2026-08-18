# Project Data Access Realtime Token Exchange Design

Date: 2026-08-17

Status: Implemented (2026-08-18)

## 1. Goal

Project Data Access Batch 3B gives SDK Realtime connections the same trusted project-actor foundation as Batch 3A HTTP GraphQL without sending a long-lived Project JWT directly to Hasura.

Druvia API authenticates a Project Session or project API key, resolves the current project runtime mode, and issues a short-lived Hasura-verifiable token. The SDK uses that token only during WebSocket connection initialization, refreshes it before expiry, and restores active subscriptions after reconnecting.

This batch must preserve existing Realtime behavior for compatibility projects while enabling scoped authenticated and anonymous roles for explicit projects.

## 2. Confirmed Decisions

- Use API token exchange followed by a direct SDK-to-Hasura WebSocket connection.
- Use a dedicated `HASURA_JWT_SECRET` signing boundary, with a temporary `JWT_SECRET` fallback for existing deployments.
- Use `HASURA_PUBLIC_URL` for the externally reachable Hasura origin; same-origin deployments may fall back to `API_BASE_URL`.
- Use a five-minute default token lifetime and refresh approximately 30 seconds before expiry.
- Reconnect active channels automatically with bounded exponential backoff.
- Preserve compatibility Realtime roles:
  - API key uses legacy `anonymous`;
  - Project User uses legacy `user`.
- Explicit projects use the versioned project-scoped authenticated and anonymous roles.
- Existing project activation remains Batch 4. Batch 3B does not add a mode toggle.
- Public Realtime remains limited to the default production schema until environment-scoped API keys/session audiences exist.

## 3. Scope

Batch 3B includes:

- a project-actor-only Realtime token endpoint;
- a pure Realtime execution-context resolver;
- short-lived HS256 Hasura JWT issuance with fixed issuer and audience;
- a dedicated Hasura JWT secret configuration and compatibility fallback;
- token-exchange rate limiting and structured audit logging;
- SDK token acquisition, authenticated `connection_init`, proactive renewal and reconnect;
- optional SDK channel status callbacks;
- Realtime readiness based on the actual runtime roles for the project mode;
- an Admin connection test using in-memory application credentials and a real WebSocket handshake;
- local/prod/release Compose synchronization and a direct Hasura smoke test;
- migration, deployment, rollback and residual-risk documentation.

Batch 3B does not include:

- a Druvia WebSocket proxy;
- database-backed token revocation or a token allowlist;
- guaranteed event delivery during a disconnect;
- public access to non-production environment schemas;
- existing-project activation or legacy permission deletion;
- service-principal or worker Realtime identities;
- RPC, Functions or Storage actor changes;
- a shared/multiplexed WebSocket across multiple SDK channels;
- a claim that all already-open third-party WebSockets are forcibly closed at JWT expiry.

## 4. Why Token Exchange

The existing Project JWT is a Druvia API credential. It may be signed with `PROJECT_AUTH_JWT_SECRET`, while Hasura may intentionally use another verifier. Sending that token directly to Hasura would couple two identity boundaries and would preserve stale role claims until the long-lived Project JWT expires.

The token-exchange model keeps these responsibilities separate:

1. Project JWT/API key authenticates the application actor to Druvia API.
2. Druvia reads the current project mode and derives a server-owned execution context.
3. Druvia issues a narrow, short-lived token for Hasura.
4. Hasura verifies only the short-lived token and enforces the embedded role/session variables.

Hasura's documented JWT contract reads `x-hasura-*` session variables from the `https://hasura.io/jwt/claims` namespace. `HASURA_GRAPHQL_JWT_SECRET` configures its verifier. Batch 3B follows those standard contracts rather than introducing client-selectable role headers.

References:

- `https://hasura.io/learn/graphql/hasura-authentication/jwt-basics/`
- `https://github.com/hasura/graphql-engine/blob/master/docs/docs/deployment/graphql-engine-flags/reference.mdx`

## 5. Configuration And Signing Boundary

Add API configuration:

```text
HASURA_JWT_SECRET
HASURA_REALTIME_TOKEN_TTL_SECONDS=300
HASURA_PUBLIC_URL
```

The effective signing secret is:

```text
HASURA_JWT_SECRET || JWT_SECRET
```

Rules:

- `HASURA_JWT_SECRET` is the normal production configuration.
- The effective key must be at least 32 characters.
- If neither key is valid, token issuance returns `503 REALTIME_TOKEN_UNAVAILABLE`.
- Falling back to `JWT_SECRET` emits one structured warning at API startup or first configuration resolution; it does not log either secret.
- TTL defaults to 300 seconds and is clamped to the inclusive range `60..900`.
- The signing algorithm is fixed to `HS256`; clients cannot select an algorithm.
- The token issuer is `druvia`.
- The token audience is `druvia-hasura`.

Hasura Compose configuration must resolve the same effective key and configure:

```json
{
  "type": "HS256",
  "key": "<effective HASURA_JWT_SECRET or JWT_SECRET>",
  "issuer": "druvia",
  "audience": "druvia-hasura"
}
```

The local, development, production and release Compose files materialize the effective key into both API and Hasura with the same `${HASURA_JWT_SECRET:-${JWT_SECRET}}` fallback expression. Compose configuration tests must prove both explicit-secret and fallback rendering before this syntax is accepted for every supported Compose file. `.env.example`, `.env.prod.example` and `.env.release.example` document the new key; real `.env` files remain untracked.

Before building or publishing images, the GitHub Release workflow installs the frozen pnpm lockfile, runs the focused API/SDK/Admin/Compose Realtime suites, builds the SDK, and runs the actual `docker compose config` renderer for every supported Compose mode. Source-text assertions alone are not the release gate. The real Hasura integration suite remains a required Docker validation-environment result because it depends on a migrated PostgreSQL/Hasura runtime.

`HASURA_PUBLIC_URL` is an externally reachable HTTP(S) origin without credentials, query, fragment, `/api/v1` or `/v1/graphql`. It is distinct from internal `HASURA_ENDPOINT` and from the Storage/API origin in deployments that expose API and Hasura on different local ports. Production/release Compose requires an explicit public origin through `HASURA_PUBLIC_URL` or same-origin `API_BASE_URL`; it must not silently render `localhost:3001`. Local Compose defaults to the host-exposed Hasura port and may be overridden with the local nginx origin. Release-mode local OTA rehearsals persist the `http://localhost:<LOCAL_HTTP_PORT>` override in untracked `.env.release`, because updater-initiated Compose commands cannot depend on the operator's original shell environment. Production keeps the durable origin in `.env.prod`.

`HASURA_GRAPHQL_UNAUTHORIZED_ROLE=anonymous` remains during compatibility migration because old SDKs still open anonymous connections with an empty `connection_init`. Its removal is a later Batch 4 production-gate decision.

## 6. Realtime Actor Resolver

Batch 3B adds a pure Realtime resolver at `apps/api/src/modules/realtime/realtime-actor.ts`. It reuses `resolveDataScopeRole()` for explicit-mode physical roles, accepts only a verified `project_user` or `apikey`, and never accepts platform, service, trusted-backend or unknown identities.

The role matrix is:

| Runtime mode | Actor | Realtime role |
| --- | --- | --- |
| `compatibility` | `project_user` | `user` |
| `compatibility` | `apikey` | `anonymous` |
| `explicit` | `project_user` | scoped authenticated role |
| `explicit` | `apikey` | scoped anonymous role |

This resolver is intentionally distinct from the HTTP resolver. Batch 3A compatibility HTTP maps both application actors to legacy `user`, while the pre-Batch-3B WebSocket path uses `anonymous`. Reusing the HTTP compatibility branch would silently break existing anonymous subscriptions.

Both modes include trusted server-derived session variables:

Project User:

```text
x-hasura-user-id=<Project User sub>
x-hasura-project-id=<Project ID>
x-hasura-actor-type=project_user
```

API key:

```text
x-hasura-project-id=<Project ID>
x-hasura-actor-type=apikey
```

The compatibility Project User path is a new Realtime capability, so providing its stable user identity does not alter an existing supported Project User WebSocket contract. Compatibility API-key permissions continue to be governed by the legacy `anonymous` role.

Unknown runtime-mode values fail closed to `compatibility`. Cross-project actors and unknown identity kinds throw typed resolver errors. Physical scoped roles are generated only through `resolveDataScopeRole()`.

## 7. Short-Lived Token Contract

The token payload is:

```json
{
  "sub": "<project-user-id or apikey:project-id>",
  "jti": "<random operation identifier>",
  "tokenType": "druvia_realtime_access",
  "projectId": "proj_xxx",
  "actorType": "project_user",
  "iat": 0,
  "exp": 0,
  "iss": "druvia",
  "aud": "druvia-hasura",
  "https://hasura.io/jwt/claims": {
    "x-hasura-allowed-roles": ["<server-derived role>"],
    "x-hasura-default-role": "<server-derived role>",
    "x-hasura-project-id": "proj_xxx",
    "x-hasura-actor-type": "project_user",
    "x-hasura-user-id": "project-user-id"
  }
}
```

API-key tokens omit `x-hasura-user-id` and use `actorType=apikey`. `x-hasura-allowed-roles` contains exactly one role, so a client cannot choose another role during connection initialization.

The payload never includes:

- an API key value or hash;
- a Project refresh token;
- platform user details;
- Hasura admin secret;
- the signing secret;
- arbitrary client-provided claims.

## 8. Token Endpoint

Add:

```text
POST /api/v1/projects/:projectId/realtime/token
```

The endpoint accepts no body and no environment selector. It always targets the project's default production schema.

Request flow:

1. Run existing `authenticate`; Bearer remains authoritative over API key.
2. Reject any identity other than `project_user` or `apikey` with `403 PROJECT_ACTOR_REQUIRED`.
3. Reject actor/URL project mismatch with `403 PROJECT_SCOPE_MISMATCH` before project loading.
4. Load the project once and require a default schema.
5. Apply the token-exchange rate limiter.
6. Resolve the Realtime execution context.
7. Sign the short-lived token.
8. Return the public WebSocket URL and expiry metadata.

Success response:

```json
{
  "success": true,
  "data": {
    "token": "<short-lived JWT>",
    "expiresIn": 300,
    "expiresAt": "2026-08-17T12:00:00.000Z",
    "websocketUrl": "wss://example.com/v1/graphql"
  }
}
```

The public WebSocket URL is derived from `HASURA_PUBLIC_URL`. A same-origin deployment may omit it and fall back to deployment `API_BASE_URL`. Both values are externally reachable origins without credentials, query, fragment, `/api/v1` or `/v1/graphql`; neither internal `HASURA_ENDPOINT` nor an API-only local port is a valid production fallback. The API parses and compares the normalized URL to its origin, converts `http/https` to `ws/wss`, and appends `/v1/graphql`. In production, a missing or invalid public origin makes token issuance unavailable instead of returning an internal `hasura:8080` address. Development may fall back to the current local Hasura endpoint under the same URL-shape validation.

The SDK keeps its existing API-root contract, for example `https://example.com/api/v1`, and appends `/projects/:projectId/realtime/token` to that root. Token exchange must use the same normalized request builder as other SDK project endpoints so a deployment origin and an SDK API root cannot be accidentally interchanged.

SDK `realtimeUrl` remains an explicit caller-owned override for custom ingress layouts. It must be an absolute `ws:`/`wss:` URL without credentials, query or fragment; the SDK normalizes the optional `/v1/graphql` suffix once. The short-lived token still comes only from the Druvia endpoint.

Errors use the normal API envelope:

- `403 PROJECT_ACTOR_REQUIRED`;
- `403 PROJECT_SCOPE_MISMATCH`;
- `404 PROJECT_NOT_FOUND`;
- `429 REALTIME_TOKEN_RATE_LIMIT_EXCEEDED`;
- `503 REALTIME_TOKEN_UNAVAILABLE`.

Authentication failures remain the existing `401 UNAUTHORIZED` errors. An invalid or expired Project token never falls back to the API key attached to the same request.

The management config endpoint maps `RealtimeTokenUnavailableError` from the same public-origin resolver to `503 REALTIME_TOKEN_UNAVAILABLE`. It must not collapse deployment misconfiguration into a generic `500` or return an internal Hasura URL. Generated examples remain available because they no longer embed a deployment WebSocket URL.

### 8.1 Rate Limiting

The endpoint uses Redis-backed fixed defaults:

- 30 token requests per actor/IP per minute;
- 300 token requests per project per minute.

Project Users are keyed by `projectId + sub`. API-key callers remain keyed by `projectId + request.ip` until API-key identity includes a stable key identifier. The implementation follows the existing proxy-aware `request.ip` contract and therefore still requires `TRUST_PROXY` behind nginx/ingress.

A `429` response reports `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset`, and `Retry-After` for the bucket that actually rejected the request. A project-total rejection overwrites actor-bucket headers with project limit/TTL values, so clients never receive a positive actor remainder alongside an unexplained rejection.

Redis failure preserves the existing rate-limiter fail-open behavior but emits a structured error. Authentication and project scoping never fail open.

### 8.2 Audit Logging

Successful issuance logs:

- request ID;
- operation/JTI identifier;
- project ID;
- actor type;
- Project User ID when applicable;
- runtime mode;
- expiry timestamp.

Logs never include the JWT, API key, signing secret or Authorization header.

## 9. SDK Architecture

`DruviaClient` creates a Realtime token provider using the same database identity precedence introduced in Batch 3A:

1. use the Project access token when a Project Session exists;
2. otherwise use only the project API key;
3. never use the platform session token;
4. never downgrade an invalid Project token to API-key access.

Project Auth `SIGNED_IN`/refresh and `SIGNED_OUT` events are active identity-boundary changes. `DruviaClient` immediately invalidates and closes every active Realtime socket, clears its snapshot, and reconnects with a newly exchanged token. It does not keep a previous user's socket alive while fetching the replacement. A sign-out may intentionally reconnect through the configured API key as the anonymous actor; an invalid Project token remains present and therefore still cannot downgrade.

The token provider calls:

```text
POST /projects/:projectId/realtime/token
```

against the configured API base URL. The SDK does not persist the returned Hasura token.

Each `RealtimeChannel` continues to own one WebSocket. Shared connection multiplexing is deferred because changing it in the same batch would make token renewal, channel removal and backward compatibility substantially harder to verify.

### 9.1 Channel State

`subscribe()` remains synchronous and may accept an optional callback:

```typescript
type RealtimeChannelStatus =
  | 'CONNECTING'
  | 'SUBSCRIBED'
  | 'RECONNECTING'
  | 'CHANNEL_ERROR'
  | 'CLOSED'

channel.subscribe((status, error?) => {})
```

The return value keeps the existing `unsubscribe()` method.

Connection flow:

1. Set state to `CONNECTING`.
2. Fetch a short-lived token.
3. Open `graphql-transport-ws` using the response URL or explicit `realtimeUrl` override.
4. On open, send:

```json
{
  "type": "connection_init",
  "payload": {
    "headers": {
      "Authorization": "Bearer <short-lived-token>"
    }
  }
}
```

5. Start a 10-second acknowledgment timer after sending `connection_init`.
6. On `connection_ack`, clear that timer, send all configured subscriptions and report `SUBSCRIBED`.
7. If acknowledgment times out, close the socket and treat it as a temporary transport failure.
8. Respond to protocol `ping` with `pong`.
9. Schedule renewal at `expiresAt - 30 seconds`, with a minimum one-second delay.
10. At renewal, fetch a new token, close the old connection, open a replacement and restore subscriptions after acknowledgment.
11. Independently schedule a local expiry guard for the active socket. If renewal has not installed a replacement by the old token's `expiresAt`, close the old socket and continue reconnecting without it.

### 9.2 Reconnect Rules

Unexpected network/transport closure retries while the channel remains subscribed. Delays use capped exponential backoff with up to 20 percent jitter:

```text
1s, 2s, 4s, 8s, 15s, then at most 30s
```

The delay is bounded; retries continue until the caller unsubscribes. A successful `connection_ack` resets the backoff attempt.

Permanent failures stop automatic retries and report `CHANNEL_ERROR`:

- token endpoint `4xx` other than `429`;
- malformed token response;
- Hasura connection-level authorization rejection or subscription operation `error`;
- invalid public WebSocket URL.

`CHANNEL_ERROR` leaves the subscription lifecycle active but retry-halted: no timer may reconnect it, while `unsubscribe()` still closes the lifecycle. A later Project Auth `SIGNED_IN`/refresh/`SIGNED_OUT` identity event may explicitly re-arm an active halted channel with the current credential. This allows a corrected Project Session to recover a prior `401` without silently downgrading the invalid token.

Temporary failures retry:

- network errors;
- token endpoint `429` using `Retry-After` when present;
- token endpoint `5xx`;
- abnormal WebSocket closure without a permanent auth signal.

The implementation uses separate token-request and socket-generation identifiers so callbacks from stale requests or sockets cannot mutate the current channel. Only one token request, reconnect timer, acknowledgment timer, renewal timer and expiry timer may be active per channel. Closure or invalidation of the active socket clears its acknowledgment, renewal and expiry timers before any retry is scheduled. A temporary renewal failure may leave the old socket connected only until its local expiry guard fires. A permanent renewal failure closes it immediately and reports `CHANNEL_ERROR`.

### 9.3 Unsubscribe, Removal And Snapshots

The subscription handle's `unsubscribe()` stops only the current subscription lifecycle. It must:

- mark the current lifecycle inactive before cleanup;
- cancel reconnect, acknowledgment, renewal and expiry timers;
- invalidate pending token requests and socket generations;
- send `complete` for active operation IDs when possible;
- close the WebSocket;
- clear operation IDs and snapshots;
- report `CLOSED` once and clear the lifecycle status callback.

It preserves `.on()` configurations and their data callbacks so an explicit later `channel.subscribe()` starts a fresh lifecycle with a new token and socket, matching the current reusable-channel behavior. Calling `subscribe()` while the channel is already active is rejected instead of leaking or replacing an untracked socket.

`removeChannel()` performs the same active-lifecycle cleanup and then permanently disposes the channel, clears `.on()` configurations/data callbacks, and removes it from `DruviaRealtime`. A disposed channel cannot subscribe again. Neither cleanup path may schedule an automatic reconnect after it returns.

After reconnect, the first subscription result becomes the new snapshot. The SDK does not fabricate INSERT/UPDATE/DELETE events for changes that occurred while disconnected. Batch 3B provides live-state resumption, not durable event replay.

## 10. Realtime Readiness

The current Realtime service checks only legacy `user` and `anonymous` roles and defines readiness from anonymous access. Batch 3B must inspect roles using the project's persisted runtime mode.

For the default production schema:

- compatibility authenticated role is `user`;
- compatibility anonymous role is `anonymous`;
- explicit roles come from `resolveDataScopeRole()`;
- `hasAuthenticatedRead` reports select permission for the active authenticated role;
- `hasAnonymousRead` reports select permission for the active anonymous role;
- `hasSelectPermission` remains a compatibility aggregate and is true when either actor can read;
- `accessStatus=ready` requires `realtime_enabled=true` and at least one active actor with select permission.

The API must load the project and pass `projectId + dataAccessMode` into subscription classification. It does not expose physical role names.

For a selected non-production environment, readiness classification also receives that environment's immutable numeric `environmentId` and derives scoped roles through `resolveDataScopeRole({ projectId, environmentId, actor })`. It must never derive an environment role from mutable environment name or schema name. This reports whether permissions are prepared accurately even though the public connection test remains unavailable.

The Realtime management config uses the same public-origin resolver as token issuance. It must not independently derive a WebSocket endpoint from `API_BASE_URL` or expose internal `HASURA_ENDPOINT` in production. Generated SDK examples do not hard-code `realtimeUrl`; they show a Druvia API root ending in `/api/v1` and let token exchange provide the current WebSocket URL. The explicit override remains documented only for custom ingress layouts.

Non-production environment management remains available, but public runtime is unavailable because sessions/API keys have no environment audience. The Realtime config response adds:

```typescript
runtimeAvailability: 'available' | 'environment_identity_required'
```

Admin shows this limitation for non-production environments and disables the public connection test there. It must not describe a prepared non-production permission as a publicly reachable Realtime endpoint.

## 11. Admin Experience

The table list continues to manage the `realtime_enabled` capability independently from read permissions. It adds separate status indicators for:

- logged-in users;
- anonymous clients.

The existing simulated connection test is removed. The replacement test:

- selects API Key or Project access token using a segmented control;
- keeps the credential and short-lived token only in component memory;
- requests a real short-lived token;
- opens the returned WebSocket;
- sends authenticated `connection_init`;
- reports connecting, connected, failed and disconnected states;
- closes the socket and clears timers/token on dialog/page unmount;
- never reads `api.getToken()` for the Realtime data connection;
- never displays or copies the short-lived token.

Admin uses its existing `graphql-ws` dependency for this browser-only test and does not add a workspace dependency on `@druvia/sdk`. It requests the exchange token through the existing Admin API client, supplies the JWT in `connectionParams.headers.Authorization`, and disposes the client on disconnect or unmount.

The Admin probe uses a 10-second `connectionAckWaitTimeout` and `retryAttempts: 0`; an opened socket without acknowledgment is a failed one-shot test, not an indefinite connecting state or a hidden reconnect loop.

The test verifies authentication and WebSocket acknowledgment. It does not claim event-delivery correctness or require a table with an `id` column.

## 12. Security And Expiry Limitations

The official Hasura material confirms JWT claims and verifier configuration, but it does not provide a sufficiently explicit guarantee that every already-established WebSocket is forcibly closed exactly when `exp` is reached.

Batch 3B therefore guarantees:

- every new connection requires a currently valid short-lived token;
- the official SDK renews before expiry and reconnects with current project mode/permissions;
- captured tokens have a bounded new-connection lifetime;
- a project mode or permission change reaches cooperative SDK clients at the next renewal, no later than approximately one token lifetime.

Batch 3B does not guarantee hard immediate revocation of a malicious custom client that keeps an already-established socket open. That guarantee requires either:

- a Druvia WebSocket proxy that owns connection lifetime; or
- a pinned-Hasura-version integration result proving server-side expiry closure and a release gate preserving that behavior.

This residual risk must remain in durable design decisions and release documentation. A local integration test may observe expiry behavior, but an undocumented observation is not elevated to a product guarantee.

### 12.1 Compatibility Role Isolation

Compatibility roles `user` and `anonymous` are legacy global Hasura role names, not project-unique roles. The token endpoint prevents an actor credential for project A from requesting a project B token, but the compatibility role itself cannot guarantee cross-project schema isolation when another tracked schema still grants the same legacy role. `x-hasura-project-id` improves identity context only where a permission rule actually uses it.

This is preserved compatibility debt, not a new Batch 3B security guarantee. Existing anonymous SDK connections already have the same legacy role visibility. Batch 3B must not describe compatibility mode as project-isolated; Batch 4 must validate and activate project-scoped roles before legacy permissions can be removed. Cross-project denial tests in this batch apply to explicit scoped roles. Compatibility tests prove behavioral preservation only.

## 13. Deployment And Rollback

Deployment order for an independent secret:

1. inventory custom clients that send an existing platform/custom JWT directly to Hasura;
2. add `HASURA_JWT_SECRET` and the public Hasura origin to the durable deployment environment (`.env.prod` for release-mode hosts);
3. render Compose configuration and verify API/Hasura use the same effective key;
4. restart Hasura with issuer/audience verification;
5. deploy the Batch 3B API and SDK/Admin assets;
6. test compatibility API-key anonymous Realtime;
7. test an explicit API-key scoped subscription;
8. test an explicit Project User scoped subscription;
9. verify proactive SDK renewal and reconnect.

This batch has no SQL migration.

The fallback rollout is allowed for existing deployments that have not yet added `HASURA_JWT_SECRET`, but the warning remains visible until operators configure it. A later release may make the dedicated key mandatory only after release/OTA checks prove all supported Compose paths carry it. Secret fallback does not preserve arbitrary old direct-JWT clients: once Hasura requires issuer `druvia` and audience `druvia-hasura`, a JWT missing those claims is rejected even when its signature uses the same key. The release guide must identify this as a compatibility preflight, while noting that empty-payload legacy anonymous SDK connections continue through `HASURA_GRAPHQL_UNAUTHORIZED_ROLE`.

Code rollback leaves `HASURA_JWT_SECRET` configured. Older API/SDK versions ignore it. Hasura may continue using it; empty-payload legacy clients still use `HASURA_GRAPHQL_UNAUTHORIZED_ROLE=anonymous`. If issuer/audience validation prevents an older custom JWT workflow, operators must restore the previous Hasura JWT JSON as part of the rollback. The release guide must record this configuration rollback explicitly.

## 14. Testing

### 14.1 API Unit Tests

- compatibility and explicit role matrix;
- exact Project User/API-key session variables;
- unknown actor and cross-project rejection;
- unknown runtime mode fallback;
- token claims, issuer, audience, algorithm, TTL clamp and JTI;
- API-key token excludes user identity;
- explicit secret and fallback secret selection;
- invalid secret produces unavailable error without logging secret material;
- public WebSocket URL validation;
- public origin and SDK override rejection for credentials, query and fragment;
- dedicated Hasura public origin, same-origin fallback and split-port local URL validation;
- token-rate-limit identifiers and response envelopes.

### 14.2 API Route Tests

- platform identity rejected before project load;
- cross-project actor rejected before project load;
- project loaded once;
- Project bearer remains authoritative over API key;
- token response never exposes role or signing details;
- missing production public URL returns `503`;
- management config public-origin failure also returns typed `503` while generated examples remain available;
- audit log contains IDs/context but no credentials.

### 14.3 SDK Tests

Using fake WebSockets and fake timers:

- token fetched before socket creation;
- exact authenticated `connection_init` payload;
- subscribe operations sent only after `connection_ack`;
- ping/pong behavior;
- proactive renewal timing;
- renewal replaces the socket and restores subscriptions;
- renewal failure cannot keep the old socket past its token expiry;
- stale socket callbacks ignored;
- exponential reconnect and reset after acknowledgment;
- token endpoint `4xx` other than `429` stops retries;
- `429/5xx/network` retries;
- subscription operation `error` stops retries and reports `CHANNEL_ERROR`;
- platform token never used;
- invalid Project token never downgrades;
- Project Auth sign-in/refresh/sign-out immediately invalidates old-user sockets and reconnects with the current actor;
- unsubscribe cancels all work, reports `CLOSED` once and permits only an explicit fresh subscribe;
- remove permanently disposes the channel and blocks later subscribe;
- first post-reconnect payload resets the snapshot without fabricated events.

### 14.4 Admin Tests

- actor-specific readiness labels;
- environment readiness uses immutable environment-scoped roles without implying public availability;
- application credential headers only;
- no platform-token lookup;
- credentials and token remain memory-only;
- real connection-state transitions;
- non-production runtime limitation disables the test.

### 14.5 Compose And Integration Tests

- local/prod/release/dev Compose render the same explicit secret into API and Hasura;
- fallback rendering uses `JWT_SECRET` on both services;
- local split-port and nginx origins render a browser-reachable `HASURA_PUBLIC_URL`;
- production/release configuration rejects a missing public origin instead of defaulting to `localhost:3001`;
- no secret value appears in committed files;
- the release workflow runs focused Realtime tests and Compose rendering before its first image build;
- Hasura accepts a valid token and rejects a modified/expired token on new connection;
- a legacy empty `connection_init` still receives the configured unauthorized `anonymous` role and can access only its retained permission;
- explicit roles can read only metadata-authorized tables;
- cross-project role/token cannot subscribe to another project's scoped table;
- compatibility API-key clients retain legacy `anonymous` access.

## 15. Documentation Updates

Implementation completion updates:

- root, API, SDK and Admin `AGENTS.md` where stable rules changed;
- `docs/agent/design-decisions.md` for the Realtime signing and residual revocation boundary;
- `docs/progress.md` for Batch 3B completion and Batch 4 next step;
- `docs/migration/supabase-compat.md` for SDK Realtime behavior;
- release/OTA documentation for the new secret and rollback JSON;
- environment examples and Compose comments;
- the parent Project Data Access design status.

No `project-memory.md` file is created.

## 16. Acceptance Criteria

- Platform, cross-project and unknown identities cannot obtain a Realtime token.
- Project User and API-key tokens contain only the single server-derived active role.
- Compatibility API keys continue to use `anonymous` Realtime permission.
- Explicit actors use their project-scoped Hasura roles and trusted session variables.
- SDK Realtime never sends a Project JWT, platform JWT or raw API key to Hasura.
- SDK Realtime acquires a short-lived token before every connection and renewal.
- Active SDK channels renew and reconnect without application resubscription.
- Invalid Project Sessions never downgrade to anonymous API-key access.
- Reconnect cannot continue after unsubscribe/remove.
- Realtime readiness reflects actual compatibility/scoped runtime roles.
- Admin connection testing uses an in-memory application credential and a real WebSocket acknowledgment.
- Non-production environments are not represented as publicly Realtime-capable.
- API and Hasura use the same independently configurable effective JWT key in every supported Compose path.
- Returned WebSocket URLs use an externally reachable Hasura origin and do not overload an API-only local origin.
- Generated SDK examples use the token-returned WebSocket URL by default instead of freezing a `realtimeUrl` override.
- Existing deployments can temporarily fall back to `JWT_SECRET` with a visible warning.
- Documentation does not claim hard immediate revocation for already-open third-party WebSockets.
- Documentation does not claim project isolation for legacy compatibility roles; that closure remains a Batch 4 requirement.
- No SQL migration is required for Batch 3B.
