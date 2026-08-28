import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { config } from '../config/index.js';

export class SecretEncryptionConfigError extends Error {
  readonly code = 'SECRET_ENCRYPTION_KEY_INVALID';

  constructor(message: string) {
    super(message);
    this.name = 'SecretEncryptionConfigError';
  }
}

type SecretEncryptionOptions = {
  requireDedicatedKey?: boolean;
};

function isPlaceholder(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  return normalized === 'change-me'
    || normalized === 'changeme'
    || normalized.startsWith('change_me')
    || normalized.includes('replace_me')
    || normalized.startsWith('your_')
    || normalized.includes('example');
}

function resolveKey(options: SecretEncryptionOptions = {}): Buffer {
  const dedicatedKey = process.env.SECRETS_ENCRYPTION_KEY || '';
  const legacyKey = process.env.JWT_SECRET || config.jwt.secret || '';
  const source = dedicatedKey || legacyKey;

  if (!source) {
    throw new SecretEncryptionConfigError('SECRETS_ENCRYPTION_KEY or JWT_SECRET must be set');
  }

  if (options.requireDedicatedKey) {
    if (!dedicatedKey || Buffer.byteLength(dedicatedKey, 'utf8') < 32 || isPlaceholder(dedicatedKey)) {
      throw new SecretEncryptionConfigError(
        'Apple secrets require a dedicated SECRETS_ENCRYPTION_KEY of at least 32 UTF-8 bytes'
      );
    }

    const forbidden = [
      process.env.JWT_SECRET,
      process.env.PROJECT_AUTH_JWT_SECRET,
      process.env.HASURA_JWT_SECRET,
    ].filter((value): value is string => Boolean(value));
    if (forbidden.includes(dedicatedKey)) {
      throw new SecretEncryptionConfigError(
        'SECRETS_ENCRYPTION_KEY must differ from authentication signing secrets'
      );
    }
  }

  return createHash('sha256').update(source).digest();
}

export function encryptSecret(text: string, options: SecretEncryptionOptions = {}): string {
  const key = resolveKey(options);
  const iv = randomBytes(16);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  return `${iv.toString('hex')}:${cipher.getAuthTag().toString('hex')}:${encrypted.toString('hex')}`;
}

export function decryptSecret(envelope: string, options: SecretEncryptionOptions = {}): string {
  const parts = envelope.split(':');
  if (parts.length !== 3 || parts.some((part) => !/^[a-f0-9]+$/i.test(part))) {
    throw new Error('Invalid encrypted secret envelope');
  }

  const [ivHex, authTagHex, encryptedHex] = parts;
  const decipher = createDecipheriv('aes-256-gcm', resolveKey(options), Buffer.from(ivHex, 'hex'));
  decipher.setAuthTag(Buffer.from(authTagHex, 'hex'));
  return Buffer.concat([
    decipher.update(Buffer.from(encryptedHex, 'hex')),
    decipher.final(),
  ]).toString('utf8');
}
