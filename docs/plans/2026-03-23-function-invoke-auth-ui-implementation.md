# Function Invoke Auth UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `Invoke Auth Mode` viewing and editing to the Admin Functions page while keeping create flow fixed to `JWT Required`.

**Architecture:** Reuse the existing Functions page data flow. The selected-function editor becomes the only place where `invokeAuthMode` can be changed, while the list shows a read-only badge for visibility. Keep the change small by extending existing props and save handlers instead of introducing a new settings page or new API layer.

**Tech Stack:** Next.js 16, React 19, TypeScript, existing Admin UI components, Vitest unit tests, Next build verification

---

### Task 1: Add Focused UI Helpers and Failing Tests

**Files:**
- Create: `apps/admin/src/components/functions/invoke-auth-mode.ts`
- Create: `tests/unit/admin/function-invoke-auth-mode.test.ts`

- [ ] **Step 1: Write failing tests for invoke auth mode labels, descriptions, and badge metadata**

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test tests/unit/admin/function-invoke-auth-mode.test.ts`

- [ ] **Step 3: Add a small helper module for labels, badge tone, and warning copy**

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test tests/unit/admin/function-invoke-auth-mode.test.ts`

### Task 2: Extend FunctionEditor to Manage Invoke Auth Mode

**Files:**
- Modify: `apps/admin/src/components/functions/FunctionEditor.tsx`
- Test: `tests/unit/admin/function-editor-render.test.ts`

- [ ] **Step 1: Write a failing render test that asserts the editor shows Invoke Auth Mode controls and anon warning text**

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test tests/unit/admin/function-editor-render.test.ts`

- [ ] **Step 3: Extend FunctionEditor props and local state to track `invokeAuthMode`**

- [ ] **Step 4: Add the select control below description and show warning text only for `anon_allowed`**

- [ ] **Step 5: Include `invokeAuthMode` in the existing save callback**

- [ ] **Step 6: Run test to verify it passes**

Run: `pnpm test tests/unit/admin/function-editor-render.test.ts`

### Task 3: Show Read-Only Auth Mode Badge in FunctionList

**Files:**
- Modify: `apps/admin/src/components/functions/FunctionList.tsx`
- Test: `tests/unit/admin/function-list-render.test.ts`

- [ ] **Step 1: Write a failing render test that asserts `ANON` and `JWT` badges appear for different functions**

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test tests/unit/admin/function-list-render.test.ts`

- [ ] **Step 3: Render a compact read-only badge in each function row using the helper module**

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test tests/unit/admin/function-list-render.test.ts`

### Task 4: Wire Page Save Flow to Persist Invoke Auth Mode

**Files:**
- Modify: `apps/admin/src/app/t/[tenantId]/p/[projectId]/functions/page.tsx`

- [ ] **Step 1: Update page save handler signature to accept `invokeAuthMode`**

- [ ] **Step 2: Pass `invokeAuthMode` through `api.updateFunction(...)`**

- [ ] **Step 3: Keep create flow unchanged so new functions still default to `jwt_required`**

- [ ] **Step 4: Ensure selected function and list state both refresh with updated mode**

### Task 5: Verify End-to-End Build Safety

**Files:**
- Verify only

- [ ] **Step 1: Run focused Admin UI tests**

Run: `pnpm test tests/unit/admin/function-invoke-auth-mode.test.ts tests/unit/admin/function-editor-render.test.ts tests/unit/admin/function-list-render.test.ts`

- [ ] **Step 2: Run API build to ensure no cross-package regressions**

Run: `pnpm --filter @druvia/api build`

- [ ] **Step 3: Run Admin build and inspect any failure**

Run: `pnpm --filter @druvia/admin build`

- [ ] **Step 4: Report results, separating existing unrelated build failures from this change if they remain**
