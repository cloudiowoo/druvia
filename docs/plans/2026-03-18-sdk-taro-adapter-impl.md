# SDK taro-app 迁移适配实施计划

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 适配 SDK Auth 模块 + QueryBuilder + Realtime，解除 taro-app 迁移全部阻塞

**Architecture:** 三个 Chunk 按优先级递进：Chunk 1 — Auth 返回值包装 + updateUser（纯 SDK）；Chunk 2 — QueryBuilder 缺失方法 `.or()` / `.maybeSingle()` / `.not()` + Realtime `.removeChannel()`（纯 SDK）；Chunk 3 — Refresh Token 基础设施（DB + API + SDK 三层）。

**Tech Stack:** TypeScript, Vitest, Fastify 5, jsonwebtoken, crypto

**需求文档:**
- `docs/plans/2026-03-18-druvia-sdk-auth-requirements.md`
- `docs/plans/2026-03-18-druvia-sdk-adapter-requirements.md`

---

## 文件结构

### P0 — SDK Auth 层改动（无 API 依赖）

| 操作 | 文件 | 职责 |
|------|------|------|
| 修改 | `packages/sdk/src/modules/auth.ts` | `getUser()`/`getSession()` 返回值包装，新增 `updateUser()` |
| 修改 | `packages/sdk/src/types.ts` | 新增 `UserResponse`/`SessionResponse` 类型 |
| 修改 | `tests/sdk/auth.test.ts` | 更新现有测试 + 新增测试 |

### P0 — SDK QueryBuilder + Realtime 层改动（无 API 依赖）

| 操作 | 文件 | 职责 |
|------|------|------|
| 修改 | `packages/sdk/src/modules/query-builder.ts` | 新增 `.or()` / `.not()` / `.maybeSingle()` |
| 修改 | `packages/sdk/src/lib/graphql-builder.ts` | `buildWhereClause` 支持 `_or` 组合条件 |
| 修改 | `packages/sdk/src/modules/realtime.ts` | `RealtimeChannel` 新增 `unsubscribeAll()` |
| 修改 | `packages/sdk/src/DruviaClient.ts` | 新增 `removeChannel()` |
| 修改 | `tests/sdk/query-builder.test.ts` | `.or()` / `.not()` / `.maybeSingle()` 测试 |
| 修改 | `tests/sdk/realtime.test.ts` | `removeChannel()` 测试 |

### P1 — Refresh Token 基础设施

| 操作 | 文件 | 职责 |
|------|------|------|
| 新建 | `migrations/013_refresh_tokens.up.sql` | refresh_tokens 表 |
| 新建 | `migrations/013_refresh_tokens.down.sql` | 回滚 |
| 修改 | `apps/api/src/modules/user/user.service.ts` | refresh token 生成/验证/轮换 |
| 修改 | `apps/api/src/modules/user/user.controller.ts` | `POST /auth/refresh` handler |
| 修改 | `apps/api/src/modules/user/user.routes.ts` | 注册 refresh 路由 |
| 修改 | `packages/sdk/src/modules/auth.ts` | `refreshSession()` 方法 |
| 修改 | `tests/sdk/auth.test.ts` | refreshSession 测试 |

---

## Chunk 1: P0 — SDK 返回值包装 + updateUser

### Task 1: 扩展 SDK 类型定义

**Files:**
- Modify: `packages/sdk/src/types.ts`

- [ ] **Step 1: 新增嵌套响应类型**

在 `types.ts` 末尾，`UserInfo` 接口之后添加：

```typescript
/** Supabase-compatible nested response for getUser() */
export interface UserResponse {
  data: { user: UserInfo | null }
  error: DruviaError | null
}

/** Supabase-compatible nested response for getSession() */
export interface SessionResponse {
  data: { session: Session | null }
  error: DruviaError | null
}
```

- [ ] **Step 2: 给 UserInfo 添加 avatarUrl / userId 字段**

当前 `UserInfo` 缺少 `avatarUrl`，API `/users/me` 会返回该字段。修改 `UserInfo`：

```typescript
export interface UserInfo {
  id: number
  userId?: string
  email?: string
  username?: string
  avatarUrl?: string
  role?: string
}
```

- [ ] **Step 3: 确认编译通过**

Run: `cd packages/sdk && npx tsc --noEmit`
Expected: 无错误

---

### Task 2: 更新现有测试以匹配新返回值结构

**Files:**
- Modify: `tests/sdk/auth.test.ts`

- [ ] **Step 1: 更新 getUser 测试**

将 `tests/sdk/auth.test.ts` 中 `getUser returns current user` 测试改为：

