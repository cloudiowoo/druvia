# Project Storage Actor And Object Access Implementation Plan

> **For agentic workers:** Use `superpowers:executing-plans` and `superpowers:test-driven-development` to implement this plan sequentially in the current main checkout. The user has explicitly rejected worktrees and subagent execution for this repository. Track the checklist in this document and do not create a separate design or implementation plan.

**Goal:** Allow a same-project Project User to use Druvia Storage directly through a small set of safe bucket presets and durable object ownership, while keeping platform management, public downloads, trusted tickets, and Function internal Storage as separate authorization paths.

**Architecture:** Migration `020` adds a conservative bucket access preset and a queryable Project User owner to Storage objects. Protected object routes resolve the existing `ProjectActorContext`, then an actor-aware Storage access service enforces policy before calling the lower-level Storage repository/adapter service. SDK direct Storage uses Project Session/API Key application credentials, while ticket operations use a raw fetch path with only their explicit credential.

**Tech Stack:** PostgreSQL 17 migrations, Fastify 5, Node.js 22, TypeScript, Local/R2 Storage adapters, React 19, Next.js 16, `@druvia/sdk`, Vitest, Docker Compose release workflow.

**Status:** Implemented and directly reviewed; focused verification complete; real Release/Registry/OTA execution remains deferred

---

## 1. Scope

This slice completes the direct Storage part of the Project Actor cutover. It covers:

- a safe, versioned database representation for bucket Project User access;
- durable object ownership that can be filtered and indexed without trusting mutable JSON metadata;
- actor-aware list, upload, download, delete, and signed URL behavior;
- unchanged Platform User management access;
- explicit rejection of API Key actors on protected Storage object routes;
- independent public-download, trusted-ticket, and Function-helper capabilities;
- SDK Storage credential selection that matches Database/RPC/Functions;
- a simplified Admin control for bucket access presets;
- migration, release manifest, documentation, and regression gates.

This slice does not add:

- custom JSON policy expressions;
- per-operation policy matrices;
- team, role, group, or collaborator ownership;
- a general end-user or Admin object-ownership transfer API;
- API Key upload or protected-object access;
- presigned direct-to-R2 upload, multipart upload, quotas, or image transformations;
- automatic re-key/copy of existing Local/R2 object bytes; legacy rows keep their current physical key and require operator reconciliation if an audit finds an existing filesystem alias;
- a Taro/WeChat-specific binary transport adapter; runtimes without standards-compatible `FormData`, `Blob`, Fetch multipart, and `Response.blob()` support continue to use the existing Edge Function path or their runtime-native upload/download API;
- content-signature/MIME sniffing; MIME allowlists continue to validate the declared multipart type;
- PostgreSQL RLS or Supabase Storage policy emulation;
- a real GitHub Release, dual-Registry publish, or OTA rehearsal.

## 2. Confirmed Decisions

1. Bucket management remains Platform User only.
2. Protected object routes accept a Platform User with project access or a same-project Project User.
3. API Key actors are rejected by protected Storage routes. Anonymous reads use the existing public bucket URL only.
4. Bucket Project User access has exactly three presets:
   - `admin_only`
   - `owner_only`
   - `authenticated_read`
5. The existing `public` flag remains independent and controls only unauthenticated public download.
6. Existing buckets migrate to `admin_only`; the migration never widens access.
7. Project User ownership is persisted in a dedicated `owner_project_user_id` column. Runtime authorization never depends on `metadata`.
8. Existing trusted platform metadata may be used once during migration to backfill ownership.
9. Project User writes claim ownership for new objects and may overwrite/delete only objects already owned by the same Project User.
10. A Platform User overwrite preserves an existing Project User owner.
11. Objects without a Project User owner remain manageable by Platform Users. Under `authenticated_read`, Project Users may read them but cannot overwrite/delete them.
12. Inaccessible objects return `404`, preventing object-existence disclosure.
13. Trusted Storage tickets and Function internal Storage remain independent trusted capabilities and do not inherit direct bucket presets.
14. Direct object authorization is enforced in the service layer. Controller-only prechecks are not sufficient.
15. Object list filtering occurs in SQL before pagination/counting.
16. Conflicting writes to the same bucket/path are serialized before ownership checks.
17. SDK direct Storage never falls back to Platform Session.
18. Ticket issue/consume calls do not carry Project or Platform bearer tokens implicitly.
19. The next unreleased migration range is `18 -> 20`, because migrations `018`, `019`, and `020` belong to the same pending release baseline.
20. Migration `020` remains SQL-compatible with ordinary canonical paths written by the old API but is marked non-reversible for OTA because dropping it loses policy/ownership state. Malformed legacy paths are intentionally rejected by the new database constraint and do not retain the old error shape.
21. Every new request path is converted to one canonical logical object name before lock lookup and database lookup. Local filesystem aliases such as `a/b`, `a//b`, and `a/./b` must never address one physical file through different authorization records.
22. Opening object routes to Project Users also requires bounded pagination, signed URL TTL, upload size, and MIME allowlist inputs. Existing Platform-only permissiveness is not carried into the application API.
23. Untrusted public objects are inline only for a small safe-image MIME allowlist. Other types are attachments, object responses use `nosniff`, and mutable public URLs do not advertise a one-year immutable cache.
24. This slice establishes authorization safety, not tenant Storage quotas. Direct access is opt-in per bucket; operators must not interpret these presets as capacity or abuse controls.
25. A new object's physical provider key is derived from its immutable `objectId`, not its user-controlled logical name. An overwrite reuses a non-empty existing `storage_path`; a legacy null key is repaired from the existing `objectId`.
26. The migration CLI's session advisory lock, version-table reads, migration transactions, and unlock must use one checked-out PostgreSQL client for the entire command. A pool-level lock call is not a valid concurrency guarantee.
27. Bucket preset/public changes govern subsequent API authorization but do not revoke an already issued private signed URL. Private URLs expire within the fixed 24-hour maximum; disabling public access is enforced on the next API request, subject to the documented five-minute client/cache lifetime.
28. Object mutations lock the bucket row before the logical object advisory key; bucket update/delete takes the bucket row lock only. Any operation that needs both locks must follow this fixed order. This prevents `ON DELETE CASCADE` from removing a concurrently inserted object row while leaving provider bytes orphaned.

## 3. Data Model

### 3.1 Bucket access preset

Migration `020_storage_project_user_access.up.sql` adds:

```sql
ALTER TABLE druvia_storage_buckets
  ADD COLUMN project_user_access VARCHAR(32) NOT NULL DEFAULT 'admin_only';

ALTER TABLE druvia_storage_buckets
  ADD CONSTRAINT druvia_storage_buckets_project_user_access_check
  CHECK (project_user_access IN ('admin_only', 'owner_only', 'authenticated_read'));
```

The application type is:

```ts
export type ProjectUserStorageAccess =
  | 'admin_only'
  | 'owner_only'
  | 'authenticated_read';
```

`CreateBucketInput.projectUserAccess` is optional and defaults to `admin_only`. `UpdateBucketInput.projectUserAccess` is optional but, when supplied, must match the union exactly. The database constraint is the final integrity boundary.

### 3.2 Object owner

Migration `020` also adds:

```sql
ALTER TABLE druvia_storage_objects
  ADD COLUMN owner_project_user_id TEXT;

CREATE INDEX idx_storage_objects_bucket_owner_name
  ON druvia_storage_objects(bucket_id, owner_project_user_id, name varchar_pattern_ops);
```

