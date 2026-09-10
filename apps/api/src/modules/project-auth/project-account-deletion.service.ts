import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import type { PoolClient } from 'pg';
import { AppleAdapterError, type AppleNativeCredential } from '../../adapters/auth/index.js';
import { config } from '../../config/index.js';
import { pool, queryOne } from '../../db/index.js';
import { encryptSecret } from '../../lib/secret-encryption.js';
import { createApiLogger } from '../../lib/logger.js';
import {
  deriveAccountDeletionReauthNonce,
  deriveAccountDeletionStatusToken,
  fingerprintAccountDeletionSubject,
  verifyAccountDeletionStatusToken,
} from './project-account-deletion.crypto.js';
import {
  claimAccountDeletionConfirmation,
  findAccountDeletion,
  findActiveAccountDeletionForUser,
  insertAccountDeletionIntent,
} from './project-account-deletion.repository.js';
import {
  toProjectAccountDeletionStatusDto,
  type ProjectAccountDeletionOperation,
  type ProjectAccountDeletionStatusDto,
} from './project-account-deletion.types.js';
import { getAppleAdapter, ProjectAuthError } from './project-auth.service.js';
import { ProjectRuntimeBlockedError, assertProjectSessionUsable } from './project-session-state.js';
import {
  acquireProjectAuthIdentityIdLock,
  acquireProjectAuthProjectLock,
  findProjectAuthIdentityById,
  findProjectAuthIdentityByProjectUser,
  markProjectAuthIdentityDeletionPending,
  deleteProjectAuthProviderTokens,
} from './project-identity.repository.js';

const APPLE_ISSUER = 'https://appleid.apple.com';
const CLEANUP_FUNCTION = 'druvia_delete_project_user_data';
const logger = createApiLogger({ module: 'project-account-deletion' });

function assertDeletionSecrets(): void {
  if (
    Buffer.byteLength(config.accountDeletion.statusSecret, 'utf8') < 32
    || Buffer.byteLength(config.accountDeletion.fenceSecret, 'utf8') < 32
  ) {
    throw new ProjectAuthError(
      'ACCOUNT_DELETION_NOT_CONFIGURED',
      'Account deletion security keys are not configured',
      503,
    );
  }
}

function sha256(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function quoteIdentifier(value: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) {
    throw new Error('ACCOUNT_DELETION_CLEANUP_CONTRACT_CHANGED');
  }
  return `"${value.replace(/"/g, '""')}"`;
}

function credentialFor(operation: ProjectAccountDeletionOperation) {
  const input = {
    secret: config.accountDeletion.statusSecret,
    projectId: operation.projectId,
    deletionId: operation.deletionId,
  };
  return {
    statusToken: deriveAccountDeletionStatusToken(input),
    reauthNonce: deriveAccountDeletionReauthNonce(input),
  };
}

interface CleanupContract {
  schemaName: string;
  functionName: string;
  contractHash: string;
}