```typescript
it('getUser returns { data: { user } } structure', async () => {
  const fetch = createMockFetch({ success: true, data: { id: 1, email: 'a@b.com', username: 'admin', role: 'admin' } })
  const storage = createMockStorage()
  const auth = new DruviaAuth('/api/v1', fetch, storage)
  const result = await auth.getUser()
  expect(result.data.user).toBeTruthy()
  expect(result.data.user?.email).toBe('a@b.com')
  expect(result.error).toBeNull()
})
```

- [ ] **Step 2: 更新 getSession 测试**

将 `getSession returns null when no session stored` 测试改为：

```typescript
it('getSession returns { data: { session: null } } when no session stored', async () => {
  const fetch = createMockFetch({})
  const storage = createMockStorage()
  const auth = new DruviaAuth('/api/v1', fetch, storage)
  const result = await auth.getSession()
  expect(result.data.session).toBeNull()
  expect(result.error).toBeNull()
})
```

- [ ] **Step 3: 新增 getSession 有数据时的测试**

```typescript
it('getSession returns { data: { session } } when session exists', async () => {
  const fetch = createMockFetch({})
  const storage = createMockStorage()
  const session = { accessToken: 'tok', user: { id: 1, email: 'a@b.com' } }
  await storage.setItem('druvia.session', JSON.stringify(session))
  const auth = new DruviaAuth('/api/v1', fetch, storage)
  const result = await auth.getSession()
  expect(result.data.session).toEqual(session)
  expect(result.data.session?.accessToken).toBe('tok')
})
```

- [ ] **Step 4: 运行测试确认失败**

Run: `pnpm vitest run tests/sdk/auth.test.ts`
Expected: FAIL — `getUser` 和 `getSession` 测试失败（返回值结构不匹配）

---

### Task 3: 实现 getUser/getSession 返回值包装

> 依赖：Task 1（`UserResponse`/`SessionResponse` 类型已定义）。

**Files:**
- Modify: `packages/sdk/src/modules/auth.ts`

- [ ] **Step 1: 更新 import 和 getUser 返回类型**

修改 `auth.ts` 第 1 行 import：

```typescript
import type { FetchFn, StorageAdapter, DruviaResponse, Session, UserInfo, UserResponse, SessionResponse } from '../types.js'
```

修改 `getUser()` 方法（第 42-53 行）：

```typescript
async getUser(): Promise<UserResponse> {
  try {
    const response = await this.fetchFn(`${this.baseUrl}/users/me`, { method: 'GET' })
    const json = await response.json()
    if (!response.ok) {
      return { data: { user: null }, error: json.error ?? { code: 'AUTH_ERROR', message: 'Failed to get user' } }
    }
    return { data: { user: json.data ?? json }, error: null }
  } catch (err) {
    return { data: { user: null }, error: { code: 'NETWORK_ERROR', message: err instanceof Error ? err.message : String(err) } }
  }
}
```

- [ ] **Step 2: 修改 getSession 返回类型**

修改 `getSession()` 方法（第 55-63 行）：

```typescript
async getSession(): Promise<SessionResponse> {
  const raw = await this.storage.getItem(SESSION_KEY)
  if (!raw) return { data: { session: null }, error: null }
  try {
    return { data: { session: JSON.parse(raw) }, error: null }
  } catch {
    return { data: { session: null }, error: null }
  }
}
```

- [ ] **Step 3: 修改 getToken 适配新结构**

`getToken()` 依赖 `getSession()`，需要适配：

```typescript
async getToken(): Promise<string | null> {
  const { data } = await this.getSession()
  return data.session?.accessToken ?? null
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm vitest run tests/sdk/auth.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```
feat(sdk): getUser/getSession 返回值包装为 Supabase 兼容结构
```

---

### Task 4: 新增 updateUser 方法

**Files:**
- Modify: `tests/sdk/auth.test.ts`
- Modify: `packages/sdk/src/modules/auth.ts`

- [ ] **Step 1: 写 updateUser 失败测试**

在 `tests/sdk/auth.test.ts` 的 describe 块内添加：

```typescript
it('updateUser calls PATCH /users/me', async () => {
  const updatedUser = { id: 1, email: 'a@b.com', username: 'newname', avatarUrl: 'https://img.com/a.png' }
  const fetch = createMockFetch({ success: true, data: updatedUser })
  const storage = createMockStorage()
  const auth = new DruviaAuth('/api/v1', fetch, storage)
  const result = await auth.updateUser({ data: { username: 'newname', avatar_url: 'https://img.com/a.png' } })
  expect(result.data.user?.username).toBe('newname')
  expect(result.error).toBeNull()
  expect(fetch).toHaveBeenCalledWith('/api/v1/users/me', expect.objectContaining({
    method: 'PATCH',
    body: JSON.stringify({ username: 'newname', avatarUrl: 'https://img.com/a.png' }),
  }))
})

