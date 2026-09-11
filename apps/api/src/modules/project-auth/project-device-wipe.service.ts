import { createHash, randomUUID } from 'node:crypto';
import type { JsonWebKey as NodeJsonWebKey } from 'node:crypto';
import type { PoolClient } from 'pg';
import { config } from '../../config/index.js';
import { pool } from '../../db/index.js';
import { decryptSecret, encryptSecret } from '../../lib/secret-encryption.js';
import { createApiLogger } from '../../lib/logger.js';
import { acquireProjectAuthProjectLock } from './project-identity.repository.js';
import {
  assertProjectRuntimeAvailable,
  ProjectRuntimeBlockedError,
} from './project-session-state.js';
import {
  acknowledgeDeviceWipeMandateHook,
  inspectDeviceWipeHookContracts,
  listDeviceWipeMandatesHook,
  registerDeviceWipeBindingHook,
} from './project-device-wipe.hooks.js';
import {
  assertDeviceWipeSecretsConfigured,
  buildDeviceWipeCommand,
  canonicalDeviceWipeJson,
  deriveBindingHandle,
  deriveBindingIdentityHmac,
  deriveBindingLookupToken,
  deriveDeviceWipeSecretVerification,
  deriveProjectUserFingerprint,
  generateDeviceWipeSigningKey,
  hashBindingLookupToken,
  signDeviceWipeCommand,
  verifyBindingLookupToken,
  type DeviceWipeCommand,
} from './project-device-wipe.crypto.js';
import {
  deviceWipeErrorChainHasCode,
  ProjectDeviceWipeError,
  type DeviceWipeHookContracts,
  type DeviceWipeHookNames,
  type DeviceWipeMandateSource,
} from './project-device-wipe.types.js';

const DEFAULT_HOOKS: DeviceWipeHookNames = {
  registerFunction: 'druvia_register_device_wipe_binding',
  queryFunction: 'druvia_list_device_wipe_mandates',
  acknowledgeFunction: 'druvia_ack_device_wipe_mandate',
};
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const logger = createApiLogger({ module: 'project-device-wipe' });

interface DeviceWipeConfigRow {
  enabled: boolean;
  register_function: string;
  query_function: string;
  acknowledge_function: string;
  binding_secret_verification: string | null;
  credential_secret_verification: string | null;
  updated_at?: Date;
}

interface DeviceWipeBindingRow {
  binding_id: string;
  project_id: string;
  project_user_fingerprint: string;
  project_user_id_encrypted: string;
  binding_identity_hmac: string;
  binding_revision: string | number;
  binding_handle: string;
  lookup_token_hash: string;
  idempotency_key: string;
  status: 'active' | 'retired';
  project_schema: string;
  register_function: string;
  register_contract_hash: string;
  query_function: string;
  query_contract_hash: string;
  acknowledge_function: string;
  acknowledge_contract_hash: string;
}

interface DeviceWipeSigningKeyRow {
  key_id: string;
  public_jwk: NodeJsonWebKey;
  private_jwk_encrypted: string;
  status?: 'active' | 'verification_only' | 'retired';
  created_at?: Date;
}

interface DeviceWipeMandateRow {
  deletion_id: string;
  scope: 'account' | 'session';
  session_id: string | null;
  key_id: string;
  command_json: DeviceWipeCommand;
  signature: string;
  status: 'pending' | 'acknowledged';
  receipt_json: Record<string, unknown> | null;
  receipt_digest: string | null;
  acknowledged_at: Date | null;
}

export interface DeviceWipeReceipt {
  version: 1;
  deletionID: { rawValue: string };
  scope: { kind: 'account' } | { kind: 'session'; sessionID: { rawValue: string } };
  bindingIdentityHMAC: string;
  completedAt: string;
  result: 'erased';
}

function deviceWipeUnavailable(message = 'Project device wipe is unavailable') {
  return new ProjectDeviceWipeError('DEVICE_WIPE_UNAVAILABLE', message, 503);
}

