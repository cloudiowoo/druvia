# Druvia SDK Auth 模块适配需求

> **来源**: taro-app Supabase → Druvia 迁移
> **优先级**: 高（阻塞 taro-app 迁移验证）
> **日期**: 2026-03-18
> **SDK 版本**: `@druvia/sdk` v0.1.0
> **文件**: `packages/sdk/src/modules/auth.ts`

---

## 背景

taro-app 迁移过程中，代码中 9 处 `druvia.auth.*` 调用沿用了 Supabase Auth SDK 的调用方式和返回值结构。当前 Druvia SDK Auth 模块存在返回值结构差异和方法缺失，需要适配。

---

## 1. 返回值结构对齐（2 个方法）

### 1.1 `auth.getUser()` — 4 处使用

**当前 SDK 返回**:
```typescript
{ data: UserInfo | null, error: DruviaError | null }
```

**taro-app 期望（Supabase 风格）**:
```typescript
{ data: { user: UserInfo | null }, error: DruviaError | null }
```

**调用示例**:
```typescript
// auth-context.tsx (3处), auth.ts (1处)
const { data: { user }, error } = await druvia.auth.getUser();
```

### 1.2 `auth.getSession()` — 2 处使用

**当前 SDK 返回**:
```typescript
{ data: Session | null, error: DruviaError | null }
```

**taro-app 期望（Supabase 风格）**:
```typescript
{ data: { session: Session | null }, error: DruviaError | null }
```

**调用示例**:
```typescript
// profile/index.tsx
const { data: sessionData } = await druvia.auth.getSession();
// sessionData.session.user.id

// auth.ts
const { data: { session }, error } = await druvia.auth.getSession();
```

---

## 2. 缺失方法新增（2 个方法）

### 2.1 `auth.refreshSession()` — 1 处使用

**用途**: 使用 refresh_token 刷新过期的 access_token

**签名**:
```typescript
refreshSession(params: { refresh_token: string }): Promise<{
  data: { session: Session | null } | null;
  error: DruviaError | null;
}>
```

**调用示例**:
```typescript
// auth.ts:284
const { data, error } = await druvia.auth.refreshSession({
  refresh_token: session.refresh_token
});

if (data?.session) {
  await saveSessionToStorage(data.session);
}
```

**实现建议**: 调用 Druvia Auth API 的 token refresh 端点，用 refresh_token 换取新的 access_token + refresh_token。

### 2.2 `auth.updateUser()` — 1 处使用

**用途**: 更新用户元数据（用于绕过 RLS 更新用户 profile）

**签名**:
```typescript
updateUser(params: { data: Record<string, unknown> }): Promise<{
  data: { user: UserInfo | null } | null;
  error: DruviaError | null;
}>
```

**调用示例**:
```typescript
// profile/index.tsx:90
await druvia.auth.updateUser({
  data: { username: '新名字', avatar_url: 'https://...' }
});
```

**实现建议**: 调用 Druvia Auth API 的用户更新端点，更新 user_metadata 字段。

---

## 3. 现有方法确认（无需修改）

| 方法 | 使用次数 | 状态 |
|------|---------|------|
| `auth.signOut()` | 1 处 | ✅ 兼容，无需修改 |
| `auth.signIn()` | 0 处 | ✅ 小程序不使用（走 Edge Function） |
| `auth.signUp()` | 0 处 | ✅ 小程序不使用（走 Edge Function） |

---

## 4. 改动汇总

| 类型 | 方法 | 改动 |
|------|------|------|
| 返回值调整 | `getUser()` | `{ data: UserInfo }` → `{ data: { user: UserInfo } }` |
| 返回值调整 | `getSession()` | `{ data: Session }` → `{ data: { session: Session } }` |
| 新增方法 | `refreshSession()` | 用 refresh_token 刷新会话 |
| 新增方法 | `updateUser()` | 更新用户元数据 |

---

## 5. 验证方式

SDK 修改完成后，在 taro-app 中验证：

```bash
cd /Users/cloudio/Developer/RN/TestRn-Cursor/taro/taro-app
npx tsc --noEmit  # TypeScript 编译通过
```

功能验证：
- [ ] `auth.getUser()` 返回 `{ data: { user } }` 结构
- [ ] `auth.getSession()` 返回 `{ data: { session } }` 结构
- [ ] `auth.refreshSession()` 能用 refresh_token 获取新 session
- [ ] `auth.updateUser()` 能更新用户元数据
- [ ] `auth.signOut()` 正常登出