`varchar_pattern_ops` is intentional because owner-filtered list queries combine equality predicates with literal prefix `LIKE`; the default locale-aware btree is not a reliable prefix-scan index outside `C` collation.

Before adding the path constraint, migration `020` checks existing names for Local-adapter aliases: leading/trailing slash, duplicate slash, backslash, exact `.`/`..` segments, control characters, or non-NFC Unicode. If any exist, the migration raises a named exception with the invalid-row count and stops without changing schema. It must not silently strand objects that the new API would reject. The release guide provides a read-only inspection query so an operator can rename/delete those objects and reconcile physical keys before retrying.

After the preflight, add a database check that rejects the same SQL-detectable aliases for every writer, including direct SQL and older API code:

```sql
ALTER TABLE druvia_storage_objects
  ADD CONSTRAINT druvia_storage_objects_name_canonical_check
  CHECK (
    name <> ''
    AND left(name, 1) <> '/'
    AND right(name, 1) <> '/'
    AND position('//' in name) = 0
    AND position(E'\\' in name) = 0
    AND name !~ '(^|/)[.]{1,2}(/|$)'
    AND name !~ '[[:cntrl:]]'
    AND name = normalize(name, NFC)
  );
```

The implementation must verify the exact PostgreSQL escaping and `normalize(name, NFC)` syntax against PostgreSQL 17 in the real migration test instead of trusting the rendered example alone. The project is fixed to PostgreSQL 17, where this NFC expression has been verified; application normalization and the database check are intentionally redundant.

No foreign key is added because Project User records live in each project schema and `users.id` may be UUID or text. Bucket membership already fixes the project boundary.

The one-time backfill accepts only non-empty string values written by existing Druvia server paths:

```sql
UPDATE druvia_storage_objects
SET owner_project_user_id = metadata ->> 'created_by_project_user_id'
WHERE owner_project_user_id IS NULL
  AND metadata ->> 'created_by_type' IN ('project_user', 'trusted_backend_project_user')
  AND jsonb_typeof(metadata -> 'created_by_project_user_id') = 'string'
  AND btrim(metadata ->> 'created_by_project_user_id') <> '';
```

After migration, `metadata.created_by_project_user_id` remains audit context only. Changing metadata cannot change authorization.

### 3.3 Down migration

`020_storage_project_user_access.down.sql` drops the owner index, object-name check, owner column, bucket-access check, and bucket access column in dependency order. It is for controlled development reset only. Release/OTA image rollback keeps migration `020` applied because old API SQL ignores both new columns and ordinary canonical paths remain valid. The old sanitizer is less strict, so malformed writes may now fail at the database boundary with a legacy generic error; rollback validation covers normal CRUD and explicitly does not promise the old malformed-path error shape.

## 4. Authorization Matrix

### 4.1 Protected routes

| Actor | `admin_only` | `owner_only` | `authenticated_read` |
| --- | --- | --- | --- |
| Platform User with project access | all bucket/object management | all bucket/object management | all bucket/object management |
| Project User, list | `403` | owned objects only | all objects |
| Project User, upload new path | `403` | allowed, becomes owner | allowed, becomes owner |
| Project User, overwrite own path | `403` | allowed | allowed |
| Project User, overwrite other/unowned path | `403` | `404` | `409` |
| Project User, download own path | `403` | allowed | allowed |
| Project User, download other/unowned path | `403` | `404` | allowed |
| Project User, signed URL for own path | `403` | allowed | allowed |
| Project User, signed URL for other/unowned path | `403` | `404` | allowed |
| Project User, delete own path | `403` | allowed | allowed |
| Project User, delete other/unowned path | `403` | `404` | `404` |
| API Key | `403 PROJECT_ACTOR_REQUIRED` | same | same |

For overwrite, the API returns `409 OBJECT_OWNERSHIP_CONFLICT` when the caller addresses a visible path that cannot be claimed. Under `owner_only`, another user's object is not visible and the route returns `404 OBJECT_NOT_FOUND`. Tests must preserve this distinction without leaking the owner ID.

### 4.2 Public downloads

`GET /api/v1/storage/public/:projectId/:bucketName/*` remains unauthenticated and depends only on `bucket.public`:

- `public=false`: `403 BUCKET_NOT_PUBLIC`;
- `public=true`: any existing object can be downloaded;
- the access preset does not narrow public downloads;
- list, upload, delete, and signed URL creation never become public through this flag.

The Admin UI must make this independence visible through separate controls. It must not imply that `owner_only + public=true` makes downloads owner-private.

### 4.3 Trusted capabilities

These paths remain outside direct preset checks:

- `POST /storage/upload-with-ticket`
- `POST /storage/remove-with-ticket`
- `/api/internal/functions/storage/upload`
- `/api/internal/functions/storage/remove`

Their existing signed ticket/internal token is the authorization boundary. Ownership effects are explicit:

- trusted ticket upload records `ticket.projectUserId` as owner;
- Function upload invoked by a Project User records that Project User as owner;
- Platform User/API Key Function uploads remain unowned unless a future capability design says otherwise;
- trusted capability overwrite may reattribute the object to its explicit on-behalf-of Project User context; this preserves the already trusted capability and is not exposed as a general ownership-transfer API;
- no generic `bypassAuthorization: true` option is introduced.

## 5. Actor And Service Boundaries

### 5.1 Canonical paths

Create `apps/api/src/modules/storage/storage-path.ts` as the only request-path normalizer. The resulting canonical logical object name is used for authorization, advisory locks, database keys, and display. It is not used directly as the physical provider key for new objects.

Canonicalization rules:

- convert backslashes to `/` for compatibility, then normalize Unicode to NFC;
- remove leading `/` characters;
- reject empty results, NUL/control characters, more than 1024 characters, empty segments, and exact `.` or `..` segments;
- reject duplicate or trailing `/` instead of silently mapping aliases;
- allow ordinary dot-prefixed names such as `.keep`;
- never decode percent escapes manually; Fastify/query parsing performs URL decoding once;
- return the canonical string or a typed `INVALID_OBJECT_PATH` error.

`normalizeObjectPrefix()` applies the same segment rules but permits an empty prefix and one trailing `/`. SQL escapes literal `%`, `_`, and `\` before using `LIKE ... ESCAPE '\\'`, so a user-supplied prefix cannot act as a wildcard.

Trusted upload ticket issuance wraps this helper with its existing stricter contract: the prefix must be non-empty and is stored with exactly one trailing `/`. Consumption compares against that canonical trailing-slash prefix, so `users/a/` cannot authorize `users/ab/file`.

The shared contract is `encodeURIComponent(segment)` while preserving `/` separators. `storage-path.ts` exports the API implementation; SDK Storage and Admin keep tiny local helpers because the public SDK does not depend on the private `@druvia/shared` package. All three use one common fixture table in tests. Every API public URL builder, Local signed URL builder, SDK direct/public URL builder, and Admin object link follows this contract; no producer interpolates a raw logical name or provider key into a path. Upload query parameters continue to use `URLSearchParams`/`encodeURIComponent` on the complete canonical path. Tests cover spaces, Unicode, `#`, `?`, `%`, backslashes, duplicate separators, dot segments, and encoded traversal attempts, including round trips through Fastify wildcard parameters.

### 5.2 Actor resolution

Protected object controllers use the canonical `ProjectActorContext`:

