import type { PoolClient } from 'pg';
import {
  ProjectDeviceWipeError,
  type DeviceWipeHookContracts,
  type DeviceWipeHookNames,
  type DeviceWipeMandateSource,
} from './project-device-wipe.types.js';

interface HookContractRow {
  owner_name: string;
  owner_superuser: boolean;
  owner_bypassrls: boolean;
  owner_createrole: boolean;
  owner_replication: boolean;
  security_definer: boolean;
  function_config: string[] | null;
  public_execute: boolean;
  non_owner_execute: boolean;
  owner_role_membership: boolean;
  owner_assumable_by_non_superuser: boolean;
  owner_cross_schema_relation_access: boolean;
  owner_cross_schema_column_access: boolean;
  owner_cross_schema_sequence_access: boolean;
  owner_cross_schema_create: boolean;
  owner_cross_schema_definer_execute: boolean;
  contract_hash: string;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const FUNCTION_PATTERN = /^[a-z_][a-z0-9_]{0,62}$/;
const SCHEMA_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const HASH_PATTERN = /^[a-f0-9]{64}$/;

function quoteIdentifier(value: string): string {
  if (!SCHEMA_PATTERN.test(value)) throw hookInvalid();
  return `"${value.replace(/"/g, '""')}"`;
}

function hookInvalid(message = 'Project device wipe Hook returned an invalid response') {
  return new ProjectDeviceWipeError('DEVICE_WIPE_HOOK_INVALID', message, 503);
}

function hookNotConfigured(message = 'Project device wipe Hooks are not configured') {
  return new ProjectDeviceWipeError('DEVICE_WIPE_NOT_CONFIGURED', message, 409);
}

function hasOnlyKeys(value: unknown, allowed: string[], required: string[]): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  return keys.every((key) => allowed.includes(key))
    && required.every((key) => Object.hasOwn(value, key));
}

