---
name: taro-migration-memory
description: Use when working on Supabase-to-Druvia or taro-app compatibility so you check the known migration-sensitive rules before changing auth, functions, storage, or SDK behavior.
---

# Taro Migration Memory

Use this skill when a task touches taro-app migration compatibility, especially:

- API key auth
- GraphQL proxy behavior
- Functions invoke permissions
- SDK auth or functions wrappers
- login-before-session flows

## Check First

1. Read:
   - `docs/agent/project-memory.md`
   - `docs/plans/2026-03-17-taro-app-migration-design.md`
2. If the task is about auth or invoke permissions, also read:
   - `docs/plans/2026-03-19-apikey-auth-design.md`
   - `docs/plans/2026-03-23-function-invoke-auth-ui-design.md`

## Known High-Risk Assumptions

- GraphQL anonymous access working does not imply Functions invoke should be anonymous by default.
- Project-level `apikey` support does not justify opening upload or user-state functions.
- A frontend save failure may be a missing migration, not a UI bug.

## Decision Rules

- Default to `jwt_required` for function invoke.
- Only allow `anon_allowed` for explicit login-before-auth flows.
- Before enabling anonymous invoke, inspect the worker implementation for its own caller validation.

## After the Change

- If you learned a new migration constraint, update `docs/agent/project-memory.md`.
- If you changed a lasting security rule, update `docs/agent/design-decisions.md`.