```ts
type StorageRouteActor = Extract<
  ProjectActorContext,
  { actorType: 'platform_user' | 'project_user' }
>;
```

Resolution rules:

- Platform User: call `checkProjectAccess(user.userId, projectId)`, then `resolvePlatformProjectActor()`;
- Project User: call `resolveScopedProjectActor()` and require `actorType === 'project_user'`;
- API Key: map to `PROJECT_ACTOR_REQUIRED`;
- same credential against another project: map to `PROJECT_SCOPE_MISMATCH`;
- missing/invalid credential remains the existing middleware `401` behavior;
- an invalid Bearer token never falls back to the API Key header.

Bucket CRUD controllers keep a narrower management resolver and never accept Project User/API Key actors.

### 5.3 Access service

Create `apps/api/src/modules/storage/storage-access.service.ts`. It owns policy decisions and actor-aware protected object operations. Its public surface is intentionally small:

```ts
export class StorageAccessError extends Error {
  constructor(
    public code: StorageAccessErrorCode,
    message: string,
    public statusCode: number
  ) { /* standard Error setup */ }
}

export async function listObjectsForActor(
  actor: StorageRouteActor,
  bucket: Bucket,
  options: ListObjectsOptions
): Promise<{ objects: StorageObject[]; total: number }>;

export async function uploadObjectForActor(
  actor: StorageRouteActor,
  bucket: Bucket,
  name: string,
  file: Buffer,
  mimeType: string
): Promise<StorageObject>;

export async function getObjectForActor(
  actor: StorageRouteActor,
  bucket: Bucket,
  name: string
): Promise<StorageObject>;

export async function deleteObjectForActor(
  actor: StorageRouteActor,
  bucket: Bucket,
  name: string
): Promise<boolean>;
```

The service never accepts raw `RequestUser`, inbound role headers, a full token, or an API Key secret. It logs only `toProjectActorAuditContext(actor)`, bucket, object path, operation, and result.

### 5.4 Repository and adapter service

`storage.service.ts` remains responsible for:

- bucket/object persistence;
- Local/R2 adapter calls;
- file-size and MIME validation;
- signed/public URL creation;
- trusted-capability primitives.

Extend repository methods with explicit owner filters rather than post-filtering:

```ts
export interface ListObjectsOptions {
  prefix?: string;
  limit?: number;
  offset?: number;
  ownerProjectUserId?: string;
}
```

`ObjectRow` and `StorageObject` gain `ownerProjectUserId: string | null`. `BucketRow` and `Bucket` gain `projectUserAccess`.

For a new object, generate `objectId` before adapter upload and derive an opaque provider key such as `${projectId}/${bucketId}/objects/${objectId}`. The key contains only server-generated identifiers. Under the same-path lock, first read the current row: an overwrite reuses its non-empty existing `storagePath` and `objectId`; only a missing logical path receives a new ID/key. A legacy row with a null `storagePath` keeps its `objectId` but derives the same opaque key pattern as a repair upload. This prevents future logical-name collisions on case-insensitive or Unicode-normalizing Local filesystems without moving existing Local/R2 data. Listing, authorization, and URLs continue to use the logical `name`; deletion/download/signed URL operations use the stored physical key.

Legacy physical keys remain a deployment precondition. Production Local Storage must use a case-sensitive filesystem. Before migration, the release guide audits duplicate exact `storage_path` values and case-folded collisions for Local deployments; a case-insensitive target with legacy collisions must reconcile/re-key those objects before enabling Project User access. R2 and case-sensitive Local keys retain their existing semantics. This slice does not claim automatic legacy byte migration.

Every object mutation path, including Platform management, direct Project User, trusted ticket, and Function upload/delete, starts a transaction, re-reads and locks its bucket row `FOR SHARE`, then obtains a transaction-scoped advisory lock for the logical object. Build an unambiguous PostgreSQL-safe text key as `${bucketId.length}:${bucketId}${normalizedPath}` and call `pg_advisory_xact_lock(hashtextextended($1, 0))`; do not use a NUL separator because PostgreSQL `text` rejects NUL bytes. A hash collision may serialize unrelated paths but cannot bypass authorization. The service reads the current object row after both locks, evaluates the current bucket policy or trusted capability, then performs the persistence path. The bucket lock, advisory lock, ownership read, object-row mutation, and commit/rollback must use one checked-out PostgreSQL client. Code inside this transaction must not call `query()`, `queryOne()`, `getObject()`, or another helper that silently checks out a different pooled connection. Shared mutation locking prevents a management/trusted delete or overwrite from racing a direct Project User ownership decision on the same path.

Bucket update/delete uses the same repository boundary. Update obtains the row lock needed by PostgreSQL for the mutation. Delete explicitly selects the bucket `FOR UPDATE`, checks object count, and deletes in that same transaction. Because every new object mutation first takes `FOR SHARE`, deletion cannot pass an empty check and then cascade a concurrently inserted row. The global lock order is always bucket row before object advisory lock; no code may acquire them in reverse order.

Platform overwrite preserves the existing owner. Project User new upload sets the owner; own overwrite keeps it. Trusted on-behalf-of upload may explicitly set/replace it. The owner update is part of the same SQL statement as object metadata persistence.

PostgreSQL and Local/R2 object bytes cannot participate in one distributed transaction. This slice guarantees serializable authorization/ownership decisions, not byte-level distributed rollback. On a failed new-object insert, delete only the newly generated opaque key. On a failed overwrite persistence, do not delete the reused existing key; emit a sanitized reconciliation-required error because deleting it would turn a metadata rollback into definite object loss. The same limitation applies if physical deletion succeeds and the later database commit fails. Tests must assert authorization and owner integrity without claiming impossible cross-system atomicity.

### 5.5 Response DTO

Create `apps/api/src/modules/storage/storage-response.ts` as a pure mapper used by protected controllers, trusted ticket consumption, and Function internal Storage. It returns this safe DTO:

```ts
interface StorageObjectResponse {
  objectId: string;
  bucketId: string;
  name: string;
  size: number;
  mimeType: string | null;
  createdAt: string;
  updatedAt: string;
}
```

Dates are serialized explicitly with `toISOString()`. Do not return `storagePath`, provider internals, raw metadata, platform `createdBy`, or another Project User's owner ID. Existing Admin and SDK consumers already use only this safe subset. The same mapper is mandatory for direct protected responses, `upload-with-ticket`, and Function internal Storage helper responses because all three results can reach application code; trusted authorization does not make provider metadata part of the public response contract.

## 6. HTTP Contract

### 6.1 Bucket routes

The URLs remain unchanged:

- `GET /projects/:projectId/storage/buckets`
- `POST /projects/:projectId/storage/buckets`
- `GET /projects/:projectId/storage/buckets/:bucketName`
- `PATCH /projects/:projectId/storage/buckets/:bucketName`
- `DELETE /projects/:projectId/storage/buckets/:bucketName`

Create/update accepts `projectUserAccess`. Bucket responses expose it to Platform User management clients.

Validation rejects unknown presets with:

```json
{
  "success": false,
  "error": {
    "code": "INVALID_STORAGE_ACCESS",
    "message": "Invalid project user storage access preset"
  }
}
```

Bucket field validation is identical for create and update, but PATCH validates only fields actually present in the request:

- `fileSizeLimit` is `null` or a positive safe integer no larger than the global multipart limit, currently `50 * 1024 * 1024` bytes;
- `allowedMimeTypes` is `null` or a deduplicated array of at most 100 lowercase `type/subtype` values, each at most 255 characters;
- each MIME value must match the conservative ASCII token form `^[a-z0-9][a-z0-9!#$&^_.+-]*/[a-z0-9][a-z0-9!#$&^_.+-]*$`; parameters, whitespace, controls, and empty type/subtype tokens are rejected;
- wildcard MIME entries are rejected because the current enforcement uses exact matching;
- empty UI values normalize to `null`, not `0` or an empty allowlist;
- invalid values return `400 INVALID_STORAGE_LIMIT`, not a database or multipart exception.

This aligns the bucket promise with Fastify's existing 50 MB hard upload limit. A future increase must update both limits and their contract test together.

Every upload entry point, including direct, trusted ticket, and Function internal Storage, lowercases and validates its declared MIME with the same token rule before bucket/ticket allowlist comparison or persistence. Invalid declared MIME returns `415 INVALID_MIME_TYPE`; a missing multipart MIME may normalize to `application/octet-stream`, but malformed input is never copied into a response header.

### 6.2 Object routes

The URLs and documented application-facing core fields remain compatible. Full repository objects were previously serialized accidentally; this slice intentionally removes undocumented provider/audit fields from direct, ticket, and Function responses, and the migration guide calls out that hardening change:

- `GET .../objects`
- `POST .../objects?path=...`
- `GET .../objects/*`
- `DELETE .../objects/*`
- `POST .../signed-url`

Every object path is normalized once through `storage-path.ts` before policy lookup. Bucket name/project lookup precedes object policy, but error responses never expose internal IDs.

Application-facing query/body limits are fixed:

- object list `limit`: integer `1..100`, default `50`;
- object list `offset`: integer `0..1_000_000`, default `0`;
- object list `prefix`: canonical prefix, at most 1024 characters;
- signed URL `expiresIn`: integer `1..86400`, default `3600` seconds;
- multipart upload: global 50 MB limit plus the equal-or-smaller bucket limit;
- malformed or out-of-range values return `400 INVALID_STORAGE_REQUEST`, except oversized multipart content which remains `413`.

These checks also run in service functions used outside HTTP so a direct caller cannot bypass resource bounds.

### 6.3 Object delivery safety

Project User uploads are untrusted content. All API-served object responses set `X-Content-Type-Options: nosniff` and `Content-Security-Policy: sandbox; default-src 'none'`. Only `image/jpeg`, `image/png`, `image/gif`, `image/webp`, and `image/avif` may use `Content-Disposition: inline`; SVG, HTML, JavaScript, XML, PDF, text, and unknown content are attachments. Private R2 signed URL generation forces attachment disposition.

Delivery behavior is:

- protected direct download: attachment, `Cache-Control: private, no-store`;
- signed Local download: attachment, with the logical filename and declared MIME carried in signed response options;
- public bucket download: safe image may be inline, otherwise attachment;
- mutable public object URL: `Cache-Control: public, max-age=300, must-revalidate`, not the current one-year cache;
- filename parameters are escaped and never copied as raw response-header syntax.

Declared MIME allowlists are not byte-signature validation. `nosniff`, safe inline selection, and attachment fallback are therefore required even when a bucket has a MIME allowlist.

Extend the adapter contract with a narrow signed-download option containing sanitized `downloadName`, declared `contentType`, and forced `disposition: 'attachment'`. R2 maps it to `ResponseContentDisposition`/`ResponseContentType`. Local includes the canonical option values in the HMAC input and URL query, then `downloadSignedUrl` validates the signature before applying them through `storage-delivery.ts`; unsigned response overrides are never accepted. The verifier checks expiry syntax and exact lowercase SHA-256 hex length before `timingSafeEqual`, so malformed anonymous input returns `403` instead of throwing a length-mismatch `500`. It continues to accept the current path-and-expiry signature only when all new option fields are absent so already-issued Local URLs remain valid until expiry, and that legacy branch always responds as a generic attachment.

Changing `projectUserAccess` does not revoke these already-issued private URLs. Tests use the maximum `expiresIn` boundary to prove they fail after expiry and document that immediate revocation would require a future denylist/key-rotation design. Turning off `public` is checked on each API public-download request, while the five-minute cache policy bounds but cannot eliminate already cached responses.

### 6.4 Error mapping

| Code | Status | Meaning |
| --- | --- | --- |
| `PROJECT_ACTOR_REQUIRED` | 403 | API Key or unsupported identity used a protected object route |
| `PROJECT_SCOPE_MISMATCH` | 403 | Project credential belongs to another project |
| `STORAGE_ACCESS_DISABLED` | 403 | Bucket is `admin_only` for a Project User |
| `OBJECT_NOT_FOUND` | 404 | Object missing or not visible to caller |
| `OBJECT_OWNERSHIP_CONFLICT` | 409 | Visible existing path cannot be overwritten by caller |
| `INVALID_STORAGE_ACCESS` | 400 | Bucket preset is invalid |
| `INVALID_OBJECT_PATH` | 400 | Object path/prefix is non-canonical or unsafe |
| `INVALID_STORAGE_REQUEST` | 400 | Pagination or signed URL TTL is invalid |
| `INVALID_STORAGE_LIMIT` | 400 | Bucket size/MIME restriction is invalid |
| `FILE_TOO_LARGE` | 413 | Existing bucket size limit failed |
| `INVALID_MIME_TYPE` | 415 | Declared MIME is malformed or an existing bucket/ticket allowlist failed |

No response contains owner IDs, actor subjects, storage paths, SQL errors, or policy implementation details.

## 7. SDK Contract

### 7.1 Fetch separation

`DruviaClient` constructs Storage with two fetch paths:

```ts
this.storage = new DruviaStorage(
  apiBase,
  options.projectId,
  this.applicationFetch,
  rawFetch
);
```

- `BucketClient.upload/list/remove/download/createSignedUrl` uses `applicationFetch`.
- `issueUploadTicket`, `issueRemoveTicket`, `uploadWithTicket`, and `removeWithTicket` use `rawFetch` because each supplies its own trusted key/ticket header.
- `getPublicUrl` remains synchronous and does not fetch.

Application credential selection remains:

1. current Project Session token as Bearer, plus project API Key;
2. when no Project Session exists, project API Key only;
3. never Platform Session;
4. invalid/expired Project Session returns the API `401` and is not retried as API Key.

All object paths used in URL path segments are encoded segment-by-segment. This preserves folders while preventing spaces, Unicode, `#`, `?`, and `%` from changing URL parsing.

This credential cutover does not create a cross-runtime binary transport abstraction. Direct SDK upload and `uploadWithTicket` require standards-compatible `FormData`, `Blob`, and Fetch multipart behavior; direct SDK download also requires `Response.blob()`. Browser and supported Node.js runtimes are in scope. Taro/WeChat mini-programs without those primitives must continue through the existing Edge Function upload flow or integrate the HTTP endpoints with runtime-native APIs such as `Taro.uploadFile`/`Taro.downloadFile`; `customFetch` alone does not prove binary compatibility. JSON-only methods such as list/remove/create-signed-URL remain usable when the custom Fetch implementation satisfies their response contract. Compatibility documentation must keep this limitation explicit until a dedicated SDK binary adapter is designed.

### 7.2 Compatibility

The following APIs keep their signatures:

```ts
druvia.storage.from(bucket).upload(path, file, options)
druvia.storage.from(bucket).list(options)
druvia.storage.from(bucket).download(path)
druvia.storage.from(bucket).remove(path)
druvia.storage.from(bucket).getPublicUrl(path)
druvia.storage.from(bucket).createSignedUrl(path, expiresIn)
```