function hookContractSelect(signature: string): string {
  return `SELECT
      owner_role.rolname AS owner_name,
      owner_role.rolsuper AS owner_superuser,
      owner_role.rolbypassrls AS owner_bypassrls,
      owner_role.rolcreaterole AS owner_createrole,
      owner_role.rolreplication AS owner_replication,
      proc.prosecdef AS security_definer,
      proc.proconfig AS function_config,
      EXISTS (
        SELECT 1
        FROM aclexplode(COALESCE(proc.proacl, acldefault('f', proc.proowner))) function_grant
        WHERE function_grant.privilege_type = 'EXECUTE' AND function_grant.grantee = 0
      ) AS public_execute,
      EXISTS (
        SELECT 1
        FROM aclexplode(COALESCE(proc.proacl, acldefault('f', proc.proowner))) function_grant
        WHERE function_grant.privilege_type = 'EXECUTE'
          AND function_grant.grantee <> proc.proowner
          AND function_grant.grantee <> 0
      ) AS non_owner_execute,
      EXISTS (
        SELECT 1 FROM pg_roles granted_role
        WHERE granted_role.oid <> owner_role.oid
          AND pg_has_role(owner_role.oid, granted_role.oid, 'MEMBER')
      ) AS owner_role_membership,
      EXISTS (
        SELECT 1 FROM pg_roles candidate_role
        WHERE candidate_role.oid <> owner_role.oid
          AND NOT candidate_role.rolsuper
          AND pg_has_role(candidate_role.oid, owner_role.oid, 'MEMBER')
      ) AS owner_assumable_by_non_superuser,
      EXISTS (
        SELECT 1
        FROM pg_class other_relation
        JOIN pg_namespace other_ns ON other_ns.oid = other_relation.relnamespace
        WHERE other_relation.relkind IN ('r', 'p', 'v', 'm', 'f')
          AND other_ns.nspname <> ns.nspname
          AND other_ns.nspname NOT IN ('pg_catalog', 'information_schema')
          AND other_ns.nspname !~ '^pg_toast'
          AND NOT EXISTS (
            SELECT 1
            FROM pg_depend extension_dependency
            JOIN pg_extension extension ON extension.oid = extension_dependency.refobjid
            WHERE extension_dependency.classid = 'pg_class'::regclass
              AND extension_dependency.objid = other_relation.oid
              AND extension_dependency.deptype = 'e'
          )
          AND has_table_privilege(
            owner_role.oid,
            other_relation.oid,
            'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
          )
      ) AS owner_cross_schema_relation_access,
      EXISTS (
        SELECT 1
        FROM pg_class other_relation
        JOIN pg_namespace other_ns ON other_ns.oid = other_relation.relnamespace
        WHERE other_relation.relkind IN ('r', 'p', 'v', 'm', 'f')
          AND other_ns.nspname <> ns.nspname
          AND other_ns.nspname NOT IN ('pg_catalog', 'information_schema')
          AND other_ns.nspname !~ '^pg_toast'
          AND NOT EXISTS (
            SELECT 1
            FROM pg_depend extension_dependency
            JOIN pg_extension extension ON extension.oid = extension_dependency.refobjid
            WHERE extension_dependency.classid = 'pg_class'::regclass
              AND extension_dependency.objid = other_relation.oid
              AND extension_dependency.deptype = 'e'
          )
          AND has_any_column_privilege(
            owner_role.oid,
            other_relation.oid,
            'SELECT,INSERT,UPDATE,REFERENCES'
          )
      ) AS owner_cross_schema_column_access,
      EXISTS (
        SELECT 1
        FROM pg_class other_sequence
        JOIN pg_namespace other_ns ON other_ns.oid = other_sequence.relnamespace
        WHERE other_sequence.relkind = 'S'
          AND other_ns.nspname <> ns.nspname
          AND other_ns.nspname NOT IN ('pg_catalog', 'information_schema')
          AND other_ns.nspname !~ '^pg_toast'
          AND NOT EXISTS (
            SELECT 1
            FROM pg_depend extension_dependency
            JOIN pg_extension extension ON extension.oid = extension_dependency.refobjid
            WHERE extension_dependency.classid = 'pg_class'::regclass
              AND extension_dependency.objid = other_sequence.oid
              AND extension_dependency.deptype = 'e'
          )
          AND has_sequence_privilege(owner_role.oid, other_sequence.oid, 'USAGE,SELECT,UPDATE')
      ) AS owner_cross_schema_sequence_access,
      EXISTS (
        SELECT 1
        FROM pg_namespace other_ns
        WHERE other_ns.oid <> ns.oid
          AND other_ns.nspname NOT IN ('pg_catalog', 'information_schema')
          AND other_ns.nspname !~ '^pg_toast'
          AND has_schema_privilege(owner_role.oid, other_ns.oid, 'CREATE')
      ) AS owner_cross_schema_create,
      EXISTS (
        SELECT 1
        FROM pg_proc other_proc
        JOIN pg_namespace other_ns ON other_ns.oid = other_proc.pronamespace
        WHERE other_ns.oid <> ns.oid
          AND other_ns.nspname NOT IN ('pg_catalog', 'information_schema')
          AND other_ns.nspname !~ '^pg_toast'
          AND other_proc.prosecdef
          AND other_proc.prorettype NOT IN ('trigger'::regtype, 'event_trigger'::regtype)
          AND NOT EXISTS (
            SELECT 1
            FROM pg_depend extension_dependency
            JOIN pg_extension extension ON extension.oid = extension_dependency.refobjid
            WHERE extension_dependency.classid = 'pg_proc'::regclass
              AND extension_dependency.objid = other_proc.oid
              AND extension_dependency.deptype = 'e'
          )
          AND has_function_privilege(owner_role.oid, other_proc.oid, 'EXECUTE')
      ) AS owner_cross_schema_definer_execute,
      encode(sha256(convert_to(concat_ws(chr(30),
        owner_role.rolname,
        owner_role.rolsuper::text,
        owner_role.rolbypassrls::text,
        owner_role.rolcreaterole::text,
        owner_role.rolreplication::text,
        proc.prosecdef::text,
        COALESCE(array_to_string(proc.proconfig, chr(29)), ''),
        COALESCE(proc.proacl::text, ''),
        has_function_privilege('public', proc.oid, 'EXECUTE')::text,
        EXISTS (
          SELECT 1
          FROM aclexplode(COALESCE(proc.proacl, acldefault('f', proc.proowner))) function_grant
          WHERE function_grant.privilege_type = 'EXECUTE'
            AND function_grant.grantee <> proc.proowner
        )::text,
        EXISTS (
          SELECT 1
          FROM pg_class other_relation
          JOIN pg_namespace other_ns ON other_ns.oid = other_relation.relnamespace
          WHERE other_relation.relkind IN ('r', 'p', 'v', 'm', 'f')
            AND other_ns.nspname <> ns.nspname
            AND other_ns.nspname NOT IN ('pg_catalog', 'information_schema')
            AND other_ns.nspname !~ '^pg_toast'
            AND NOT EXISTS (
              SELECT 1
              FROM pg_depend extension_dependency
              JOIN pg_extension extension ON extension.oid = extension_dependency.refobjid
              WHERE extension_dependency.classid = 'pg_class'::regclass
                AND extension_dependency.objid = other_relation.oid
                AND extension_dependency.deptype = 'e'
            )
            AND has_any_column_privilege(
              owner_role.oid,
              other_relation.oid,
              'SELECT,INSERT,UPDATE,REFERENCES'
            )
        )::text,
        EXISTS (
          SELECT 1 FROM pg_roles granted_role
          WHERE granted_role.oid <> owner_role.oid
            AND pg_has_role(owner_role.oid, granted_role.oid, 'MEMBER')
        )::text,
        EXISTS (
          SELECT 1 FROM pg_roles candidate_role
          WHERE candidate_role.oid <> owner_role.oid
            AND NOT candidate_role.rolsuper
            AND pg_has_role(candidate_role.oid, owner_role.oid, 'MEMBER')
        )::text,
        EXISTS (
          SELECT 1
          FROM pg_class other_relation
          JOIN pg_namespace other_ns ON other_ns.oid = other_relation.relnamespace
          WHERE other_relation.relkind IN ('r', 'p', 'v', 'm', 'f')
            AND other_ns.nspname <> ns.nspname
            AND other_ns.nspname NOT IN ('pg_catalog', 'information_schema')
            AND other_ns.nspname !~ '^pg_toast'
            AND NOT EXISTS (
              SELECT 1
              FROM pg_depend extension_dependency
              JOIN pg_extension extension ON extension.oid = extension_dependency.refobjid
              WHERE extension_dependency.classid = 'pg_class'::regclass
                AND extension_dependency.objid = other_relation.oid
                AND extension_dependency.deptype = 'e'
            )
            AND has_table_privilege(
              owner_role.oid,
              other_relation.oid,
              'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
            )
        )::text,
        EXISTS (
          SELECT 1
          FROM pg_class other_sequence
          JOIN pg_namespace other_ns ON other_ns.oid = other_sequence.relnamespace
          WHERE other_sequence.relkind = 'S'
            AND other_ns.nspname <> ns.nspname
            AND other_ns.nspname NOT IN ('pg_catalog', 'information_schema')
            AND other_ns.nspname !~ '^pg_toast'
            AND NOT EXISTS (
              SELECT 1
              FROM pg_depend extension_dependency
              JOIN pg_extension extension ON extension.oid = extension_dependency.refobjid
              WHERE extension_dependency.classid = 'pg_class'::regclass
                AND extension_dependency.objid = other_sequence.oid
                AND extension_dependency.deptype = 'e'
            )
            AND has_sequence_privilege(owner_role.oid, other_sequence.oid, 'USAGE,SELECT,UPDATE')
        )::text,
        EXISTS (
          SELECT 1
          FROM pg_namespace other_ns
          WHERE other_ns.oid <> ns.oid
            AND other_ns.nspname NOT IN ('pg_catalog', 'information_schema')
            AND other_ns.nspname !~ '^pg_toast'
            AND has_schema_privilege(owner_role.oid, other_ns.oid, 'CREATE')
        )::text,
        EXISTS (
          SELECT 1
          FROM pg_proc other_proc
          JOIN pg_namespace other_ns ON other_ns.oid = other_proc.pronamespace
          WHERE other_ns.oid <> ns.oid
            AND other_ns.nspname NOT IN ('pg_catalog', 'information_schema')
            AND other_ns.nspname !~ '^pg_toast'
            AND other_proc.prosecdef
            AND other_proc.prorettype NOT IN ('trigger'::regtype, 'event_trigger'::regtype)
            AND NOT EXISTS (
              SELECT 1
              FROM pg_depend extension_dependency
              JOIN pg_extension extension ON extension.oid = extension_dependency.refobjid
              WHERE extension_dependency.classid = 'pg_proc'::regclass
                AND extension_dependency.objid = other_proc.oid
                AND extension_dependency.deptype = 'e'
            )
            AND has_function_privilege(owner_role.oid, other_proc.oid, 'EXECUTE')
        )::text,
        pg_get_function_identity_arguments(proc.oid),
        pg_get_function_result(proc.oid),
        pg_get_functiondef(proc.oid)
      ), 'UTF8')), 'hex') AS contract_hash
    FROM pg_proc proc
    JOIN pg_namespace ns ON ns.oid = proc.pronamespace
    JOIN pg_roles owner_role ON owner_role.oid = proc.proowner
    WHERE proc.oid = to_regprocedure(format('%I.%I(${signature})', $1::text, $2::text))
      AND proc.prorettype = 'jsonb'::regtype`;
}

