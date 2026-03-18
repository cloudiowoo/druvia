# Druvia SDK 功能适配需求（taro-app 迁移）

> **来源**: taro-app Supabase → Druvia 迁移
> **日期**: 2026-03-18
> **SDK 版本**: `@druvia/sdk` v0.1.0
> **优先级**: 高（阻塞 taro-app 迁移验证）

---

## 概述

taro-app 迁移过程中发现 SDK 存在功能缺失和接口差异，分为两类：
- **QueryBuilder 缺失方法**（5 项）
- **Auth 模块适配**（4 项，详见 `2026-03-18-druvia-sdk-auth-requirements.md`）

---

## 一、QueryBuilder 缺失方法

### 1. `.or()` — 逻辑或查询 【阻塞】

**使用次数**: 2 处
**文件**: `src/app.tsx`, `src/pages/activities/index.tsx`

```typescript
// 当前调用
const { data } = await druvia
  .from('activities')
  .select('*')
  .or('is_demo.eq.true,is_creator_demo.eq.true')
  .order('activity_date', { ascending: true });
```

**期望签名**:
```typescript
or(filters: string): PromiseLike<DruviaResponse<T[]>> & QueryBuilder<T>;
```

**临时替代**: 可拆为两次查询合并，但性能差且代码复杂。建议 SDK 原生支持。

---

### 2. `.not()` — 逻辑非查询 【部分可替代】

**使用次数**: 3 处
**文件**: `src/pages/activity-detail/index.tsx`, `src/components/PositionGrid.tsx`

```typescript
// 当前调用
.not('display_name', 'is', null)  // 排除 null 值
```

**期望签名**:
```typescript
not(column: string, operator: string, value: unknown): PromiseLike<DruviaResponse<T[]>> & QueryBuilder<T>;
```

**临时替代**: `.not('col', 'is', null)` 可用 `.neq('col', null)` 或 Hasura `_is_null: false` 替代，但语义不完全等价。

---

### 3. `.maybeSingle()` — 可选单条查询 【阻塞】

**使用次数**: 5 处
**文件**: `src/pages/activity-detail/index.tsx`(3处), `src/components/PositionGrid.tsx`(2处)

```typescript
// 当前调用
const { data } = await druvia
  .from('user_activities')
  .select('*')
  .eq('user_id', userId)
  .eq('activity_id', activityId)
  .maybeSingle();
```

**与 `single()` 的区别**: `single()` 在 0 条结果时返回 error，`maybeSingle()` 在 0 条时返回 `{ data: null, error: null }`。

**期望签名**:
```typescript
maybeSingle(): PromiseLike<DruviaResponse<T | null>>;
```

**临时替代**: 可用 `.limit(1)` 后取 `data?.[0] ?? null`，但需要修改每处调用。

---

### 4. `.removeChannel()` — 取消实时订阅 【阻塞】

**使用次数**: 1 处
**文件**: `src/pages/activity-detail/index.tsx`

```typescript
// 当前调用
druvia.removeChannel(subscription);
```

**期望签名**（在 DruviaClient 上）:
```typescript
removeChannel(channel: RealtimeChannel | Subscription): void;
```

**说明**: Supabase 的 `removeChannel` 是在 client 实例上调用，用于清理订阅资源。

---

### 5. `select()` 支持 count 参数 【已 workaround，建议支持】

**使用次数**: 3 处（`druvia.ts` 已 workaround，`team-manage/index.tsx` 未处理）
**文件**: `src/pages/team-manage/index.tsx`

```typescript
// 当前调用
const { count, error } = await druvia
  .from('user_activities')
  .select('*', { count: 'exact', head: true })
  .eq('team_id', team.id);
```

**期望签名**:
```typescript
select(fields?: string, options?: { count?: 'exact' | 'planned' | 'estimated'; head?: boolean }): ...;
```

**当前 workaround**: 改为 `.select('id')` 后取 `data.length`，但效率低。

---

### 6. `order()` 支持 foreignTable 参数 【已 workaround，建议支持】

**使用次数**: 6 处
**文件**: `src/pages/activity-detail/index.tsx`

```typescript
// 当前调用
.order('weight', { foreignTable: 'teams', ascending: true })
```

**期望签名**:
```typescript
order(column: string, opts?: { ascending?: boolean; foreignTable?: string }): this;
```

**当前 workaround**: 去掉 foreignTable，依赖 Hasura 默认排序。排序可能不准确。

---

## 二、Auth 模块适配

详见 `docs/plans/2026-03-18-druvia-sdk-auth-requirements.md`，包含：

1. `getUser()` 返回值结构对齐（4处）
2. `getSession()` 返回值结构对齐（2处）
3. 新增 `refreshSession()`（1处）
4. 新增 `updateUser()`（1处）

---

## 三、优先级排序

### P0 — 阻塞迁移验证（必须修复）

| 功能 | 影响范围 |
|------|---------|
| Auth 返回值结构（getUser/getSession） | 6处，认证流程不通 |
| `auth.refreshSession()` | 1处，token 刷新不可用 |
| `auth.updateUser()` | 1处，用户资料更新不可用 |
| `.maybeSingle()` | 5处，查询结果处理异常 |
| `.or()` | 2处，示例活动查询不可用 |
| `.removeChannel()` | 1处，实时订阅资源泄漏 |

### P1 — 已有 workaround，建议后续支持

| 功能 | 影响范围 |
|------|---------|
| `select({ count, head })` | 3处，计数效率低 |
| `order({ foreignTable })` | 6处，关联表排序不准确 |
| `.not()` | 3处，可用 `neq` 部分替代 |

---

## 四、验证方式

SDK 修改完成后：

```bash
# 1. 重新构建 SDK
cd /Users/cloudio/Developer/nodejs/Druvia/packages/sdk
pnpm build

# 2. taro-app TypeScript 编译
cd /Users/cloudio/Developer/RN/TestRn-Cursor/taro/taro-app
npx tsc --noEmit

# 3. 功能验证（微信开发者工具）
# - 示例活动列表加载（.or）
# - 加入活动位置（.maybeSingle）
# - 实时订阅/取消（.removeChannel）
# - 登录/刷新token（Auth）
```