function credentialInvalid() {
  return new ProjectDeviceWipeError(
    'DEVICE_WIPE_CREDENTIAL_INVALID',
    'Invalid project device wipe credential',
    401,
  );
}

function readDeviceWipeSecrets() {
  try {
    return assertDeviceWipeSecretsConfigured(config.deviceWipe);
  } catch {
    throw deviceWipeUnavailable('Project device wipe secrets are unavailable');
  }
}

function secretVerification(secrets: { bindingSecret: string; credentialSecret: string }) {
  return {
    binding: deriveDeviceWipeSecretVerification(secrets.bindingSecret, 'binding'),
    credential: deriveDeviceWipeSecretVerification(secrets.credentialSecret, 'credential'),
  };
}

async function assertDeviceWipeRuntimeAvailable(client: PoolClient, projectId: string): Promise<void> {
  try {
    await assertProjectRuntimeAvailable(projectId, client);
  } catch (error) {
    if (error instanceof ProjectRuntimeBlockedError) {
      throw new ProjectDeviceWipeError(
        error.code,
        'Project access is temporarily unavailable',
        error.statusCode,
      );
    }
    throw error;
  }
}

function assertPersistedSecretVerification(
  row: DeviceWipeConfigRow,
  secrets: { bindingSecret: string; credentialSecret: string },
) {
  const expected = secretVerification(secrets);
  if (
    row.binding_secret_verification !== expected.binding
    || row.credential_secret_verification !== expected.credential
  ) {
    throw new ProjectDeviceWipeError(
      'DEVICE_WIPE_SECRET_MISMATCH',
      'Project device wipe secret configuration changed',
      503,
    );
  }
  return expected;
}

async function inTransaction<T>(run: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      "SELECT set_config('statement_timeout', $1, true)",
      [`${config.deviceWipe.hookStatementTimeoutMs}ms`],
    );
    const result = await run(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackError) {
      throw rollbackError;
    }
    if (deviceWipeErrorChainHasCode(error, '57014')) {
      throw new ProjectDeviceWipeError(
        'DEVICE_WIPE_HOOK_TIMEOUT',
        'Project device wipe request timed out',
        503,
      );
    }
    throw error;
  } finally {
    client.release();
  }
}

function configHooks(row: DeviceWipeConfigRow): DeviceWipeHookNames {
  return {
    registerFunction: row.register_function,
    queryFunction: row.query_function,
    acknowledgeFunction: row.acknowledge_function,
  };
}

async function readConfigForUpdate(client: PoolClient, projectId: string) {
  const result = await client.query<DeviceWipeConfigRow>(
    `SELECT enabled, register_function, query_function, acknowledge_function,
            binding_secret_verification, credential_secret_verification, updated_at
     FROM druvia_project_device_wipe_configs
     WHERE project_id = $1
     FOR UPDATE`,
    [projectId],
  );
  return result.rows[0] ?? null;
}

function bindingResponse(binding: DeviceWipeBindingRow, credentialSecret: string) {
  const bindingLookupToken = deriveBindingLookupToken({
    secret: credentialSecret,
    projectId: binding.project_id,
    bindingId: binding.binding_id,
  });
  if (
    binding.binding_handle !== deriveBindingHandle({
      secret: credentialSecret,
      projectId: binding.project_id,
      bindingId: binding.binding_id,
    })
    || !verifyBindingLookupToken(bindingLookupToken, binding.lookup_token_hash)
  ) throw deviceWipeUnavailable('Project device wipe credential configuration changed');
  return {
    bindingHandle: binding.binding_handle,
    bindingLookupToken,
    projectUserFingerprint: binding.project_user_fingerprint,
    bindingIdentityHmac: binding.binding_identity_hmac,
    bindingRevision: Number(binding.binding_revision),
  };
}

