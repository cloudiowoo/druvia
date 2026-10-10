# Data Access v2 Explicit Column Grants

## Goal and scope

Allow an authorized platform project manager to explicitly add authenticated `select` and `insert` column grants to an existing managed v2 authorization-projection table. PITCHETCH V29 needs `capture_observation.cumulative_workout_distance_meters` for insert/select and three new `session_summary` select columns. The PITCHETCH JSON file is an input checklist, not a Hasura permission template.

This operation does not modify access modes, owner column, projection constraint, relationship, dependency contract, anonymous grants, update/delete grants, or existing grants. It does not apply application schema migrations or edit Local/GLOBAL metadata automatically.

## Design

- New `grant_extension` policy-operation kind with immutable source/target snapshots, baseline revision, resource version, request digest, writer lease and existing recovery gate. Migration 030 extends the operation-kind constraint. API startup requires migration 030.
- Only managed v2 baselines may be extended. `refresh_required` tables must first run the existing shrink-only reconcile. Reject custom, missing dependency provenance, active recovery, and any outstanding project operation.
- Preview receives explicit additions for authenticated select/insert. Require nonempty, unique, not already granted, capability-valid column names. Require the relevant access mode to be enabled; exclude owner insert preset column. Build the target by unioning only those additions into the saved grants, then materialize the *unchanged* baseline policy.
- Apply confirms operation ID, source/target digests, baseline revision and project alias. Recheck current schema, baseline, metadata, column capabilities and projection dependency before the existing permission writer runs. Recheck dependency after the write and before the baseline commit. Recovery uses the recorded source/target snapshots; unexpected third-party metadata remains a recovery gate.
- The Admin table panel offers an explicit preview/confirm flow for managed v2 tables. Normal policy Save remains unavailable for v2; refresh remains shrink-only. Display exactly the newly added fields and the unchanged projection rule.
- No direct Hasura metadata edit, owner-only fallback or automatic grant of new columns. No role or public permission change.

## Implementation sequence

1. Add failing policy-operation tests for preview/apply, unchanged projection filter, invalid additions, stale revision/dependency and recovery behavior.
2. Add migration 030 and update migration compatibility, CLI bootstrap registry, release workflow and manifest target checks.
3. Add dedicated API preview/apply routes, payload validation and policy operation implementation using existing writer/recovery machinery.
4. Add Admin API types and the table-level preview/confirmation flow; test the v2 view and preserve v1 behavior.
5. Run focused API/Admin tests, migration and release-contract tests, typechecks/build, and review the diff. Update the durable module rule and release prerequisites if the implementation changes them.

## Acceptance

- No grant appears before apply; after apply only the requested authenticated columns are added.
- `capture_observation` retains owner insert check and owner-plus-projection select; `session_summary` retains owner-plus-projection select. Anonymous, update/delete and all other scoped permissions remain byte-for-byte equivalent after canonicalization.
- Duplicate, absent, generated/non-insertable, already granted and owner preset insert columns fail before metadata writes.
- Drift in baseline, schema, columns, Hasura resource version, projection definition/relationship or active operation fails closed.
- Apply replay is idempotent; unknown write outcomes retain the recovery gate and recover only attributed source/target or recorded command-prefix states.
- Existing v1 policy updates and v2 shrink-only reconcile continue to work. PITCHETCH V2 verifier and dual-user probes remain separate Local/GLOBAL rollout steps.

## Status

Implementation completed in the main checkout. Migration 030, API preview/apply, Admin confirmation flow, release ceiling and documentation are updated. Unit tests: 175 files, 1366 tests passed; API and Admin typechecks and builds passed. The isolated PostgreSQL + Hasura integration test was added to the existing release gate but was not run against a disposable stack in this session.

Local rollout completed on 2026-10-10 against the active `postgres-postgis` database: applied migration 030, rebuilt/restarted API and Admin, reconciled `capture_observation` and `session_summary` from revision 2 to 3, then applied explicit grants to revision 4. `capture_observation.cumulative_workout_distance_meters` has authenticated select/insert; `session_summary.watch_workout_distance_meters`, `gps_distance_meters` and `distance_source` have authenticated select only. Both tables remain `managed` with the original owner AND authorization-projection policy. The PITCHETCH `verify-workout-distance-data-access.sh` read-only audit passed against Local; Hasura reported zero inconsistent metadata objects, and the local API/Admin entrances returned HTTP 200. No project-user tokens were available for a dual-user GraphQL probe.

GLOBAL remains unchanged. Its rollout still requires migration 030, deployment of the new API/Admin, any needed shrink-only reconcile, explicit preview/apply of the same PITCHETCH V2 columns, the PITCHETCH verifier and dual-user probes. Do not modify Hasura metadata directly or temporarily replace projection rules with owner-only access.