function validateContract(
  row: HookContractRow | undefined,
  dbUser: string,
  schemaName: string,
): HookContractRow {
  const searchPath = row?.function_config?.find((entry) => entry.startsWith('search_path='));
  const normalizedSearchPath = searchPath?.replace(/\s/g, '').toLowerCase();
  if (
    !row
    || row.owner_name !== dbUser
    || row.owner_superuser
    || row.owner_bypassrls
    || row.owner_createrole
    || row.owner_replication
    || row.owner_role_membership
    || row.owner_assumable_by_non_superuser
    || row.owner_cross_schema_relation_access
    || row.owner_cross_schema_column_access
    || row.owner_cross_schema_sequence_access
    || row.owner_cross_schema_create
    || row.owner_cross_schema_definer_execute
    || !row.security_definer
    || row.public_execute
    || row.non_owner_execute
    || normalizedSearchPath !== `search_path=pg_catalog,${schemaName}`.toLowerCase()
    || !HASH_PATTERN.test(row.contract_hash)
  ) {
    throw hookNotConfigured('Project device wipe Hook security contract is invalid');
  }
  return row;
}

export async function inspectDeviceWipeHookContracts(
  client: PoolClient,
  projectId: string,
  names: DeviceWipeHookNames,
): Promise<DeviceWipeHookContracts> {
  if (Object.values(names).some((name) => !FUNCTION_PATTERN.test(name))) throw hookNotConfigured();
  const projectResult = await client.query<{ schema_name: string | null; db_user: string | null }>(
    'SELECT schema_name, db_user FROM druvia_projects WHERE project_id = $1',
    [projectId],
  );
  const project = projectResult.rows[0];
  if (!project?.schema_name || !project.db_user || !SCHEMA_PATTERN.test(project.schema_name)) {
    throw hookNotConfigured('Project database identity is not ready');
  }

  const inspect = async (functionName: string, signature: string) => {
    const result = await client.query<HookContractRow>(hookContractSelect(signature), [
      project.schema_name,
      functionName,
    ]);
    return validateContract(result.rows[0], project.db_user!, project.schema_name!);
  };
  const register = await inspect(names.registerFunction, 'text,text,bigint');
  const query = await inspect(names.queryFunction, 'text,bigint');
  const acknowledge = await inspect(names.acknowledgeFunction, 'text,bigint,uuid,jsonb');
  return {
    schemaName: project.schema_name,
    ...names,
    registerContractHash: register.contract_hash,
    queryContractHash: query.contract_hash,
    acknowledgeContractHash: acknowledge.contract_hash,
  };
}

