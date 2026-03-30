import { query } from '../../db/index.js';
import format from 'pg-format';

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
): Promise<FunctionSignature | null> {
  const cacheKey = `${schemaName}.${functionName}`;
  const cached = signatureCache.get(cacheKey);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL) {
    return cached;
  }

  const rows = await query<{
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
export async function callFunction(
  schemaName: string,
  functionName: string,
  args?: Record<string, unknown>,
): Promise<unknown> {
  const signature = await discoverFunction(schemaName, functionName);
  if (signature === null) {
    throw new RpcError('FUNCTION_NOT_FOUND', `Function "${functionName}" not found in schema "${schemaName}"`);
  }

  // Build parameterized call
  // Use pg-format %I for identifiers (schema + function name)
  if (!args || Object.keys(args).length === 0 || signature.argTypeOids.length === 0) {
    // No arguments
    const sql = format('SELECT * FROM %I.%I()', schemaName, functionName);
    const rows = await query<Record<string, unknown>>(sql);
    return normalizeResult(rows);
  }

  // Map named args to positional params in pg_proc order
  const values: unknown[] = [];
  const placeholders: string[] = [];
  const { argNames, argTypeOids } = signature;

  if (argNames.length > 0) {
    // Ordered by function signature
    for (let i = 0; i < argNames.length; i++) {
      const name = argNames[i];
      const typeOid = argTypeOids[i];
      const rawValue = Object.prototype.hasOwnProperty.call(args, name) ? args[name] : undefined;
      values.push(normalizeArgValue(rawValue, typeOid));
      placeholders.push(buildPlaceholder(i + 1, typeOid));
    }
  } else {
    // No named args in pg_proc — pass all args in order received
    let idx = 1;
    for (const [index, value] of Object.values(args).entries()) {
      const typeOid = argTypeOids[index];
      values.push(normalizeArgValue(value, typeOid));
      placeholders.push(buildPlaceholder(idx++, typeOid));
    }
  }

  const sql = format(
    'SELECT * FROM %I.%I(%s)',
    schemaName,
    functionName,
    placeholders.join(', '),
  );

  const rows = await query<Record<string, unknown>>(sql, values);
  return normalizeResult(rows);
}

/**
 * Normalize PG result to match design spec:
 * - SETOF/TABLE → array
 * - single row with single column → scalar
 * - single row → object
 * - no rows → null
 */
function normalizeResult(rows: Record<string, unknown>[]): unknown {
  if (rows.length === 0) return null;
  if (rows.length === 1) {
    const keys = Object.keys(rows[0]);
    // Single column scalar result (e.g. RETURNS int)
    if (keys.length === 1) {
      const val = rows[0][keys[0]];
      // If the single column is the function name itself, unwrap
      return val;
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
