const ALIAS_REGEX = /^[a-z0-9]{3,16}$/;

export function validateAlias(alias: string, field: string): void {
  if (!ALIAS_REGEX.test(alias)) {
    throw new Error(`${field} 必须是 3-16 个小写字母或数字`);
  }
}

export function generateSchemaName(tenantAlias: string, projectAlias: string): string {
  return `dru_${tenantAlias}_${projectAlias}`;
}