function cleanupContractSelect(schemaParameter: string, functionParameter: string): string {
  return `SELECT owner_role.rolname AS owner_name,
            owner_role.rolsuper AS owner_superuser,
            owner_role.rolbypassrls AS owner_bypassrls,
            owner_role.rolcreaterole AS owner_createrole,
            proc.prosecdef AS security_definer,
            proc.proconfig AS function_config,
            proc.proacl::text AS function_acl,
            has_function_privilege('public', proc.oid, 'EXECUTE') AS public_execute,
            EXISTS (
              SELECT 1
              FROM aclexplode(COALESCE(proc.proacl, acldefault('f', proc.proowner))) function_grant
              WHERE function_grant.privilege_type = 'EXECUTE'
                AND function_grant.grantee <> proc.proowner
            ) AS non_owner_execute,
            EXISTS (
              SELECT 1 FROM pg_roles granted_role
              WHERE granted_role.oid <> owner_role.oid
                AND (granted_role.rolsuper OR granted_role.rolbypassrls OR granted_role.rolcreaterole)
                AND pg_has_role(owner_role.oid, granted_role.oid, 'MEMBER')
            ) AS owner_privileged_membership,
            EXISTS (
              SELECT 1
              FROM pg_class other_relation
              JOIN pg_namespace other_ns ON other_ns.oid = other_relation.relnamespace
              WHERE other_relation.relkind IN ('r', 'p', 'v', 'm', 'f')
                AND other_ns.nspname <> ns.nspname
                AND other_ns.nspname NOT IN ('pg_catalog', 'information_schema')
                AND other_ns.nspname !~ '^pg_toast'
                AND has_table_privilege(
                  owner_role.oid,
                  other_relation.oid,
                  'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
                )
            ) AS owner_cross_schema_write,
            pg_get_functiondef(proc.oid) AS function_definition,
            encode(sha256(convert_to(concat_ws(E'\\x1f',
              ns.nspname,
              proc.proname,
              proc.oid::regprocedure::text,
              owner_role.rolname,
              owner_role.rolsuper::text,
              owner_role.rolbypassrls::text,
              owner_role.rolcreaterole::text,
              proc.prosecdef::text,
              COALESCE(array_to_string(proc.proconfig, E'\\x1e'), ''),
              COALESCE(proc.proacl::text, ''),
              EXISTS (
                SELECT 1
                FROM aclexplode(COALESCE(proc.proacl, acldefault('f', proc.proowner))) function_grant
                WHERE function_grant.privilege_type = 'EXECUTE'
                  AND function_grant.grantee <> proc.proowner
              )::text,
              EXISTS (
                SELECT 1 FROM pg_roles granted_role
                WHERE granted_role.oid <> owner_role.oid
                  AND (granted_role.rolsuper OR granted_role.rolbypassrls OR granted_role.rolcreaterole)
                  AND pg_has_role(owner_role.oid, granted_role.oid, 'MEMBER')
              )::text,
              EXISTS (
                SELECT 1
                FROM pg_class other_relation
                JOIN pg_namespace other_ns ON other_ns.oid = other_relation.relnamespace
                WHERE other_relation.relkind IN ('r', 'p', 'v', 'm', 'f')
                  AND other_ns.nspname <> ns.nspname
                  AND other_ns.nspname NOT IN ('pg_catalog', 'information_schema')
                  AND other_ns.nspname !~ '^pg_toast'
                  AND has_table_privilege(
                    owner_role.oid,
                    other_relation.oid,
                    'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
                  )
              )::text,
              pg_get_functiondef(proc.oid)
            ), 'UTF8')), 'hex') AS contract_hash
     FROM pg_proc proc
     JOIN pg_namespace ns ON ns.oid = proc.pronamespace
     JOIN pg_roles owner_role ON owner_role.oid = proc.proowner
     WHERE proc.oid = to_regprocedure(format(
       '%I.%I(text,uuid)',
       ${schemaParameter}::text,
       ${functionParameter}::text
     ))
       AND proc.prorettype = 'jsonb'::regtype`;
}

export async function inspectAccountDeletionCleanupContract(
  client: PoolClient,
  projectId: string,
): Promise<CleanupContract> {
  const projectResult = await client.query<{
    schema_name: string | null;
    db_user: string | null;
    cleanup_function: string | null;
  }>(
    `SELECT p.schema_name, p.db_user, c.cleanup_function
     FROM druvia_projects p
     LEFT JOIN druvia_project_account_deletion_configs c ON c.project_id = p.project_id
     WHERE p.project_id = $1`,
    [projectId],
  );
  const project = projectResult.rows[0];
  const schemaName = project?.schema_name;
  const dbUser = project?.db_user;
  const functionName = project?.cleanup_function || CLEANUP_FUNCTION;
  if (
    !schemaName
    || !dbUser
    || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(schemaName)
    || !/^[a-z_][a-z0-9_]{0,62}$/.test(functionName)
  ) {
    throw new ProjectAuthError(
      'ACCOUNT_DELETION_NOT_CONFIGURED',
      'Project account deletion cleanup is not ready',
      409,
    );
  }

  const contractResult = await client.query<{
    owner_name: string;
    owner_superuser: boolean;
    owner_bypassrls: boolean;
    owner_createrole: boolean;
    security_definer: boolean;
    function_config: string[] | null;
    function_acl: string | null;
    public_execute: boolean;
    non_owner_execute: boolean;
    owner_privileged_membership: boolean;
    owner_cross_schema_write: boolean;
    function_definition: string;
    contract_hash: string;
  }>(
    cleanupContractSelect('$1', '$2'),
    [schemaName, functionName],
  );
  const contract = contractResult.rows[0];
  const searchPath = contract?.function_config?.find((entry) => entry.startsWith('search_path='));
  const normalizedSearchPath = searchPath?.replace(/\s/g, '').toLowerCase();
  const expectedSearchPath = `search_path=pg_catalog,${schemaName}`.toLowerCase();
  if (
    !contract
    || contract.owner_name !== dbUser
    || contract.owner_superuser
    || contract.owner_bypassrls
    || contract.owner_createrole
    || contract.owner_privileged_membership
    || contract.owner_cross_schema_write
    || !contract.security_definer
    || contract.public_execute
    || contract.non_owner_execute
    || normalizedSearchPath !== expectedSearchPath
  ) {
    throw new ProjectAuthError(
      'ACCOUNT_DELETION_NOT_CONFIGURED',
      'Project account deletion cleanup contract is invalid',
      409,
    );
  }

  return { schemaName, functionName, contractHash: contract.contract_hash };
}