The SDK must adapt the real API DTO instead of trusting its current test-only mock shape:

- upload API returns `StorageObjectResponse`; SDK returns `{ path: response.name }` as its declared public shape;
- `createSignedUrl(path, expiresIn)` maps its public `path` argument to the API request field `{ objectPath, expiresIn }`; it does not send the currently incompatible `{ path, expiresIn }` body;
- signed URL API returns `{ url, expiresIn }`; SDK returns `{ signedUrl: url }` as its declared public shape;
- if either required source field is absent, return `INVALID_STORAGE_RESPONSE` instead of a successful object with `undefined` fields;
- tests invoke the adapter against fixtures matching the real controller contract, not `{ path }` or `{ signedUrl }` fixtures invented only for SDK tests.

The behavioral change is intentional: direct protected Storage now represents the application Project User, not the logged-in Druvia administrator. Server-side Platform management continues through Admin/API management clients, not `@druvia/sdk` application Storage.

## 8. Admin Experience

### 8.1 Bucket creation

The existing create dialog adds:

- a Select labeled `项目用户访问`;
- options `仅管理端`, `仅自己的文件`, and `登录可读，个人可写`;
- default `仅管理端`;
- the existing public switch remains separate;
- optional file-size and MIME allowlist fields use existing Input controls.

The size field is explicitly labeled in bytes and constrained to 50 MB. MIME values are normalized to lowercase exact `type/subtype` entries before submit. The form does not imply content-signature inspection or Storage quota enforcement.

Do not add implementation-oriented Hasura/actor explanations. Labels describe business effects only.

### 8.2 Bucket settings

Create `apps/admin/src/components/storage/BucketAccessSettingsDialog.tsx` so the already large page does not absorb another full settings form. It receives a bucket, open state, and save callback, and edits:

- Project User access preset;
- public download switch;
- file size limit;
- comma/newline-normalized MIME allowlist.

Use existing Dialog, Select, Switch, Input, Label, Button, and toast patterns. Save is disabled while unchanged or submitting. Server errors remain visible in a destructive toast and the dialog stays open.

The save payload contains only dirty fields. Changing the access preset must not resend an untouched historical size/MIME value, and editing MIME/size must not overwrite a concurrently refreshed public/access setting. Existing non-canonical legacy restrictions remain visible and must be corrected before that specific field can be submitted.

### 8.3 Status display

Bucket rows show compact badges:

- `仅管理端`
- `用户私有`
- `登录可读`
- optional separate `公开下载`

The bucket menu adds a settings action with the Lucide `Settings` icon. Badge and button dimensions must remain stable on mobile and desktop.

## 9. Migration And Release

### 9.1 Deployment order

All environments use the standard migration runner:

```bash
node apps/api/dist/cli/migrate.js up
```

Before relying on this command for migration `020`, fix `apps/api/src/cli/migrate.ts` so it checks out one client, acquires `pg_try_advisory_lock` on that client, performs version reads and every migration transaction on it, unlocks in `finally`, then releases the client. The current pool-level acquire/release calls can run on different sessions. Migration failures must throw back to the top-level exit-code handler instead of calling `process.exit()` before cleanup. A two-process integration test must prove the second runner exits without applying anything while the first holds the lock, and a later runner succeeds after release, including after a failed migration transaction.

Required order:

1. take database backup for release/OTA;
2. run migrations through `020` using the new API image;
3. start new API/Admin services;
4. run health and Storage actor probes.

New API code may assume both columns exist. Local source development therefore also requires applying migration `020` before testing the new routes.

The legacy-name/NFC validation and index creation scan `druvia_storage_objects` and can hold table locks. The release guide requires checking object count, Local filesystem case sensitivity/legacy physical-key collisions, and migration duration on a production-sized copy; large installations schedule this step in a Storage write maintenance window instead of assuming a zero-downtime migration.

### 9.2 Release manifest

Update `.github/workflows/release.yml` defaults and both manifest generation environments:

```text
migration_required=true
migration_from=18
migration_to=20
migration_requires_backup=true
migration_reversible=false
```

Add a `Verify Project Storage actor and object access` step before image builds. Update `tests/unit/release-pipeline.test.ts` so tag pushes and workflow dispatch generate identical GHCR/self-hosted manifests.

### 9.3 Rollback

Old API SQL ignores the new columns, so image/Compose rollback does not require a down migration for ordinary canonical object operations. Automatic rollback must continue warning that the database migration remains applied and that malformed paths rejected by the new constraint may surface through the old API as generic failures. A write made by the old API during rollback can replace an opaque provider key with its legacy logical-name key and leave the old bytes orphaned; rollback probes therefore cover reads and ordinary CRUD, while operators must reconcile Storage bytes after any rolled-back write window. A database restore is required only if the operator intends to remove migration `020` and lose policy/ownership state.

Real Registry publishing and OTA rollback remain deferred until the next scheduled release window.

## 10. File Map

### Create

- `migrations/020_storage_project_user_access.up.sql`
  - legacy-name preflight, canonical-name constraint, bucket preset, object owner, backfill, and index.
- `migrations/020_storage_project_user_access.down.sql`
  - controlled development rollback.
- `apps/api/src/modules/storage/storage-access.service.ts`
  - actor-aware direct Storage policy and errors.
- `apps/api/src/modules/storage/storage-path.ts`
  - canonical object path/prefix validation and SQL prefix escaping.
- `apps/api/src/modules/storage/storage-delivery.ts`
  - pure safe content-disposition, CSP, cache, and filename header policy.
- `apps/api/src/modules/storage/storage-response.ts`
  - one application-facing object DTO mapper for direct, ticket, and Function responses.
- `apps/api/src/cli/migration-sql.ts`
  - strips only a complete outer transaction wrapper before runner-owned transactions.
- `apps/admin/src/components/storage/BucketAccessSettingsDialog.tsx`
  - simplified bucket settings dialog.
- `tests/unit/storage-project-access-schema.test.ts`
  - migration source contract.
- `tests/unit/storage-access.service.test.ts`
  - pure/service authorization matrix.
- `tests/unit/storage-path.test.ts`
  - canonical path aliases, Unicode, URL-sensitive characters, and prefix escaping.
- `tests/fixtures/storage-path-cases.ts`
  - shared API/SDK/Admin logical-path encoding vectors without production package coupling.
- `tests/unit/storage-delivery.test.ts`
  - untrusted inline allowlist and cache/header policy.
- `tests/unit/storage-local-signed-url.test.ts`
  - Local HMAC option/legacy/malformed-input behavior and R2 response overrides.
- `tests/unit/storage-controller.test.ts`
  - route actor and sanitized response/error behavior.
- `tests/unit/storage-list-access.test.ts`
  - actor-aware pagination, project scope, current bucket preset, and owner-filter boundary.
- `tests/unit/migration-sql.test.ts`
  - comment-prefixed and malformed transaction-wrapper behavior.
- `tests/sdk/fetch-adapter.test.ts`
  - JSON application requests in runtimes without a global `FormData` constructor.
- `tests/unit/admin/storage-bucket-access.test.ts`
  - settings form and badge behavior.
- `tests/integration/storage-project-access.test.ts`
  - real PostgreSQL/Local adapter actor and ownership behavior.

### Modify

