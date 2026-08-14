---
name: druvia-doc-update
description: Use when a Druvia change alters permissions, compatibility, migration prerequisites, module rules, architecture decisions, or milestone status and project documentation may need synchronization.
---

# Druvia Doc Update

Keep durable project context current without documenting every trivial change.

## Workflow

1. Classify the new information:
   - human-facing milestone or current next step
   - lasting architecture or security decision
   - subtree-specific working rule
   - detailed design, evidence, or rollout context
2. Update the smallest appropriate target:
   - `docs/progress.md` for milestones and current status
   - `docs/agent/design-decisions.md` for decisions the team should not re-debate
   - nearest `AGENTS.md` for subtree-specific rules
   - root `AGENTS.md` only for repository-wide constraints every task must see
   - `docs/plans/YYYY-MM-DD-*.md` for full rationale, evidence, and implementation context
3. Remove or correct stale statements instead of adding contradictory notes.
4. Mirror into `.claude/*` only when Claude compatibility is explicitly required.

## Update Triggers

- permission or identity model changes
- Supabase/taro-app compatibility conclusions
- migration or deployment prerequisites
- recurring production/debugging root causes
- release, OTA, or cross-module process changes

## Biases

- Prefer secure defaults and concrete migration gaps.
- Keep root `AGENTS.md` concise.
- Do not create a parallel `project-memory.md`.