export async function registerProjectDeviceWipeBinding(input: {
  projectId: string;
  projectUserId: string;
  idempotencyKey: string;
  bindingIdentity: string;
  bindingRevision: number;
}) {
  const secrets = readDeviceWipeSecrets();
  const projectUserFingerprint = deriveProjectUserFingerprint({
    secret: secrets.bindingSecret,
    projectId: input.projectId,
    projectUserId: input.projectUserId,
  });
  const bindingIdentityHmac = deriveBindingIdentityHmac({
    secret: secrets.bindingSecret,
    projectId: input.projectId,
    bindingIdentity: input.bindingIdentity,
  });

  return inTransaction(async (client) => {
    await acquireProjectAuthProjectLock(client, input.projectId);
    await assertDeviceWipeRuntimeAvailable(client, input.projectId);
    const configRow = await readConfigForUpdate(client, input.projectId);
    if (!configRow?.enabled) {
      throw new ProjectDeviceWipeError('DEVICE_WIPE_NOT_CONFIGURED', 'Project device wipe is not enabled', 409);
    }
    assertPersistedSecretVerification(configRow, secrets);

    const idempotent = await client.query<DeviceWipeBindingRow>(
      `SELECT * FROM druvia_project_device_wipe_bindings
       WHERE project_id = $1 AND project_user_fingerprint = $2 AND idempotency_key = $3
       FOR UPDATE`,
      [input.projectId, projectUserFingerprint, input.idempotencyKey],
    );
    if (idempotent.rows[0]) {
      const binding = idempotent.rows[0];
      if (
        binding.binding_identity_hmac !== bindingIdentityHmac
        || Number(binding.binding_revision) !== input.bindingRevision
      ) {
        throw new ProjectDeviceWipeError(
          'DEVICE_WIPE_IDEMPOTENCY_CONFLICT',
          'Idempotency key was already used for another binding request',
          409,
        );
      }
      return bindingResponse(binding, secrets.credentialSecret);
    }

    const identityRows = await client.query<DeviceWipeBindingRow>(
      `SELECT * FROM druvia_project_device_wipe_bindings
       WHERE project_id = $1 AND binding_identity_hmac = $2
       ORDER BY binding_revision DESC
       FOR UPDATE`,
      [input.projectId, bindingIdentityHmac],
    );
    if (identityRows.rows.some((row) => row.project_user_fingerprint !== projectUserFingerprint)) {
      throw new ProjectDeviceWipeError(
        'DEVICE_WIPE_BINDING_CONFLICT',
        'Device binding is already registered to another project user',
        409,
      );
    }
    if (identityRows.rows.some((row) => Number(row.binding_revision) >= input.bindingRevision)) {
      throw new ProjectDeviceWipeError(
        'DEVICE_WIPE_BINDING_REVISION_STALE',
        'Device binding revision is stale',
        409,
      );
    }

    const contracts = await inspectDeviceWipeHookContracts(client, input.projectId, configHooks(configRow));
    let encryptedProjectUserId: string;
    try {
      encryptedProjectUserId = encryptSecret(input.projectUserId, { requireDedicatedKey: true });
    } catch {
      throw deviceWipeUnavailable('Project device wipe replay material cannot be stored');
    }
    await registerDeviceWipeBindingHook(client, {
      schemaName: contracts.schemaName,
      functionName: contracts.registerFunction,
      contractHash: contracts.registerContractHash,
      projectUserId: input.projectUserId,
      bindingIdentityHmac,
      bindingRevision: input.bindingRevision,
    });

    const bindingId = randomUUID();
    const bindingHandle = deriveBindingHandle({
      secret: secrets.credentialSecret,
      projectId: input.projectId,
      bindingId,
    });
    const bindingLookupToken = deriveBindingLookupToken({
      secret: secrets.credentialSecret,
      projectId: input.projectId,
      bindingId,
    });
    await client.query(
      `UPDATE druvia_project_device_wipe_bindings
       SET status = 'retired', retired_at = NOW()
       WHERE project_id = $1 AND binding_identity_hmac = $2 AND status = 'active'`,
      [input.projectId, bindingIdentityHmac],
    );
    await client.query(
       `INSERT INTO druvia_project_device_wipe_bindings (
         binding_id, project_id, project_user_fingerprint, project_user_id_encrypted,
         binding_identity_hmac, binding_revision, binding_handle, lookup_token_hash, idempotency_key,
         project_schema, register_function, register_contract_hash,
         query_function, query_contract_hash, acknowledge_function, acknowledge_contract_hash
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)`,
      [
        bindingId,
        input.projectId,
        projectUserFingerprint,
        encryptedProjectUserId,
        bindingIdentityHmac,
        input.bindingRevision,
        bindingHandle,
        hashBindingLookupToken(bindingLookupToken),
        input.idempotencyKey,
        contracts.schemaName,
        contracts.registerFunction,
        contracts.registerContractHash,
        contracts.queryFunction,
        contracts.queryContractHash,
        contracts.acknowledgeFunction,
        contracts.acknowledgeContractHash,
      ],
    );
    const response = {
      bindingHandle,
      bindingLookupToken,
      projectUserFingerprint,
      bindingIdentityHmac,
      bindingRevision: input.bindingRevision,
    };
    logger.info('project device wipe binding registered', {
      projectUserId: undefined,
      projectId: input.projectId,
      bindingId,
      projectUserFingerprint,
      bindingRevision: input.bindingRevision,
    });
    return response;
  });
}

