# Explicit project backup protection

Status: implemented and deployed to the authorized PITCHETCH Local/GLOBAL environments on 2026-11-18; real-device application acceptance remains in progress. The owning application decision and acceptance checklist is PITCHETCH `docs/2026-11-18-session-diagnostic-submission.md` §10. This platform change serves only explicitly registered projects. Existing staged Data Access documentation is unrelated and preserved.

## Contract

`PROJECT_BACKUP_GUARDS_FILE` names a private 0600 deployment configuration JSON file. Missing environment configuration preserves compatibility. A configured file that is absent, malformed or unsafe fails startup/guarded operations. Format: `{version:1,projects:[{projectId,schemaName,hookSchema,hookName,hookOwner,hookHash,retentionDays,journalDirectory}]}`. Registration is an operator deployment action; there is no public configuration endpoint. Identifiers are validated, project and schema registrations unique, retention an integer 1–30 days, journal location absolute and independent of database/backup storage. Every deployment/recreation must preserve this configuration and its mount.

The Hook is `text → jsonb`, SECURITY DEFINER with a non-login, non-inheriting, non-superuser owner and no role memberships. Direct EXECUTE grants other than owner/superuser are rejected. Calls validate exact project/schema mapping and SHA-256 of `pg_get_functiondef` in the statement that executes the Hook. All Hook phases use bounded transactions and return `{completed:true}`, except `export`.

Restore order under the existing Data Access and Project Auth locks:

1. Acquire the per-project backup lock; re-read the backup row and reject expired or changed scope
2. Persist existing platform restore gate, then call `prepare` in a committed transaction to quarantine application reads/writes and drain in-flight work
3. Restore the schema preserving owner/ACL, with exit-on-error and one PostgreSQL transaction
4. Inside the existing account/device fence replay transaction call `beginReplay`, replay registrations/account deletions/receipts, call `replay`, then remove the platform gate
5. On failure retain platform recovery_required; application quarantine remains in force

The application Hook owns diagnostic-specific data and purge behavior. Druvia does not implement football algorithms, infer schemas, or invoke arbitrary hooks discovered from project SQL. Pre-contract snapshots can fail closed and require a controlled application forward recovery.

## Retention and independent receipts

This implementation admits only the currently verified local filesystem storage adapter; a configured project using another provider fails closed until object deletion/privacy semantics are verified. Only registered projects are swept at startup and every 15 minutes, with no overlapping loop and a cross-process advisory lock shared with backup creation/restore/manual deletion. Each cycle deletes at most 25 expired objects, from their creation time; legacy null-project rows require exact registered schema and tenant mapping. Failed/pending objects are included only after expiry and after acquiring the upload lock. Validate canonical storage keys, delete object, confirm absence, then remove metadata. Storage failures retain retryable metadata. A backlog does not refresh the application receiving lease.

After a successful sweep, `export` returns only `{version:1,schema,fences:[{id,state,createdAt}]}`. The file is validated, merged monotonically with the previously retained journal, fsynced and atomically replaced with 0600 permissions. No account identity, raw observations or health data enter it. The initial empty journal is explicitly created during enrollment; a missing/corrupt existing journal is an error. Only after this succeeds does `retention` refresh the application receiving lease. Exports are periodic, not a zero-loss synchronous external deletion ledger.

Database/host disaster recovery must stop application traffic and operator access before restore. The PITCHETCH guard rejects a changed PostgreSQL start generation. Its manual recovery imports independently retained receipts and conservatively deletes every restored temporary diagnostic package because receipts after the last export cannot be proven complete; original client sessions are unaffected. Missing independent receipts keep the service closed. This does not claim automatic disaster recovery for the whole platform.

The 30-day setting is an operational retention target enforced while the scheduler and storage are available; outage/backlog is reported and new intake lease expires. Before rollout, inventory any whole-database/host/manual backup paths separately. A policy value alone does not prove deletion from those paths.

## Verification and rollout

- [x] Focused tests reproduce absent hooks/guard failure and cover contract pinning, receipts, storage failure, restore callback order and expired downloads
- [x] Full affected API regression and TypeScript build after final change
- [x] Application V54 real PostgreSQL restore matrix, including account deletion/expiry and duplicate replay
- [x] Local/GLOBAL configuration, identical application version, backup-storage and scheduling checks
- [x] Authorized activation after evidence; real device consent remains an application acceptance item

No automatic review, Git mutation, remote Git access or message sending was performed. Platform migration version remains 030; no new platform tables or public interfaces are introduced.


2026-11-18 evidence: 52 focused tests in 10 files passed (`/tmp/druvia-d1-protection-final.log`); API TypeScript build passed (`/tmp/druvia-d1-api-final-build.log`). PITCHETCH V54 checksum `02f55773d4c02f96acce5e62330c20c9223561ea9742ddad50d6de35ec567c53` matches both targets. Actual API database caller identity meets the management Hook superuser requirement. Existing source baselines, image, runtime environment and mounts were checked before targeted source/dist deployment and API-only recreation. Old artifacts/configuration are retained in private operations storage.

Both targets passed native Hook invocation, expired synthetic backup object+row removal, fresh object retention, private storage and independent journal checks. Public HTTPS and origin authenticated policy reads returned 200/enabled with 30-day backup retention; unauthenticated returned 401. One initial public TLS attempt failed and succeeded on retry. No real application records were altered by these tests. A user subsequently consented to one sync-only diagnostic package; its audited read and application acceptance are tracked in the owning PITCHETCH document.

The managed backup inventory was empty before synthetic checks; Time Machine destination inventory was empty on both hosts. New whole-database/manual/host backup paths require separate retention coverage. The API-only rollout preserves PostgreSQL and shared service configuration; ongoing operation still depends on host/Docker availability and preservation of the explicit deployment registration.