function invocationContractCte(schemaName: string, functionName: string, signature: string): string {
  const select = hookContractSelect(signature)
    .replace(/\$1::text/g, `'${schemaName.replace(/'/g, "''")}'::text`)
    .replace(/\$2::text/g, `'${functionName.replace(/'/g, "''")}'::text`);
  return `contract AS MATERIALIZED (${select}),
    validated AS MATERIALIZED (SELECT 1 FROM contract WHERE contract_hash = $1)`;
}

function assertInvocationInput(input: {
  schemaName: string;
  functionName: string;
  contractHash: string;
}) {
  if (
    !SCHEMA_PATTERN.test(input.schemaName)
    || !FUNCTION_PATTERN.test(input.functionName)
    || !HASH_PATTERN.test(input.contractHash)
  ) throw hookInvalid();
}

export async function registerDeviceWipeBindingHook(client: PoolClient, input: {
  schemaName: string;
  functionName: string;
  contractHash: string;
  projectUserId: string;
  bindingIdentityHmac: string;
  bindingRevision: number;
}): Promise<void> {
  assertInvocationInput(input);
  const target = `${quoteIdentifier(input.schemaName)}.${quoteIdentifier(input.functionName)}`;
  const result = await client.query<{ result: unknown }>(
    `WITH ${invocationContractCte(input.schemaName, input.functionName, 'text,text,bigint')}
     SELECT ${target}($2::text, $3::text, $4::bigint) AS result FROM validated`,
    [input.contractHash, input.projectUserId, input.bindingIdentityHmac, input.bindingRevision],
  );
  if (
    !hasOnlyKeys(result.rows[0]?.result, ['registered'], ['registered'])
    || result.rows[0].result.registered !== true
  ) {
    throw hookInvalid();
  }
}