async function readAuthorizedBinding(client: PoolClient, input: {
  projectId: string;
  bindingHandle: string;
  bindingLookupToken: string;
}): Promise<DeviceWipeBindingRow> {
  const result = await client.query<DeviceWipeBindingRow>(
    `SELECT * FROM druvia_project_device_wipe_bindings
     WHERE project_id = $1 AND binding_handle = $2
     FOR UPDATE`,
    [input.projectId, input.bindingHandle],
  );
  const binding = result.rows[0];
  if (!binding || !verifyBindingLookupToken(input.bindingLookupToken, binding.lookup_token_hash)) {
    throw credentialInvalid();
  }
  return binding;
}

function mandateMatchesSource(row: DeviceWipeMandateRow, source: DeviceWipeMandateSource): boolean {
  return row.scope === source.scope && row.session_id === source.sessionId;
}

function mandateEnvelope(row: DeviceWipeMandateRow) {
  return {
    version: 1 as const,
    keyID: row.key_id,
    command: row.command_json,
    signature: row.signature,
  };
}

async function readMandates(client: PoolClient, projectId: string, bindingId: string) {
  const result = await client.query<DeviceWipeMandateRow>(
    `SELECT deletion_id, scope, session_id, key_id, command_json, signature,
            status, receipt_json, receipt_digest, acknowledged_at
     FROM druvia_project_device_wipe_mandates
     WHERE project_id = $1 AND binding_id = $2
     ORDER BY created_at, deletion_id
     FOR UPDATE`,
    [projectId, bindingId],
  );
  return result.rows;
}

async function readActiveSigningKey(client: PoolClient, projectId: string) {
  const result = await client.query<DeviceWipeSigningKeyRow>(
    `SELECT key_id, public_jwk, private_jwk_encrypted
     FROM druvia_project_device_wipe_signing_keys
     WHERE project_id = $1 AND status = 'active'
     FOR UPDATE`,
    [projectId],
  );
  if (!result.rows[0]) throw deviceWipeUnavailable('Project device wipe signing key is unavailable');
  return result.rows[0];
}

