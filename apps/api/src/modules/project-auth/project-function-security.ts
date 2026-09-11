export function hasFixedProjectFunctionSearchPath(
  functionConfig: string[] | null | undefined,
  schemaName: string,
): boolean {
  const searchPaths = (functionConfig ?? [])
    .map((entry) => entry.replace(/\s/g, '').toLowerCase())
    .filter((entry) => entry.startsWith('search_path='));

  return searchPaths.length === 1
    && searchPaths[0] === `search_path=pg_catalog,${schemaName},pg_temp`.toLowerCase();
}

export function fixedProjectFunctionSearchPathSql(): string {
  return `ARRAY(
    SELECT regexp_replace(lower(setting), '[[:space:]]', '', 'g')
    FROM unnest(COALESCE(proc.proconfig, ARRAY[]::text[])) AS setting
    WHERE regexp_replace(lower(setting), '[[:space:]]', '', 'g') LIKE 'search_path=%'
  ) = ARRAY['search_path=pg_catalog,' || lower(ns.nspname) || ',pg_temp']`;
}