export async function executeAccountDeletionCleanupContract(
  client: PoolClient,
  input: {
    schemaName: string;
    functionName: string;
    contractHash: string;
    projectUserId: string;
    deletionId: string;
  },
): Promise<void> {
  if (
    !/^[A-Za-z_][A-Za-z0-9_]*$/.test(input.schemaName)
    || !/^[a-z_][a-z0-9_]{0,62}$/.test(input.functionName)
    || !/^[a-f0-9]{64}$/.test(input.contractHash)
  ) {
    throw new Error('ACCOUNT_DELETION_CLEANUP_CONTRACT_CHANGED');
  }
  const result = await client.query<{ result: { completed?: unknown } }>(
    `WITH contract AS MATERIALIZED (
       ${cleanupContractSelect('$3', '$4')}
     ), validated AS MATERIALIZED (
       SELECT 1 FROM contract WHERE contract_hash = $5
     )
     SELECT ${quoteIdentifier(input.schemaName)}.${quoteIdentifier(input.functionName)}($1::text, $2::uuid) AS result
     FROM validated`,
    [input.projectUserId, input.deletionId, input.schemaName, input.functionName, input.contractHash],
  );
  if (!result.rows[0]) throw new Error('ACCOUNT_DELETION_CLEANUP_CONTRACT_CHANGED');
  if (result.rows[0].result?.completed !== true) throw new Error('INVALID_CLEANUP_RESULT');
}

export async function getAccountDeletionConfig(projectId: string) {
  const row = await queryOne<{ enabled: boolean; updated_at: Date }>(
    `SELECT enabled, updated_at
     FROM druvia_project_account_deletion_configs
     WHERE project_id = $1`,
    [projectId],
  );
  let cleanupReady = false;
  const client = await pool.connect();
  try {
    await inspectAccountDeletionCleanupContract(client, projectId);
    cleanupReady = true;
  } catch (error) {
    if (!(error instanceof ProjectAuthError) || error.code !== 'ACCOUNT_DELETION_NOT_CONFIGURED') throw error;
  } finally {
    client.release();
  }
  return {
    enabled: row?.enabled ?? false,
    cleanupReady,
    updatedAt: row?.updated_at?.toISOString() ?? null,
  };
}

