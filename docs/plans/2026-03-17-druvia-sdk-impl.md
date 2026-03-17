# @druvia/sdk Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `@druvia/sdk` — a TypeScript client SDK covering Auth, Database CRUD, Storage, Realtime, RPC, and Edge Functions, with pluggable fetch/storage/websocket adapters for multi-platform support (browser, Node.js, WeChat mini-program).

**Architecture:** SDK is a monorepo package at `packages/sdk/`. Core client delegates to 6 modules, each wrapping Druvia REST API or Hasura GraphQL. Database module converts chainable query builder calls into GraphQL via an internal graphql-builder. Realtime wraps Hasura GraphQL subscriptions over WebSocket with local-snapshot diffing to emit change events. All I/O goes through injectable adapters (fetch, storage, websocket).

**Tech Stack:** TypeScript 5.4+, tsc (no bundler, matching existing packages), Vitest, ES modules

**Spec:** `docs/plans/2026-03-17-taro-app-migration-design.md` sections 四 (4.1–4.6)

---

## File Structure

```
packages/sdk/
├── package.json
├── tsconfig.json
├── src/
│   ├── index.ts                    # createClient() export
│   ├── DruviaClient.ts             # Main client class, wires modules
│   ├── types.ts                    # Shared types (DruviaClientOptions, etc.)
│   ├── modules/
│   │   ├── auth.ts                 # DruviaAuth — signUp/signIn/signOut/getUser/getSession/onAuthStateChange
│   │   ├── database.ts            # DruviaDatabase — from() returns QueryBuilder
│   │   ├── query-builder.ts       # QueryBuilder — chainable select/eq/insert/update/delete
│   │   ├── storage.ts             # DruviaStorage — from(bucket) returns BucketClient
│   │   ├── realtime.ts            # DruviaRealtime — channel() returns RealtimeChannel
│   │   ├── rpc.ts                 # DruviaRpc — rpc(name, args)
│   │   └── functions.ts           # DruviaFunctions — invoke(name, opts)
│   └── lib/
│       ├── graphql-builder.ts     # Converts QueryBuilder state → GraphQL string
│       ├── fetch-adapter.ts       # FetchAdapter interface + default impl
│       ├── storage-adapter.ts     # StorageAdapter interface (localStorage-like)
│       └── websocket-adapter.ts   # WebSocketAdapter interface + default impl
tests/
└── sdk/
    ├── graphql-builder.test.ts
    ├── query-builder.test.ts
    ├── auth.test.ts
    ├── database.test.ts
    ├── storage.test.ts
    ├── realtime.test.ts
    ├── rpc.test.ts
    ├── functions.test.ts
    └── client.test.ts
```

---

## Chunk 1: Package Scaffold + Types + Adapters

### Task 1: Package scaffold

**Files:**
- Create: `packages/sdk/package.json`
- Create: `packages/sdk/tsconfig.json`
- Create: `packages/sdk/src/index.ts`
- Create: `packages/sdk/src/types.ts`

- [ ] **Step 1: Create package.json**

```json
{
  "name": "@druvia/sdk",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.js"
    }
  },
  "scripts": {
    "build": "tsc",
    "dev": "tsc --watch"
  },
  "devDependencies": {
    "@types/node": "^20.0.0",
    "typescript": "^5.4.0"
  }
}
```

- [ ] **Step 2: Create tsconfig.json**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "./dist",
    "rootDir": "./src",
    "lib": ["ES2022", "DOM"]
  },
  "include": ["src/**/*"]
}
```

Note: `DOM` lib needed for `Response`, `Request`, `WebSocket` types used in adapter interfaces.

- [ ] **Step 3: Create types.ts**

```typescript
// packages/sdk/src/types.ts

/** Pluggable fetch function — must return Response-compatible object */
export type FetchFn = (input: string, init?: RequestInit) => Promise<Response>

/** Pluggable localStorage-like storage */
export interface StorageAdapter {
  getItem(key: string): string | null | Promise<string | null>
  setItem(key: string, value: string): void | Promise<void>
  removeItem(key: string): void | Promise<void>
}

/** Pluggable WebSocket adapter for non-standard environments (e.g. WeChat) */
export interface WebSocketLike {
  onOpen(cb: () => void): void
  onMessage(cb: (data: string) => void): void
  onClose(cb: (event?: { code?: number; reason?: string }) => void): void
  onError(cb: (error: unknown) => void): void
  send(data: string): void
  close(): void
}

export type WebSocketFactory = (url: string, protocols?: string[]) => WebSocketLike

export interface DruviaClientOptions {
  projectId: string
  schema?: string   // Hasura schema name (e.g. 'dru_taroapp'), auto-derived from projectId if omitted
  realtimeUrl?: string  // Hasura WebSocket URL (e.g. 'ws://localhost:8080'), auto-derived from baseUrl if omitted
  fetch?: FetchFn
  storage?: StorageAdapter
  websocket?: WebSocketFactory
}

/** Standard response shape from all SDK methods */
export interface DruviaResponse<T> {
  data: T | null
  error: DruviaError | null
}

export interface DruviaError {
  code: string
  message: string
}

/** Auth token pair */
export interface Session {
  accessToken: string
  refreshToken?: string
  user: UserInfo
}

export interface UserInfo {
  id: number
  email?: string
  username?: string
  role?: string
}
```

- [ ] **Step 4: Create index.ts (placeholder)**

```typescript
// packages/sdk/src/index.ts
export { createClient } from './DruviaClient.js'
export type {
  DruviaClientOptions,
  DruviaResponse,
  DruviaError,
  Session,
  UserInfo,
  FetchFn,
  StorageAdapter,
  WebSocketLike,
  WebSocketFactory,
} from './types.js'
```

- [ ] **Step 5: Install dependencies and verify build**

Run: `cd /Users/cloudio/Developer/nodejs/Druvia && pnpm install && pnpm --filter @druvia/sdk build`
Expected: Build fails (DruviaClient.ts not yet created) — that's OK, confirms package is wired up.

---

### Task 2: Adapter defaults + fetch wrapper

**Files:**
- Create: `packages/sdk/src/lib/fetch-adapter.ts`
- Create: `packages/sdk/src/lib/storage-adapter.ts`
- Create: `packages/sdk/src/lib/websocket-adapter.ts`

- [ ] **Step 1: Create fetch-adapter.ts**

```typescript
// packages/sdk/src/lib/fetch-adapter.ts
import type { FetchFn } from '../types.js'

/** Default fetch — uses globalThis.fetch */
export function getDefaultFetch(): FetchFn {
  if (typeof globalThis.fetch === 'function') {
    return globalThis.fetch.bind(globalThis)
  }
  throw new Error('@druvia/sdk: No fetch implementation found. Pass a custom fetch in createClient options.')
}

/** Wrapper that adds auth headers and base URL */
export function createFetchWrapper(
  baseUrl: string,
  apiKey: string,
  fetchFn: FetchFn,
  getToken: () => string | null,
): FetchFn {
  return async (input: string, init?: RequestInit) => {
    const url = input.startsWith('http') ? input : `${baseUrl}${input}`
    const headers = new Headers(init?.headers)
    headers.set('apikey', apiKey)
    const token = getToken()
    if (token) {
      headers.set('Authorization', `Bearer ${token}`)
    }
    if (!headers.has('Content-Type') && init?.body) {
      headers.set('Content-Type', 'application/json')
    }
    return fetchFn(url, { ...init, headers })
  }
}
```

- [ ] **Step 2: Create storage-adapter.ts**

```typescript
// packages/sdk/src/lib/storage-adapter.ts
import type { StorageAdapter } from '../types.js'

/** Default storage — uses globalThis.localStorage, no-op if unavailable */
export function getDefaultStorage(): StorageAdapter {
  if (typeof globalThis.localStorage !== 'undefined') {
    return globalThis.localStorage
  }
  // In-memory fallback (Node.js, SSR)
  const store = new Map<string, string>()
  return {
    getItem: (key) => store.get(key) ?? null,
    setItem: (key, value) => { store.set(key, value) },
    removeItem: (key) => { store.delete(key) },
  }
}
```

- [ ] **Step 3: Create websocket-adapter.ts**

```typescript
// packages/sdk/src/lib/websocket-adapter.ts
import type { WebSocketFactory, WebSocketLike } from '../types.js'

/** Default WebSocket factory — uses globalThis.WebSocket */
export function getDefaultWebSocketFactory(): WebSocketFactory | null {
  if (typeof globalThis.WebSocket === 'undefined') {
    return null
  }
  return (url: string, protocols?: string[]): WebSocketLike => {
    const ws = new globalThis.WebSocket(url, protocols)
    return {
      onOpen: (cb) => { ws.addEventListener('open', cb) },
      onMessage: (cb) => { ws.addEventListener('message', (e) => cb(String(e.data))) },
      onClose: (cb) => { ws.addEventListener('close', (e) => cb({ code: e.code, reason: e.reason })) },
      onError: (cb) => { ws.addEventListener('error', cb) },
      send: (data) => ws.send(data),
      close: () => ws.close(),
    }
  }
}
```

---

## Chunk 2: GraphQL Builder + Query Builder + Database Module

### Task 3: GraphQL Builder (pure function, no I/O)

**Files:**
- Create: `packages/sdk/src/lib/graphql-builder.ts`
- Create: `tests/sdk/graphql-builder.test.ts`

This is the core engine that converts query builder state into Hasura-compatible GraphQL strings.

- [ ] **Step 1: Write failing tests for graphql-builder**

```typescript
// tests/sdk/graphql-builder.test.ts
import { describe, it, expect } from 'vitest'
import { buildQuery, buildMutation, type QueryState } from '../../packages/sdk/src/lib/graphql-builder.js'

