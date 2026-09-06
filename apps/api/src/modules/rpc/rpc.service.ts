import { getClient, query } from '../../db/index.js';
import format from 'pg-format';
import {
  toProjectActorClaims,
  toProjectActorHeaders,
  type ProjectActorContext,
} from '../../lib/project-actor.js';

interface FunctionSignature {
  argNames: string[];
  argTypeOids: number[];
  fetchedAt: number;
}

const CACHE_TTL = 5 * 60 * 1000; // 5 minutes
const signatureCache = new Map<string, FunctionSignature>();
const PG_JSON_OID = 114;
const PG_JSONB_OID = 3802;

function parsePgTextArray(raw: string | null | undefined): string[] {
  if (!raw) return [];
  const trimmed = raw.trim();
  if (!trimmed) return [];

  if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
    const inner = trimmed.slice(1, -1);
    if (!inner) return [];
    return inner
      .split(',')
      .map((value) => value.trim().replace(/^"(.*)"$/, '$1'));
  }

  return trimmed
    .split(/\s+/)
    .map((value) => value.trim())
    .filter(Boolean);
}

function parseTypeOids(raw: string | null | undefined): number[] {
  return parsePgTextArray(raw)
    .map((value) => Number.parseInt(value, 10))
    .filter((value) => Number.isInteger(value));
}

function parseArgModes(raw: string | null | undefined): string[] {
  return parsePgTextArray(raw);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Object.prototype.toString.call(value) === '[object Object]';
}

function hasErrorCode(error: unknown, code: string): boolean {
  return typeof error === 'object'
    && error !== null
    && Reflect.get(error, 'code') === code;
}

function isJsonLikeType(typeOid?: number): typeOid is typeof PG_JSON_OID | typeof PG_JSONB_OID {
  return typeOid === PG_JSON_OID || typeOid === PG_JSONB_OID;
}

function buildPlaceholder(index: number, typeOid?: number): string {
  if (typeOid === PG_JSON_OID) {
    return `$${index}::json`;
  }
  if (typeOid === PG_JSONB_OID) {
    return `$${index}::jsonb`;
  }
  return `$${index}`;
}

function normalizeArgValue(value: unknown, typeOid?: number): unknown {
  if (isJsonLikeType(typeOid)) {
    if (value === undefined) {
      return null;
    }
    return JSON.stringify(value);
  }
  return value;
}

function isInputArgMode(mode?: string): boolean {
  return mode === 'i' || mode === 'b' || mode === 'v';
}

function buildInputSignature(row: {
  proargnames: string[] | null;
  proargtypes: string | null;
  proallargtypes: string | null;
  proargmodes: string | null;
}): { argNames: string[]; argTypeOids: number[] } {
  const argNames = row.proargnames ?? [];
  const inputArgTypeOids = parseTypeOids(row.proargtypes);
  const allArgTypeOids = parseTypeOids(row.proallargtypes);
  const argModes = parseArgModes(row.proargmodes);

  if (allArgTypeOids.length > 0 && argModes.length === allArgTypeOids.length) {
    const filteredArgNames = argNames.filter((_, index) => isInputArgMode(argModes[index]));
    const filteredArgTypeOids = allArgTypeOids.filter((_, index) => isInputArgMode(argModes[index]));

    return {
      argNames: filteredArgNames,
      argTypeOids: filteredArgTypeOids,
    };
  }

  return {
    argNames: inputArgTypeOids.length > 0 ? argNames.slice(0, inputArgTypeOids.length) : argNames,
    argTypeOids: inputArgTypeOids,
  };
}

/**
 * Discover PG function argument names from pg_proc.
 * Returns null if function does not exist in the given schema.
 */
async function discoverFunction(
  schemaName: string,
  functionName: string,
  queryImpl: typeof query = query,
): Promise<FunctionSignature | null> {
  const cacheKey = `${schemaName}.${functionName}`;
  const cached = signatureCache.get(cacheKey);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL) {
    return cached;
  }

  const rows = await queryImpl<{
    proargnames: string[] | null;
    proargtypes: string | null;
    proallargtypes: string | null;
    proargmodes: string | null;
  }>(
    `SELECT
       p.proargnames,
       p.proargtypes::text AS proargtypes,
       p.proallargtypes::text AS proallargtypes,
       p.proargmodes::text AS proargmodes
     FROM pg_proc p
     JOIN pg_namespace n ON p.pronamespace = n.oid
     WHERE n.nspname = $1 AND p.proname = $2`,
    [schemaName, functionName],
  );

  if (rows.length === 0) return null;

  const inputSignature = buildInputSignature(rows[0]);
  const signature = {
    argNames: inputSignature.argNames,
    argTypeOids: inputSignature.argTypeOids,
    fetchedAt: Date.now(),
  };
  signatureCache.set(cacheKey, signature);
  return signature;
}

