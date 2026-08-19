const LEADING_TRANSACTION_WRAPPER =
  /^((?:\s|--[^\r\n]*(?:\r?\n|$)|\/\*[\s\S]*?\*\/)*)BEGIN\s*;\s*/i;

const TRAILING_TRANSACTION_WRAPPER =
  /(^|\r?\n)[\t ]*COMMIT\s*;((?:(?:[\t ]*(?:\r?\n|$))|(?:[\t ]*--[^\r\n]*(?:\r?\n|$))|(?:[\t ]*\/\*[\s\S]*?\*\/[\t ]*(?:\r?\n|$)))*)$/i;

export function stripMigrationTransactionWrapper(sql: string): string {
  const trimmed = sql.trim();
  if (!LEADING_TRANSACTION_WRAPPER.test(trimmed)
    || !TRAILING_TRANSACTION_WRAPPER.test(trimmed)) {
    return trimmed;
  }
  return trimmed
    .replace(LEADING_TRANSACTION_WRAPPER, '$1')
    .replace(TRAILING_TRANSACTION_WRAPPER, '$1$2')
    .trim();
}
