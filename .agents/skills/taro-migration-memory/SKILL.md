---
name: taro-migration-memory
description: Use when changing Druvia auth, API keys, GraphQL, Functions, Storage, Realtime, or SDK behavior that may affect Supabase-to-Druvia or taro-app compatibility.
---

# Taro Migration Memory

## Check First

1. Read root `AGENTS.md` and the nearest `apps/api/AGENTS.md` or `packages/sdk/AGENTS.md`.
2. Read `docs/agent/design-decisions.md` and `docs/plans/2026-03-17-taro-app-migration-design.md`.
3. For auth or invoke permissions, also read:
   - `docs/plans/2026-03-19-apikey-auth-design.md`
   - `docs/plans/2026-03-23-function-invoke-auth-ui-design.md`

## High-Risk Assumptions

- GraphQL anonymous access does not imply Functions should be anonymous by default.
- Project `apikey` support does not justify opening upload or user-state functions.
- A frontend save failure may indicate a missing migration rather than a UI defect.
- Interface similarity is not proof of Supabase behavior compatibility.

## Decision Rules

- Default Functions invoke to `jwt_required`.
- Use `anon_allowed` only for explicit pre-authentication flows.
- Before anonymous invoke, inspect Worker-side caller validation.
- Verify token selection and response behavior against the real API middleware contract.

## After The Change

- Put a new module constraint in the nearest `AGENTS.md`.
- Put a lasting security decision in `docs/agent/design-decisions.md`.
- Use a dated `docs/plans/*` document when evidence or rollout context matters.