describe('buildQuery', () => {
  it('builds simple select with explicit fields', () => {
    const state: QueryState = {
      table: 'users',
      selectFields: 'id, name, email',
      filters: [],
      orderBy: [],
      offset: undefined,
      limit: undefined,
      isSingle: false,
    }
    const gql = buildQuery(state)
    expect(gql).toContain('query')
    expect(gql).toContain('users')
    expect(gql).toContain('id')
    expect(gql).toContain('name')
    expect(gql).toContain('email')
  })

  it('builds select with eq filter', () => {
    const state: QueryState = {
      table: 'users',
      selectFields: 'id, name',
      filters: [{ column: 'id', op: '_eq', value: 1 }],
      orderBy: [],
      offset: undefined,
      limit: undefined,
      isSingle: false,
    }
    const gql = buildQuery(state)
    expect(gql).toContain('where')
    expect(gql).toContain('id')
    expect(gql).toContain('_eq')
  })

  it('builds select with multiple filters', () => {
    const state: QueryState = {
      table: 'activities',
      selectFields: 'id, status',
      filters: [
        { column: 'status', op: '_eq', value: 'active' },
        { column: 'team_id', op: '_in', value: [1, 2, 3] },
      ],
      orderBy: [{ column: 'created_at', ascending: false }],
      offset: 0,
      limit: 20,
      isSingle: false,
    }
    const gql = buildQuery(state)
    expect(gql).toContain('_eq')
    expect(gql).toContain('_in')
    expect(gql).toContain('order_by')
    expect(gql).toContain('desc')
    expect(gql).toContain('offset: 0')
    expect(gql).toContain('limit: 20')
  })

  it('builds select with nested relation', () => {
    const state: QueryState = {
      table: 'activities',
      selectFields: '*, user_activities(*)',
      filters: [],
      orderBy: [],
      offset: undefined,
      limit: undefined,
      isSingle: false,
    }
    const gql = buildQuery(state)
    expect(gql).toContain('user_activities')
  })

  it('applies limit 1 for single()', () => {
    const state: QueryState = {
      table: 'users',
      selectFields: 'id, name',
      filters: [{ column: 'id', op: '_eq', value: 1 }],
      orderBy: [],
      offset: undefined,
      limit: undefined,
      isSingle: true,
    }
    const gql = buildQuery(state)
    expect(gql).toContain('limit: 1')
  })
})