- `apps/api/src/modules/storage/storage.service.ts`
  - new fields, owner-aware repository operations, lock, and safe ownership persistence.
- `apps/api/src/modules/storage/storage.controller.ts`
  - actor resolution, management/object split, safe DTOs, and error mapping.
- `apps/api/src/modules/storage/storage.routes.ts`
  - keep route shape; clarify management/object registration contracts if useful.
- `apps/api/src/adapters/storage/r2.adapter.ts`
  - force safe attachment semantics for private R2 signed downloads.
- `apps/api/src/adapters/storage/interface.ts`
  - signed-download response option contract.
- `apps/api/src/adapters/storage/local.adapter.ts`
  - sign logical filename/MIME/disposition and preserve legacy URL verification.
- `apps/api/src/modules/functions/internal-storage.routes.ts`
  - pass explicit trusted ownership context to the updated persistence API.
- `docker/deno-worker/druvia-helper.ts`
  - replace the upload result's open-ended object record with the safe Storage object shape.
- `apps/api/src/cli/migrate.ts`
  - hold the migration advisory lock and execute migrations on one checked-out client.
- `packages/sdk/src/DruviaClient.ts`
  - direct Storage application fetch and raw ticket fetch.
- `packages/sdk/src/modules/storage.ts`
  - separate direct/ticket fetch dependencies.
- `packages/sdk/src/lib/fetch-adapter.ts`
  - detect multipart bodies without assuming `FormData` exists globally.
- `apps/admin/src/lib/api.ts`
  - bucket access types and create/update payloads.
- `apps/admin/src/app/t/[tenantId]/p/[projectId]/storage/page.tsx`
  - creation fields, settings dialog, and status badges.
- `.github/workflows/release.yml`
  - migration `18 -> 20` and Storage gate.
- `tests/unit/storage-service.test.ts`
  - repository ownership persistence and owner filters.
- `tests/unit/functions-internal-storage.test.ts`
  - trusted Function ownership regression.
- `tests/unit/druvia-helper.test.ts`
  - typed safe Function Storage upload response regression.
- `tests/unit/storage-trusted-access.service.test.ts`
  - canonical non-empty ticket prefix, path, MIME, size, and expiry regression.
- `tests/integration/storage.test.ts`
  - existing management route regression.
- `tests/integration/storage-validation.test.ts`
  - shared direct/trusted/Function MIME and byte-limit validation regression.
- `tests/integration/storage-trusted-access.test.ts`
  - ticket ownership regression.
- `tests/sdk/storage.test.ts`
  - direct/raw fetch separation.
- `tests/sdk/client.test.ts`
  - Project/Platform token selection and no fallback.
- `tests/unit/release-pipeline.test.ts`
  - workflow gate/default manifest contract.
- `tests/unit/migration-runner-lock.test.ts`
  - checked-out-client lock source contract; real concurrent-process behavior is verified against PostgreSQL during migration rehearsal.
- `AGENTS.md`
  - mark direct Storage actor baseline complete.
- `apps/api/AGENTS.md`
  - module-specific Storage authorization rule.
- `packages/sdk/AGENTS.md`
  - Storage credential selection rule.
- `docs/agent/design-decisions.md`
  - durable bucket preset and ownership decision.
- `docs/progress.md`
  - completed milestone and next step.
- `docs/migration/supabase-compat.md`
  - Project Session Storage behavior and limitations.
- `docs/003-version-release-guide.md`
  - migration `020`, release defaults, backup, and rollback rule.
- `docs/plans/2026-08-14-project-update-direction-analysis.md`
  - current Storage maturity update if implementation completes.
- `docs/plans/2026-08-19-project-storage-actor-object-access.md`
  - checklist, review corrections, evidence, and final status.

No Compose service or environment variable change is expected. If implementation discovers one, stop and revise this design before editing deployment files.

## 11. Implementation Tasks

### Task 1: Migration and model contract

**Files:** migration `020`, schema source test, `storage.service.ts` model types.

- [x] Write `tests/unit/storage-project-access-schema.test.ts` first. Assert the legacy-name/NFC preflight, canonical-name constraint including PostgreSQL `normalize(..., NFC)`, default, exact preset values, owner column, trusted metadata backfill guards, index, and down order.
- [x] Run `pnpm vitest run tests/unit/storage-project-access-schema.test.ts` and confirm it fails because migration `020` does not exist.
- [x] Add the up/down migrations with the SQL in Section 3.
- [x] Extend Bucket/Object row and public types without changing route behavior.
- [x] Run the schema and Storage service tests to green.

### Task 2: Access decision core

**Files:** `storage-access.service.ts`, `storage.service.ts`, unit tests.

- [x] Write failing canonical path/prefix tests, including Local aliases (`a/b`, `a//b`, `a/./b`), traversal, controls, Unicode NFC, URL delimiters, server/client URL round trips, and SQL wildcard literals.
- [x] Implement `storage-path.ts` and replace controller, trusted-ticket, and Function path normalization with the shared contract.
- [x] Write table-driven tests for every row in Section 4 before creating the access service.
- [x] Confirm RED failures name missing actor-aware functions, not fixture errors.
- [x] Implement typed errors, preset checks, visibility, owner filters, and safe audit projection.
- [x] Add repository owner filtering and escaped literal prefix matching so count and rows use the identical predicate.
- [x] Run `pnpm vitest run tests/unit/storage-path.test.ts tests/unit/storage-access.service.test.ts tests/unit/storage-service.test.ts` to green.

### Task 3: Atomic write ownership

**Files:** `storage.service.ts`, access service, unit/integration tests.

- [x] Write failing tests for new upload ownership, own overwrite, other/unowned overwrite rejection, Platform owner preservation, trusted owner replacement, opaque new-object keys, existing-key reuse, and null-key repair.
- [x] Write deterministic concurrency tests: exactly one of two Project Users may claim a new path, management/trusted upload/delete cannot interleave around a Project User ownership check, and bucket deletion cannot pass its empty check while an upload inserts provider bytes.
- [x] Add bucket `FOR SHARE`/`FOR UPDATE`, the transaction-scoped path advisory lock, and owner-aware upsert/delete behavior on one checked-out client with the fixed bucket-before-object order; assert no pool-level query helper runs inside the locked transaction.
- [x] Preserve existing file-size/MIME validation, clean up only failed newly generated keys, and avoid deleting a reused existing key after failed overwrite persistence.
- [x] Run focused tests and confirm there is no owner change on rejected writes.

### Task 4: HTTP actor cutover

**Files:** controller/routes, access service, controller and app tests.

- [x] Write failing route tests for Platform User, same-project Project User, cross-project Project User, API Key, invalid Bearer + valid API Key, and no credential.
- [x] Write failing request-bound tests for list limit/offset/prefix, signed URL TTL, bucket size/MIME restrictions, and the global 50 MB contract.
- [x] Write failing delivery tests proving HTML/SVG/unknown objects are attachments, safe public images alone may be inline, all object responses use `nosniff`, signed response options are covered by the signature, malformed/length-mismatched signatures return `403`, and public mutable URLs use five-minute revalidation.
- [x] Add management and object actor resolvers using `ProjectActorContext`.
- [x] Route all protected object operations through the access service.
- [x] Add safe object DTO mapping, typed error mapping, bounded input validation, and `storage-delivery.ts` header application.
- [x] Make private Local/R2 signed downloads request attachment disposition with a safely encoded logical filename; preserve existing Local signatures only through the option-absent legacy branch.
- [x] Verify public download remains unauthenticated and preset-independent.
- [x] Verify preset changes do not revoke an existing private signed URL, expiry does, and disabling public access blocks the next uncached public request.
- [x] Run controller, auth, public Storage, and API app tests to green.

