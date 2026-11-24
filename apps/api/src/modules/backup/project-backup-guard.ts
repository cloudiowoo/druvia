import { constants } from 'node:fs';
import { readFile, lstat, mkdir, open, rename, unlink } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';

export interface ProjectBackupGuard {
  projectId: string;
  schemaName: string;
  hookSchema: string;
  hookName: string;
  hookOwner: string;
  hookHash: string;
  retentionDays: number;
  journalDirectory: string;
}
export type BackupGuardPhase = 'prepare' | 'beginReplay' | 'replay' | 'retention' | 'export';
export class ProjectBackupGuardError extends Error {
  readonly code = 'PROJECT_BACKUP_GUARD_REQUIRED';
  constructor() { super('Project backup protection is unavailable'); }
}
const identifier = /^[a-z_][a-z0-9_]{0,62}$/;
const projectIdentifier = /^[a-zA-Z0-9_-]{1,128}$/;
const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const keysEqual = (value: Record<string, unknown>, keys: string[]) =>
  Object.keys(value).sort().join(',') === [...keys].sort().join(',');

export function parseProjectBackupGuards(value: unknown): ProjectBackupGuard[] {
  if (!isObject(value) || !keysEqual(value, ['version', 'projects']) || value.version !== 1
    || !Array.isArray(value.projects) || value.projects.length > 20) throw new ProjectBackupGuardError();
  const projects = new Set<string>();
  const schemas = new Set<string>();
  return value.projects.map((item: unknown) => {
    if (!isObject(item) || !keysEqual(item, ['projectId', 'schemaName', 'hookSchema', 'hookName',
      'hookOwner', 'hookHash', 'retentionDays', 'journalDirectory'])
      || typeof item.projectId !== 'string' || !projectIdentifier.test(item.projectId)
      || !['schemaName', 'hookSchema', 'hookName', 'hookOwner'].every(
        key => typeof item[key] === 'string' && identifier.test(item[key] as string))
      || typeof item.hookHash !== 'string' || !/^[a-f0-9]{64}$/.test(item.hookHash)
      || !Number.isInteger(item.retentionDays) || Number(item.retentionDays) < 1 || Number(item.retentionDays) > 30
      || typeof item.journalDirectory !== 'string' || !isAbsolute(item.journalDirectory)
      || item.journalDirectory.includes('\0') || projects.has(item.projectId)
      || schemas.has(item.schemaName as string)) throw new ProjectBackupGuardError();
    projects.add(item.projectId);
    schemas.add(item.schemaName as string);
    return item as unknown as ProjectBackupGuard;
  });
}

// Deployment configuration only. No Project Session or settings API can register a Hook.
export async function loadProjectBackupGuards(): Promise<ProjectBackupGuard[]> {
  const file = process.env.PROJECT_BACKUP_GUARDS_FILE;
  if (!file) return [];
  try {
    if (!isAbsolute(file)) throw new ProjectBackupGuardError();
    const info = await lstat(file);
    if (!info.isFile() || (info.mode & 0o077) !== 0 || info.size > 65536) throw new ProjectBackupGuardError();
    return parseProjectBackupGuards(JSON.parse(await readFile(file, 'utf8')));
  } catch { throw new ProjectBackupGuardError(); }
}

export async function projectBackupGuard(projectId: string): Promise<ProjectBackupGuard | undefined> {
  return (await loadProjectBackupGuards()).find(item => item.projectId === projectId);
}

