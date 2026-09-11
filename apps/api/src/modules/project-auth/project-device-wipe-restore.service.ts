import type { PoolClient } from 'pg';
import {
  acknowledgeDeviceWipeMandateHook,
  inspectDeviceWipeHookContracts,
  registerDeviceWipeBindingHook,
} from './project-device-wipe.hooks.js';
import { decryptSecret } from '../../lib/secret-encryption.js';
import type { DeviceWipeHookNames } from './project-device-wipe.types.js';

interface RestoredDeviceWipeBindingRow {
  binding_id: string;
  project_user_id_encrypted: string;
  project_schema: string;
  register_function: string;
  register_contract_hash: string;
  query_function: string;
  query_contract_hash: string;
  acknowledge_function: string;
  acknowledge_contract_hash: string;
  binding_identity_hmac: string;
  binding_revision: string | number;
  deletion_id: string | null;
  receipt_json: Record<string, unknown> | null;
}

export class ProjectDeviceWipeRestoreError extends Error {
  readonly code = 'DEVICE_WIPE_RECEIPT_REPLAY_REQUIRED';

  constructor(cause?: unknown) {
    super('Project device wipe receipt replay is required', { cause });
    this.name = 'ProjectDeviceWipeRestoreError';
  }
}

export class ProjectDeviceWipeBindingRestoreError extends Error {
  readonly code = 'DEVICE_WIPE_BINDING_REPLAY_REQUIRED';

  constructor(cause?: unknown) {
    super('Project device wipe binding replay is required', { cause });
    this.name = 'ProjectDeviceWipeBindingRestoreError';
  }
}

function hookNames(row: RestoredDeviceWipeBindingRow): DeviceWipeHookNames {
  return {
    registerFunction: row.register_function,
    queryFunction: row.query_function,
    acknowledgeFunction: row.acknowledge_function,
  };
}

function contractKey(row: RestoredDeviceWipeBindingRow): string {
  return JSON.stringify([
    row.register_function,
    row.query_function,
    row.acknowledge_function,
  ]);
}

async function inspectRestoredContracts(
  client: PoolClient,
  projectId: string,
  row: RestoredDeviceWipeBindingRow,
  contracts: Map<string, Awaited<ReturnType<typeof inspectDeviceWipeHookContracts>>>,
) {
  const key = contractKey(row);
  let restored = contracts.get(key);
  if (!restored) {
    restored = await inspectDeviceWipeHookContracts(client, projectId, hookNames(row));
    contracts.set(key, restored);
  }
  if (
    restored.schemaName !== row.project_schema
    || restored.registerContractHash !== row.register_contract_hash
    || restored.queryContractHash !== row.query_contract_hash
    || restored.acknowledgeContractHash !== row.acknowledge_contract_hash
  ) {
    throw new Error('Project device wipe Hook contract changed during restore');
  }
  return restored;
}

export async function replayProjectDeviceWipeRegistrations(
  client: PoolClient,
  projectId: string,
): Promise<void> {
  try {
    const result = await client.query<RestoredDeviceWipeBindingRow>(
      `SELECT binding_id, project_user_id_encrypted, project_schema,
              register_function, register_contract_hash,
              query_function, query_contract_hash,
              acknowledge_function, acknowledge_contract_hash,
              binding_identity_hmac, binding_revision
       FROM druvia_project_device_wipe_bindings
       WHERE project_id = $1
       ORDER BY binding_identity_hmac, binding_revision, binding_id`,
      [projectId],
    );
    const contracts = new Map<string, Awaited<ReturnType<typeof inspectDeviceWipeHookContracts>>>();
    for (const row of result.rows) {
      const restored = await inspectRestoredContracts(client, projectId, row, contracts);
      let projectUserId: string;
      try {
        projectUserId = decryptSecret(row.project_user_id_encrypted, { requireDedicatedKey: true });
      } catch (error) {
        throw new Error('Project device wipe registration replay material cannot be loaded', { cause: error });
      }
      await registerDeviceWipeBindingHook(client, {
        schemaName: row.project_schema,
        functionName: row.register_function,
        contractHash: restored.registerContractHash,
        projectUserId,
        bindingIdentityHmac: row.binding_identity_hmac,
        bindingRevision: Number(row.binding_revision),
      });
    }
  } catch (error) {
    if (error instanceof ProjectDeviceWipeBindingRestoreError) throw error;
    throw new ProjectDeviceWipeBindingRestoreError(error);
  }
}

export async function replayProjectDeviceWipeReceipts(
  client: PoolClient,
  projectId: string,
): Promise<void> {
  try {
    const result = await client.query<RestoredDeviceWipeBindingRow>(
      `SELECT binding.binding_id, binding.project_user_id_encrypted, binding.project_schema,
              binding.register_function, binding.register_contract_hash,
              binding.query_function, binding.query_contract_hash,
              binding.acknowledge_function, binding.acknowledge_contract_hash,
              binding.binding_identity_hmac, binding.binding_revision,
              mandate.deletion_id, mandate.receipt_json
       FROM druvia_project_device_wipe_bindings binding
       LEFT JOIN druvia_project_device_wipe_mandates mandate
         ON mandate.project_id = binding.project_id
        AND mandate.binding_id = binding.binding_id
        AND mandate.status = 'acknowledged'
       WHERE binding.project_id = $1
       ORDER BY binding.created_at, mandate.created_at, mandate.deletion_id`,
      [projectId],
    );
    const contracts = new Map<string, Awaited<ReturnType<typeof inspectDeviceWipeHookContracts>>>();
    for (const row of result.rows) {
      const restored = await inspectRestoredContracts(client, projectId, row, contracts);
      if (!row.deletion_id) continue;
      if (!row.receipt_json || typeof row.receipt_json !== 'object' || Array.isArray(row.receipt_json)) {
        throw new Error('Project device wipe receipt snapshot is invalid');
      }
      await acknowledgeDeviceWipeMandateHook(client, {
        schemaName: row.project_schema,
        functionName: row.acknowledge_function,
        contractHash: restored.acknowledgeContractHash,
        bindingIdentityHmac: row.binding_identity_hmac,
        bindingRevision: Number(row.binding_revision),
        deletionId: row.deletion_id,
        receipt: row.receipt_json,
      });
    }
  } catch (error) {
    if (error instanceof ProjectDeviceWipeRestoreError) throw error;
    throw new ProjectDeviceWipeRestoreError(error);
  }
}