### Task 5: Trusted ticket and Function regressions

**Files:** internal Storage route, trusted service/tests, Function tests.

- [x] Write failing assertions that ticket/Project User Function uploads persist `ownerProjectUserId` while Platform/API Key Function uploads do not claim one, and that both response paths plus the Deno helper return only typed `StorageObjectResponse` fields.
- [x] Adapt internal callers to explicit trusted capability input; never pass direct-route actor policy or a boolean bypass.
- [x] Verify ticket prefix/path, MIME, max-byte, expiry, and project checks remain unchanged.
- [x] Run trusted ticket and Function internal Storage tests to green.

### Task 6: SDK credential cutover

**Files:** `DruviaClient.ts`, SDK Storage module/tests.

- [x] Write failing tests showing direct Storage uses Project Session, ignores Platform Session, sends API Key only when signed out, and does not retry an invalid Project Session.
- [x] Write failing tests showing all four trusted ticket methods receive only explicit trusted/ticket headers from Storage and do not use the application wrapper.
- [x] Replace SDK-only fake success fixtures with real controller DTOs and assert upload maps `name -> path`, the signed request maps `path -> objectPath`, and the signed response maps `url -> signedUrl`.
- [x] Add segment-safe direct/public URL tests for spaces, Unicode, `#`, `?`, `%`, and nested folders; server-generated public and Local signed URLs use the same fixtures.
- [x] Split direct and raw fetch dependencies in `DruviaStorage`.
- [x] Keep all public SDK method signatures and response shapes compatible.
- [x] Keep Taro/WeChat upload/download binary transport explicitly unsupported by this slice; do not infer compatibility from `customFetch` tests.
- [x] Run SDK Storage/client/project-auth tests to green.

### Task 7: Admin bucket access settings

**Files:** Admin API types, settings dialog, Storage page, jsdom tests.

- [x] Write failing UI tests for defaults, all three labels, dirty-field-only PATCH payloads, unchanged-save disablement, successful save, failed save retention, and badge display.
- [x] Add `BucketAccessSettingsDialog` using existing UI primitives and Lucide icons.
- [x] Extend create bucket and bucket rows without nesting cards or exposing implementation details.
- [x] Add file-size/MIME normalization and ensure empty values serialize as `null`.
- [x] Run Admin component tests and `pnpm --filter @druvia/admin build`.

### Task 8: Real integration and release gate

**Files:** real integration test, release workflow/test, release guide.

- [x] Write the migration-runner checked-out-client source contract, then bind the session lock, version reads, migrations, and unlock to one checked-out client; replace inner `process.exit()` with propagated failure and prove with a real second process that a blocked runner performs no migration while retry works after lock release.
- [x] On the disposable/local test database, prove invalid alias and non-NFC legacy names block migration `020` without partial schema changes, clean the fixtures, apply `020`, audit backfill/default/constraints/index state, run `down` for exactly `020`, verify residue removal, then apply `020` again before integration tests; separately run the documented Local legacy physical-key collision audit.
- [x] Run real Local adapter tests for Project User list/upload/download/signed URL/delete across all presets.
- [x] Run deterministic same-path concurrency and metadata-backfill residue checks.
- [x] Update release defaults to `18 -> 20` and add the exact focused gate.
- [x] Update release-pipeline tests first, confirm RED, then update workflow to GREEN.
- [x] Parse workflow YAML and render manifest fixtures for GHCR and self-hosted Registry.

### Task 9: Documentation and final verification

**Files:** AGENTS, decisions, progress, compatibility, direction analysis, this plan.

- [x] Update the smallest durable documentation targets listed in Section 10.
- [x] Mark completed checklist items and add exact verification evidence to Section 15.
- [x] Run the full scoped test/build commands from Section 13.
- [x] Review the complete diff for credential leakage, unsafe permission widening, migration ordering, and unrelated churn.
- [x] Perform a direct review/fix/re-review loop until no important findings remain.

## 12. Test Matrix

### 12.1 Authorization

- Platform User with project membership can manage every preset and object.
- Platform User without project membership receives `403`.
- Project User cannot create/update/delete/list bucket configuration.
- Same-project Project User follows the exact preset matrix.
- Cross-project Project User receives a scoped `403`.
- API Key receives `PROJECT_ACTOR_REQUIRED` for protected routes.
- Invalid Bearer token plus valid API Key remains `401`.
- Public URL behavior depends only on `public`.
- Existing private signed URLs survive preset changes only until their bounded expiry; uncached public requests observe `public=false`.

### 12.2 Ownership

- direct Project User upload creates owner;
- own overwrite preserves owner;
- other/unowned overwrite is rejected;
- Platform overwrite preserves existing owner;
- trusted ticket sets/replaces explicit on-behalf-of owner;
- Project User Function helper sets caller owner;
- Platform/API Key Function helper does not fabricate Project User owner;
- metadata edits cannot alter access;
- old trusted metadata backfills only valid non-empty strings;
- metadata with an unrelated/missing `created_by_type` never backfills ownership;
- concurrent users cannot both claim the same new path;
- management/trusted mutations cannot race around a Project User ownership decision;
- bucket deletion cannot cascade a concurrent object row and orphan its provider key;
- new objects use opaque provider keys, overwrites preserve existing keys, and null-key repair does not change logical identity;

### 12.3 Query and response safety

- owner-only list count and page rows use the same owner predicate;
- prefixes are combined with owner filtering;
- canonical logical paths plus opaque new-object provider keys prevent Local filesystem aliases, and prefix `%`/`_` are literal;
- offset/limit cannot reveal hidden-object counts;
- pagination, signed URL TTL, bucket limits, and multipart size are bounded;
- direct, ticket, and Function application responses omit storage path, metadata, createdBy, and owner IDs;
- logs omit credentials, payload bytes, signed URL signatures, and raw metadata;
- public HTML/SVG/unknown content is attachment-only, all object responses use `nosniff`, and mutable public URLs revalidate after five minutes.

### 12.4 SDK

- Project Session is selected for direct protected Storage;
- Platform Session is never selected;
- signed-out direct access sends API Key and receives actor-required behavior;
- invalid Project Session is not retried as API Key;
- public URL generation remains synchronous;
- ticket paths use only their explicit credential;
- upload maps the real object DTO name to `path`, and signed URL maps API `url` to SDK `signedUrl`.
- nested and URL-sensitive object names are encoded segment-by-segment.
- standard browser/Node binary behavior is tested without claiming Taro/WeChat direct upload/download support.

### 12.5 Migration and release

- fresh migration up/down works;
- concurrent migration runners serialize on one session advisory lock and release it after success/failure;
- invalid legacy aliases and non-NFC names block migration atomically and produce the documented preflight error;
- existing bucket defaults are `admin_only`;
- ownership backfill is idempotent;
- ordinary old API SQL remains valid after migration, with malformed-path and rolled-back-write caveats documented;
- release manifests state `18 -> 20`, backup required, non-reversible;
- GHCR and self-hosted manifests agree;
- real release/OTA execution remains explicitly unclaimed.

## 13. Verification Commands

Focused RED/GREEN commands are run per task. Final verification includes:

```bash
pnpm vitest run \
  tests/unit/storage-project-access-schema.test.ts \
  tests/unit/migration-sql.test.ts \
  tests/unit/migration-runner-lock.test.ts \
  tests/unit/storage-path.test.ts \
  tests/unit/storage-delivery.test.ts \
  tests/unit/storage-local-signed-url.test.ts \
  tests/unit/storage-access.service.test.ts \
  tests/unit/storage-list-access.test.ts \
  tests/unit/storage-controller.test.ts \
  tests/unit/storage-service.test.ts \
  tests/unit/storage-trusted-access.service.test.ts \
  tests/unit/functions-internal-storage.test.ts \
  tests/unit/druvia-helper.test.ts \
  tests/unit/auth.test.ts \
  tests/unit/api-app.test.ts \
  tests/sdk/storage.test.ts \
  tests/sdk/fetch-adapter.test.ts \
  tests/sdk/client.test.ts \
  tests/sdk/project-auth.test.ts \
  tests/unit/admin/storage-bucket-access.test.ts \
  tests/unit/release-pipeline.test.ts

pnpm vitest run \
  tests/integration/storage-project-access.test.ts \
  tests/integration/storage.test.ts \
  tests/integration/storage-validation.test.ts \
  tests/integration/storage-public-access.test.ts \
  tests/integration/storage-trusted-access.test.ts \
  tests/unit/migration-runner-lock.test.ts

pnpm --filter @druvia/shared build
pnpm --filter @druvia/sdk build
pnpm --filter @druvia/api build
pnpm --filter @druvia/admin build

ruby -e "require 'yaml'; YAML.load_file('.github/workflows/release.yml')"
git diff --check
```

Run the repository's broader unit/API/SDK suite after focused tests. Repository-wide lint may still contain unrelated pre-existing Admin failures; changed files must introduce no new lint failure, and any remaining baseline failure must be reported precisely.

## 14. Completion Criteria

The slice is complete only when:

1. Migration `020` defaults every old bucket to `admin_only` and backfills only trusted Project User audit values.
2. The direct Storage matrix is enforced in service code, not only controllers.
3. Project User list pagination cannot leak hidden objects.
4. Canonical logical paths and opaque new-object provider keys prevent new Local adapter aliases, legacy Local key risks are audited, and SQL-prefix wildcard expansion is blocked.
5. Bucket-row and same-path locking across every mutation capability prevents ownership races and bucket-delete orphaning.
6. Project User inputs are bounded and untrusted object delivery cannot render active content inline under the Druvia origin.
7. Platform management, public downloads, trusted tickets, and Function helper regressions remain green.
8. SDK direct Storage uses Project Session/API Key application credentials and never Platform Session.
9. SDK upload/signed URL results match their declared public types when consuming real API DTOs, without claiming unsupported Taro binary transport.
10. Ticket operations do not carry implicit application/platform credentials.
11. Admin exposes only the three approved presets and keeps public download independent.
12. Release manifests advance through migration `020` with backup/non-reversible safeguards, and the migration runner holds one real session lock for the command lifetime.
13. Required docs are synchronized without creating `docs/superpowers` or a parallel memory file.
14. Focused and broad verification passes, or any unrelated baseline failure is documented.
15. Direct review finds no remaining important issue.

## 15. Verification Evidence

### Design review, 2026-08-19

- Reviewed directly in the main checkout without worktrees or subagents.
- Cross-checked the plan against the current Storage service/controller, Local/R2 adapters, Project Actor resolver, SDK fetch wrapper/Storage module, Deno helper, migration CLI, updater, release workflow, and existing Storage tests.
- Verified on the running PostgreSQL 17 container that `normalize(text, NFC)` works and that the proposed check accepts `a/b` while rejecting duplicate/leading/trailing slashes, backslashes, exact dot segments, and non-NFC names.
- Confirmed migrations `018` and `019` are after the latest locally available release tag and the current release workflow range is `18 -> 19`; this slice advances that established range through `020`.
- Confirmed `docs/superpowers` is absent and this is the only uncommitted file.
- `git diff --check` passes.
- Direct review/fix/re-review found no remaining important design finding. No implementation test, build, Registry publish, Release, or OTA rehearsal is claimed.

### Implementation evidence, 2026-08-19

- RED gates were observed before implementation for the missing migration/path/access modules. The final review also added failing assertions for exact Storage errors, cross-project actor scope, the release Storage gate, Admin create restrictions, invalid-size feedback, and RFC 5987 filename encoding before each correction.
- The exact release Storage gate now passes: 20 files and 150 tests, covering migration source/parser/runner/bootstrap, paths, delivery, Local signed URLs, access decisions, actor-aware list/read boundaries, controller actor/error behavior, repository lock contract, validation, trusted/Function paths, Deno helper, SDK identity/DTO mapping and no-`FormData` JSON behavior, Admin contract, and release workflow.
- The latest affected integration group passes 6 files and 49 tests for management, validation, public, trusted, direct Project User, and project deletion behavior. It includes owner filtering, same-path concurrent claim, authenticated read conflict behavior, opaque provider keys, Platform owner preservation, and parallel-safe test Storage cleanup.
- Migration `020` was rehearsed on PostgreSQL 17. An invalid `a//b` fixture blocked apply with no partial columns/version change; after cleanup, up applied, audits found version 20, four legacy buckets at `admin_only`, 240/318 trusted owner rows backfilled, both constraints and the owner index present, and no owner/project mismatch. Down removed exactly `020`; the next up restored it.
- A real second migration process was rejected while another PostgreSQL session held the advisory lock (`Another migration is running`), then succeeded after release. The Local legacy audit found no null physical keys or case-folded key collisions.
- The local database is left at schema version `20`; the final audit reports 240 owned objects and no bucket with Project User access enabled implicitly.
- `pnpm build` succeeds for all 6 Turbo packages, including API TypeScript and the Admin Next.js production build. The release workflow parses successfully as YAML, and release-pipeline tests verify matching GHCR/self-hosted manifest defaults at migration range `18 -> 20`.
- ESLint passes for the changed Storage page, bucket settings dialog, and Admin API client. Repository-wide `pnpm lint` still fails on 15 pre-existing Admin errors outside this change; no changed file appears in that report.
- An earlier repository-wide `pnpm test` run reported 1225 passed, 12 skipped, and 13 failed. One affected hard-coded legacy Storage path expectation was fixed and its project-deletion suite now passes 10/10. The remaining failures were unrelated environment/parallel-integration baselines: missing Realtime/Hasura secrets, shared project/schema lock contention, a backup deadlock under parallel execution, and one pre-existing schema-qualified FK expectation. Focused affected suites and builds pass after the final fixes.
- Final direct review corrected stale bucket validation after row locking, caller-supplied preset trust, actor project scope, exact non-disclosing object errors, legacy null/empty provider keys, malformed historical MIME headers, canonical actor resolver usage, trusted MIME normalization, pre-buffer admin-only rejection, no-`FormData` JSON fetch behavior, comment-prefixed and unmatched migration transaction wrappers, missing bootstrap detection through migration `020`, missing release tests, incomplete Admin creation controls, silent size validation, parallel test Storage cleanup, and filename encoding. The release guide now includes executable legacy logical/provider-key audit SQL.
- Final `git diff --check`, release workflow YAML parsing, and private-key/token/local-private-path scan pass with no findings.
- No GitHub Release, Registry image publication, production Compose apply, or OTA rehearsal was executed in this slice, as explicitly deferred by scope.
