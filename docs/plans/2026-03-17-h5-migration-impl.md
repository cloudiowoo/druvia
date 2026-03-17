# H5 端迁移 + 文档 Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 taro-app H5 子项目（Next.js）从 Supabase 迁移到 Druvia，完成全部 39 个 API routes + 20+ RPC 函数的改写，并输出迁移文档。

**Architecture:** H5 端是 Next.js App Router 应用，服务端 API routes 直连 Supabase。迁移后使用 `@druvia/sdk` 替换 `@supabase/supabase-js`，CRUD 链式 API 语法基本不变，RPC 调用改为 `druvia.rpc()`，session 管理保持原有 username + sessionId 模式。

**Tech Stack:** Next.js 16, @druvia/sdk, TypeScript

**Spec:** `docs/plans/2026-03-17-taro-app-migration-design.md` sections 八 (8.1–8.5)

**Depends on:** Plan 1 (@druvia/sdk), Plan 2 (RPC + Edge Functions), Plan 3 (数据已导入 Druvia)

**Target repo:** `/Users/cloudio/Developer/RN/TestRn-Cursor/taro/taro-app/h5`

---

## 前置条件

- [ ] Plan 3 已完成：数据已导入 `dru_taroapp` schema，PG 函数已导入，Hasura 已 track
- [ ] `@druvia/sdk` 包可用（Plan 1 产物）
- [ ] Druvia 开发环境运行中

---

## Chunk 1: 客户端初始化 + 基础设施

### Task 1: 替换依赖与客户端初始化

**Files (h5 repo):**
- Modify: `h5/package.json`
- Create: `h5/src/utils/druvia.ts`（替换 `h5/src/utils/supabase.ts`）

- [ ] **Step 1: 替换依赖**

```bash
cd /Users/cloudio/Developer/RN/TestRn-Cursor/taro/taro-app/h5
pnpm remove @supabase/supabase-js
pnpm add @druvia/sdk@workspace:*  # 或 link 到本地 SDK
```

- [ ] **Step 2: 创建 `h5/src/utils/druvia.ts`**

```typescript
// h5/src/utils/druvia.ts
import { createClient } from '@druvia/sdk'

/**
 * 动态获取 Druvia URL
 * 复用原有 Supabase 的自动适配逻辑
 * 注意：原 Supabase 使用 :8000 (Kong gateway)，Druvia API 使用 :3001
 * 生产环境通过 nginx 代理，无需指定端口
 */
function getDruviaUrl(): string {
  if (typeof window === 'undefined') {
    return process.env.NEXT_PUBLIC_DRUVIA_URL || 'http://localhost:3001'
  }

  const currentHost = window.location.hostname
  const currentProtocol = window.location.protocol

  if (currentHost === 'localhost' || currentHost === '127.0.0.1') {
    return 'http://localhost:3001'
  }

  const isLanIp = /^(192\.168\.|10\.|172\.(1[6-9]|2[0-9]|3[01])\.)/.test(currentHost)
  if (isLanIp) {
    return `http://${currentHost}:3001`
  }

  // 域名访问：去掉 h5 子域名
  const domain = currentHost.replace(/^h5\./, '')
  return `${currentProtocol}//${domain}`
}

const druviaUrl = getDruviaUrl()
const druviaApiKey = process.env.NEXT_PUBLIC_DRUVIA_API_KEY
const druviaProjectId = process.env.NEXT_PUBLIC_DRUVIA_PROJECT_ID

if (!druviaApiKey) {
  throw new Error(
    'Missing Druvia environment variables. ' +
    'Please configure NEXT_PUBLIC_DRUVIA_API_KEY in .env.local'
  )
}

if (!druviaProjectId) {
  throw new Error(
    'Missing Druvia environment variables. ' +
    'Please configure NEXT_PUBLIC_DRUVIA_PROJECT_ID in .env.local'
  )
}

export const druvia = createClient(druviaUrl, druviaApiKey, {
  projectId: druviaProjectId,
})

console.log('[Druvia] Client initialized:', {
  url: druviaUrl,
  currentHost: typeof window !== 'undefined' ? window.location.hostname : 'SSR',
  hasKey: !!druviaApiKey
})
```

- [ ] **Step 3: 更新 `.env.local`**

```bash
# Before
NEXT_PUBLIC_SUPABASE_URL=...
NEXT_PUBLIC_SUPABASE_ANON_KEY=...