export async function updateAccountDeletionConfig(projectId: string, enabled: boolean) {
  assertDeletionSecrets();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await acquireProjectAuthProjectLock(client, projectId);
    if (enabled) {
      await getAppleAdapter(projectId);
      await inspectAccountDeletionCleanupContract(client, projectId);
    } else {
      const active = await client.query(
        `SELECT 1 FROM druvia_project_account_deletions
         WHERE project_id = $1 AND status NOT IN ('expired', 'completed') LIMIT 1`,
        [projectId],
      );
      if (active.rows[0]) {
        throw new ProjectAuthError(
          'ACCOUNT_DELETION_IN_PROGRESS',
          'Account deletion cannot be disabled while an operation is active',
          409,
        );
      }
    }
    await client.query(
      `INSERT INTO druvia_project_account_deletion_configs
         (project_id, enabled, cleanup_function, updated_at)
       VALUES ($1, $2, $3, NOW())
       ON CONFLICT (project_id) DO UPDATE
       SET enabled = EXCLUDED.enabled, updated_at = NOW()`,
      [projectId, enabled, CLEANUP_FUNCTION],
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
  return getAccountDeletionConfig(projectId);
}

export async function createAccountDeletionFromAppleNotification(
  client: PoolClient,
  input: {
    projectId: string;
    eventId: string;
    identity: {
      id: number;
      projectUserId: string;
      issuer: string;
      subject: string;
      generation: number;
    };
  },
): Promise<boolean> {
  assertDeletionSecrets();
  const configured = await client.query<{ enabled: boolean }>(
    `SELECT enabled FROM druvia_project_account_deletion_configs
     WHERE project_id = $1`,
    [input.projectId],
  );
  if (!configured.rows[0]?.enabled) return false;

  const contract = await inspectAccountDeletionCleanupContract(client, input.projectId);
  const existing = await findActiveAccountDeletionForUser(
    client,
    input.projectId,
    input.identity.projectUserId,
  );
  if (existing && existing.status !== 'pending_confirmation') return true;

  const deletionId = existing?.deletionId ?? crypto.randomUUID();
  const fingerprint = fingerprintAccountDeletionSubject({
    secret: config.accountDeletion.fenceSecret,
    projectId: input.projectId,
    provider: 'apple',
    issuer: input.identity.issuer,
    subject: input.identity.subject,
  });
  const token = await client.query<{ audience: string; refresh_token_encrypted: string }>(
    `SELECT audience, refresh_token_encrypted
     FROM druvia_project_auth_provider_tokens
     WHERE identity_id = $1
     ORDER BY updated_at DESC LIMIT 1`,
    [input.identity.id],
  );
  if (existing) {
    await client.query(
      `UPDATE druvia_project_account_deletions
       SET status = 'accepted', phase = 'business_cleanup', accepted_at = NOW(),
           data_deletion_deadline_at = NOW() + INTERVAL '24 hours', next_attempt_at = NOW(),
           provider_revocation_status = $2
       WHERE deletion_id = $1 AND status = 'pending_confirmation'`,
      [deletionId, token.rows[0] ? 'pending' : 'not_required'],
    );
  } else {
    await client.query(
      `INSERT INTO druvia_project_account_deletions (
       deletion_id, project_id, project_schema, project_user_id, provider, issuer,
       identity_id, source, source_reference, generation, idempotency_key,
       cleanup_function, cleanup_contract_hash, status, phase, accepted_at,
       data_deletion_deadline_at, next_attempt_at, provider_revocation_status
     ) VALUES ($1, $2, $3, $4, 'apple', $5, $6, 'apple_notification', $7, $8,
       $9, $10, $11, 'accepted', 'business_cleanup', NOW(), NOW() + INTERVAL '24 hours',
         NOW(), $12)`,
      [
        deletionId,
        input.projectId,
        contract.schemaName,
        input.identity.projectUserId,
        input.identity.issuer,
        input.identity.id,
        `apple:${input.identity.issuer}:${input.eventId}`,
        input.identity.generation,
        crypto.randomUUID(),
        contract.functionName,
        contract.contractHash,
        token.rows[0] ? 'pending' : 'not_required',
      ],
    );
  }
  await client.query(
    `INSERT INTO druvia_project_account_deletion_fences
       (deletion_id, project_id, deleted_project_user_id, provider, issuer,
        subject_fingerprint, generation, accepted_at)
     VALUES ($1, $2, $3, 'apple', $4, $5, $6, NOW())`,
    [
      deletionId,
      input.projectId,
      input.identity.projectUserId,
      input.identity.issuer,
      fingerprint,
      input.identity.generation,
    ],
  );
  if (token.rows[0]) {
    await client.query(
      `INSERT INTO druvia_project_account_deletion_provider_tokens
         (deletion_id, purpose, audience, refresh_token_encrypted)
       VALUES ($1, 'accepted_deletion', $2, $3)`,
      [deletionId, token.rows[0].audience, token.rows[0].refresh_token_encrypted],
    );
  }
  await markProjectAuthIdentityDeletionPending(client, input.identity.id);
  await deleteProjectAuthProviderTokens(client, input.identity.id);
  return true;
}

export async function createAccountDeletionIntent(input: {
  projectId: string;
  projectUserId: string;
  idempotencyKey: string;
}) {
  assertDeletionSecrets();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await acquireProjectAuthProjectLock(client, input.projectId);
    const configured = await client.query<{ enabled: boolean }>(
      `SELECT enabled FROM druvia_project_account_deletion_configs
       WHERE project_id = $1 FOR UPDATE`,
      [input.projectId],
    );
    if (!configured.rows[0]?.enabled) {
      throw new ProjectAuthError(
        'ACCOUNT_DELETION_NOT_CONFIGURED',
        'Project account deletion is not enabled',
        409,
      );
    }
    await getAppleAdapter(input.projectId);
    const identity = await findProjectAuthIdentityByProjectUser(
      client,
      input.projectId,
      input.projectUserId,
    );
    if (!identity || identity.status !== 'active') {
      throw new ProjectAuthError(
        'ACCOUNT_DELETION_REAUTH_REQUIRED',
        'An active Apple identity is required',
        401,
      );
    }
    await acquireProjectAuthIdentityIdLock(client, identity.id);
    await client.query(
      `UPDATE druvia_project_account_deletions
       SET status = 'expired', phase = 'awaiting_confirmation'
       WHERE project_id = $1 AND project_user_id = $2
         AND status = 'pending_confirmation' AND intent_expires_at <= NOW()`,
      [input.projectId, input.projectUserId],
    );
    const sameRequest = await client.query<{ deletion_id: string }>(
      `SELECT deletion_id FROM druvia_project_account_deletions
       WHERE project_id = $1 AND project_user_id = $2 AND idempotency_key = $3
       FOR UPDATE`,
      [input.projectId, input.projectUserId, input.idempotencyKey],
    );
    if (sameRequest.rows[0]) {
      const existing = await findAccountDeletion(
        client,
        input.projectId,
        sameRequest.rows[0].deletion_id,
      );
      if (!existing) throw new Error('Account deletion idempotency record disappeared');
      await client.query('COMMIT');
      return {
        deletionId: existing.deletionId,
        ...credentialFor(existing),
        status: existing.status,
        intentExpiresAt: existing.intentExpiresAt?.toISOString() ?? null,
      };
    }
    const active = await findActiveAccountDeletionForUser(client, input.projectId, input.projectUserId);
    if (active) {
      await client.query('COMMIT');
      const credential = credentialFor(active);
      return {
        deletionId: active.deletionId,
        ...credential,
        status: active.status,
        intentExpiresAt: active.intentExpiresAt?.toISOString() ?? null,
      };
    }
    const contract = await inspectAccountDeletionCleanupContract(client, input.projectId);
    const deletionId = crypto.randomUUID();
    const credential = credentialFor({
      projectId: input.projectId,
      deletionId,
    } as ProjectAccountDeletionOperation);
    const operation = await insertAccountDeletionIntent(client, {
      deletionId,
      projectId: input.projectId,
      projectSchema: contract.schemaName,
      projectUserId: input.projectUserId,
      identityId: identity.id,
      issuer: identity.issuer,
      generation: identity.generation,
      idempotencyKey: input.idempotencyKey,
      reauthNonceHash: sha256(credential.reauthNonce),
      intentExpiresAt: new Date(Date.now() + config.accountDeletion.intentTtlSeconds * 1000),
      cleanupFunction: contract.functionName,
      cleanupContractHash: contract.contractHash,
    });
    await client.query('COMMIT');
    return {
      deletionId: operation.deletionId,
      ...credential,
      status: operation.status,
      intentExpiresAt: operation.intentExpiresAt?.toISOString() ?? null,
    };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function readAuthorizedOperation(input: {
  projectId: string;
  deletionId: string;
  statusToken: string;
}): Promise<ProjectAccountDeletionOperation> {
  assertDeletionSecrets();
  if (!verifyAccountDeletionStatusToken({
    secret: config.accountDeletion.statusSecret,
    ...input,
    token: input.statusToken,
  })) {
    throw new ProjectAuthError(
      'ACCOUNT_DELETION_STATUS_TOKEN_INVALID',
      'Invalid account deletion status credential',
      401,
    );
  }
  const client = await pool.connect();
  try {
    let operation = await findAccountDeletion(client, input.projectId, input.deletionId);
    if (!operation) {
      throw new ProjectAuthError(
        'ACCOUNT_DELETION_STATUS_TOKEN_INVALID',
        'Invalid account deletion status credential',
        401,
      );
    }
    if (
      operation.status === 'pending_confirmation'
      && operation.intentExpiresAt
      && operation.intentExpiresAt <= new Date()
    ) {
      const expired = await client.query(
        `UPDATE druvia_project_account_deletions
         SET status = 'expired', phase = 'awaiting_confirmation'
         WHERE project_id = $1 AND deletion_id = $2 AND status = 'pending_confirmation'`,
        [input.projectId, input.deletionId],
      );
      if (expired.rowCount === 1) {
        operation = { ...operation, status: 'expired', phase: 'awaiting_confirmation' };
      }
    }
    return operation;
  } finally {
    client.release();
  }
}

export async function getAccountDeletionStatus(input: {
  projectId: string;
  deletionId: string;
  statusToken: string;
}): Promise<ProjectAccountDeletionStatusDto> {
  return toProjectAccountDeletionStatusDto(await readAuthorizedOperation(input));
}

function assertFreshIdentityToken(identityToken: string): void {
  const payload = jwt.decode(identityToken) as { iat?: unknown } | null;
  const now = Math.floor(Date.now() / 1000);
  if (
    typeof payload?.iat !== 'number'
    || payload.iat > now + 60
    || now - payload.iat > config.accountDeletion.reauthMaxAgeSeconds + 60
  ) {
    throw new ProjectAuthError(
      'ACCOUNT_DELETION_REAUTH_REQUIRED',
      'A recent Apple authentication is required',
      401,
    );
  }
}

async function persistReauthCompensation(input: {
  deletionId: string;
  audience: string;
  refreshToken: string;
}): Promise<void> {
  try {
    await pool.query(
      `INSERT INTO druvia_project_account_deletion_provider_tokens
         (deletion_id, purpose, audience, refresh_token_encrypted)
       VALUES ($1, 'reauth_compensation', $2, $3)`,
      [input.deletionId, input.audience, encryptSecret(input.refreshToken, { requireDedicatedKey: true })],
    );
  } catch (error) {
    logger.error('failed to persist Apple reauth compensation', {
      deletionId: input.deletionId,
      errorCode: 'ACCOUNT_DELETION_COMPENSATION_PERSIST_FAILED',
    }, error);
  }
}

export async function confirmAccountDeletion(input: {
  projectId: string;
  deletionId: string;
  statusToken: string;
  projectUserId?: string;
  credential?: AppleNativeCredential;
}): Promise<ProjectAccountDeletionStatusDto> {
  const initial = await readAuthorizedOperation(input);
  if (initial.status !== 'pending_confirmation') {
    return toProjectAccountDeletionStatusDto(initial);
  }
  if (!input.credential) {
    throw new ProjectAuthError('INVALID_INPUT', 'Apple reauthentication credential is required', 400);
  }
  if (!input.projectUserId || input.projectUserId !== initial.projectUserId) {
    throw new ProjectAuthError('FORBIDDEN', 'Project user authentication does not match this deletion', 403);
  }
  try {
    await assertProjectSessionUsable({
      projectId: input.projectId,
      projectUserId: input.projectUserId,
    });
  } catch (error) {
    if (error instanceof ProjectRuntimeBlockedError) {
      throw new ProjectAuthError(error.code, 'Project session is unavailable', error.statusCode);
    }
    throw error;
  }
  const expectedNonce = credentialFor(initial).reauthNonce;
  if (
    sha256(input.credential.rawNonce) !== initial.reauthNonceHash
    || input.credential.rawNonce !== expectedNonce
  ) {
    throw new ProjectAuthError('ACCOUNT_DELETION_REAUTH_REQUIRED', 'Invalid account deletion nonce', 401);
  }
  assertFreshIdentityToken(input.credential.identityToken);

  const leaseToken = crypto.randomUUID();
  const claimClient = await pool.connect();
  let claimed: ProjectAccountDeletionOperation | null;
  try {
    claimed = await claimAccountDeletionConfirmation(claimClient, {
      projectId: input.projectId,
      deletionId: input.deletionId,
      leaseToken,
      leaseSeconds: 60,
    });
  } finally {
    claimClient.release();
  }
  if (!claimed) {
    const latest = await readAuthorizedOperation(input);
    if (latest.status !== 'pending_confirmation') return toProjectAccountDeletionStatusDto(latest);
    throw new ProjectAuthError('ACCOUNT_DELETION_STALE', 'Account deletion confirmation is unavailable', 409);
  }

  const adapter = await getAppleAdapter(input.projectId);
  let authentication;
  try {
    authentication = await adapter.authenticateNative(input.credential);
  } catch (error) {
    if (error instanceof AppleAdapterError && error.retryable) {
      throw new ProjectAuthError('PROVIDER_UNAVAILABLE', 'Apple authentication is unavailable', 503);
    }
    throw new ProjectAuthError('ACCOUNT_DELETION_REAUTH_REQUIRED', 'Invalid Apple credential', 401);
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await acquireProjectAuthProjectLock(client, input.projectId);
    const operation = await findAccountDeletion(client, input.projectId, input.deletionId, { forUpdate: true });
    if (
      !operation
      || operation.status !== 'pending_confirmation'
      || operation.confirmationLeaseToken !== leaseToken
      || !operation.confirmationLeaseUntil
      || operation.confirmationLeaseUntil <= new Date()
      || operation.projectUserId !== input.projectUserId
      || operation.identityId === null
    ) {
      throw new ProjectAuthError('ACCOUNT_DELETION_STALE', 'Account deletion intent is stale', 409);
    }
    await acquireProjectAuthIdentityIdLock(client, operation.identityId);
    const identity = await findProjectAuthIdentityById(client, operation.identityId);
    if (
      !identity
      || identity.projectId !== input.projectId
      || identity.projectUserId !== input.projectUserId
      || identity.status !== 'active'
      || identity.provider !== 'apple'
      || identity.issuer !== operation.issuer
      || identity.subject !== authentication.user.providerId
      || identity.generation !== operation.generation
    ) {
      throw new ProjectAuthError('ACCOUNT_DELETION_IDENTITY_MISMATCH', 'Apple identity does not match', 403);
    }
    const fingerprint = fingerprintAccountDeletionSubject({
      secret: config.accountDeletion.fenceSecret,
      projectId: input.projectId,
      provider: 'apple',
      issuer: identity.issuer,
      subject: identity.subject,
    });
    await client.query(
      `INSERT INTO druvia_project_account_deletion_fences
         (deletion_id, project_id, deleted_project_user_id, provider, issuer,
          subject_fingerprint, generation, accepted_at)
       VALUES ($1, $2, $3, 'apple', $4, $5, $6, NOW())`,
      [operation.deletionId, operation.projectId, operation.projectUserId, identity.issuer, fingerprint, identity.generation],
    );
    await client.query(
      `INSERT INTO druvia_project_account_deletion_provider_tokens
         (deletion_id, purpose, audience, refresh_token_encrypted)
       VALUES ($1, 'accepted_deletion', $2, $3)`,
      [
        operation.deletionId,
        authentication.providerSession.audience,
        encryptSecret(authentication.providerSession.refreshToken, { requireDedicatedKey: true }),
      ],
    );
    await markProjectAuthIdentityDeletionPending(client, identity.id);
    await client.query(
      `UPDATE druvia_project_account_deletions
       SET status = 'accepted', phase = 'business_cleanup', accepted_at = NOW(),
           data_deletion_deadline_at = NOW() + INTERVAL '24 hours', next_attempt_at = NOW(),
           provider_revocation_status = 'pending'
       WHERE deletion_id = $1 AND confirmation_lease_token = $2`,
      [operation.deletionId, leaseToken],
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    try {
      await adapter.revoke({
        audience: authentication.providerSession.audience,
        refreshToken: authentication.providerSession.refreshToken,
      });
    } catch {
      await persistReauthCompensation({
        deletionId: input.deletionId,
        audience: authentication.providerSession.audience,
        refreshToken: authentication.providerSession.refreshToken,
      });
    }
    throw error;
  } finally {
    client.release();
  }
  return getAccountDeletionStatus(input);
}