export async function queryProjectDeviceWipeMandates(input: {
  projectId: string;
  bindingHandle: string;
  bindingLookupToken: string;
}) {
  return inTransaction(async (client) => {
    await acquireProjectAuthProjectLock(client, input.projectId);
    await assertDeviceWipeRuntimeAvailable(client, input.projectId);
    const binding = await readAuthorizedBinding(client, input);
    const existing = await readMandates(client, input.projectId, binding.binding_id);
    const envelopes = existing.filter((row) => row.status === 'pending').map(mandateEnvelope);
    if (envelopes.length > 0) {
      logger.info('project device wipe mandates queried', {
        projectId: input.projectId,
        bindingId: binding.binding_id,
        mandateCount: envelopes.length,
      });
      return { mandates: envelopes };
    }
    if (binding.status === 'retired') return { mandates: [] };
    const sourceMandates = await listDeviceWipeMandatesHook(client, {
      schemaName: binding.project_schema,
      functionName: binding.query_function,
      contractHash: binding.query_contract_hash,
      bindingIdentityHmac: binding.binding_identity_hmac,
      bindingRevision: Number(binding.binding_revision),
    });
    const byDeletionId = new Map(existing.map((row) => [row.deletion_id, row]));
    let activeKey: DeviceWipeSigningKeyRow | null = null;

    for (const source of [...sourceMandates].sort((left, right) => left.deletionId.localeCompare(right.deletionId))) {
      const materialized = byDeletionId.get(source.deletionId);
      if (materialized) {
        if (!mandateMatchesSource(materialized, source)) {
          throw new ProjectDeviceWipeError(
            'DEVICE_WIPE_MANDATE_CONFLICT',
            'Project device wipe mandate identity changed',
            409,
          );
        }
        continue;
      }
      activeKey ??= await readActiveSigningKey(client, input.projectId);
      let privateJwk: NodeJsonWebKey;
      try {
        privateJwk = JSON.parse(decryptSecret(activeKey.private_jwk_encrypted, { requireDedicatedKey: true }));
      } catch {
        throw deviceWipeUnavailable('Project device wipe signing key cannot be loaded');
      }
      const command = buildDeviceWipeCommand({
        deletionId: source.deletionId,
        projectId: input.projectId,
        projectUserFingerprint: binding.project_user_fingerprint,
        bindingIdentityHmac: binding.binding_identity_hmac,
        bindingRevision: Number(binding.binding_revision),
        scope: source.scope,
        sessionId: source.sessionId,
      });
      const signature = signDeviceWipeCommand({ keyId: activeKey.key_id, command, privateJwk });
      await client.query(
        `INSERT INTO druvia_project_device_wipe_mandates (
           project_id, binding_id, deletion_id, scope, session_id,
           key_id, command_json, signature
         ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8)`,
        [
          input.projectId,
          binding.binding_id,
          source.deletionId,
          source.scope,
          source.sessionId,
          activeKey.key_id,
          JSON.stringify(command),
          signature,
        ],
      );
      envelopes.push({ version: 1, keyID: activeKey.key_id, command, signature });
    }
    logger.info('project device wipe mandates queried', {
      projectId: input.projectId,
      bindingId: binding.binding_id,
      mandateCount: envelopes.length,
    });
    return { mandates: envelopes };
  });
}

export function normalizeDeviceWipeReceipt(
  value: unknown,
  expected: { deletionId: string; bindingIdentityHmac: string; scope: 'account' | 'session'; sessionId: string | null },
): DeviceWipeReceipt {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ProjectDeviceWipeError('DEVICE_WIPE_RECEIPT_INVALID', 'Invalid device wipe receipt', 400);
  }
  const receipt = value as Record<string, unknown>;
  const deletion = receipt.deletionID as Record<string, unknown> | undefined;
  const scope = receipt.scope as Record<string, unknown> | undefined;
  const session = scope?.sessionID as Record<string, unknown> | undefined;
  const completedAt = receipt.completedAt;
  const completedDate = typeof completedAt === 'string' ? new Date(completedAt) : null;
  const expectedScope = expected.scope === 'account'
    ? scope?.kind === 'account' && Object.keys(scope).length === 1
    : scope?.kind === 'session'
      && Object.keys(scope).length === 2
      && session?.rawValue === expected.sessionId
      && Object.keys(session).length === 1;
  if (
    receipt.version !== 1
    || deletion?.rawValue !== expected.deletionId
    || Object.keys(deletion).length !== 1
    || receipt.bindingIdentityHMAC !== expected.bindingIdentityHmac
    || !expectedScope
    || receipt.result !== 'erased'
    || !completedDate
    || Number.isNaN(completedDate.getTime())
    || completedDate.toISOString() !== completedAt
    || completedDate.getTime() > Date.now() + 5 * 60_000
    || Object.keys(receipt).some((key) => ![
      'version', 'deletionID', 'scope', 'bindingIdentityHMAC', 'completedAt', 'result',
    ].includes(key))
  ) {
    throw new ProjectDeviceWipeError('DEVICE_WIPE_RECEIPT_INVALID', 'Invalid device wipe receipt', 400);
  }
  return receipt as unknown as DeviceWipeReceipt;
}