# After
NEXT_PUBLIC_DRUVIA_URL=http://localhost:3001
NEXT_PUBLIC_DRUVIA_API_KEY=<druvia_api_key>
NEXT_PUBLIC_DRUVIA_PROJECT_ID=<project_id>
```

---

### Task 2: 全局 import 替换

**背景:** H5 端有 21 个 utils 文件 + 39 个 API route 文件引用 `supabase`。需要批量替换 import。

- [ ] **Step 1: 查找所有 supabase import**

```bash
grep -rn "from.*['\"].*supabase['\"]" h5/src/ --include="*.ts" --include="*.tsx"
```

- [ ] **Step 2: 批量替换 import 语句**

所有文件中：
```typescript
// Before
import { supabase } from './supabase'
import { supabase } from '../utils/supabase'
import { supabase } from '@/utils/supabase'

// After
import { druvia } from './druvia'
import { druvia } from '../utils/druvia'
import { druvia } from '@/utils/druvia'
```

- [ ] **Step 3: 批量替换变量名**

所有文件中 `supabase.` → `druvia.`（仅在 CRUD/RPC/Storage 调用上下文中）。

```bash
# 查找所有 supabase. 调用
grep -rn "supabase\." h5/src/ --include="*.ts" --include="*.tsx" | grep -v node_modules | grep -v "supabase.ts"
```

---

### Task 3: server-auth.ts 迁移

**Files:**
- Modify: `h5/src/utils/server-auth.ts`

**背景:** server-auth.ts 用于 API routes 验证 session，查询 `user_sessions` 表。

- [ ] **Step 1: 替换 import 和调用**

```typescript
// h5/src/utils/server-auth.ts
import { NextRequest } from 'next/server'
import { druvia } from './druvia'

// ... 接口定义不变 ...

export async function getServerSession(request: NextRequest): Promise<ServerSession | null> {
  // ... session 提取逻辑不变 ...

  // 替换 supabase → druvia
  const { data: session, error } = await druvia
    .from('user_sessions')
    .select('session_id, user_id, username, login_time, expires_at')
    .eq('session_id', sessionData.sessionId)
    .single()

  // ... 后续逻辑不变 ...
}
```

---

### Task 4: auth.ts 迁移

**Files:**
- Modify: `h5/src/utils/auth.ts`

- [ ] **Step 1: 替换 import**

```typescript
// Before
import { supabase } from './supabase'

// After
import { druvia } from './druvia'
```

auth.ts 的登录逻辑通过 `fetch('/api/auth/login')` 调用服务端 API，客户端不直接调用 Supabase。仅需替换 import。

---

## Chunk 2: API Routes 迁移（CRUD）

### Task 5: auth API routes 迁移

**Files:**
- Modify: `h5/src/app/api/auth/login/route.ts`
- Modify: `h5/src/app/api/auth/wechat-login/route.ts`

- [ ] **Step 1: 替换 auth/login**

```typescript
// import { supabase } from '@/utils/supabase'
import { druvia } from '@/utils/druvia'

// 所有 supabase.from(...) → druvia.from(...)
```

- [ ] **Step 2: 替换 auth/wechat-login**

同上模式替换。

---

### Task 6: stats API routes 迁移 — CRUD 部分

**Files:** 39 个 route.ts 文件，分布在：
- `h5/src/app/api/stats/admin/`
- `h5/src/app/api/stats/combo/`
- `h5/src/app/api/stats/dashboard/`
- `h5/src/app/api/stats/match/`
- `h5/src/app/api/stats/match-detail/`
- `h5/src/app/api/stats/match-event/`
- `h5/src/app/api/stats/match-result/`
- `h5/src/app/api/stats/player/`
- `h5/src/app/api/stats/players/`
- `h5/src/app/api/stats/positions/`
- `h5/src/app/api/stats/recalculate/`
- `h5/src/app/api/stats/team/`
- `h5/src/app/api/stats/team-standing/`
- `h5/src/app/api/stats/aliases/`

**背景:** 大部分 API routes 的模式相同：import supabase → 查询/插入/更新 → 返回结果。迁移是机械性的 import + 变量名替换。

- [ ] **Step 1: 批量替换所有 stats route 文件的 import**

```bash
# 查找所有引用 supabase 的 route 文件
find h5/src/app/api -name "route.ts" -exec grep -l "supabase" {} \;
```

对每个文件执行：
```typescript
// Before
import { supabase } from '@/utils/supabase'

