import { importPKCS8 } from 'jose';

const APPLE_ID_PATTERN = /^[A-Za-z0-9]{10}$/;
const AUDIENCE_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9.-]{0,253}[A-Za-z0-9])?$/;

export class AppleProviderConfigError extends Error {
  constructor(
    readonly code:
      | 'APPLE_PROVIDER_CONFIG_INVALID'
      | 'APPLE_PRIVATE_KEY_INVALID'
      | 'APPLE_PROJECT_SCHEMA_INCOMPATIBLE',
    message: string,
  ) {
    super(message);
    this.name = 'AppleProviderConfigError';
  }
}

export interface AppleProjectAuthColumn {
  column_name: string;
  is_nullable: string;
}

export function validateAppleProjectAuthSchema(columns: AppleProjectAuthColumn[]): void {
  if (!columns.some((column) => column.column_name === 'id')) {
    throw new AppleProviderConfigError(
      'APPLE_PROJECT_SCHEMA_INCOMPATIBLE',
      'Project users table with an id column is required before enabling Apple Auth',
    );
  }
  const providerId = columns.find((column) => column.column_name === 'provider_id');
  if (providerId && providerId.is_nullable !== 'YES') {
    throw new AppleProviderConfigError(
      'APPLE_PROJECT_SCHEMA_INCOMPATIBLE',
      'Project users.provider_id must allow NULL before enabling Apple Auth',
    );
  }
}

export interface ValidAppleProviderConfig extends Record<string, unknown> {
  teamId: string;
  keyId: string;
  allowedAudiences: string[];
  flow: 'native';
}

function isValidAudience(value: string): boolean {
  return value.length <= 255
    && AUDIENCE_PATTERN.test(value)
    && !value.includes('..');
}

export async function validateAppleProviderConfiguration(input: {
  clientId: string;
  privateKeyPem: string;
  config: Record<string, unknown>;
}): Promise<ValidAppleProviderConfig> {
  const teamId = typeof input.config.teamId === 'string' ? input.config.teamId.trim() : '';
  const keyId = typeof input.config.keyId === 'string' ? input.config.keyId.trim() : '';
  const clientId = input.clientId.trim();
  const audiences = Array.isArray(input.config.allowedAudiences)
    ? input.config.allowedAudiences.map((value) => typeof value === 'string' ? value.trim() : '')
    : [];

  if (
    !APPLE_ID_PATTERN.test(teamId)
    || !APPLE_ID_PATTERN.test(keyId)
    || !isValidAudience(clientId)
    || audiences.length < 1
    || audiences.length > 8
    || audiences.some((audience) => !isValidAudience(audience))
    || new Set(audiences).size !== audiences.length
    || !audiences.includes(clientId)
    || (input.config.flow !== undefined && input.config.flow !== 'native')
  ) {
    throw new AppleProviderConfigError(
      'APPLE_PROVIDER_CONFIG_INVALID',
      'Invalid Apple Team ID, Key ID, Bundle ID, or audience allowlist',
    );
  }

  if (!input.privateKeyPem || Buffer.byteLength(input.privateKeyPem, 'utf8') > 16 * 1024) {
    throw new AppleProviderConfigError('APPLE_PRIVATE_KEY_INVALID', 'Invalid Apple private key');
  }
  try {
    await importPKCS8(input.privateKeyPem, 'ES256');
  } catch {
    throw new AppleProviderConfigError(
      'APPLE_PRIVATE_KEY_INVALID',
      'Apple private key must be a valid ES256 PKCS8 key',
    );
  }

  return { teamId, keyId, allowedAudiences: audiences, flow: 'native' };
}
