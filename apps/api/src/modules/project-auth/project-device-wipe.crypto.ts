import {
  createHash,
  createHmac,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  sign,
  timingSafeEqual,
  verify,
} from 'node:crypto';
import type { JsonWebKey as NodeJsonWebKey } from 'node:crypto';

export interface DeviceWipeCryptoConfig {
  bindingSecret: string;
  credentialSecret: string;
  protectedSecrets: string[];
}

export interface DeviceWipeCommand {
  version: 1;
  deletionID: { rawValue: string };
  projectID: string;
  projectUserFingerprint: string;
  bindingIdentityHMAC: string;
  bindingRevision: number;
  scope: { kind: 'account' } | { kind: 'session'; sessionID: { rawValue: string } };
}

export interface DeviceWipeSigningKeyPair {
  keyId: string;
  publicJwk: NodeJsonWebKey;
  privateJwk: NodeJsonWebKey;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const FINGERPRINT_PATTERN = /^[A-Za-z0-9_-]{43}$/;

function isPlaceholder(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  return normalized === 'change-me'
    || normalized === 'changeme'
    || normalized.startsWith('change_me')
    || normalized.includes('replace_me')
    || normalized.startsWith('your_')
    || normalized.includes('example');
}

export function assertDeviceWipeSecretsConfigured(config: DeviceWipeCryptoConfig) {
  const { bindingSecret, credentialSecret } = config;
  if (
    Buffer.byteLength(bindingSecret, 'utf8') < 32
    || Buffer.byteLength(credentialSecret, 'utf8') < 32
    || isPlaceholder(bindingSecret)
    || isPlaceholder(credentialSecret)
  ) {
    throw new Error('Device wipe secrets are not configured with at least 32 UTF-8 bytes');
  }
  if (
    bindingSecret === credentialSecret
    || config.protectedSecrets.includes(bindingSecret)
    || config.protectedSecrets.includes(credentialSecret)
  ) {
    throw new Error('Device wipe secrets must be distinct from each other and other signing secrets');
  }
  return { bindingSecret, credentialSecret };
}

function deriveHmac(secret: string, domain: string, parts: string[]): string {
  const hmac = createHmac('sha256', secret);
  hmac.update(`druvia:device-wipe:${domain}:v1\0`, 'utf8');
  for (const part of parts) {
    hmac.update(String(Buffer.byteLength(part, 'utf8')), 'ascii');
    hmac.update(':', 'ascii');
    hmac.update(part, 'utf8');
    hmac.update('\0', 'utf8');
  }
  return hmac.digest('base64url');
}

export function deriveDeviceWipeSecretVerification(
  secret: string,
  purpose: 'binding' | 'credential',
): string {
  return deriveHmac(secret, `secret-verification:${purpose}`, []);
}

export function deriveProjectUserFingerprint(input: {
  secret: string;
  projectId: string;
  projectUserId: string;
}): string {
  return deriveHmac(input.secret, 'project-user', [input.projectId, input.projectUserId]);
}

export function deriveBindingIdentityHmac(input: {
  secret: string;
  projectId: string;
  bindingIdentity: string;
}): string {
  return deriveHmac(input.secret, 'binding-identity', [input.projectId, input.bindingIdentity]);
}

export function deriveBindingLookupToken(input: {
  secret: string;
  projectId: string;
  bindingId: string;
}): string {
  return deriveHmac(input.secret, 'binding-lookup-token', [input.projectId, input.bindingId]);
}

export function deriveBindingHandle(input: {
  secret: string;
  projectId: string;
  bindingId: string;
}): string {
  return `dwb_${deriveHmac(input.secret, 'binding-handle', [input.projectId, input.bindingId]).slice(0, 32)}`;
}

export function hashBindingLookupToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export function verifyBindingLookupToken(token: string, expectedDigest: string): boolean {
  if (!FINGERPRINT_PATTERN.test(token) || !/^[a-f0-9]{64}$/.test(expectedDigest)) return false;
  const actual = Buffer.from(hashBindingLookupToken(token), 'hex');
  const expected = Buffer.from(expectedDigest, 'hex');
  return timingSafeEqual(actual, expected);
}

export function buildDeviceWipeCommand(input: {
  deletionId: string;
  projectId: string;
  projectUserFingerprint: string;
  bindingIdentityHmac: string;
  bindingRevision: number;
  scope: 'account' | 'session';
  sessionId: string | null;
}): DeviceWipeCommand {
  if (!UUID_PATTERN.test(input.deletionId)) throw new Error('Invalid device wipe deletion ID');
  if (!/^[A-Za-z0-9_-]+$/.test(input.projectId)) throw new Error('Invalid device wipe project ID');
  if (!FINGERPRINT_PATTERN.test(input.projectUserFingerprint)) {
    throw new Error('Invalid device wipe project user fingerprint');
  }
  if (!FINGERPRINT_PATTERN.test(input.bindingIdentityHmac)) {
    throw new Error('Invalid device wipe binding identity HMAC');
  }
  if (!Number.isSafeInteger(input.bindingRevision) || input.bindingRevision <= 0) {
    throw new Error('Invalid device wipe binding revision');
  }
  if (input.scope === 'session' && (!input.sessionId || !UUID_PATTERN.test(input.sessionId))) {
    throw new Error('A valid session ID is required for a session device wipe mandate');
  }
  if (input.scope === 'account' && input.sessionId !== null) {
    throw new Error('An account device wipe mandate cannot include a session ID');
  }

  return {
    version: 1,
    deletionID: { rawValue: input.deletionId },
    projectID: input.projectId,
    projectUserFingerprint: input.projectUserFingerprint,
    bindingIdentityHMAC: input.bindingIdentityHmac,
    bindingRevision: input.bindingRevision,
    scope: input.scope === 'account'
      ? { kind: 'account' }
      : { kind: 'session', sessionID: { rawValue: input.sessionId! } },
  };
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right, 'en'))
        .map(([key, nested]) => [key, sortJson(nested)]),
    );
  }
  return value;
}

export function canonicalDeviceWipeJson(value: unknown): Buffer {
  return Buffer.from(JSON.stringify(sortJson(value)), 'utf8');
}

export function canonicalDeviceWipeSigningPayload(
  keyId: string,
  command: DeviceWipeCommand,
): Buffer {
  return canonicalDeviceWipeJson({ version: 1, keyID: keyId, command });
}

export function generateDeviceWipeSigningKey(): DeviceWipeSigningKeyPair {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return {
    keyId: `dwk_${Date.now().toString(36)}_${randomBytes(6).toString('base64url')}`,
    publicJwk: publicKey.export({ format: 'jwk' }),
    privateJwk: privateKey.export({ format: 'jwk' }),
  };
}

export function signDeviceWipeCommand(input: {
  keyId: string;
  command: DeviceWipeCommand;
  privateJwk: NodeJsonWebKey;
}): string {
  const key = createPrivateKey({ key: input.privateJwk, format: 'jwk' });
  return sign(null, canonicalDeviceWipeSigningPayload(input.keyId, input.command), key).toString('base64url');
}

export function verifyDeviceWipeSignature(input: {
  keyId: string;
  command: DeviceWipeCommand;
  signature: string;
  publicJwk: NodeJsonWebKey;
}): boolean {
  try {
    const key = createPublicKey({ key: input.publicJwk, format: 'jwk' });
    return verify(
      null,
      canonicalDeviceWipeSigningPayload(input.keyId, input.command),
      key,
      Buffer.from(input.signature, 'base64url'),
    );
  } catch {
    return false;
  }
}
