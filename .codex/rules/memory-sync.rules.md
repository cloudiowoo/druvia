# Druvia Memory Sync Rules

## Intent

Prevent noisy documentation churn while still keeping durable project knowledge recoverable in future Codex sessions.

## Default Rule

Do not update project memory after every trivial task.

Only trigger automatic memory sync when the completed task changed project understanding in a durable way, such as:

- architecture conclusions
- debug root causes
- environment or migration prerequisites
- process conventions
- cross-subproject impacts
- lasting security or permission rules

## Explicit Command Rule

The repository supports these user text conventions:

- `/update_progress`
- `/update_agents`
- `/sync_memory`

These are not native Codex CLI slash commands. Treat them as explicit user instructions encoded as text.

## Command Semantics

### `/update_progress`

Force an update to `docs/progress.md` even if the task itself was small.

Use when the main value is:

- milestone status
- work completed
- blocker removed
- current next steps

### `/update_agents`

Force a sync of agent-facing project memory even if the task itself was small.

When triggered:

- summarize what was learned
- update `docs/agent/project-memory.md` if durable project understanding changed
- update `docs/agent/design-decisions.md` if a lasting decision was made
- update module `AGENTS.md` only if the rule is subtree-specific

Do not update `docs/progress.md` unless the task also changed human-facing progress.

### `/sync_memory`

Run both tracks:

- update `docs/progress.md` for progress
- update agent-facing memory and decisions for durable knowledge

## Minimal-Change Rule

When memory sync is triggered:

- update only the smallest set of files needed
- prefer `docs/agent/project-memory.md` over root `AGENTS.md`
- prefer module `AGENTS.md` over adding module details to root
- avoid rewriting old progress entries unless they are now misleading

## Output Priority

Choose targets in this order:

1. `docs/progress.md` for human-facing progress
2. `docs/agent/project-memory.md` for recent durable facts
3. `docs/agent/design-decisions.md` for lasting decisions
4. nearest subtree `AGENTS.md` for module-specific rules
5. `docs/plans/*` for full rationale