export async function acknowledgeProjectDeviceWipeMandate(input: {
  projectId: string;
  bindingHandle: string;
  bindingLookupToken: string;
  deletionId: string;
  receipt: unknown;
}) {
  return inTransaction(async (client) => {
    await acquireProjectAuthProjectLock(client, input.projectId);
    await assertDeviceWipeRuntimeAvailable(client, input.projectId);
    const binding = await readAuthorizedBinding(client, input);
    const result = await client.query<DeviceWipeMandateRow>(
      `SELECT deletion_id, scope, session_id, key_id, command_json, signature,
              status, receipt_json, receipt_digest, acknowledged_at
       FROM druvia_project_device_wipe_mandates
       WHERE project_id = $1 AND binding_id = $2 AND deletion_id = $3
       FOR UPDATE`,
      [input.projectId, binding.binding_id, input.deletionId],
    );
    const mandate = result.rows[0];
    if (!mandate) {
      throw new ProjectDeviceWipeError('DEVICE_WIPE_MANDATE_NOT_FOUND', 'Device wipe mandate was not found', 404);
    }
    const receipt = normalizeDeviceWipeReceipt(input.receipt, {
      deletionId: mandate.deletion_id,
      bindingIdentityHmac: binding.binding_identity_hmac,
      scope: mandate.scope,
      sessionId: mandate.session_id,
    });
    const receiptJson = canonicalDeviceWipeJson(receipt).toString('utf8');
    const receiptDigest = createHash('sha256').update(receiptJson).digest('hex');
    if (mandate.status === 'acknowledged') {
      if (mandate.receipt_digest !== receiptDigest) {
        throw new ProjectDeviceWipeError(
          'DEVICE_WIPE_RECEIPT_CONFLICT',
          'A different device wipe receipt was already accepted',
          409,
        );
      }
      return {
        acknowledged: true,
        replay: true,
        acknowledgedAt: mandate.acknowledged_at?.toISOString() ?? null,
      };
    }

    await acknowledgeDeviceWipeMandateHook(client, {
      schemaName: binding.project_schema,
      functionName: binding.acknowledge_function,
      contractHash: binding.acknowledge_contract_hash,
      bindingIdentityHmac: binding.binding_identity_hmac,
      bindingRevision: Number(binding.binding_revision),
      deletionId: input.deletionId,
      receipt: JSON.parse(receiptJson),
    });
    const update = await client.query<{ acknowledged_at: Date }>(
      `UPDATE druvia_project_device_wipe_mandates
       SET status = 'acknowledged', receipt_json = $4::jsonb,
           receipt_digest = $5, acknowledged_at = NOW()
       WHERE project_id = $1 AND binding_id = $2 AND deletion_id = $3
         AND status = 'pending'
       RETURNING acknowledged_at`,
      [input.projectId, binding.binding_id, input.deletionId, receiptJson, receiptDigest],
    );
    if (!update.rows[0]) throw deviceWipeUnavailable('Device wipe receipt could not be persisted');
    logger.info('project device wipe mandate acknowledged', {
      projectId: input.projectId,
      bindingId: binding.binding_id,
      deletionId: input.deletionId,
    });
    return { acknowledged: true, replay: false, acknowledgedAt: update.rows[0].acknowledged_at.toISOString() };
  });
}

