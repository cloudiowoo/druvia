---
name: druvia-doc-update
description: Use when a Druvia code change should also update project memory, module AGENTS, or plan docs so future Codex sessions recover the new rules quickly.
---

# Druvia Doc Update

Use this skill after meaningful Druvia changes, especially when the change affects:

- permissions
- Supabase or taro-app compatibility
- admin configuration behavior
- migration prerequisites
- module-specific working rules
- durable project understanding

## Goal

Keep Codex-facing project context current without forcing every session to rediscover the same facts.

## Workflow

1. Decide whether the change is:
   - recent operational fact
   - long-lived design decision
   - module-specific rule
   - full design / implementation context
2. Update the right target:
   - `docs/agent/project-memory.md`
   - `docs/progress.md`
   - `docs/agent/design-decisions.md`
   - nearest `AGENTS.md`
   - `docs/plans/YYYY-MM-DD-*.md`
3. Keep the root `AGENTS.md` short. Add only:
   - a new high-priority rule
   - a new important change
   - a new useful-file pointer
4. When the change matters to Claude workflows too, mirror only the minimum needed into `.claude/*`.

## Classification Guide

- Put it in `project-memory.md` when a new session is likely to trip over it.
- Put it in `docs/progress.md` when the main change is human-facing progress or milestone status.
- Put it in `design-decisions.md` when the team should stop re-debating it.
- Put it in module `AGENTS.md` when it only matters inside one subtree.
- Put it in `docs/plans/*` when the rationale or rollout details matter.

## Explicit Sync Commands

Treat these as repository conventions, not native Codex slash commands:

- `/update_progress`: force a `docs/progress.md` update
- `/update_agents`: force project-memory and decision sync even for a small task
- `/sync_memory`: update both progress and agent-facing memory as needed

For exact trigger logic, follow `.codex/rules/memory-sync.rules.md`.

## Current Druvia Biases

- Prefer documenting migration compatibility gaps over abstract platform completeness.
- Prefer secure defaults.
- Treat anonymous invoke allowances as exceptional, not normal.