/**
 * Call a PG function in the given schema with named args.
 * Uses parameterized queries to prevent SQL injection.
 */
interface RpcClient {
  query(text: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
  release(error?: Error): void;
}

export interface RpcServiceDependencies {
  query: typeof query;
  getClient(): Promise<RpcClient>;
}

function buildFunctionCall(
  schemaName: string,
  functionName: string,
  signature: FunctionSignature,
  args?: Record<string, unknown>,
): { sql: string; values: unknown[] } {
  if (!args || Object.keys(args).length === 0 || signature.argTypeOids.length === 0) {
    return {
      sql: format('SELECT * FROM %I.%I()', schemaName, functionName),
      values: [],
    };
  }

  const values: unknown[] = [];
  const placeholders: string[] = [];
  const { argNames, argTypeOids } = signature;

  if (argNames.length > 0) {
    for (let i = 0; i < argNames.length; i++) {
      const name = argNames[i];
      const typeOid = argTypeOids[i];
      const rawValue = Object.prototype.hasOwnProperty.call(args, name) ? args[name] : undefined;
      values.push(normalizeArgValue(rawValue, typeOid));
      placeholders.push(buildPlaceholder(i + 1, typeOid));
    }
  } else {
    let idx = 1;
    for (const [index, value] of Object.values(args).entries()) {
      const typeOid = argTypeOids[index];
      values.push(normalizeArgValue(value, typeOid));
      placeholders.push(buildPlaceholder(idx++, typeOid));
    }
  }

  return {
    sql: format(
      'SELECT * FROM %I.%I(%s)',
      schemaName,
      functionName,
      placeholders.join(', '),
    ),
    values,
  };
}

export function createRpcService(dependencies: RpcServiceDependencies) {
  return {
    async callFunction(
      schemaName: string,
      functionName: string,
      args: Record<string, unknown> | undefined,
      actor: ProjectActorContext,
    ): Promise<unknown> {
      const signature = await discoverFunction(schemaName, functionName, dependencies.query);
      if (signature === null) {
        throw new RpcError('FUNCTION_NOT_FOUND', `Function "${functionName}" not found in schema "${schemaName}"`);
      }

      const invocation = buildFunctionCall(schemaName, functionName, signature, args);
      const client = await dependencies.getClient();
      let transactionStarted = false;
      let releaseError: Error | undefined;
      let phase: 'setup' | 'invoke' | 'commit' = 'setup';

      try {
        await client.query('BEGIN');
        transactionStarted = true;
        const claims = JSON.stringify(toProjectActorClaims(actor));
        await client.query("SELECT set_config('request.jwt.claims', $1, true)", [claims]);
        await client.query("SELECT set_config('request.headers', $1, true)", [
          JSON.stringify(toProjectActorHeaders(actor)),
        ]);
        await client.query("SELECT set_config('druvia.actor', $1, true)", [claims]);
        phase = 'invoke';
        const result = await client.query(invocation.sql, invocation.values);
        phase = 'commit';
        await client.query('COMMIT');
        return normalizeResult(result.rows);
      } catch (error) {
        if (transactionStarted) {
          try {
            await client.query('ROLLBACK');
          } catch (rollbackError) {
            releaseError = rollbackError instanceof Error
              ? rollbackError
              : new Error(String(rollbackError));
          }
        }
        if (phase === 'invoke' && hasErrorCode(error, 'P0001')) {
          if (releaseError) {
            throw releaseError;
          }
          throw new RpcError('RPC_REJECTED', 'RPC request rejected');
        }
        throw error;
      } finally {
        client.release(releaseError);
      }
    },
  };
}

const defaultRpcService = createRpcService({ query, getClient });

export async function callFunction(
  schemaName: string,
  functionName: string,
  args: Record<string, unknown> | undefined,
  actor: ProjectActorContext,
): Promise<unknown> {
  return defaultRpcService.callFunction(schemaName, functionName, args, actor);
}

/*
 * Normalize PG result to match the SDK contract.
 */
function normalizeResult(rows: Record<string, unknown>[]): unknown {
  if (rows.length === 0) return null;
  if (rows.length === 1) {
    const keys = Object.keys(rows[0]);
    if (keys.length === 1) {
      return rows[0][keys[0]];
    }
    return rows[0];
  }
  return rows;
}

export class RpcError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

/** Clear signature cache (for testing or manual refresh) */
export function clearSignatureCache(key?: string): void {
  if (key) {
    signatureCache.delete(key);
  } else {
    signatureCache.clear();
  }
}