it('updateUser handles error', async () => {
  const fetch = createMockFetch({ success: false, error: { code: 'UNAUTHORIZED', message: 'Not authenticated' } }, 401)
  const storage = createMockStorage()
  const auth = new DruviaAuth('/api/v1', fetch, storage)
  const result = await auth.updateUser({ data: { username: 'x' } })
  expect(result.data.user).toBeNull()
  expect(result.error?.code).toBe('UNAUTHORIZED')
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm vitest run tests/sdk/auth.test.ts`
Expected: FAIL — `auth.updateUser is not a function`

- [ ] **Step 3: 实现 updateUser**

在 `auth.ts` 的 `getToken()` 方法之后添加：

```typescript
async updateUser(params: { data: Record<string, unknown> }): Promise<UserResponse> {
  try {
    // 转换 snake_case 字段名到 camelCase（avatar_url → avatarUrl）
    const body: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(params.data)) {
      const camelKey = key.replace(/_([a-z])/g, (_, c) => c.toUpperCase())
      body[camelKey] = value
    }
    const response = await this.fetchFn(`${this.baseUrl}/users/me`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    const json = await response.json()
    if (!response.ok) {
      return { data: { user: null }, error: json.error ?? { code: 'UPDATE_ERROR', message: 'Failed to update user' } }
    }
    return { data: { user: json.data ?? json }, error: null }
  } catch (err) {
    return { data: { user: null }, error: { code: 'NETWORK_ERROR', message: err instanceof Error ? err.message : String(err) } }
  }
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm vitest run tests/sdk/auth.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```
feat(sdk): 新增 auth.updateUser() 方法
```

---

## Chunk 2: P0 — QueryBuilder 缺失方法 + Realtime removeChannel

### Task 5: 新增 `.maybeSingle()` 方法

**Files:**
- Modify: `tests/sdk/query-builder.test.ts`
- Modify: `packages/sdk/src/modules/query-builder.ts`

- [ ] **Step 1: 写 maybeSingle 测试**

在 `tests/sdk/query-builder.test.ts` 的 describe 块内添加：

```typescript
it('maybeSingle() returns single object when found', async () => {
  const fetch = mockFetch({ data: { users: [{ id: 1, name: 'Alice' }] } })
  const qb = new QueryBuilder('users', '/graphql', fetch)
  const result = await qb.select('id, name').eq('id', 1).maybeSingle()

  expect(result.data).toEqual({ id: 1, name: 'Alice' })
  expect(result.error).toBeNull()
})

it('maybeSingle() returns null without error when no rows', async () => {
  const fetch = mockFetch({ data: { users: [] } })
  const qb = new QueryBuilder('users', '/graphql', fetch)
  const result = await qb.select('id, name').eq('id', 999).maybeSingle()

  expect(result.data).toBeNull()
  expect(result.error).toBeNull()
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm vitest run tests/sdk/query-builder.test.ts`
Expected: FAIL — `qb.maybeSingle is not a function`

- [ ] **Step 3: 实现 maybeSingle**

在 `query-builder.ts` 的 `single()` 方法（第 98-101 行）之后添加：

```typescript
maybeSingle(): PromiseLike<DruviaResponse<T | null>> {
  this.singleFlag = true
  return {
    then: (resolve: any, reject: any) =>
      this.execute().then((result) => {
        // maybeSingle: 0 条结果返回 { data: null, error: null } 而非 error
        if (result.error?.code === 'PGRST116') {
          return { data: null, error: null }
        }
        return result
      }).then(resolve, reject)
  } as PromiseLike<DruviaResponse<T | null>>
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm vitest run tests/sdk/query-builder.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```
feat(sdk): 新增 QueryBuilder.maybeSingle() 方法
```

---

### Task 6: 新增 `.or()` 方法

**Files:**
- Modify: `tests/sdk/query-builder.test.ts`
- Modify: `packages/sdk/src/lib/graphql-builder.ts`
- Modify: `packages/sdk/src/modules/query-builder.ts`

- [ ] **Step 1: 写 or 测试**

在 `tests/sdk/query-builder.test.ts` 添加：

```typescript
it('or() generates _or where clause', async () => {
  const fetch = mockFetch({ data: { activities: [{ id: 1 }] } })
  const qb = new QueryBuilder('activities', '/graphql', fetch)
  const result = await qb
    .select('id')
    .or('is_demo.eq.true,is_creator_demo.eq.true')

  const body = JSON.parse((fetch as any).mock.calls[0][1].body)
  expect(body.query).toContain('_or')
  expect(body.query).toContain('is_demo')
  expect(body.query).toContain('is_creator_demo')
  expect(body.query).toContain('_eq')
  expect(result.error).toBeNull()
})

it('or() combines with existing eq filters', async () => {
  const fetch = mockFetch({ data: { activities: [] } })
  const qb = new QueryBuilder('activities', '/graphql', fetch)
  await qb
    .select('id')
    .eq('status', 'active')
    .or('is_demo.eq.true,is_creator_demo.eq.true')

  const body = JSON.parse((fetch as any).mock.calls[0][1].body)
  expect(body.query).toContain('status')
  expect(body.query).toContain('_or')
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm vitest run tests/sdk/query-builder.test.ts`
Expected: FAIL — `qb.or is not a function`

- [ ] **Step 3: 在 graphql-builder.ts 中支持 `_or` 条件**

修改 `graphql-builder.ts` 的 `FilterItem` 接口和 `buildWhereClause` 函数。

在 `FilterItem` 之后新增类型：

```typescript
export interface OrFilter {
  type: 'or'
  conditions: FilterItem[]
}

export type WhereItem = FilterItem | OrFilter
```

修改 `QueryState` 中 `filters` 类型：

```typescript
export interface QueryState {
  table: string
  selectFields: string
  filters: WhereItem[]
  orderBy: OrderByItem[]
  offset: number | undefined
  limit: number | undefined
  isSingle: boolean
}
```

修改 `buildWhereClause` 函数：

```typescript
function buildWhereClause(filters: WhereItem[]): string {
  if (filters.length === 0) return ''
  const conditions: string[] = []
  for (const f of filters) {
    if ('type' in f && f.type === 'or') {
      const orConds = f.conditions.map(c => {
        if (c.op === '_is_null') {
          return `{${c.column}: {_is_null: ${c.value ? 'true' : 'false'}}}`
        }
        return `{${c.column}: {${c.op}: ${serializeValue(c.value)}}}`
      })
      conditions.push(`_or: [${orConds.join(', ')}]`)
    } else {
      const fi = f as FilterItem
      if (fi.op === '_is_null') {
        conditions.push(`${fi.column}: {_is_null: ${fi.value ? 'true' : 'false'}}`)
      } else {
        conditions.push(`${fi.column}: {${fi.op}: ${serializeValue(fi.value)}}`)
      }
    }
  }
  return `where: {${conditions.join(', ')}}`
}
```

- [ ] **Step 4: 在 query-builder.ts 中新增 `or()` 方法**

在 `query-builder.ts` 的 `filters` 类型从 `FilterItem[]` 改为 `WhereItem[]`：

```typescript
import { buildQuery, buildMutation, type QueryState, type FilterItem, type WhereItem, type OrFilter, type OrderByItem } from '../lib/graphql-builder.js'
```

```typescript
private filters: WhereItem[] = []
```

在 `is()` 方法之后添加：

```typescript
or(filterString: string): PromiseLike<DruviaResponse<T[]>> & QueryBuilder<T> {
  // 解析 Supabase 风格 filter: "col.op.value,col.op.value"
  const conditions: FilterItem[] = filterString.split(',').map(part => {
    const [column, op, ...rest] = part.trim().split('.')
    const value = rest.join('.')
    const hasuraOp = `_${op}`  // eq → _eq, is → _is_null, etc.
    if (op === 'is' && value === 'null') {
      return { column, op: '_is_null', value: true }
    }
    // 自动转换 "true"/"false" 为布尔值，数字字符串为数字
    let parsed: unknown = value
    if (value === 'true') parsed = true
    else if (value === 'false') parsed = false
    else if (/^\d+$/.test(value)) parsed = Number(value)
    return { column, op: hasuraOp, value: parsed }
  })
  this.filters.push({ type: 'or', conditions } as OrFilter)
  return this.makeThenable()
}
```

- [ ] **Step 5: 修改 buildWhereObject 兼容 OrFilter**

`buildWhereObject()` 用于 mutation 的 where 构建，也需要兼容：

```typescript
private buildWhereObject(): Record<string, unknown> {
  const where: Record<string, unknown> = {}
  for (const f of this.filters) {
    if ('type' in f && f.type === 'or') {
      // mutation 场景下 _or 不常用，但保持兼容
      where._or = (f as OrFilter).conditions.map(c => ({ [c.column]: { [c.op]: c.value } }))
    } else {
      const fi = f as FilterItem
      where[fi.column] = { [fi.op]: fi.value }
    }
  }
  return where
}
```

- [ ] **Step 6: 运行测试确认通过**

Run: `pnpm vitest run tests/sdk/query-builder.test.ts`
Expected: PASS

- [ ] **Step 7: Commit**

```
feat(sdk): 新增 QueryBuilder.or() 支持 Supabase 风格逻辑或查询
```

---

### Task 7: 新增 `.not()` 方法

**Files:**
- Modify: `tests/sdk/query-builder.test.ts`
- Modify: `packages/sdk/src/modules/query-builder.ts`

- [ ] **Step 1: 写 not 测试**

```typescript
it('not() negates a filter condition', async () => {
  const fetch = mockFetch({ data: { users: [{ id: 1, display_name: 'Alice' }] } })
  const qb = new QueryBuilder('users', '/graphql', fetch)
  const result = await qb.select('id, display_name').not('display_name', 'is', null)

  const body = JSON.parse((fetch as any).mock.calls[0][1].body)
  expect(body.query).toContain('display_name')
  expect(body.query).toContain('_is_null: false')
  expect(result.error).toBeNull()
})

it('not() with eq operator', async () => {
  const fetch = mockFetch({ data: { users: [] } })
  const qb = new QueryBuilder('users', '/graphql', fetch)
  await qb.select('id').not('status', 'eq', 'deleted')

  const body = JSON.parse((fetch as any).mock.calls[0][1].body)
  expect(body.query).toContain('_neq')
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm vitest run tests/sdk/query-builder.test.ts`
Expected: FAIL — `qb.not is not a function`

- [ ] **Step 3: 实现 not**

在 `or()` 方法之后添加。operator 取反映射表：

```typescript
not(column: string, operator: string, value: unknown): PromiseLike<DruviaResponse<T[]>> & QueryBuilder<T> {
  // Supabase operator → Hasura 取反 operator
  const negationMap: Record<string, string> = {
    eq: '_neq',
    neq: '_eq',
    gt: '_lte',
    gte: '_lt',
    lt: '_gte',
    lte: '_gt',
    like: '_nlike',
    ilike: '_nilike',
    is: '_is_null',  // not(col, 'is', null) → _is_null: false
  }
  const hasuraOp = negationMap[operator]
  if (!hasuraOp) {
    throw new Error(`@druvia/sdk: Unsupported not() operator: "${operator}"`)
  }
  if (operator === 'is' && value === null) {
    this.filters.push({ column, op: '_is_null', value: false })
  } else {
    this.filters.push({ column, op: hasuraOp, value })
  }
  return this.makeThenable()
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm vitest run tests/sdk/query-builder.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```
feat(sdk): 新增 QueryBuilder.not() 支持逻辑非查询
```

---

### Task 8: 新增 `removeChannel()` 方法

**Files:**
- Modify: `tests/sdk/realtime.test.ts`
- Modify: `packages/sdk/src/modules/realtime.ts`
- Modify: `packages/sdk/src/DruviaClient.ts`

- [ ] **Step 1: 写 removeChannel 测试**

在 `tests/sdk/realtime.test.ts` 添加：

```typescript
it('removeChannel() closes and removes the channel', () => {
  const { factory, ws } = createMockWsFactory()
  const rt = new DruviaRealtime('ws://localhost:8080/v1/graphql', factory)
  const ch = rt.channel('test')
  ch.on('postgres_changes', { event: '*', table: 'items' }, vi.fn())
  ch.subscribe()

  rt.removeChannel(ch)
  expect(ws.close).toHaveBeenCalled()
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm vitest run tests/sdk/realtime.test.ts`
Expected: FAIL — `rt.removeChannel is not a function`

- [ ] **Step 3: 给 RealtimeChannel 添加 unsubscribeAll 方法**

在 `realtime.ts` 的 `RealtimeChannel` 类中，`subscribe()` 方法之后添加：

```typescript
/** 外部调用：关闭 WebSocket 并清理资源 */
unsubscribeAll(): void {
  if (this.ws) {
    for (let i = 1; i <= this.subIdCounter; i++) {
      this.ws.send(JSON.stringify({ id: String(i), type: 'complete' }))
    }
    this.ws.close()
    this.ws = null
  }
  this.snapshot.clear()
  this.configs = []
}
```

- [ ] **Step 4: 给 DruviaRealtime 添加 channel 追踪和 removeChannel**

修改 `realtime.ts` 的 `DruviaRealtime` 类：

```typescript
export class DruviaRealtime {
  private wsUrl: string
  private wsFactory: WebSocketFactory
  private channels: Set<RealtimeChannel> = new Set()

  constructor(wsUrl: string, wsFactory: WebSocketFactory) {
    this.wsUrl = wsUrl
    this.wsFactory = wsFactory
  }

  channel(_name: string): RealtimeChannel {
    const ch = new RealtimeChannel(this.wsUrl, this.wsFactory)
    this.channels.add(ch)
    return ch
  }

  removeChannel(channel: RealtimeChannel): void {
    channel.unsubscribeAll()
    this.channels.delete(channel)
  }
}
```

- [ ] **Step 5: 给 DruviaClient 添加 removeChannel 代理**

在 `DruviaClient.ts` 的 `channel()` 方法之后添加：

```typescript
removeChannel(channel: RealtimeChannel): void {
  if (!this.realtime) {
    throw new Error('@druvia/sdk: No WebSocket available.')
  }
  this.realtime.removeChannel(channel)
}
```

- [ ] **Step 6: 运行测试确认通过**

Run: `pnpm vitest run tests/sdk/realtime.test.ts`
Expected: PASS

- [ ] **Step 7: Commit**

```
feat(sdk): 新增 removeChannel() 支持清理实时订阅资源
```

---

## Chunk 3: P1 — Refresh Token 基础设施

### Task 9: 创建 refresh_tokens 迁移

**Files:**
- Create: `migrations/013_refresh_tokens.up.sql`
- Create: `migrations/013_refresh_tokens.down.sql`

> 先 `ls migrations/*.up.sql` 确认编号不冲突（012 已被 project_environments 占用）。

- [ ] **Step 1: 创建 up 迁移**

```sql
-- 013_refresh_tokens.up.sql
CREATE TABLE druvia_refresh_tokens (
  id SERIAL PRIMARY KEY,
  token_hash VARCHAR(128) UNIQUE NOT NULL,
  user_id VARCHAR(64) NOT NULL REFERENCES druvia_users(user_id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL,
  revoked BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_refresh_tokens_user ON druvia_refresh_tokens(user_id);
CREATE INDEX idx_refresh_tokens_expires ON druvia_refresh_tokens(expires_at) WHERE revoked = false;
```

设计说明：
- 存 `token_hash`（SHA-256）而非明文，防止数据库泄露后 token 被盗用
- `revoked` 支持主动撤销（登出时）
- 按 `user_id` 索引支持"撤销该用户所有 token"
- 过期索引支持定期清理

- [ ] **Step 2: 创建 down 迁移**

```sql
-- 013_refresh_tokens.down.sql
DROP TABLE IF EXISTS druvia_refresh_tokens;
```

> 注意：`druvia_refresh_tokens` 是内部基础设施表，不需要在 Hasura 中 track。

- [ ] **Step 3: 运行迁移**

Run: `pnpm migrate up`
Expected: `013_refresh_tokens` applied

- [ ] **Step 4: 确认迁移状态**

Run: `pnpm migrate status`
Expected: 013 显示为 applied

- [ ] **Step 5: Commit**

```
feat(db): 新增 druvia_refresh_tokens 表
```

---

### Task 10: API 层 refresh token 服务

**Files:**
- Modify: `apps/api/src/modules/user/user.service.ts`

- [ ] **Step 1: 新增 refresh token 工具函数**

在 `user.service.ts` 顶部 import 区域添加 `crypto` 已有，在文件末尾添加：

```typescript
// ── Refresh Token ──

const REFRESH_TOKEN_EXPIRES = 7 * 24 * 60 * 60 * 1000; // 7 days in ms

function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

export async function createRefreshToken(userId: string): Promise<string> {
  const token = crypto.randomBytes(32).toString('base64url');
  const tokenHash = hashToken(token);
  const expiresAt = new Date(Date.now() + REFRESH_TOKEN_EXPIRES);

  await query(
    `INSERT INTO druvia_refresh_tokens (token_hash, user_id, expires_at) VALUES ($1, $2, $3)`,
    [tokenHash, userId, expiresAt]
  );

  return token;
}

export async function consumeRefreshToken(token: string): Promise<User | null> {
  const tokenHash = hashToken(token);

  // 原子操作：查找有效 token 并标记为已撤销（token rotation）
  const row = await queryOne<{ user_id: string }>(
    `UPDATE druvia_refresh_tokens
     SET revoked = true
     WHERE token_hash = $1 AND revoked = false AND expires_at > NOW()
     RETURNING user_id`,
    [tokenHash]
  );

  if (!row) return null;
  return getUserById(row.user_id);
}

export async function revokeUserRefreshTokens(userId: string): Promise<void> {
  await query(
    `UPDATE druvia_refresh_tokens SET revoked = true WHERE user_id = $1 AND revoked = false`,
    [userId]
  );
}
```

- [ ] **Step 2: 确认编译通过**

Run: `cd apps/api && npx tsc --noEmit`
Expected: 无错误

---

### Task 11: 登录/注册返回 refresh token + refresh 端点

**Files:**
- Modify: `apps/api/src/modules/user/user.controller.ts`
- Modify: `apps/api/src/modules/user/user.routes.ts`

- [ ] **Step 1: 修改 register 返回 refreshToken**

在 `user.controller.ts` 的 `register` 函数中，`signToken` 之后添加 refreshToken 生成：

```typescript
// 在 const token = signToken(...) 之后添加：
const refreshToken = await userService.createRefreshToken(user.userId);

return reply.status(201).send({
  success: true,
  data: { user, token, refreshToken },
});
```

- [ ] **Step 2: 修改 login 返回 refreshToken**

在 `login` 函数中同样处理：

```typescript
// 在 const token = signToken(...) 之后添加：
const refreshToken = await userService.createRefreshToken(user.userId);

return reply.send({
  success: true,
  data: { user, token, refreshToken },
});
```

- [ ] **Step 3: 新增 refresh 端点 handler**

在 `user.controller.ts` 末尾添加：

```typescript
export async function refreshToken(
  request: FastifyRequest<{ Body: { refresh_token: string } }>,
  reply: FastifyReply
) {
  const { refresh_token } = request.body;

  if (!refresh_token) {
    return reply.status(400).send({
      success: false,
      error: { code: 'INVALID_INPUT', message: 'refresh_token is required' },
    });
  }

  const user = await userService.consumeRefreshToken(refresh_token);

  if (!user) {
    return reply.status(401).send({
      success: false,
      error: { code: 'INVALID_TOKEN', message: 'Invalid or expired refresh token' },
    });
  }

  const token = signToken({ userId: user.userId, uid: user.id, role: user.role });
  const newRefreshToken = await userService.createRefreshToken(user.userId);

  return reply.send({
    success: true,
    data: { user, token, refreshToken: newRefreshToken },
  });
}
```

- [ ] **Step 4: 修改 signOut 撤销 refresh tokens（可选增强）**

当前 signOut 是纯客户端操作。如果需要服务端撤销，可以后续添加 `POST /auth/logout` 端点。本次不改动。

- [ ] **Step 5: 注册路由**

在 `user.routes.ts` 的 Public routes 区域添加：

```typescript
app.post('/auth/refresh', controller.refreshToken as never);
```

- [ ] **Step 6: 确认编译通过**

Run: `cd apps/api && npx tsc --noEmit`
Expected: 无错误

- [ ] **Step 7: Commit**

```
feat(api): 登录/注册返回 refreshToken + POST /auth/refresh 端点
```

---

### Task 12: SDK authRequest 保存 refreshToken + refreshSession

**Files:**
- Modify: `packages/sdk/src/modules/auth.ts`
- Modify: `tests/sdk/auth.test.ts`

- [ ] **Step 1: 写 refreshSession 测试**

在 `tests/sdk/auth.test.ts` 添加：

```typescript
it('refreshSession exchanges refresh_token for new session', async () => {
  const newSession = {
    user: { id: 1, email: 'a@b.com' },
    token: 'new-access-tok',
    refreshToken: 'new-refresh-tok',
  }
  const fetch = createMockFetch({ success: true, data: newSession })
  const storage = createMockStorage()
  const auth = new DruviaAuth('/api/v1', fetch, storage)
  const result = await auth.refreshSession({ refresh_token: 'old-refresh-tok' })
  expect(result.data?.session?.accessToken).toBe('new-access-tok')
  expect(result.data?.session?.refreshToken).toBe('new-refresh-tok')
  expect(result.error).toBeNull()
  expect(fetch).toHaveBeenCalledWith('/api/v1/auth/refresh', expect.objectContaining({
    method: 'POST',
    body: JSON.stringify({ refresh_token: 'old-refresh-tok' }),
  }))
  // 验证新 session 已保存且包含 refreshToken
  const savedSession = JSON.parse((storage.setItem as ReturnType<typeof vi.fn>).mock.calls[0][1])
  expect(savedSession.refreshToken).toBe('new-refresh-tok')
})

it('refreshSession handles invalid token', async () => {
  const fetch = createMockFetch(
    { success: false, error: { code: 'INVALID_TOKEN', message: 'Invalid or expired refresh token' } },
    401
  )
  const storage = createMockStorage()
  const auth = new DruviaAuth('/api/v1', fetch, storage)
  const result = await auth.refreshSession({ refresh_token: 'bad-token' })
  expect(result.data).toBeNull()
  expect(result.error?.code).toBe('INVALID_TOKEN')
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm vitest run tests/sdk/auth.test.ts`
Expected: FAIL — `auth.refreshSession is not a function`

- [ ] **Step 3: 修改 authRequest 保存 refreshToken**

`authRequest` 是 `signUp` 和 `signIn` 的共用内部方法，此处一次修改即可让两者都保存 refreshToken。

在 `auth.ts` 的 `authRequest` 方法中，session 构建部分修改为：

```typescript
const session: Session = {
  accessToken: sessionData.token,
  refreshToken: sessionData.refreshToken,
  user: sessionData.user,
}
```

- [ ] **Step 4: 实现 refreshSession**

在 `updateUser` 方法之后添加：

```typescript
async refreshSession(params: { refresh_token: string }): Promise<{ data: { session: Session | null } | null; error: DruviaError | null }> {
  try {
    const response = await this.fetchFn(`${this.baseUrl}/auth/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refresh_token: params.refresh_token }),
    })
    const json = await response.json()
    if (!response.ok || json.success === false) {
      return { data: null, error: json.error ?? { code: 'REFRESH_FAILED', message: 'Failed to refresh session' } }
    }
    const sessionData = json.data ?? json
    const session: Session = {
      accessToken: sessionData.token,
      refreshToken: sessionData.refreshToken,
      user: sessionData.user,
    }
    await this.storage.setItem(SESSION_KEY, JSON.stringify(session))
    this.notify('SIGNED_IN', session)
    return { data: { session }, error: null }
  } catch (err) {
    return { data: null, error: { code: 'NETWORK_ERROR', message: err instanceof Error ? err.message : String(err) } }
  }
}
```

- [ ] **Step 5: 运行测试确认通过**

Run: `pnpm vitest run tests/sdk/auth.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```
feat(sdk): 新增 auth.refreshSession() + authRequest 保存 refreshToken
```

---

### Task 13: 更新 signUp/signIn 测试验证 refreshToken 保存

**Files:**
- Modify: `tests/sdk/auth.test.ts`

> 依赖：Task 11（API 层登录/注册已返回 refreshToken）和 Task 12（SDK authRequest 已保存 refreshToken）。

- [ ] **Step 1: 更新 signUp 测试 mock 数据包含 refreshToken**

```typescript
it('signUp calls register endpoint', async () => {
  const fetch = createMockFetch({ success: true, data: { user: { id: 1, email: 'a@b.com' }, token: 'tok123', refreshToken: 'ref123' } })
  const storage = createMockStorage()
  const auth = new DruviaAuth('/api/v1', fetch, storage)
  const result = await auth.signUp({ email: 'a@b.com', password: '12345678' })
  expect(result.error).toBeNull()
  expect(result.data?.user.email).toBe('a@b.com')
  expect(result.data?.refreshToken).toBe('ref123')
})
```

- [ ] **Step 2: 更新 signIn 测试 mock 数据包含 refreshToken**

```typescript
it('signIn with email calls login endpoint', async () => {
  const fetch = createMockFetch({ success: true, data: { user: { id: 1, email: 'a@b.com' }, token: 'tok123', refreshToken: 'ref456' } })
  const storage = createMockStorage()
  const auth = new DruviaAuth('/api/v1', fetch, storage)
  const result = await auth.signIn({ email: 'a@b.com', password: '12345678' })
  expect(result.error).toBeNull()
  expect(result.data?.refreshToken).toBe('ref456')
  expect(storage.setItem).toHaveBeenCalled()
})
```

- [ ] **Step 3: 运行全部 SDK 测试**

Run: `pnpm vitest run tests/sdk/`
Expected: ALL PASS

- [ ] **Step 4: 构建 SDK 确认无错误**

Run: `pnpm --filter @druvia/shared build && pnpm --filter @druvia/sdk build`
Expected: 构建成功

- [ ] **Step 5: Commit**

```
test(sdk): 更新 auth 测试覆盖 refreshToken 流程
```

---

## 验证清单

完成所有 Task 后：

**Auth 模块：**
- [ ] `pnpm vitest run tests/sdk/auth.test.ts` — 全部通过
- [ ] `auth.getUser()` 返回 `{ data: { user } }` 结构
- [ ] `auth.getSession()` 返回 `{ data: { session } }` 结构
- [ ] `auth.updateUser()` 能更新用户 profile
- [ ] `auth.refreshSession()` 能用 refresh_token 获取新 session
- [ ] `auth.signOut()` 正常登出

**QueryBuilder 模块：**
- [ ] `pnpm vitest run tests/sdk/query-builder.test.ts` — 全部通过
- [ ] `.or('col.eq.val,col2.eq.val2')` 生成 `_or` GraphQL where
- [ ] `.not('col', 'is', null)` 生成 `_is_null: false`
- [ ] `.maybeSingle()` 0 条结果返回 `{ data: null, error: null }`

**Realtime 模块：**
- [ ] `pnpm vitest run tests/sdk/realtime.test.ts` — 全部通过
- [ ] `druvia.removeChannel(channel)` 关闭 WebSocket 并清理资源

**整体：**
- [ ] `pnpm vitest run tests/sdk/` — 全部 SDK 测试通过
- [ ] `pnpm --filter @druvia/shared build && pnpm --filter @druvia/sdk build` — 构建成功
