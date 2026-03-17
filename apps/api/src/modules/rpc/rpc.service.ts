import { query } from '../../db/index.js';
import format from 'pg-format';

interface FunctionSignature {
  argNames: string[];
  fetchedAt: number;
}

const CACHE_TTL = 5 * 60 * 1000; // 5 minutes
const signatureCache = new Map<string, FunctionSignature>();

/**
 * Discover PG function argument names from pg_proc.
 * Returns null if function does not exist in the given schema.
 */
async function discoverFunction(
  schemaName: string,
  functionName: string,
): Promise<string[] | null> {
  const cacheKey = `${schemaName}.${functionName}`;
  const cached = signatureCache.get(cacheKey);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL) {
    return cached.argNames;
  }

  const rows = await query<{ proargnames: string[] | null }>(
    `SELECT p.proargnames
     FROM pg_proc p
     JOIN pg_namespace n ON p.pronamespace = n.oid
     WHERE n.nspname = $1 AND p.proname = $2`,
    [schemaName, functionName],
  );

  if (rows.length === 0) return null;

  const argNames = rows[0].proargnames ?? [];
  signatureCache.set(cacheKey, { argNames, fetchedAt: Date.now() });
  return argNames;
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
  const argNames = await discoverFunction(schemaName, functionName);
  if (argNames === null) {
    throw new RpcError('FUNCTION_NOT_FOUND', `Function "${functionName}" not found in schema "${schemaName}"`);
  }

  // Build parameterized call
  // Use pg-format %I for identifiers (schema + function name)
  if (!args || Object.keys(args).length === 0) {
    // No arguments
    const sql = format('SELECT * FROM %I.%I()', schemaName, functionName);
    const rows = await query<Record<string, unknown>>(sql);
    return normalizeResult(rows);
  }

  // Map named args to positional params in pg_proc order
  const values: unknown[] = [];
  const placeholders: string[] = [];

  if (argNames.length > 0) {
    // Ordered by function signature
    for (let i = 0; i < argNames.length; i++) {
      const name = argNames[i];
      values.push(args[name] ?? null);
      placeholders.push(`$${i + 1}`);
    }
  } else {
    // No named args in pg_proc — pass all args in order received
    let idx = 1;
    for (const value of Object.values(args)) {
      values.push(value);
      placeholders.push(`$${idx++}`);
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