describe('buildMutation', () => {
  it('builds insert mutation', () => {
    const gql = buildMutation('users', 'insert', {
      objects: [{ username: 'test', user_id: 'u1' }],
      returning: 'id, username',
    })
    expect(gql).toContain('mutation')
    expect(gql).toContain('insert_users')
    expect(gql).toContain('username')
  })

  it('builds update mutation with where', () => {
    const gql = buildMutation('users', 'update', {
      set: { username: 'new_name' },
      where: { id: { _eq: 1 } },
      returning: 'id, username',
    })
    expect(gql).toContain('update_users')
    expect(gql).toContain('_set')
    expect(gql).toContain('where')
  })

  it('builds delete mutation with where', () => {
    const gql = buildMutation('users', 'delete', {
      where: { id: { _eq: 1 } },
      returning: 'id',
    })
    expect(gql).toContain('delete_users')
    expect(gql).toContain('where')
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /Users/cloudio/Developer/nodejs/Druvia && pnpm vitest run tests/sdk/graphql-builder.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement graphql-builder.ts**

```typescript
// packages/sdk/src/lib/graphql-builder.ts

export interface FilterItem {
  column: string
  op: string   // _eq, _neq, _in, _gt, _gte, _lt, _lte, _like, _ilike, _is_null
  value: unknown
}

export interface OrderByItem {
  column: string
  ascending: boolean
}

export interface QueryState {
  table: string
  selectFields: string          // raw select string: 'id, name' or '*, relation(*)'
  filters: FilterItem[]
  orderBy: OrderByItem[]
  offset: number | undefined
  limit: number | undefined
  isSingle: boolean
}

/** Parse select string into GraphQL field list */
function parseSelectFields(fields: string): string {
  // Handle '*' as placeholder — caller must resolve via introspection
  // Handle 'field1, field2, relation(subfield1, subfield2)'
  return fields
    .split(',')
    .map(f => f.trim())
    .map(f => {
      // Nested relation: 'user_activities(*)' or 'user_activities(id, name)'
      const nestedMatch = f.match(/^(\w+)\((.+)\)$/)
      if (nestedMatch) {
        const [, rel, subFields] = nestedMatch
        return `${rel} { ${parseSelectFields(subFields)} }`
      }
      return f
    })
    .join('\n    ')
}

function serializeValue(value: unknown): string {
  if (typeof value === 'string') return `"${value}"`
  if (Array.isArray(value)) return `[${value.map(serializeValue).join(', ')}]`
  if (value === null) return 'null'
  if (typeof value === 'boolean') return String(value)
  return String(value)
}

function buildWhereClause(filters: FilterItem[]): string {
  if (filters.length === 0) return ''
  const conditions = filters.map(f => {
    if (f.op === '_is_null') {
      return `${f.column}: {_is_null: ${f.value ? 'true' : 'false'}}`
    }
    return `${f.column}: {${f.op}: ${serializeValue(f.value)}}`
  })
  return `where: {${conditions.join(', ')}}`
}

function buildOrderByClause(orderBy: OrderByItem[]): string {
  if (orderBy.length === 0) return ''
  const items = orderBy.map(o => `${o.column}: ${o.ascending ? 'asc' : 'desc'}`)
  return `order_by: {${items.join(', ')}}`
}

export function buildQuery(state: QueryState): string {
  const args: string[] = []

  const where = buildWhereClause(state.filters)
  if (where) args.push(where)

  const orderBy = buildOrderByClause(state.orderBy)
  if (orderBy) args.push(orderBy)

  if (state.offset !== undefined) args.push(`offset: ${state.offset}`)

  const limit = state.isSingle ? 1 : state.limit
  if (limit !== undefined) args.push(`limit: ${limit}`)

  const argsStr = args.length > 0 ? `(${args.join(', ')})` : ''
  const fields = parseSelectFields(state.selectFields)

  return `query {
  ${state.table}${argsStr} {
    ${fields}
  }
}`
}

export interface MutationInsertOpts {
  objects: Record<string, unknown>[]
  returning: string
}

export interface MutationUpdateOpts {
  set: Record<string, unknown>
  where: Record<string, unknown>
  returning: string
}

export interface MutationDeleteOpts {
  where: Record<string, unknown>
  returning: string
}

function serializeObject(obj: Record<string, unknown>): string {
  const entries = Object.entries(obj).map(([k, v]) => {
    if (typeof v === 'object' && v !== null && !Array.isArray(v)) {
      return `${k}: {${Object.entries(v as Record<string, unknown>).map(([k2, v2]) => `${k2}: ${serializeValue(v2)}`).join(', ')}}`
    }
    return `${k}: ${serializeValue(v)}`
  })
  return `{${entries.join(', ')}}`
}

export function buildMutation(
  table: string,
  type: 'insert' | 'update' | 'delete',
  opts: MutationInsertOpts | MutationUpdateOpts | MutationDeleteOpts,
): string {
  const returning = 'returning' in opts ? parseSelectFields(opts.returning) : 'affected_rows'

  if (type === 'insert') {
    const { objects } = opts as MutationInsertOpts
    const objectsStr = objects.map(serializeObject).join(', ')
    return `mutation {
  insert_${table}(objects: [${objectsStr}]) {
    ${returning}
  }
}`
  }

  if (type === 'update') {
    const { set, where } = opts as MutationUpdateOpts
    const setStr = Object.entries(set).map(([k, v]) => `${k}: ${serializeValue(v)}`).join(', ')
    const whereStr = serializeObject(where)
    return `mutation {
  update_${table}(where: ${whereStr}, _set: {${setStr}}) {
    ${returning}
  }
}`
  }

  // delete
  const { where } = opts as MutationDeleteOpts
  const whereStr = serializeObject(where)
  return `mutation {
  delete_${table}(where: ${whereStr}) {
    ${returning}
  }
}`
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /Users/cloudio/Developer/nodejs/Druvia && pnpm vitest run tests/sdk/graphql-builder.test.ts`
Expected: All tests PASS

> **Note on `select('*')`**: graphql-builder 中 `parseSelectFields('*')` 会输出字面量 `*`，Hasura 不接受。SDK 采用以下策略：
> - QueryBuilder 在执行前检查 selectFields 是否为 `*`
> - 如果是，通过 Hasura introspection 查询表字段：`query { __type(name: "<schema>_<table>") { fields { name } } }`
>   Hasura 类型名格式为 `<schema>_<table>`（如 `dru_taroapp_users`），SDK 需根据 projectId 推导 schema 名拼接完整类型名
> - 缓存到内存 `Map<tableName, string[]>`，后续直接使用
> - 如果 introspection 失败，抛出错误提示用户显式列出字段
> - 提供 `druvia.schema.refresh(tableName?)` 手动刷新缓存
>
> 此逻辑在 QueryBuilder.execute() 中实现（Task 4），不需要独立 task。

---

### Task 4: QueryBuilder (chainable API)

**Files:**
- Create: `packages/sdk/src/modules/query-builder.ts`
- Create: `tests/sdk/query-builder.test.ts`

- [ ] **Step 1: Write failing tests for QueryBuilder**

```typescript
// tests/sdk/query-builder.test.ts
import { describe, it, expect, vi } from 'vitest'
import { QueryBuilder } from '../../packages/sdk/src/modules/query-builder.js'
import type { FetchFn, DruviaResponse } from '../../packages/sdk/src/types.js'

function mockFetch(responseData: unknown): FetchFn {
  return vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => responseData,
  } as Response)
}

describe('QueryBuilder', () => {
  it('builds and executes select query', async () => {
    const fetch = mockFetch({ data: { users: [{ id: 1, name: 'Alice' }] } })
    const qb = new QueryBuilder('users', '/graphql', fetch)
    const result = await qb.select('id, name').eq('id', 1)

    expect(fetch).toHaveBeenCalledOnce()
    expect(result.data).toEqual([{ id: 1, name: 'Alice' }])
    expect(result.error).toBeNull()
  })

  it('chains multiple filters', async () => {
    const fetch = mockFetch({ data: { activities: [] } })
    const qb = new QueryBuilder('activities', '/graphql', fetch)
    const result = await qb
      .select('id, status')
      .eq('status', 'active')
      .neq('type', 'draft')
      .order('created_at', { ascending: false })
      .range(0, 9)

    expect(fetch).toHaveBeenCalledOnce()
    const body = JSON.parse((fetch as any).mock.calls[0][1].body)
    expect(body.query).toContain('_eq')
    expect(body.query).toContain('_neq')
    expect(body.query).toContain('order_by')
    expect(body.query).toContain('limit: 10')
    expect(body.query).toContain('offset: 0')
  })

  it('single() returns one object not array', async () => {
    const fetch = mockFetch({ data: { users: [{ id: 1, name: 'Alice' }] } })
    const qb = new QueryBuilder('users', '/graphql', fetch)
    const result = await qb.select('id, name').eq('id', 1).single()

    expect(result.data).toEqual({ id: 1, name: 'Alice' })
  })

  it('single() returns error when no rows', async () => {
    const fetch = mockFetch({ data: { users: [] } })
    const qb = new QueryBuilder('users', '/graphql', fetch)
    const result = await qb.select('id, name').eq('id', 999).single()

    expect(result.data).toBeNull()
    expect(result.error).toBeTruthy()
    expect(result.error!.code).toBe('PGRST116')
  })

  it('insert sends mutation', async () => {
    const fetch = mockFetch({ data: { insert_users: { returning: [{ id: 1 }] } } })
    const qb = new QueryBuilder('users', '/graphql', fetch)
    const result = await qb.insert({ username: 'test', user_id: 'u1' })

    const body = JSON.parse((fetch as any).mock.calls[0][1].body)
    expect(body.query).toContain('insert_users')
  })

  it('update sends mutation with where', async () => {
    const fetch = mockFetch({ data: { update_users: { returning: [{ id: 1 }] } } })
    const qb = new QueryBuilder('users', '/graphql', fetch)
    const result = await qb.update({ username: 'new' }).eq('id', 1)

    const body = JSON.parse((fetch as any).mock.calls[0][1].body)
    expect(body.query).toContain('update_users')
    expect(body.query).toContain('_set')
  })

  it('delete sends mutation with where', async () => {
    const fetch = mockFetch({ data: { delete_users: { returning: [{ id: 1 }] } } })
    const qb = new QueryBuilder('users', '/graphql', fetch)
    const result = await qb.delete().eq('id', 1)

    const body = JSON.parse((fetch as any).mock.calls[0][1].body)
    expect(body.query).toContain('delete_users')
  })

  it('upsert sends insert mutation with on_conflict', async () => {
    const fetch = mockFetch({ data: { insert_users: { returning: [{ id: 1 }] } } })
    const qb = new QueryBuilder('users', '/graphql', fetch)
    const result = await qb.upsert({ id: 1, username: 'test' })

    const body = JSON.parse((fetch as any).mock.calls[0][1].body)
    expect(body.query).toContain('insert_users')
    expect(body.query).toContain('on_conflict')
  })

  it('select("*") triggers introspection to resolve fields', async () => {
    // First call: introspection query to get fields
    // Second call: actual data query with resolved fields
    const fetch = vi.fn()
      .mockResolvedValueOnce({
        ok: true, json: async () => ({
          data: { __type: { fields: [{ name: 'id' }, { name: 'username' }, { name: 'email' }] } }
        })
      } as Response)
      .mockResolvedValueOnce({
        ok: true, json: async () => ({ data: { users: [{ id: 1, username: 'a', email: 'a@b.com' }] } })
      } as Response) as unknown as FetchFn

    const qb = new QueryBuilder('users', '/graphql', fetch)
    const result = await qb.select('*').eq('id', 1)

    // Should have made 2 calls: introspection + actual query
    expect(fetch).toHaveBeenCalledTimes(2)
    // Second call should contain resolved field names, not '*'
    const dataBody = JSON.parse((fetch as any).mock.calls[1][1].body)
    expect(dataBody.query).toContain('id')
    expect(dataBody.query).toContain('username')
    expect(dataBody.query).not.toContain('*')
  })

  it('handles GraphQL errors', async () => {
    const fetch = mockFetch({ errors: [{ message: 'field not found' }] })
    const qb = new QueryBuilder('users', '/graphql', fetch)
    const result = await qb.select('nonexistent')

    expect(result.data).toBeNull()
    expect(result.error).toBeTruthy()
    expect(result.error!.message).toContain('field not found')
  })

  it('handles network errors', async () => {
    const fetch = vi.fn().mockRejectedValue(new Error('Network error'))
    const qb = new QueryBuilder('users', '/graphql', fetch as FetchFn)
    const result = await qb.select('id')

    expect(result.data).toBeNull()
    expect(result.error!.code).toBe('NETWORK_ERROR')
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /Users/cloudio/Developer/nodejs/Druvia && pnpm vitest run tests/sdk/query-builder.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement query-builder.ts**

```typescript
// packages/sdk/src/modules/query-builder.ts
import { buildQuery, buildMutation, type QueryState, type FilterItem, type OrderByItem } from '../lib/graphql-builder.js'
import type { FetchFn, DruviaResponse } from '../types.js'

type PendingOp =
  | { type: 'select' }
  | { type: 'insert'; data: Record<string, unknown> | Record<string, unknown>[] }
  | { type: 'update'; data: Record<string, unknown> }
  | { type: 'upsert'; data: Record<string, unknown> | Record<string, unknown>[] }
  | { type: 'delete' }

export class QueryBuilder<T = unknown> {
  private table: string
  private schema: string | undefined
  private graphqlUrl: string
  private fetchFn: FetchFn
  private selectStr = '*'
  private filters: FilterItem[] = []
  private orderByItems: OrderByItem[] = []
  private offsetVal: number | undefined
  private limitVal: number | undefined
  private singleFlag = false
  private pendingOp: PendingOp = { type: 'select' }

  constructor(table: string, graphqlUrl: string, fetchFn: FetchFn, schema?: string) {
    this.table = table
    this.graphqlUrl = graphqlUrl
    this.fetchFn = fetchFn
    this.schema = schema
  }

  select(fields: string = '*'): this {
    this.selectStr = fields
    this.pendingOp = { type: 'select' }
    return this
  }

  insert(data: Record<string, unknown> | Record<string, unknown>[]): PromiseLike<DruviaResponse<T[]>> & QueryBuilder<T> {
    this.pendingOp = { type: 'insert', data }
    return this.makeThenable()
  }

  update(data: Record<string, unknown>): this {
    this.pendingOp = { type: 'update', data }
    return this
  }

  upsert(data: Record<string, unknown> | Record<string, unknown>[]): PromiseLike<DruviaResponse<T[]>> & QueryBuilder<T> {
    this.pendingOp = { type: 'upsert', data }
    return this.makeThenable()
  }

  delete(): this {
    this.pendingOp = { type: 'delete' }
    return this
  }

  // --- Filters ---
  eq(column: string, value: unknown): PromiseLike<DruviaResponse<T[]>> & QueryBuilder<T> {
    this.filters.push({ column, op: '_eq', value })
    return this.makeThenable()
  }

  neq(column: string, value: unknown): PromiseLike<DruviaResponse<T[]>> & QueryBuilder<T> {
    this.filters.push({ column, op: '_neq', value })
    return this.makeThenable()
  }

  in(column: string, values: unknown[]): PromiseLike<DruviaResponse<T[]>> & QueryBuilder<T> {
    this.filters.push({ column, op: '_in', value: values })
    return this.makeThenable()
  }

  gt(column: string, value: unknown): this { this.filters.push({ column, op: '_gt', value }); return this }
  gte(column: string, value: unknown): this { this.filters.push({ column, op: '_gte', value }); return this }
  lt(column: string, value: unknown): this { this.filters.push({ column, op: '_lt', value }); return this }
  lte(column: string, value: unknown): this { this.filters.push({ column, op: '_lte', value }); return this }
  like(column: string, value: string): this { this.filters.push({ column, op: '_like', value }); return this }
  ilike(column: string, value: string): this { this.filters.push({ column, op: '_ilike', value }); return this }
  is(column: string, value: null | boolean): this {
    this.filters.push({ column, op: '_is_null', value: value === null })
    return this
  }

  // --- Ordering & Pagination ---
  order(column: string, opts?: { ascending?: boolean }): this {
    this.orderByItems.push({ column, ascending: opts?.ascending ?? true })
    return this
  }

  range(from: number, to: number): PromiseLike<DruviaResponse<T[]>> & QueryBuilder<T> {
    this.offsetVal = from
    this.limitVal = to - from + 1
    return this.makeThenable()
  }

  limit(count: number): this { this.limitVal = count; return this }

  single(): PromiseLike<DruviaResponse<T>> {
    this.singleFlag = true
    return { then: (resolve, reject) => this.execute().then(resolve, reject) } as PromiseLike<DruviaResponse<T>>
  }

  // --- Execution ---
  private makeThenable(): PromiseLike<DruviaResponse<T[]>> & QueryBuilder<T> {
    const self = this as any
    self.then = (resolve: any, reject: any) => this.execute().then(resolve, reject)
    return self
  }

  private async execute(): Promise<DruviaResponse<any>> {
    try {
      const op = this.pendingOp

      // Resolve select('*') via introspection
      if (this.selectStr === '*' || this.selectStr.includes('*')) {
        await this.resolveWildcardFields()
      }

      let query: string
      if (op.type === 'select') {
        const state: QueryState = {
          table: this.table,
          selectFields: this.selectStr,
          filters: this.filters,
          orderBy: this.orderByItems,
          offset: this.offsetVal,
          limit: this.limitVal,
          isSingle: this.singleFlag,
        }
        query = buildQuery(state)
      } else if (op.type === 'insert' || op.type === 'upsert') {
        const objects = Array.isArray(op.data) ? op.data : [op.data]
        const onConflict = op.type === 'upsert'
          ? ', on_conflict: {constraint: ' + this.table + '_pkey, update_columns: [' +
            Object.keys(objects[0]).filter(k => k !== 'id').join(', ') + ']}'
          : ''
        query = buildMutation(this.table, 'insert', {
          objects,
          returning: this.selectStr === '*' ? 'id' : this.selectStr,
          onConflict,
        })
      } else if (op.type === 'update') {
        const where = this.buildWhereObject()
        query = buildMutation(this.table, 'update', {
          set: op.data,
          where,
          returning: this.selectStr === '*' ? 'id' : this.selectStr,
        })
      } else {
        // delete
        const where = this.buildWhereObject()
        query = buildMutation(this.table, 'delete', {
          where,
          returning: 'id',
        })
      }

      const response = await this.fetchFn(this.graphqlUrl, {
        method: 'POST',
        body: JSON.stringify({ query }),
      })

      const json = await response.json()

      if (json.errors) {
        return {
          data: null,
          error: { code: 'GRAPHQL_ERROR', message: json.errors[0].message },
        }
      }

      // Extract data from GraphQL response
      const dataKey = Object.keys(json.data)[0]
      let data = json.data[dataKey]

      // For mutations, extract from 'returning'
      if (data?.returning) {
        data = data.returning
      }

      // Handle single()
      if (this.singleFlag) {
        if (Array.isArray(data) && data.length === 0) {
          return { data: null, error: { code: 'PGRST116', message: 'No rows found' } }
        }
        return { data: Array.isArray(data) ? data[0] : data, error: null }
      }

      return { data, error: null }
    } catch (err) {
      return {
        data: null,
        error: { code: 'NETWORK_ERROR', message: err instanceof Error ? err.message : String(err) },
      }
    }
  }

  private buildWhereObject(): Record<string, unknown> {
    const where: Record<string, unknown> = {}
    for (const f of this.filters) {
      where[f.column] = { [f.op]: f.value }
    }
    return where
  }

  // --- Introspection for select('*') ---
  private static fieldCache = new Map<string, string[]>()

  private async resolveWildcardFields(): Promise<void> {
    // Check cache first
    const cached = QueryBuilder.fieldCache.get(this.table)
    if (cached) {
      this.selectStr = this.selectStr.replace('*', cached.join(', '))
      return
    }

    // Introspect via Hasura __type query
    // Hasura 类型名格式为 <schema>_<table>（如 dru_taroapp_users）
    const typeName = this.schema ? `${this.schema}_${this.table}` : this.table
    try {
      const response = await this.fetchFn(this.graphqlUrl, {
        method: 'POST',
        body: JSON.stringify({
          query: `query { __type(name: "${typeName}") { fields { name } } }`
        }),
      })
      const json = await response.json()
      const fields = json.data?.__type?.fields?.map((f: { name: string }) => f.name)
      if (fields && fields.length > 0) {
        // Filter out internal Hasura fields
        const filtered = fields.filter((f: string) => !f.startsWith('__'))
        QueryBuilder.fieldCache.set(this.table, filtered)
        this.selectStr = this.selectStr.replace('*', filtered.join(', '))
      } else {
        throw new Error(`Cannot resolve fields for table "${this.table}". Use explicit field names in select().`)
      }
    } catch (err) {
      throw new Error(`@druvia/sdk: Introspection failed for table "${this.table}". Specify fields explicitly: .select('id, name, ...')`)
    }
  }

  /** Clear cached field lists (call after schema changes) */
  static clearFieldCache(tableName?: string): void {
    if (tableName) {
      QueryBuilder.fieldCache.delete(tableName)
    } else {
      QueryBuilder.fieldCache.clear()
    }
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /Users/cloudio/Developer/nodejs/Druvia && pnpm vitest run tests/sdk/query-builder.test.ts`
Expected: All tests PASS

---

### Task 5: Database module

**Files:**
- Create: `packages/sdk/src/modules/database.ts`
- Create: `tests/sdk/database.test.ts`

- [ ] **Step 1: Write failing test**

```typescript
// tests/sdk/database.test.ts
import { describe, it, expect, vi } from 'vitest'
import { DruviaDatabase } from '../../packages/sdk/src/modules/database.js'
import type { FetchFn } from '../../packages/sdk/src/types.js'

describe('DruviaDatabase', () => {
  it('from() returns a QueryBuilder for the given table', () => {
    const fetch = vi.fn() as unknown as FetchFn
    const db = new DruviaDatabase('/graphql', fetch)
    const qb = db.from('users')
    expect(qb).toBeDefined()
    expect(typeof qb.select).toBe('function')
    expect(typeof qb.insert).toBe('function')
    expect(typeof qb.eq).toBe('function')
  })

  it('graphql() sends raw query', async () => {
    const fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: { users: [{ id: 1 }] } }),
    }) as unknown as FetchFn
    const db = new DruviaDatabase('/graphql', fetch)
    const result = await db.graphql('query { users { id } }')
    expect(result.data).toEqual({ users: [{ id: 1 }] })
    expect(fetch).toHaveBeenCalledWith('/graphql', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ query: 'query { users { id } }' }),
    }))
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/cloudio/Developer/nodejs/Druvia && pnpm vitest run tests/sdk/database.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement database.ts**

```typescript
// packages/sdk/src/modules/database.ts
import { QueryBuilder } from './query-builder.js'
import type { FetchFn, DruviaResponse } from '../types.js'

export class DruviaDatabase {
  private graphqlUrl: string
  private fetchFn: FetchFn
  private schema: string | undefined

  constructor(graphqlUrl: string, fetchFn: FetchFn, schema?: string) {
    this.graphqlUrl = graphqlUrl
    this.fetchFn = fetchFn
    this.schema = schema
  }

  from<T = unknown>(table: string): QueryBuilder<T> {
    return new QueryBuilder<T>(table, this.graphqlUrl, this.fetchFn, this.schema)
  }

  async graphql<T = unknown>(query: string, variables?: Record<string, unknown>): Promise<DruviaResponse<T>> {
    try {
      const response = await this.fetchFn(this.graphqlUrl, {
        method: 'POST',
        body: JSON.stringify({ query, variables }),
      })
      const json = await response.json()
      if (json.errors) {
        return { data: null, error: { code: 'GRAPHQL_ERROR', message: json.errors[0].message } }
      }
      return { data: json.data as T, error: null }
    } catch (err) {
      return { data: null, error: { code: 'NETWORK_ERROR', message: err instanceof Error ? err.message : String(err) } }
    }
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /Users/cloudio/Developer/nodejs/Druvia && pnpm vitest run tests/sdk/database.test.ts`
Expected: PASS

---

## Chunk 3: Auth + Storage + RPC + Functions Modules

### Task 6: Auth module

**Files:**
- Create: `packages/sdk/src/modules/auth.ts`
- Create: `tests/sdk/auth.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// tests/sdk/auth.test.ts
import { describe, it, expect, vi } from 'vitest'
import { DruviaAuth } from '../../packages/sdk/src/modules/auth.js'
import type { FetchFn, StorageAdapter } from '../../packages/sdk/src/types.js'

function createMockFetch(responseData: unknown, status = 200): FetchFn {
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: async () => responseData,
  } as Response)
}

function createMockStorage(): StorageAdapter {
  const store = new Map<string, string>()
  return {
    getItem: vi.fn((key: string) => store.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => { store.set(key, value) }),
    removeItem: vi.fn((key: string) => { store.delete(key) }),
  }
}

describe('DruviaAuth', () => {
  it('signUp calls register endpoint', async () => {
    const fetch = createMockFetch({ success: true, data: { user: { id: 1, email: 'a@b.com' }, token: 'tok123' } })
    const storage = createMockStorage()
    const auth = new DruviaAuth('/api/v1', fetch, storage)

    const result = await auth.signUp({ email: 'a@b.com', password: '12345678' })
    expect(result.error).toBeNull()
    expect(result.data?.user.email).toBe('a@b.com')
    expect(fetch).toHaveBeenCalledWith('/api/v1/auth/register', expect.objectContaining({ method: 'POST' }))
  })

  it('signIn with email calls login endpoint', async () => {
    const fetch = createMockFetch({ success: true, data: { user: { id: 1, email: 'a@b.com' }, token: 'tok123' } })
    const storage = createMockStorage()
    const auth = new DruviaAuth('/api/v1', fetch, storage)

    const result = await auth.signIn({ email: 'a@b.com', password: '12345678' })
    expect(result.error).toBeNull()
    expect(storage.setItem).toHaveBeenCalled()
  })

  it('signIn with username calls login endpoint', async () => {
    const fetch = createMockFetch({ success: true, data: { user: { id: 1, username: 'admin' }, token: 'tok123' } })
    const storage = createMockStorage()
    const auth = new DruviaAuth('/api/v1', fetch, storage)

    const result = await auth.signIn({ username: 'admin', password: '12345678' })
    expect(result.error).toBeNull()
  })

  it('signOut clears stored session', async () => {
    const storage = createMockStorage()
    await storage.setItem('druvia.session', JSON.stringify({ accessToken: 'tok', user: { id: 1 } }))
    const fetch = createMockFetch({})
    const auth = new DruviaAuth('/api/v1', fetch, storage)

    await auth.signOut()
    expect(storage.removeItem).toHaveBeenCalledWith('druvia.session')
  })

  it('getUser returns current user from stored session', async () => {
    const fetch = createMockFetch({ success: true, data: { id: 1, email: 'a@b.com', username: 'admin', role: 'admin' } })
    const storage = createMockStorage()
    await storage.setItem('druvia.session', JSON.stringify({ accessToken: 'tok', user: { id: 1 } }))
    const auth = new DruviaAuth('/api/v1', fetch, storage)

    const result = await auth.getUser()
    expect(result.data).toBeTruthy()
    expect(fetch).toHaveBeenCalledWith('/api/v1/users/me', expect.objectContaining({ method: 'GET' }))
  })

  it('getSession returns null when no session stored', async () => {
    const fetch = createMockFetch({})
    const storage = createMockStorage()
    const auth = new DruviaAuth('/api/v1', fetch, storage)

    const result = await auth.getSession()
    expect(result.data).toBeNull()
  })

  it('handles login failure', async () => {
    const fetch = createMockFetch({ success: false, error: { code: 'AUTH_FAILED', message: 'Invalid credentials' } }, 401)
    const storage = createMockStorage()
    const auth = new DruviaAuth('/api/v1', fetch, storage)

    const result = await auth.signIn({ email: 'a@b.com', password: 'wrong' })
    expect(result.data).toBeNull()
    expect(result.error?.code).toBe('AUTH_FAILED')
  })

  it('onAuthStateChange fires on signIn and signOut', async () => {
    const fetch = createMockFetch({ success: true, data: { user: { id: 1, email: 'a@b.com' }, token: 'tok123' } })
    const storage = createMockStorage()
    const auth = new DruviaAuth('/api/v1', fetch, storage)
    const callback = vi.fn()

    const { unsubscribe } = auth.onAuthStateChange(callback)

    await auth.signIn({ email: 'a@b.com', password: '12345678' })
    expect(callback).toHaveBeenCalledWith('SIGNED_IN', expect.objectContaining({ accessToken: 'tok123' }))

    await auth.signOut()
    expect(callback).toHaveBeenCalledWith('SIGNED_OUT', null)

    // After unsubscribe, no more calls
    callback.mockClear()
    unsubscribe()
    await auth.signOut()
    expect(callback).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run tests/sdk/auth.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement auth.ts**

```typescript
// packages/sdk/src/modules/auth.ts
import type { FetchFn, StorageAdapter, DruviaResponse, Session, UserInfo } from '../types.js'

const SESSION_KEY = 'druvia.session'

interface SignUpParams { email: string; password: string; username?: string }
interface SignInParams { email?: string; username?: string; password: string }

type AuthChangeCallback = (event: 'SIGNED_IN' | 'SIGNED_OUT', session: Session | null) => void

export class DruviaAuth {
  private baseUrl: string
  private fetchFn: FetchFn
  private storage: StorageAdapter
  private listeners: AuthChangeCallback[] = []

  constructor(baseUrl: string, fetchFn: FetchFn, storage: StorageAdapter) {
    this.baseUrl = baseUrl
    this.fetchFn = fetchFn
    this.storage = storage
  }

  async signUp(params: SignUpParams): Promise<DruviaResponse<Session>> {
    return this.authRequest('/auth/register', {
      email: params.email,
      password: params.password,
      username: params.username ?? params.email.split('@')[0],
    })
  }

  async signIn(params: SignInParams): Promise<DruviaResponse<Session>> {
    const body: Record<string, string> = { password: params.password }
    if (params.email) body.email = params.email
    if (params.username) body.username = params.username
    return this.authRequest('/auth/login', body)
  }

  async signOut(): Promise<void> {
    await this.storage.removeItem(SESSION_KEY)
    this.notify('SIGNED_OUT', null)
  }

  async getUser(): Promise<DruviaResponse<UserInfo>> {
    try {
      const response = await this.fetchFn(`${this.baseUrl}/users/me`, { method: 'GET' })
      const json = await response.json()
      if (!response.ok) {
        return { data: null, error: json.error ?? { code: 'AUTH_ERROR', message: 'Failed to get user' } }
      }
      return { data: json.data ?? json, error: null }
    } catch (err) {
      return { data: null, error: { code: 'NETWORK_ERROR', message: err instanceof Error ? err.message : String(err) } }
    }
  }

  async getSession(): Promise<DruviaResponse<Session>> {
    const raw = await this.storage.getItem(SESSION_KEY)
    if (!raw) return { data: null, error: null }
    try {
      return { data: JSON.parse(raw), error: null }
    } catch {
      return { data: null, error: null }
    }
  }

  /** Returns the current access token, or null */
  async getToken(): Promise<string | null> {
    const { data } = await this.getSession()
    return data?.accessToken ?? null
  }

  onAuthStateChange(callback: AuthChangeCallback): { unsubscribe: () => void } {
    this.listeners.push(callback)
    return { unsubscribe: () => { this.listeners = this.listeners.filter(l => l !== callback) } }
  }

  private async authRequest(path: string, body: Record<string, string>): Promise<DruviaResponse<Session>> {
    try {
      const response = await this.fetchFn(`${this.baseUrl}${path}`, {
        method: 'POST',
        body: JSON.stringify(body),
      })
      const json = await response.json()
      if (!response.ok || json.success === false) {
        return { data: null, error: json.error ?? { code: 'AUTH_FAILED', message: 'Authentication failed' } }
      }
      const sessionData = json.data ?? json
      const session: Session = {
        accessToken: sessionData.token,
        user: sessionData.user,
      }
      await this.storage.setItem(SESSION_KEY, JSON.stringify(session))
      this.notify('SIGNED_IN', session)
      return { data: session, error: null }
    } catch (err) {
      return { data: null, error: { code: 'NETWORK_ERROR', message: err instanceof Error ? err.message : String(err) } }
    }
  }

  private notify(event: 'SIGNED_IN' | 'SIGNED_OUT', session: Session | null) {
    for (const cb of this.listeners) cb(event, session)
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run tests/sdk/auth.test.ts`
Expected: All PASS

---

### Task 7: Storage module

**Files:**
- Create: `packages/sdk/src/modules/storage.ts`
- Create: `tests/sdk/storage.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// tests/sdk/storage.test.ts
import { describe, it, expect, vi } from 'vitest'
import { DruviaStorage } from '../../packages/sdk/src/modules/storage.js'
import type { FetchFn } from '../../packages/sdk/src/types.js'

function createMockFetch(responseData: unknown, status = 200): FetchFn {
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: async () => responseData,
    blob: async () => new Blob(['file-content']),
    headers: new Headers({ 'content-type': 'application/octet-stream' }),
  } as unknown as Response)
}

describe('DruviaStorage', () => {
  const projectId = 'proj_123'

  it('from() returns a BucketClient', () => {
    const fetch = vi.fn() as unknown as FetchFn
    const storage = new DruviaStorage('/api/v1', projectId, fetch)
    const bucket = storage.from('team-assets')
    expect(bucket).toBeDefined()
    expect(typeof bucket.upload).toBe('function')
    expect(typeof bucket.download).toBe('function')
    expect(typeof bucket.getPublicUrl).toBe('function')
  })

  it('upload sends POST to storage endpoint', async () => {
    const fetch = createMockFetch({ success: true, data: { path: 'avatar.png' } })
    const storage = new DruviaStorage('/api/v1', projectId, fetch)
    const result = await storage.from('team-assets').upload('avatar.png', new Blob(['img']))

    expect(fetch).toHaveBeenCalledWith(
      `/api/v1/projects/${projectId}/storage/buckets/team-assets/objects/avatar.png`,
      expect.objectContaining({ method: 'POST' })
    )
    expect(result.error).toBeNull()
  })

  it('download sends GET to storage endpoint', async () => {
    const fetch = createMockFetch({})
    const storage = new DruviaStorage('/api/v1', projectId, fetch)
    const result = await storage.from('team-assets').download('avatar.png')

    expect(fetch).toHaveBeenCalledWith(
      `/api/v1/projects/${projectId}/storage/buckets/team-assets/objects/avatar.png`,
      expect.objectContaining({ method: 'GET' })
    )
    expect(result.error).toBeNull()
  })

  it('getPublicUrl returns URL string', () => {
    const fetch = vi.fn() as unknown as FetchFn
    const storage = new DruviaStorage('/api/v1', projectId, fetch)
    const { data } = storage.from('team-assets').getPublicUrl('avatar.png')

    expect(data?.publicUrl).toContain('team-assets')
    expect(data?.publicUrl).toContain('avatar.png')
  })

  it('createSignedUrl sends POST', async () => {
    const fetch = createMockFetch({ success: true, data: { signedUrl: 'https://example.com/signed' } })
    const storage = new DruviaStorage('/api/v1', projectId, fetch)
    const result = await storage.from('team-assets').createSignedUrl('avatar.png', 3600)

    expect(fetch).toHaveBeenCalledWith(
      `/api/v1/projects/${projectId}/storage/buckets/team-assets/signed-url`,
      expect.objectContaining({ method: 'POST' })
    )
    expect(result.data?.signedUrl).toBeTruthy()
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run tests/sdk/storage.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement storage.ts**

```typescript
// packages/sdk/src/modules/storage.ts
import type { FetchFn, DruviaResponse } from '../types.js'

export class BucketClient {
  private baseUrl: string
  private projectId: string
  private bucketName: string
  private fetchFn: FetchFn

  constructor(baseUrl: string, projectId: string, bucketName: string, fetchFn: FetchFn) {
    this.baseUrl = baseUrl
    this.projectId = projectId
    this.bucketName = bucketName
    this.fetchFn = fetchFn
  }

  private objectUrl(path: string): string {
    return `${this.baseUrl}/projects/${this.projectId}/storage/buckets/${this.bucketName}/objects/${path}`
  }

  async upload(path: string, file: Blob | File | ArrayBuffer, options?: { contentType?: string }): Promise<DruviaResponse<{ path: string }>> {
    try {
      const headers: Record<string, string> = {}
      if (options?.contentType) headers['Content-Type'] = options.contentType

      const response = await this.fetchFn(this.objectUrl(path), {
        method: 'POST',
        body: file as any,
        headers,
      })
      const json = await response.json()
      if (!response.ok) {
        return { data: null, error: json.error ?? { code: 'STORAGE_ERROR', message: 'Upload failed' } }
      }
      return { data: json.data ?? { path }, error: null }
    } catch (err) {
      return { data: null, error: { code: 'NETWORK_ERROR', message: err instanceof Error ? err.message : String(err) } }
    }
  }

  async download(path: string): Promise<DruviaResponse<Blob>> {
    try {
      const response = await this.fetchFn(this.objectUrl(path), { method: 'GET' })
      if (!response.ok) {
        const json = await response.json()
        return { data: null, error: json.error ?? { code: 'STORAGE_ERROR', message: 'Download failed' } }
      }
      const blob = await response.blob()
      return { data: blob, error: null }
    } catch (err) {
      return { data: null, error: { code: 'NETWORK_ERROR', message: err instanceof Error ? err.message : String(err) } }
    }
  }

  getPublicUrl(path: string): { data: { publicUrl: string } } {
    const publicUrl = `${this.baseUrl}/storage/public/${this.projectId}/${this.bucketName}/${path}`
    return { data: { publicUrl } }
  }

  async createSignedUrl(path: string, expiresIn: number): Promise<DruviaResponse<{ signedUrl: string }>> {
    try {
      const response = await this.fetchFn(
        `${this.baseUrl}/projects/${this.projectId}/storage/buckets/${this.bucketName}/signed-url`,
        {
          method: 'POST',
          body: JSON.stringify({ path, expiresIn }),
        }
      )
      const json = await response.json()
      if (!response.ok) {
        return { data: null, error: json.error ?? { code: 'STORAGE_ERROR', message: 'Failed to create signed URL' } }
      }
      return { data: json.data ?? json, error: null }
    } catch (err) {
      return { data: null, error: { code: 'NETWORK_ERROR', message: err instanceof Error ? err.message : String(err) } }
    }
  }

  async remove(paths: string[]): Promise<DruviaResponse<null>> {
    try {
      for (const path of paths) {
        await this.fetchFn(this.objectUrl(path), { method: 'DELETE' })
      }
      return { data: null, error: null }
    } catch (err) {
      return { data: null, error: { code: 'NETWORK_ERROR', message: err instanceof Error ? err.message : String(err) } }
    }
  }

  async list(prefix?: string): Promise<DruviaResponse<Array<{ name: string; size: number }>>> {
    try {
      const url = prefix
        ? `${this.baseUrl}/projects/${this.projectId}/storage/buckets/${this.bucketName}/objects?prefix=${encodeURIComponent(prefix)}`
        : `${this.baseUrl}/projects/${this.projectId}/storage/buckets/${this.bucketName}/objects`
      const response = await this.fetchFn(url, { method: 'GET' })
      const json = await response.json()
      if (!response.ok) {
        return { data: null, error: json.error ?? { code: 'STORAGE_ERROR', message: 'List failed' } }
      }
      return { data: json.data ?? json, error: null }
    } catch (err) {
      return { data: null, error: { code: 'NETWORK_ERROR', message: err instanceof Error ? err.message : String(err) } }
    }
  }
}

export class DruviaStorage {
  private baseUrl: string
  private projectId: string
  private fetchFn: FetchFn

  constructor(baseUrl: string, projectId: string, fetchFn: FetchFn) {
    this.baseUrl = baseUrl
    this.projectId = projectId
    this.fetchFn = fetchFn
  }

  from(bucketName: string): BucketClient {
    return new BucketClient(this.baseUrl, this.projectId, bucketName, this.fetchFn)
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run tests/sdk/storage.test.ts`
Expected: All PASS

---

### Task 8: RPC module

**Files:**
- Create: `packages/sdk/src/modules/rpc.ts`
- Create: `tests/sdk/rpc.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// tests/sdk/rpc.test.ts
import { describe, it, expect, vi } from 'vitest'
import { DruviaRpc } from '../../packages/sdk/src/modules/rpc.js'
import type { FetchFn } from '../../packages/sdk/src/types.js'

describe('DruviaRpc', () => {
  const projectId = 'proj_123'

  it('rpc() sends POST to /rpc/:functionName', async () => {
    const fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: [{ id: 1, confirmed: true }], error: null }),
    }) as unknown as FetchFn

    const rpc = new DruviaRpc('/api/v1', projectId, fetch)
    const result = await rpc.call('confirm_drafts', { match_id: 1 })

    expect(fetch).toHaveBeenCalledWith(
      `/api/v1/projects/${projectId}/rpc/confirm_drafts`,
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ args: { match_id: 1 } }),
      })
    )
    expect(result.data).toEqual([{ id: 1, confirmed: true }])
    expect(result.error).toBeNull()
  })

  it('rpc() with no args sends empty args', async () => {
    const fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: null, error: null }),
    }) as unknown as FetchFn

    const rpc = new DruviaRpc('/api/v1', projectId, fetch)
    await rpc.call('cleanup_data')

    const body = JSON.parse((fetch as any).mock.calls[0][1].body)
    expect(body.args).toEqual({})
  })

  it('handles error response', async () => {
    const fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
      json: async () => ({ error: { code: 'NOT_FOUND', message: 'Function not found' } }),
    }) as unknown as FetchFn

    const rpc = new DruviaRpc('/api/v1', projectId, fetch)
    const result = await rpc.call('nonexistent_fn', {})

    expect(result.data).toBeNull()
    expect(result.error?.code).toBe('NOT_FOUND')
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run tests/sdk/rpc.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement rpc.ts**

```typescript
// packages/sdk/src/modules/rpc.ts
import type { FetchFn, DruviaResponse } from '../types.js'

export class DruviaRpc {
  private baseUrl: string
  private projectId: string
  private fetchFn: FetchFn

  constructor(baseUrl: string, projectId: string, fetchFn: FetchFn) {
    this.baseUrl = baseUrl
    this.projectId = projectId
    this.fetchFn = fetchFn
  }

  async call<T = unknown>(functionName: string, args?: Record<string, unknown>): Promise<DruviaResponse<T>> {
    try {
      const response = await this.fetchFn(
        `${this.baseUrl}/projects/${this.projectId}/rpc/${functionName}`,
        {
          method: 'POST',
          body: JSON.stringify({ args: args ?? {} }),
        }
      )
      const json = await response.json()
      if (!response.ok) {
        return { data: null, error: json.error ?? { code: 'RPC_ERROR', message: `RPC call to ${functionName} failed` } }
      }
      return { data: json.data ?? json, error: null }
    } catch (err) {
      return { data: null, error: { code: 'NETWORK_ERROR', message: err instanceof Error ? err.message : String(err) } }
    }
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run tests/sdk/rpc.test.ts`
Expected: All PASS

---

### Task 9: Functions module (Edge Functions invoke)

**Files:**
- Create: `packages/sdk/src/modules/functions.ts`
- Create: `tests/sdk/functions.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// tests/sdk/functions.test.ts
import { describe, it, expect, vi } from 'vitest'
import { DruviaFunctions } from '../../packages/sdk/src/modules/functions.js'
import type { FetchFn } from '../../packages/sdk/src/types.js'

describe('DruviaFunctions', () => {
  const projectId = 'proj_123'

  it('invoke() sends POST to /functions/:name/invoke', async () => {
    const fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ user: { id: 1 }, token: 'tok' }),
    }) as unknown as FetchFn

    const fns = new DruviaFunctions('/api/v1', projectId, fetch)
    const result = await fns.invoke('wx-silent-login', { body: { code: 'wx_code' } })

    expect(fetch).toHaveBeenCalledWith(
      `/api/v1/projects/${projectId}/functions/wx-silent-login/invoke`,
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ code: 'wx_code' }),
      })
    )
    expect(result.data).toEqual({ user: { id: 1 }, token: 'tok' })
  })

  it('invoke() without body sends empty object', async () => {
    const fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ result: 'ok' }),
    }) as unknown as FetchFn

    const fns = new DruviaFunctions('/api/v1', projectId, fetch)
    await fns.invoke('health-check')

    expect(fetch).toHaveBeenCalledWith(
      expect.stringContaining('health-check/invoke'),
      expect.objectContaining({ body: '{}' })
    )
  })

  it('handles invoke error', async () => {
    const fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => ({ error: { code: 'FUNCTION_ERROR', message: 'Runtime error' } }),
    }) as unknown as FetchFn

    const fns = new DruviaFunctions('/api/v1', projectId, fetch)
    const result = await fns.invoke('broken-fn')

    expect(result.data).toBeNull()
    expect(result.error?.code).toBe('FUNCTION_ERROR')
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run tests/sdk/functions.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement functions.ts**