export async function executeProjectBackupGuard(
  client: PoolClient, guard: ProjectBackupGuard, phase: BackupGuardPhase,
): Promise<unknown> {
  try {
    // All call sites own a transaction. Bound both lock waits and application Hook execution.
    await client.query("SELECT set_config('statement_timeout', '30000ms', true)");
    const { rows } = await client.query<{ result: unknown }>(
      `SELECT CASE WHEN EXISTS (
         SELECT 1 FROM pg_proc p
         JOIN pg_namespace n ON n.oid=p.pronamespace JOIN pg_roles r ON r.oid=p.proowner
         WHERE n.nspname=$2 AND p.proname=$3 AND p.proargtypes='25'::oidvector
           AND p.prorettype='jsonb'::regtype AND p.prosecdef AND p.prokind='f'
           AND r.rolname=$4 AND NOT (r.rolcanlogin OR r.rolinherit OR r.rolsuper OR r.rolcreatedb
             OR r.rolcreaterole OR r.rolreplication OR r.rolbypassrls)
           AND NOT EXISTS(SELECT 1 FROM pg_auth_members WHERE roleid=r.oid OR member=r.oid)
           AND NOT EXISTS(SELECT 1 FROM aclexplode(COALESCE(p.proacl,acldefault('f',p.proowner))) a
             WHERE a.grantee<>p.proowner AND NOT EXISTS(SELECT 1 FROM pg_roles allowed WHERE allowed.oid=a.grantee AND allowed.rolsuper))
           AND encode(sha256(convert_to(pg_get_functiondef(p.oid),'UTF8')),'hex')=$5
           AND EXISTS(SELECT 1 FROM public.druvia_projects WHERE project_id=$6 AND schema_name=$7)
       ) THEN "${guard.hookSchema}"."${guard.hookName}"($1::text) ELSE NULL END AS result`,
      [phase, guard.hookSchema, guard.hookName, guard.hookOwner, guard.hookHash, guard.projectId, guard.schemaName],
    );
    const result = rows[0]?.result;
    if (!isObject(result) || (phase !== 'export' && result.completed !== true)) throw new ProjectBackupGuardError();
    return result;
  } catch { throw new ProjectBackupGuardError(); }
}

export function validateGuardJournal(guard: ProjectBackupGuard, value: unknown): Record<string, unknown> {
  if (!isObject(value) || !keysEqual(value, ['version', 'schema', 'fences'])
    || value.version !== 1 || value.schema !== guard.schemaName || !Array.isArray(value.fences)
    || value.fences.length > 1000000) throw new ProjectBackupGuardError();
  const ids = new Set<string>();
  for (const fence of value.fences) {
    if (!isObject(fence) || !keysEqual(fence, ['id', 'state', 'createdAt'])
      || typeof fence.id !== 'string' || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(fence.id)
      || ids.has(fence.id) || !['withdrawn', 'expired'].includes(String(fence.state))
      || typeof fence.createdAt !== 'string' || !Number.isFinite(Date.parse(fence.createdAt))) throw new ProjectBackupGuardError();
    ids.add(fence.id);
  }
  return value;
}

export async function writeGuardJournal(guard: ProjectBackupGuard, value: unknown): Promise<void> {
  const journal = validateGuardJournal(guard, value);
  const target = join(guard.journalDirectory, `${guard.projectId}.json`);
  // Never let an older database overwrite newer independently retained receipts.
  const previousInfo = await lstat(target);
  if (!previousInfo.isFile() || (previousInfo.mode & 0o077) !== 0 || previousInfo.size > 64 * 1024 * 1024) throw new ProjectBackupGuardError();
  const previous = validateGuardJournal(guard, JSON.parse(await readFile(target, 'utf8')));
  const fences = new Map<string, { id: string; state: string; createdAt: string }>();
  for (const item of [...previous.fences as never[], ...journal.fences as never[]]) {
    const row = item as { id: string; state: string; createdAt: string };
    const old = fences.get(row.id);
    fences.set(row.id, old ? { id: row.id, state: old.state === 'withdrawn' ? old.state : row.state,
      createdAt: Date.parse(old.createdAt) < Date.parse(row.createdAt) ? old.createdAt : row.createdAt } : row);
  }
  const data = JSON.stringify({ version: 1, schema: guard.schemaName, fences: [...fences.values()].sort((a, b) => a.id.localeCompare(b.id)) });
  if (Buffer.byteLength(data) > 64 * 1024 * 1024) throw new ProjectBackupGuardError();
  await mkdir(guard.journalDirectory, { recursive: true, mode: 0o700 });
  const info = await lstat(guard.journalDirectory);
  if (!info.isDirectory() || (info.mode & 0o077) !== 0) throw new ProjectBackupGuardError();
  const temporary = join(guard.journalDirectory, `.${randomUUID()}.tmp`);
  try {
    const handle = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
    try { await handle.writeFile(data); await handle.sync(); } finally { await handle.close(); }
    await rename(temporary, target);
    const directory = await open(guard.journalDirectory, constants.O_RDONLY);
    try { await directory.sync(); } finally { await directory.close(); }
  } finally { await unlink(temporary).catch(() => {}); }
}
