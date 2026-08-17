# Project Data Access Overview Design

Date: 2026-08-17

Status: Implemented

## 1. Goal

Batch 2B adds a project-level, read-only data access overview for the default production schema. It helps administrators find tables that are unconfigured, have scoped anonymous read configured, are missing Realtime read access, still use legacy permissions, or carry custom scoped metadata that requires review.

The overview is for status, filtering and navigation. Permission editing remains in the selected table context.

## 2. Scope

This batch includes:

- one project-level overview API;
- one Admin page under project settings;
- project-wide summary counts;
- per-table access and Realtime status;
- filters for common remediation workflows;
- direct navigation to the selected table's Data Access tab;
- loading, empty, failure and retry states.

This batch does not include:

- bulk permission changes;
- automatic migration or repair;
- removal of legacy roles;
- scoped-role runtime activation;
- non-production environment access;
- raw Hasura metadata or physical role display.

## 3. Management API

Add a JWT-only endpoint:

```text
GET /api/v1/projects/:projectId/data-access/overview
```

The endpoint requires a `platform_user` and a successful `checkProjectAccess`. Project-user sessions and API keys receive `401`. The endpoint always targets the project's default schema and accepts no environment parameter.

The response uses the standard Druvia envelope and this data shape:

```typescript
interface ProjectDataAccessOverview {
  projectId: string
  schemaName: string
  runtimeMode: 'compatibility' | 'explicit'
  summary: {
    totalTables: number
    configuredTables: number
    anonymousConfiguredTables: number
    realtimeAccessRequiredTables: number
    legacyTables: number
    reviewRequiredTables: number
  }
  tables: ProjectTableDataAccessOverview[]
}

interface ProjectTableDataAccessOverview {
  tableName: string
  dataInterface: 'connected' | 'not_connected'
  authenticatedAccess: 'closed' | 'read_only' | 'write_only' | 'read_write' | 'custom'
  anonymousAccess: 'closed' | 'read' | 'custom'
  realtime: 'disabled' | 'access_required' | 'configured'
  legacyAccess: {
    authenticated: boolean
    anonymous: boolean
  }
  reviewRequired: boolean
}
```

The public type reserves `runtimeMode: 'compatibility' | 'explicit'`, while Batch 2B always returns `compatibility`. This makes the current boundary explicit without exposing physical role terminology or requiring a response-contract change when Batch 3 adds persisted project activation state. Explicit permissions can be configured, but HTTP and WebSocket application requests have not switched to that enforcement path.

## 4. Aggregation Rules

The API builds the overview from three inputs:

1. PostgreSQL table inventory for the project schema;
2. `_meta_tables.realtime_enabled` capability flags;
3. one Hasura `export_metadata` snapshot.

The overview must not call the existing single-table endpoint once per table. It reuses the same managed-permission parser as Batch 2A so the editor and overview cannot classify the same metadata differently.

### 4.1 Data Interface

- `connected`: the table exists in the default Hasura source metadata;
- `not_connected`: the PostgreSQL table exists but is not tracked in that source.

### 4.2 Authenticated Access

- `closed`: no managed authenticated permission exists;
- `read_only`: managed select exists, but no managed insert/update/delete exists;
- `write_only`: at least one managed insert/update/delete permission exists and managed select does not exist;
- `read_write`: managed select and at least one managed insert/update/delete permission both exist;
- `custom`: the authenticated scoped role contains a permission shape outside Batch 2A's exact supported forms.

The overview does not expose the underlying `none / all / owner` values. Those remain available in the table editor.

### 4.3 Anonymous Access

- `read`: a supported managed anonymous select permission exists;
- `closed`: no managed anonymous select permission exists;
- `custom`: the anonymous scoped role contains any unsupported permission shape, including anonymous writes.

Any unsupported permission for the anonymous scoped role sets `reviewRequired=true`. Anonymous writes are always unsupported and therefore produce `anonymousAccess='custom'`.

### 4.4 Realtime

- `disabled`: `_meta_tables.realtime_enabled` is false;
- `access_required`: Realtime is enabled but neither authenticated nor anonymous managed select is configured;
- `configured`: Realtime is enabled and at least one managed actor has select access.

`configured` means permission configuration is ready for the later actor cutover. It does not claim that Batch 2B scoped permissions are already active for runtime WebSocket connections.

### 4.5 Review And Summary Counts

`reviewRequired` is true when any of these conditions holds:

- the table is not connected to the data interface;
- managed scoped metadata is custom or unsupported;
- legacy authenticated or anonymous permissions exist.

Summary fields count tables, not permission entries:

- `configuredTables`: tables with any supported managed authenticated or anonymous permission;
- `anonymousConfiguredTables`: tables with supported scoped anonymous select, regardless of current runtime mode;
- `realtimeAccessRequiredTables`: tables with Realtime enabled and no managed select;
- `legacyTables`: tables with at least one legacy authenticated or anonymous access rule;
- `reviewRequiredTables`: tables where `reviewRequired=true`.

Tables are returned in ascending table-name order for stable rendering and tests.

## 5. Service Boundaries

The data-access module owns overview composition, database inventory and permission classification. A focused database-only inventory reader returns each visible application table's name, ordered column names and `realtime_enabled` value without exporting Hasura metadata. Internal tables whose names begin with `_` are excluded, matching the Tables page inventory. This gives the permission parser the actual columns required to recognize exact managed shapes while keeping the overview to one project-wide inventory instead of per-table metadata queries.