// After
import { druvia } from '@/utils/druvia'
```

- [ ] **Step 2: 批量替换 CRUD 调用变量名**

所有 route 文件中 `supabase.from(` → `druvia.from(`

链式 API 语法不变：`.select()`, `.eq()`, `.order()`, `.range()`, `.single()`, `.insert()`, `.update()`, `.delete()`, `.upsert()` 均兼容。

- [ ] **Step 3: 逐文件检查特殊用法**

部分 route 可能有非标准用法需要手动调整：
- `.textSearch()` — 确认 SDK 是否支持
- `.or()` / `.not()` — 确认 SDK 是否支持
- `.csv()` — 确认 SDK 是否支持

```bash
grep -rn "\.textSearch\|\.or(\|\.not(\|\.csv(" h5/src/app/api/ --include="*.ts"
```

不支持的方法需改写为 `druvia.graphql()` 原生 GraphQL 查询。

---

### Task 7: stats API routes 迁移 — RPC 部分

**背景:** 20+ RPC 调用分布在多个 route 文件和 utils 中。所有 `supabase.rpc('fn_name', args)` → `druvia.rpc('fn_name', args)`。

- [ ] **Step 1: 批量替换 RPC 调用**

已确认的 RPC 调用位置（20 处）：

| 文件 | RPC 函数 |
|------|----------|
| `utils/user-matcher.ts:357` | `fuzzy_match_users` |
| `utils/activity-import-service.ts:717` | `calculate_season_aggregation` |
| `utils/activity-import-service.ts:727` | `calculate_player_combo_aggregation` |
| `utils/import-service.ts:341` | `import_player_with_transaction` |
| `utils/import-service.ts:599` | `verify_excel_totals` |
| `utils/import-service.ts:676` | `calculate_season_aggregation` |
| `api/stats/team/color/[category]/route.ts:17` | `get_team_color_standings` |
| `api/stats/recalculate/route.ts:26,39,59,63` | `calculate_season_aggregation`, `calculate_player_combo_aggregation` |
| `api/stats/match-detail/draft/route.ts:75` | `create_draft_with_events` |
| `api/stats/match-result/[id]/generate-scores/route.ts:321,345,370` | RPC 调用 |
| `api/stats/match-detail/draft/[id]/route.ts:77` | `update_draft_with_events` |
| `api/stats/aliases/resolve/route.ts:169` | `update_import_batch_stats` |
| `api/stats/match-result/[id]/drafts/route.ts:45` | `get_drafts_optimized` |
| `api/stats/match-result/[id]/drafts/conflicts/route.ts:73` | `detect_conflicts_optimized` |
| `api/stats/match-result/[id]/drafts/confirm/route.ts:52` | `confirm_drafts` |

替换模式统一：
```typescript
// Before
const { data, error } = await supabase.rpc('function_name', { arg1, arg2 })

// After
const { data, error } = await druvia.rpc('function_name', { arg1, arg2 })
```

- [ ] **Step 2: 确认所有 PG 函数已导入 dru_taroapp schema**

```bash
psql -h localhost -p 5432 -U postgres -d druvia -c \
  "SELECT proname FROM pg_proc p JOIN pg_namespace n ON p.pronamespace = n.oid WHERE n.nspname = 'dru_taroapp' ORDER BY proname;"
```

对照上表确认所有函数存在。

---

### Task 8: utils 文件迁移

**Files:**
- Modify: `h5/src/utils/import-service.ts`
- Modify: `h5/src/utils/activity-import-service.ts`
- Modify: `h5/src/utils/user-matcher.ts`
- Modify: `h5/src/utils/draft-service.ts`
- Modify: `h5/src/utils/match-service.ts`
- Modify: `h5/src/utils/match-detail-service.ts`
- Modify: `h5/src/utils/match-sync-service.ts`
- Modify: `h5/src/utils/season-service.ts`
- Modify: `h5/src/utils/schedule-service.ts`
- Modify: `h5/src/utils/session-helper.ts`
- Modify: `h5/src/utils/user-list.ts`
- Modify: `h5/src/utils/stats-state.ts`

- [ ] **Step 1: 批量替换所有 utils 文件的 import + 变量名**

```bash
# 查找所有引用 supabase 的 utils 文件
grep -rln "supabase" h5/src/utils/ --include="*.ts" | grep -v "supabase.ts"
```

对每个文件：
- `import { supabase } from './supabase'` → `import { druvia } from './druvia'`
- `supabase.from(` → `druvia.from(`
- `supabase.rpc(` → `druvia.rpc(`
- `supabase.storage` → `druvia.storage`

---

### Task 9: Storage 相关迁移

**Files:**
- Modify: `h5/src/app/api/upload/` 下的 route 文件

- [ ] **Step 1: 替换 Storage 调用**

```typescript
// Before
import { supabase } from '@/utils/supabase'
await supabase.storage.from('team-assets').upload(path, file)
const { data } = supabase.storage.from('team-assets').getPublicUrl(path)

// After
import { druvia } from '@/utils/druvia'
await druvia.storage.from('team-assets').upload(path, file)
const { data } = druvia.storage.from('team-assets').getPublicUrl(path)
```

---

## Chunk 3: 验证 + 清理 + 文档

### Task 10: 编译验证

- [ ] **Step 1: TypeScript 编译检查**

```bash
cd /Users/cloudio/Developer/RN/TestRn-Cursor/taro/taro-app/h5
npx tsc --noEmit
```

Expected: 无类型错误

- [ ] **Step 2: Next.js 构建**

```bash
pnpm build
```

Expected: 构建成功

- [ ] **Step 3: 搜索残留的 Supabase 引用**

```bash
grep -rn "supabase\|SUPABASE" h5/src/ --include="*.ts" --include="*.tsx" | grep -v node_modules
```

Expected: 无结果（旧 `supabase.ts` 已删除）

- [ ] **Step 4: 删除旧文件**

```bash
rm h5/src/utils/supabase.ts
```

---

### Task 11: 功能验证

按 spec 8.5 验证标准逐项测试：

- [ ] **Step 1: username 登录 / session 管理**

浏览器访问 H5 → 输入用户名登录 → 验证 session 创建。

- [ ] **Step 2: 比赛数据 CRUD**

测试比赛列表查询、创建比赛、更新比赛详情。

- [ ] **Step 3: 草稿确认 / 冲突检测（RPC）**

测试 `create_draft_with_events` → `detect_conflicts_optimized` → `confirm_drafts` 链路。

- [ ] **Step 4: 赛季统计计算（RPC）**

测试 `calculate_season_aggregation` + `calculate_player_combo_aggregation`。

- [ ] **Step 5: 球员数据导入**

测试 Excel 导入 → `import_player_with_transaction` → `verify_excel_totals`。

- [ ] **Step 6: 图片上传 / 显示**

测试 Storage 上传 + getPublicUrl 显示。

---

### Task 12: 迁移文档更新

**Files (Druvia repo):**
- Modify: `docs/migration/supabase-compat.md`

- [ ] **Step 1: 更新 Supabase → Druvia 兼容性对照表**

基于 taro-app 实际迁移经验，更新以下内容：

```markdown
## API 映射（基于 taro-app 实际验证）

| Supabase API | Druvia 等价 | 状态 |
|-------------|-------------|------|
| `createClient(url, key)` | `createClient(url, key, { projectId })` | ✅ |
| `.from().select().eq()...` | 相同链式 API | ✅ |
| `.insert() / .update() / .delete() / .upsert()` | 相同 | ✅ |
| `.rpc(name, args)` | `.rpc(name, args)` → RPC 代理端点 | ✅ |
| `.storage.from().upload()` | 相同 | ✅ |
| `.channel().on('postgres_changes')` | 相同（schema 需改为 `dru_<project>`，如 `dru_taroapp`） | ✅ |
| `functions.invoke(name, { body })` | 相同 → Deno Worker | ✅ |
| Supabase Auth (email/password) | druvia.auth.signIn() | ✅ |
| Supabase Auth (OAuth) | 需 Edge Function | ⚠️ |
| RLS (Row Level Security) | Hasura 权限 filter | ⚠️ 需手动配 |
| Broadcast / Presence | 不支持 | ❌ |
| Image transformations | 不支持 | ❌ |
```

- [ ] **Step 2: 添加迁移注意事项**

基于实际迁移中遇到的问题，补充 gotchas：

```markdown
## 迁移注意事项

1. **schema 引用**：Supabase 使用 `public` schema，Druvia 使用 `dru_<project>` schema
   - Realtime subscription 的 `schema` 参数需从 `public` 改为 `dru_<project>`（如 `dru_taroapp`）
   - PG 函数内部的表引用需调整

2. **createClient 差异**：Druvia 需要额外的 `projectId` 参数

3. **select('*')**：SDK 通过 introspection 自动解析字段，首次调用略慢

4. **RPC 参数**：Druvia RPC 代理通过 pg_proc 发现参数名，参数名必须与 PG 函数定义一致

5. **Edge Functions**：需确认函数代码使用 `Deno.serve()` 模式（Druvia Worker 支持）

6. **序列重置**：数据导入后必须重置自增序列，否则 INSERT 会主键冲突
```

---

## Summary

| Chunk | Task | 说明 |
|-------|------|------|
| 1 | Task 1 | 替换依赖 + 创建 druvia.ts 客户端 |
| 1 | Task 2 | 全局 import 批量替换 |
| 1 | Task 3 | server-auth.ts 迁移 |
| 1 | Task 4 | auth.ts 迁移 |
| 2 | Task 5 | auth API routes 迁移 |
| 2 | Task 6 | 34 个 stats API routes CRUD 替换 |
| 2 | Task 7 | 20+ RPC 调用替换 |
| 2 | Task 8 | 12 个 utils 文件替换 |
| 2 | Task 9 | Storage 相关迁移 |
| 3 | Task 10 | 编译验证 + 残留检查 |
| 3 | Task 11 | 功能验证（6 项验收标准） |
| 3 | Task 12 | supabase-compat.md 文档更新 |