function normalizeMandates(value: unknown): DeviceWipeMandateSource[] {
  if (!Array.isArray(value) || value.length > 100) throw hookInvalid();
  const seen = new Set<string>();
  return value.map((item) => {
    if (!hasOnlyKeys(item, ['deletionId', 'scope', 'sessionId'], ['deletionId', 'scope'])) {
      throw hookInvalid();
    }
    const row = item;
    const deletionId = row.deletionId;
    const scope = row.scope;
    const sessionId = row.sessionId ?? null;
    if (
      typeof deletionId !== 'string'
      || !UUID_PATTERN.test(deletionId)
      || (scope !== 'account' && scope !== 'session')
      || (scope === 'account' && sessionId !== null)
      || (scope === 'session' && (typeof sessionId !== 'string' || !UUID_PATTERN.test(sessionId)))
    ) throw hookInvalid();
    if (seen.has(deletionId)) throw hookInvalid();
    seen.add(deletionId);
    return { deletionId, scope, sessionId: sessionId as string | null };
  });
}

export async function listDeviceWipeMandatesHook(client: PoolClient, input: {
  schemaName: string;
  functionName: string;
  contractHash: string;
  bindingIdentityHmac: string;
  bindingRevision: number;
}): Promise<DeviceWipeMandateSource[]> {
  assertInvocationInput(input);
  const target = `${quoteIdentifier(input.schemaName)}.${quoteIdentifier(input.functionName)}`;
  const result = await client.query<{ result: unknown }>(
    `WITH ${invocationContractCte(input.schemaName, input.functionName, 'text,bigint')}
     SELECT ${target}($2::text, $3::bigint) AS result FROM validated`,
    [input.contractHash, input.bindingIdentityHmac, input.bindingRevision],
  );
  if (!result.rows[0]) throw hookInvalid('Project device wipe Hook contract changed');
  return normalizeMandates(result.rows[0].result);
}

export async function acknowledgeDeviceWipeMandateHook(client: PoolClient, input: {
  schemaName: string;
  functionName: string;
  contractHash: string;
  bindingIdentityHmac: string;
  bindingRevision: number;
  deletionId: string;
  receipt: Record<string, unknown>;
}): Promise<void> {
  assertInvocationInput(input);
  if (!UUID_PATTERN.test(input.deletionId)) throw hookInvalid();
  const target = `${quoteIdentifier(input.schemaName)}.${quoteIdentifier(input.functionName)}`;
  const result = await client.query<{ result: unknown }>(
    `WITH ${invocationContractCte(input.schemaName, input.functionName, 'text,bigint,uuid,jsonb')}
     SELECT ${target}($2::text, $3::bigint, $4::uuid, $5::jsonb) AS result FROM validated`,
    [
      input.contractHash,
      input.bindingIdentityHmac,
      input.bindingRevision,
      input.deletionId,
      JSON.stringify(input.receipt),
    ],
  );
  if (
    !hasOnlyKeys(result.rows[0]?.result, ['acknowledged'], ['acknowledged'])
    || result.rows[0].result.acknowledged !== true
  ) {
    throw hookInvalid();
  }
}