The overview GET path has no tracking, permission, reload or schema-creation side effects. The inventory reader does not call `ensureRealtimeMetaTable`; it checks whether the table exists and, when absent, returns all visible tables with `realtime_enabled=false`, leaving repair to an explicit management workflow.

The existing single-table service and overview service share pure inspection helpers. The internal inspection result keeps authenticated and anonymous state separate:

```typescript
interface InspectedTableDataAccess {
  authenticatedState: 'managed' | 'custom'
  anonymousState: 'managed' | 'custom'
  policy: TableDataAccessInput
  legacyRoles: string[]
  existingManaged: Array<{ operation: DataAccessOperation; role: string }>
}
```

The single-table editor continues to expose `managedState='custom'` when either actor state is custom, preserving its write-protection behavior. The overview uses actor-specific states so an anonymous custom rule cannot incorrectly mark authenticated access as custom, or appear as anonymous access being closed. Neither Admin nor the controller reimplements metadata classification.

The overview maps internal legacy role names to `legacyAccess.authenticated/anonymous` booleans before returning the management response. Raw legacy or scoped role names do not enter the overview API or normal Admin rendering.

No database migration is required in Batch 2B.

## 6. Admin Experience

Add this page:

```text
/t/:tenantId/p/:projectId/settings/data-access
```

Add a `数据访问` entry to the project's Settings page. The overview is not added as a top-level sidebar module because editing still belongs to Tables and the page is a project governance view.

The page uses a restrained operational layout:

- title, schema name and compatibility-mode notice at the top;
- one compact summary band;
- filter tabs for `All`, `Unconfigured`, `Anonymous Configured`, `Realtime Access Required`, and `Review Required`;
- one scan-friendly table containing table name, data interface, authenticated access, anonymous access, Realtime, logical legacy-access status and action;
- an action link that opens the table detail page with `?tab=access&scope=default`.

The compatibility notice uses product-facing copy: `当前处于兼容模式，新数据访问配置尚未用于应用请求`. It does not mention implementation batches, Hasura roles or migration internals.

The visible Chinese labels use application concepts:

- `数据接口`;
- `认证用户`;
- `匿名读取`;
- `实时更新`;
- `旧规则`;
- `配置`.

The UI does not display Hasura, metadata command names, scoped roles or secrets.

## 7. Filter Semantics

- `全部`: every table;
- `待配置`: the data interface is connected, authenticated and anonymous managed access are both closed, and `reviewRequired=false`;
- `匿名已配置`: `anonymousAccess='read'`;
- `Realtime 待授权`: `realtime='access_required'`;
- `需检查`: `reviewRequired=true`.

Filtering is client-side because the API already returns the bounded project table inventory. An empty filter result shows a filter-specific empty state without refetching.

Legacy-only, custom and untracked tables do not also appear in `待配置`; they belong to `需检查` so migration and repair risks are not mixed into the normal configuration queue.

## 8. Navigation

The table overview action URL-encodes the table-name path segment and links to an explicit default-scope target:

```text
/t/:tenantId/p/:projectId/tables/:tableName?tab=access&scope=default
```

The table detail page accepts only `structure` or `access`. When `scope=default` is present, it first normalizes the Admin environment context to the project's default production schema and then opens `access`. Without that explicit scope, it opens `access` only when the currently selected schema already equals the project default. Invalid query values and non-default environments always fall back to `structure`, preserving the Batch 2A scope restriction.

## 9. Error Handling

- Hasura metadata failures return a sanitized `502 DATA_ACCESS_SERVICE_UNAVAILABLE` response;
- missing projects or schemas return `404 DATA_ACCESS_NOT_FOUND`;
- database and unknown failures return a generic `500 DATA_ACCESS_FAILED` response;
- no upstream secret, database detail or raw metadata error reaches Admin;
- the overview does not return partial summary data when a required source fails.

Admin shows a full-page error state with one retry command. A successful response with no tables shows an empty project state and a link to Tables.

## 10. Testing

API tests cover:

- stable aggregation and table-name ordering;
- authenticated closed/read-only/read-write/custom classification;
- authenticated write-only classification;
- anonymous closed/read/custom classification;
- connected and untracked tables;
- Realtime disabled/access-required/configured states;
- logical legacy-access and custom review flags without public role names;
- summary counts without double counting;
- one metadata export per overview request;
- platform-user project access and rejection of other identities;
- sanitized upstream and unknown failures.

Admin tests cover:

- summary rendering;
- each filter;
- compatibility-mode notice;
- status labels without Hasura implementation terms;
- empty, failure and retry states;
- encoded table configuration links;
- `?tab=access` scope enforcement in the table detail presentation helper.

Verification includes focused tests, API and Admin production builds, Admin changed-file lint and `git diff --check`.

## 11. Acceptance Criteria

- One request returns a consistent project-level data access snapshot.
- The API does not perform per-table management API requests.
- Administrators can identify unconfigured, scoped anonymous-read configured, Realtime-blocked, legacy and custom tables.
- The page is read-only except for navigation and retry.
- Table configuration links open the existing table-level editor directly.
- Non-production schemas cannot use the overview or editor to change default-scope permissions accidentally.
- Scoped permissions are never presented as runtime-active before Batch 3.
- Existing legacy and custom rules remain unchanged.