async function insertSigningKey(client: PoolClient, projectId: string) {
  const generated = generateDeviceWipeSigningKey();
  let encrypted: string;
  try {
    encrypted = encryptSecret(JSON.stringify(generated.privateJwk), { requireDedicatedKey: true });
  } catch {
    logger.error('project device wipe signing key encryption failed', { projectId });
    throw deviceWipeUnavailable('Project device wipe signing key cannot be stored');
  }
  await client.query(
    `INSERT INTO druvia_project_device_wipe_signing_keys (
       project_id, key_id, public_jwk, private_jwk_encrypted, status
     ) VALUES ($1, $2, $3::jsonb, $4, 'active')`,
    [projectId, generated.keyId, JSON.stringify(generated.publicJwk), encrypted],
  );
  return { keyId: generated.keyId, algorithm: 'Ed25519' as const, publicJwk: generated.publicJwk, status: 'active' as const };
}

export async function getProjectDeviceWipeConfig(projectId: string) {
  const client = await pool.connect();
  try {
    const result = await client.query<DeviceWipeConfigRow>(
      `SELECT enabled, register_function, query_function, acknowledge_function, updated_at
       FROM druvia_project_device_wipe_configs WHERE project_id = $1`,
      [projectId],
    );
    const row = result.rows[0];
    const hooks = row ? configHooks(row) : DEFAULT_HOOKS;
    let hooksReady = false;
    try {
      await inspectDeviceWipeHookContracts(client, projectId, hooks);
      hooksReady = true;
    } catch {
      hooksReady = false;
    }
    const keyResult = await client.query<{ active_key_id: string | null; key_count: string | number }>(
      `SELECT max(key_id) FILTER (WHERE status = 'active') AS active_key_id,
              count(*) FILTER (WHERE status <> 'retired') AS key_count
       FROM druvia_project_device_wipe_signing_keys WHERE project_id = $1`,
      [projectId],
    );
    return {
      enabled: row?.enabled ?? false,
      hooksReady,
      activeKeyId: keyResult.rows[0]?.active_key_id ?? null,
      verificationKeyCount: Number(keyResult.rows[0]?.key_count ?? 0),
      updatedAt: row?.updated_at?.toISOString() ?? null,
    };
  } finally {
    client.release();
  }
}

export async function updateProjectDeviceWipeConfig(projectId: string, enabled: boolean) {
  await inTransaction(async (client) => {
    await acquireProjectAuthProjectLock(client, projectId);
    await assertDeviceWipeRuntimeAvailable(client, projectId);
    const current = await readConfigForUpdate(client, projectId);
    const hooks = current ? configHooks(current) : DEFAULT_HOOKS;
    let verification: ReturnType<typeof secretVerification> | null = null;
    if (enabled) {
      const secrets = readDeviceWipeSecrets();
      verification = current?.binding_secret_verification || current?.credential_secret_verification
        ? assertPersistedSecretVerification(current, secrets)
        : secretVerification(secrets);
      await inspectDeviceWipeHookContracts(client, projectId, hooks);
    }
    await client.query(
      `INSERT INTO druvia_project_device_wipe_configs (
         project_id, enabled, register_function, query_function, acknowledge_function,
         binding_secret_verification, credential_secret_verification
       ) VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (project_id) DO UPDATE
       SET enabled = EXCLUDED.enabled,
           binding_secret_verification = COALESCE(
             druvia_project_device_wipe_configs.binding_secret_verification,
             EXCLUDED.binding_secret_verification
           ),
           credential_secret_verification = COALESCE(
             druvia_project_device_wipe_configs.credential_secret_verification,
             EXCLUDED.credential_secret_verification
           ),
           updated_at = NOW()`,
      [
        projectId,
        enabled,
        hooks.registerFunction,
        hooks.queryFunction,
        hooks.acknowledgeFunction,
        verification?.binding ?? null,
        verification?.credential ?? null,
      ],
    );
    if (enabled) {
      const active = await client.query(
        `SELECT 1 FROM druvia_project_device_wipe_signing_keys
         WHERE project_id = $1 AND status = 'active' FOR UPDATE`,
        [projectId],
      );
      if (!active.rows[0]) await insertSigningKey(client, projectId);
    }
  });
  logger.info('project device wipe configuration updated', { projectId, enabled });
  return getProjectDeviceWipeConfig(projectId);
}