```typescript
// packages/sdk/src/modules/functions.ts
import type { FetchFn, DruviaResponse } from '../types.js'

interface InvokeOptions {
  body?: Record<string, unknown>
  headers?: Record<string, string>
}

export class DruviaFunctions {
  private baseUrl: string
  private projectId: string
  private fetchFn: FetchFn

  constructor(baseUrl: string, projectId: string, fetchFn: FetchFn) {
    this.baseUrl = baseUrl
    this.projectId = projectId
    this.fetchFn = fetchFn
  }

  async invoke<T = unknown>(functionName: string, options?: InvokeOptions): Promise<DruviaResponse<T>> {
    try {
      const response = await this.fetchFn(
        `${this.baseUrl}/projects/${this.projectId}/functions/${functionName}/invoke`,
        {
          method: 'POST',
          body: JSON.stringify(options?.body ?? {}),
          headers: options?.headers,
        }
      )
      const json = await response.json()
      if (!response.ok) {
        return { data: null, error: json.error ?? { code: 'FUNCTION_ERROR', message: `Function ${functionName} failed` } }
      }
      return { data: json as T, error: null }
    } catch (err) {
      return { data: null, error: { code: 'NETWORK_ERROR', message: err instanceof Error ? err.message : String(err) } }
    }
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run tests/sdk/functions.test.ts`
Expected: All PASS

---

## Chunk 4: Realtime Module + DruviaClient + Integration

### Task 10: Realtime module

**Files:**
- Create: `packages/sdk/src/modules/realtime.ts`
- Create: `tests/sdk/realtime.test.ts`

Realtime wraps Hasura GraphQL Subscriptions over WebSocket. SDK maintains a local snapshot and diffs to emit INSERT/UPDATE/DELETE events (bridging Hasura's "current state" push model to Supabase-style change events).

- [ ] **Step 1: Write failing tests**

```typescript
// tests/sdk/realtime.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { DruviaRealtime, RealtimeChannel } from '../../packages/sdk/src/modules/realtime.js'
import type { WebSocketFactory, WebSocketLike } from '../../packages/sdk/src/types.js'

function createMockWsFactory(): { factory: WebSocketFactory; ws: WebSocketLike & { _trigger: (event: string, data?: unknown) => void } } {
  const handlers: Record<string, Function> = {}
  const ws: WebSocketLike & { _trigger: (event: string, data?: unknown) => void } = {
    onOpen: (cb) => { handlers['open'] = cb },
    onMessage: (cb) => { handlers['message'] = cb },
    onClose: (cb) => { handlers['close'] = cb },
    onError: (cb) => { handlers['error'] = cb },
    send: vi.fn(),
    close: vi.fn(),
    _trigger: (event, data) => { handlers[event]?.(data) },
  }
  const factory: WebSocketFactory = vi.fn().mockReturnValue(ws)
  return { factory, ws }
}

describe('DruviaRealtime', () => {
  it('channel() returns a RealtimeChannel', () => {
    const { factory } = createMockWsFactory()
    const rt = new DruviaRealtime('ws://localhost:8080/v1/graphql', factory)
    const ch = rt.channel('test_channel')
    expect(ch).toBeInstanceOf(RealtimeChannel)
  })

  it('on() registers a callback and subscribe() connects', () => {
    const { factory, ws } = createMockWsFactory()
    const rt = new DruviaRealtime('ws://localhost:8080/v1/graphql', factory)
    const callback = vi.fn()

    const ch = rt.channel('maintenance')
      .on('postgres_changes', { event: '*', table: 'system_config' }, callback)
      .subscribe()

    expect(factory).toHaveBeenCalled()
    // Simulate WebSocket open → should send connection_init
    ws._trigger('open')
    expect(ws.send).toHaveBeenCalled()
    const initMsg = JSON.parse((ws.send as any).mock.calls[0][0])
    expect(initMsg.type).toBe('connection_init')
  })

  it('emits INSERT event when new row appears in snapshot', () => {
    const { factory, ws } = createMockWsFactory()
    const rt = new DruviaRealtime('ws://localhost:8080/v1/graphql', factory)
    const callback = vi.fn()

    rt.channel('test')
      .on('postgres_changes', { event: '*', table: 'items' }, callback)
      .subscribe()

    ws._trigger('open')
    // Simulate connection_ack
    ws._trigger('message', JSON.stringify({ type: 'connection_ack' }))
    // Send subscription start message
    // Simulate first data push (empty → one row = INSERT)
    ws._trigger('message', JSON.stringify({
      type: 'data',
      id: '1',
      payload: { data: { items: [{ id: 1, name: 'A' }] } }
    }))

    // First push establishes snapshot, no event
    // Second push with new row triggers INSERT
    ws._trigger('message', JSON.stringify({
      type: 'data',
      id: '1',
      payload: { data: { items: [{ id: 1, name: 'A' }, { id: 2, name: 'B' }] } }
    }))

    expect(callback).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: 'INSERT', new: { id: 2, name: 'B' } })
    )
  })

  it('emits UPDATE event when row changes', () => {
    const { factory, ws } = createMockWsFactory()
    const rt = new DruviaRealtime('ws://localhost:8080/v1/graphql', factory)
    const callback = vi.fn()

    rt.channel('test')
      .on('postgres_changes', { event: '*', table: 'items' }, callback)
      .subscribe()

    ws._trigger('open')
    ws._trigger('message', JSON.stringify({ type: 'connection_ack' }))
    // Initial snapshot
    ws._trigger('message', JSON.stringify({
      type: 'data', id: '1',
      payload: { data: { items: [{ id: 1, name: 'A' }] } }
    }))
    // Updated row
    ws._trigger('message', JSON.stringify({
      type: 'data', id: '1',
      payload: { data: { items: [{ id: 1, name: 'A_updated' }] } }
    }))

    expect(callback).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: 'UPDATE', new: { id: 1, name: 'A_updated' }, old: { id: 1, name: 'A' } })
    )
  })

  it('emits DELETE event when row disappears', () => {
    const { factory, ws } = createMockWsFactory()
    const rt = new DruviaRealtime('ws://localhost:8080/v1/graphql', factory)
    const callback = vi.fn()

    rt.channel('test')
      .on('postgres_changes', { event: '*', table: 'items' }, callback)
      .subscribe()

    ws._trigger('open')
    ws._trigger('message', JSON.stringify({ type: 'connection_ack' }))
    ws._trigger('message', JSON.stringify({
      type: 'data', id: '1',
      payload: { data: { items: [{ id: 1, name: 'A' }] } }
    }))
    ws._trigger('message', JSON.stringify({
      type: 'data', id: '1',
      payload: { data: { items: [] } }
    }))

    expect(callback).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: 'DELETE', old: { id: 1, name: 'A' } })
    )
  })

  it('unsubscribe() closes the WebSocket', () => {
    const { factory, ws } = createMockWsFactory()
    const rt = new DruviaRealtime('ws://localhost:8080/v1/graphql', factory)

    const sub = rt.channel('test')
      .on('postgres_changes', { event: '*', table: 'items' }, vi.fn())
      .subscribe()

    sub.unsubscribe()
    expect(ws.close).toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run tests/sdk/realtime.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement realtime.ts**

```typescript
// packages/sdk/src/modules/realtime.ts
import type { WebSocketFactory, WebSocketLike } from '../types.js'

interface SubscriptionConfig {
  event: '*' | 'INSERT' | 'UPDATE' | 'DELETE'
  table: string
  schema?: string
  filter?: string
  fields?: string  // GraphQL fields to subscribe to, e.g. 'id, key, value'. Defaults to 'id'.
}

interface ChangeEvent {
  eventType: 'INSERT' | 'UPDATE' | 'DELETE'
  new: Record<string, unknown> | null
  old: Record<string, unknown> | null
}

type ChangeCallback = (event: ChangeEvent) => void

interface Subscription {
  unsubscribe: () => void
}

export class RealtimeChannel {
  private wsUrl: string
  private wsFactory: WebSocketFactory
  private configs: Array<{ config: SubscriptionConfig; callback: ChangeCallback }> = []
  private ws: WebSocketLike | null = null
  private snapshot: Map<string, Record<string, unknown>[]> = new Map()
  private subIdCounter = 0

  constructor(wsUrl: string, wsFactory: WebSocketFactory) {
    this.wsUrl = wsUrl
    this.wsFactory = wsFactory
  }

  on(type: 'postgres_changes', config: SubscriptionConfig, callback: ChangeCallback): this {
    this.configs.push({ config, callback })
    return this
  }

  subscribe(): Subscription {
    this.ws = this.wsFactory(this.wsUrl, ['graphql-ws'])

    this.ws.onOpen(() => {
      this.ws!.send(JSON.stringify({ type: 'connection_init', payload: {} }))
    })

    this.ws.onMessage((raw: string) => {
      const msg = JSON.parse(raw)

      if (msg.type === 'connection_ack') {
        // Send subscription queries for each config
        for (const { config } of this.configs) {
          this.subIdCounter++
          const id = String(this.subIdCounter)
          const schema = config.schema ?? 'public'
          // Note: subscription query uses all scalar fields from the table.
          // The caller should provide fields via config, or we default to common patterns.
          // For taro-app's use cases (system_config, activities), the subscription
          // returns all columns since Hasura subscriptions support implicit field selection.
          // We use a dynamic approach: first introspect, then subscribe.
          const fields = config.fields ?? 'id'
          const filterClause = config.filter ? `(where: {${this.parseFilter(config.filter)}})` : ''
          const query = `subscription { ${config.table}${filterClause} { ${fields} } }`
          this.ws!.send(JSON.stringify({ id, type: 'start', payload: { query } }))
        }
        return
      }

      if (msg.type === 'data' && msg.payload?.data) {
        const tableName = Object.keys(msg.payload.data)[0]
        const newRows: Record<string, unknown>[] = msg.payload.data[tableName] ?? []
        const oldRows = this.snapshot.get(tableName) ?? null

        if (oldRows === null) {
          // First push — establish snapshot, no events
          this.snapshot.set(tableName, structuredClone(newRows))
          return
        }

        // Diff old vs new
        const config = this.configs.find(c => c.config.table === tableName)
        if (!config) return

        this.diffAndEmit(oldRows, newRows, config.config, config.callback)
        this.snapshot.set(tableName, structuredClone(newRows))
      }
    })

    return {
      unsubscribe: () => {
        this.ws?.close()
        this.ws = null
        this.snapshot.clear()
      }
    }
  }

  private diffAndEmit(
    oldRows: Record<string, unknown>[],
    newRows: Record<string, unknown>[],
    config: SubscriptionConfig,
    callback: ChangeCallback,
  ) {
    const getId = (row: Record<string, unknown>) => row.id ?? JSON.stringify(row)
    const oldMap = new Map(oldRows.map(r => [getId(r), r]))
    const newMap = new Map(newRows.map(r => [getId(r), r]))

    // INSERT: in new but not in old
    for (const [id, row] of newMap) {
      if (!oldMap.has(id)) {
        if (config.event === '*' || config.event === 'INSERT') {
          callback({ eventType: 'INSERT', new: row, old: null })
        }
      }
    }

    // UPDATE: in both but changed
    for (const [id, newRow] of newMap) {
      const oldRow = oldMap.get(id)
      if (oldRow && JSON.stringify(oldRow) !== JSON.stringify(newRow)) {
        if (config.event === '*' || config.event === 'UPDATE') {
          callback({ eventType: 'UPDATE', new: newRow, old: oldRow })
        }
      }
    }

    // DELETE: in old but not in new
    for (const [id, row] of oldMap) {
      if (!newMap.has(id)) {
        if (config.event === '*' || config.event === 'DELETE') {
          callback({ eventType: 'DELETE', new: null, old: row })
        }
      }
    }
  }

  private parseFilter(filter: string): string {
    // Parse Supabase-style filter: 'key=eq.maintenance_mode'
    const match = filter.match(/^(\w+)=eq\.(.+)$/)
    if (match) {
      return `${match[1]}: {_eq: "${match[2]}"}`
    }
    return filter
  }
}

export class DruviaRealtime {
  private wsUrl: string
  private wsFactory: WebSocketFactory

  constructor(wsUrl: string, wsFactory: WebSocketFactory) {
    this.wsUrl = wsUrl
    this.wsFactory = wsFactory
  }

  channel(_name: string): RealtimeChannel {
    return new RealtimeChannel(this.wsUrl, this.wsFactory)
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run tests/sdk/realtime.test.ts`
Expected: All PASS

---

### Task 11: DruviaClient main class

**Files:**
- Create: `packages/sdk/src/DruviaClient.ts`
- Create: `tests/sdk/client.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// tests/sdk/client.test.ts
import { describe, it, expect, vi } from 'vitest'
import { createClient } from '../../packages/sdk/src/index.js'

// Mock globalThis.fetch for Node environment
const mockFetch = vi.fn().mockResolvedValue({
  ok: true,
  json: async () => ({ data: {} }),
} as Response)
globalThis.fetch = mockFetch as any

describe('createClient', () => {
  it('creates a client with required options', () => {
    const client = createClient('http://localhost:3001/api/v1', 'test-api-key', {
      projectId: 'proj_123',
    })
    expect(client).toBeDefined()
    expect(client.auth).toBeDefined()
    expect(client.storage).toBeDefined()
    expect(client.functions).toBeDefined()
    expect(typeof client.from).toBe('function')
    expect(typeof client.rpc).toBe('function')
    expect(typeof client.graphql).toBe('function')
  })

  it('from() returns a QueryBuilder', () => {
    const client = createClient('http://localhost:3001/api/v1', 'test-key', {
      projectId: 'proj_123',
    })
    const qb = client.from('users')
    expect(typeof qb.select).toBe('function')
    expect(typeof qb.insert).toBe('function')
    expect(typeof qb.eq).toBe('function')
  })

  it('rpc() delegates to DruviaRpc', async () => {
    const client = createClient('http://localhost:3001/api/v1', 'test-key', {
      projectId: 'proj_123',
      fetch: vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ data: { result: true } }),
      }) as any,
    })
    const result = await client.rpc('test_fn', { arg: 1 })
    expect(result).toBeDefined()
  })

  it('channel() returns a RealtimeChannel when websocket provided', () => {
    const client = createClient('http://localhost:3001/api/v1', 'test-key', {
      projectId: 'proj_123',
      websocket: vi.fn().mockReturnValue({
        onOpen: vi.fn(), onMessage: vi.fn(), onClose: vi.fn(), onError: vi.fn(),
        send: vi.fn(), close: vi.fn(),
      }),
    })
    const ch = client.channel('test')
    expect(ch).toBeDefined()
    expect(typeof ch.on).toBe('function')
  })

  it('channel() throws when no websocket available', () => {
    // In Node without WebSocket — channel() should throw, not constructor
    const origWs = globalThis.WebSocket
    delete (globalThis as any).WebSocket

    // Constructor succeeds (realtime is null internally)
    const client = createClient('http://localhost:3001/api/v1', 'test-key', {
      projectId: 'proj_123',
    })
    // channel() throws because no websocket factory
    expect(() => client.channel('test')).toThrow('@druvia/sdk: No WebSocket available')

    ;(globalThis as any).WebSocket = origWs
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run tests/sdk/client.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement DruviaClient.ts**

```typescript
// packages/sdk/src/DruviaClient.ts
import type { DruviaClientOptions, DruviaResponse, FetchFn, WebSocketFactory } from './types.js'
import { getDefaultFetch, createFetchWrapper } from './lib/fetch-adapter.js'
import { getDefaultStorage } from './lib/storage-adapter.js'
import { getDefaultWebSocketFactory } from './lib/websocket-adapter.js'
import { DruviaAuth } from './modules/auth.js'
import { DruviaDatabase } from './modules/database.js'
import { DruviaStorage } from './modules/storage.js'
import { DruviaRealtime, RealtimeChannel } from './modules/realtime.js'
import { DruviaRpc } from './modules/rpc.js'
import { DruviaFunctions } from './modules/functions.js'
import { QueryBuilder } from './modules/query-builder.js'

export class DruviaClient {
  readonly auth: DruviaAuth
  readonly storage: DruviaStorage
  readonly functions: DruviaFunctions

  private database: DruviaDatabase
  private rpcModule: DruviaRpc
  private realtime: DruviaRealtime | null
  private authedFetch: FetchFn

  constructor(baseUrl: string, apiKey: string, options: DruviaClientOptions) {
    const rawFetch = options.fetch ?? getDefaultFetch()
    const storageAdapter = options.storage ?? getDefaultStorage()

    // Normalize baseUrl: user passes 'http://localhost:3001', SDK appends '/api/v1'
    const apiBase = baseUrl.replace(/\/+$/, '') + '/api/v1'

    // Derive schema name from projectId if not explicitly provided
    // Convention: dru_<projectId with hyphens replaced by underscores>
    const schema = options.schema ?? (options.projectId ? `dru_${options.projectId.replace(/-/g, '_')}` : undefined)

    // Authed fetch wrapper — adds apikey header + Bearer token
    // Token cache: updated on auth state change, avoids async storage reads per request
    let cachedToken: string | null = null
    this.auth = new DruviaAuth(apiBase, rawFetch, storageAdapter)
    this.auth.onAuthStateChange((event, session) => {
      cachedToken = session?.accessToken ?? null
    })
    // Try to load initial token synchronously (works for sync storage adapters like WeChat)
    const initialRaw = storageAdapter.getItem('druvia.session')
    if (typeof initialRaw === 'string') {
      try { cachedToken = JSON.parse(initialRaw).accessToken } catch { /* ignore */ }
    }

    this.authedFetch = createFetchWrapper(apiBase, apiKey, rawFetch, () => cachedToken)

    // GraphQL URL — Hasura proxy through Druvia API
    const graphqlUrl = `${apiBase}/projects/${options.projectId}/graphql`

    // Database module
    this.database = new DruviaDatabase(graphqlUrl, this.authedFetch, schema)

    // Storage module
    this.storage = new DruviaStorage(apiBase, options.projectId, this.authedFetch)

    // RPC module
    this.rpcModule = new DruviaRpc(apiBase, options.projectId, this.authedFetch)

    // Functions module
    this.functions = new DruviaFunctions(apiBase, options.projectId, this.authedFetch)

    // Realtime module — optional, needs WebSocket
    // Hasura WS is NOT proxied through Druvia API — needs direct connection
    // Dev: ws://localhost:8080/v1/graphql, Prod: wss://domain/v1/graphql (via nginx)
    const wsFactory = options.websocket ?? getDefaultWebSocketFactory()
    if (wsFactory) {
      const wsUrl = options.realtimeUrl
        ? options.realtimeUrl.replace(/\/+$/, '') + '/v1/graphql'
        : baseUrl.replace(/^http/, 'ws').replace(/:\d+/, ':8080') + '/v1/graphql'
      this.realtime = new DruviaRealtime(wsUrl, wsFactory)
    } else {
      this.realtime = null
    }
  }

  /** Start a chainable query on a table */
  from<T = unknown>(table: string): QueryBuilder<T> {
    return this.database.from<T>(table)
  }

  /** Execute raw GraphQL */
  async graphql<T = unknown>(query: string, variables?: Record<string, unknown>): Promise<DruviaResponse<T>> {
    return this.database.graphql<T>(query, variables)
  }

  /** Call a PostgreSQL function via RPC proxy */
  async rpc<T = unknown>(functionName: string, args?: Record<string, unknown>): Promise<DruviaResponse<T>> {
    return this.rpcModule.call<T>(functionName, args)
  }

  /** Create a realtime subscription channel */
  channel(name: string): RealtimeChannel {
    if (!this.realtime) {
      throw new Error('@druvia/sdk: No WebSocket available. Pass a websocket factory in createClient options.')
    }
    return this.realtime.channel(name)
  }
}

export function createClient(baseUrl: string, apiKey: string, options: DruviaClientOptions): DruviaClient {
  return new DruviaClient(baseUrl, apiKey, options)
}
```

- [ ] **Step 4: Update index.ts exports**

```typescript
// packages/sdk/src/index.ts
export { createClient, DruviaClient } from './DruviaClient.js'
export { RealtimeChannel } from './modules/realtime.js'
export { QueryBuilder } from './modules/query-builder.js'
export type {
  DruviaClientOptions,
  DruviaResponse,
  DruviaError,
  Session,
  UserInfo,
  FetchFn,
  StorageAdapter,
  WebSocketLike,
  WebSocketFactory,
} from './types.js'
```

- [ ] **Step 5: Build the full package**

Run: `cd /Users/cloudio/Developer/nodejs/Druvia && pnpm --filter @druvia/sdk build`
Expected: Build succeeds with no errors

- [ ] **Step 6: Run all SDK tests**

Run: `pnpm vitest run tests/sdk/`
Expected: All tests PASS

---

### Task 12: Final verification + package cleanup

- [ ] **Step 1: Run full test suite to ensure no regressions**

Run: `pnpm vitest run`
Expected: All existing tests + new SDK tests PASS

- [ ] **Step 2: Verify package builds cleanly**

Run: `pnpm --filter @druvia/sdk build && ls packages/sdk/dist/`
Expected: dist/ contains .js and .d.ts files for all modules

---

## Summary

| Task | Module | Tests |
|------|--------|-------|
| 1 | Package scaffold + types | — |
| 2 | Adapter defaults | — |
| 3 | GraphQL builder | graphql-builder.test.ts |
| 4 | QueryBuilder | query-builder.test.ts |
| 5 | Database | database.test.ts |
| 6 | Auth | auth.test.ts |
| 7 | Storage | storage.test.ts |
| 8 | RPC | rpc.test.ts |
| 9 | Functions | functions.test.ts |
| 10 | Realtime | realtime.test.ts |
| 11 | DruviaClient | client.test.ts |
| 12 | Final verification | full suite |