export async function listProjectDeviceWipeVerificationKeys(projectId: string) {
  const client = await pool.connect();
  try {
    const result = await client.query<DeviceWipeSigningKeyRow>(
      `SELECT key_id, public_jwk, status, created_at
       FROM druvia_project_device_wipe_signing_keys
       WHERE project_id = $1 AND status IN ('active', 'verification_only')
       ORDER BY created_at DESC`,
      [projectId],
    );
    return {
      keys: result.rows.map((row) => ({
        keyId: row.key_id,
        algorithm: 'Ed25519' as const,
        publicJwk: row.public_jwk,
        status: row.status,
        createdAt: row.created_at?.toISOString() ?? null,
      })),
    };
  } finally {
    client.release();
  }
}

export async function rotateProjectDeviceWipeSigningKey(projectId: string) {
  const key = await inTransaction(async (client) => {
    await acquireProjectAuthProjectLock(client, projectId);
    await assertDeviceWipeRuntimeAvailable(client, projectId);
    const current = await readConfigForUpdate(client, projectId);
    if (!current?.enabled) {
      throw new ProjectDeviceWipeError('DEVICE_WIPE_NOT_CONFIGURED', 'Project device wipe is not enabled', 409);
    }
    assertPersistedSecretVerification(current, readDeviceWipeSecrets());
    await client.query(
      `UPDATE druvia_project_device_wipe_signing_keys
       SET status = 'verification_only'
       WHERE project_id = $1 AND status = 'active'`,
      [projectId],
    );
    return insertSigningKey(client, projectId);
  });
  logger.info('project device wipe signing key rotated', { projectId, keyId: key.keyId });
  return key;
}

export async function retireProjectDeviceWipeSigningKey(projectId: string, keyId: string) {
  try {
    const result = await inTransaction(async (client) => {
      await acquireProjectAuthProjectLock(client, projectId);
      await assertDeviceWipeRuntimeAvailable(client, projectId);
      const result = await client.query<{ key_id: string }>(
        `UPDATE druvia_project_device_wipe_signing_keys
         SET status = 'retired', retired_at = NOW()
         WHERE project_id = $1 AND key_id = $2 AND status = 'verification_only'
         RETURNING key_id`,
        [projectId, keyId],
      );
      if (!result.rows[0]) {
        throw new ProjectDeviceWipeError(
          'DEVICE_WIPE_SIGNING_KEY_NOT_RETIRABLE',
          'Device wipe signing key is not eligible for retirement',
          409,
        );
      }
      return { retired: true, keyId: result.rows[0].key_id };
    });
    logger.info('project device wipe signing key retired', { projectId, keyId });
    return result;
  } catch (error) {
    if ((error as { code?: string }).code === '55006') {
      throw new ProjectDeviceWipeError(
        'DEVICE_WIPE_SIGNING_KEY_IN_USE',
        'Device wipe signing key still has pending mandates',
        409,
      );
    }
    throw error;
  }
}

export async function assertProjectDeviceWipeProjectDeletionAllowed(
  projectId: string,
  existingClient?: PoolClient,
): Promise<void> {
  const client = existingClient ?? await pool.connect();
  try {
    const result = await client.query<{ blocked: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM druvia_project_device_wipe_bindings WHERE project_id = $1
         UNION ALL
         SELECT 1 FROM druvia_project_device_wipe_mandates WHERE project_id = $1
       ) AS blocked`,
      [projectId],
    );
    if (result.rows[0]?.blocked) {
      throw new ProjectDeviceWipeError(
        'DEVICE_WIPE_DECOMMISSION_REQUIRED',
        'Project device wipe records must be decommissioned before deleting the project',
        409,
      );
    }
  } finally {
    if (!existingClient) client.release();
  }
}
