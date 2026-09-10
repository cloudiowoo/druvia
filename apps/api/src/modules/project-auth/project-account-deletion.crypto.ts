import { createHmac, timingSafeEqual } from 'node:crypto';

const VERSION = 'v1';

interface DeletionCredentialInput {
  secret: string;
  projectId: string;
  deletionId: string;
}

function hmacBase64Url(secret: string, domain: string, values: string[]): string {
  if (Buffer.byteLength(secret, 'utf8') < 32) {
    throw new Error(`${domain} secret must contain at least 32 UTF-8 bytes`);
  }

  return createHmac('sha256', secret)
    .update([VERSION, domain, ...values].join('\0'))
    .digest('base64url');
}

export function deriveAccountDeletionStatusToken(input: DeletionCredentialInput): string {
  return hmacBase64Url(input.secret, 'account-deletion-status', [input.projectId, input.deletionId]);
}

export function deriveAccountDeletionReauthNonce(input: DeletionCredentialInput): string {
  return hmacBase64Url(input.secret, 'account-deletion-reauth', [input.projectId, input.deletionId]);
}

export function verifyAccountDeletionStatusToken(
  input: DeletionCredentialInput & { token: string },
): boolean {
  const expected = deriveAccountDeletionStatusToken(input);
  const expectedBuffer = Buffer.from(expected, 'utf8');
  const actualBuffer = Buffer.from(input.token, 'utf8');
  return expectedBuffer.length === actualBuffer.length
    && timingSafeEqual(expectedBuffer, actualBuffer);
}

export function fingerprintAccountDeletionSubject(input: {
  secret: string;
  projectId: string;
  provider: string;
  issuer: string;
  subject: string;
}): string {
  if (Buffer.byteLength(input.secret, 'utf8') < 32) {
    throw new Error('account deletion fence secret must contain at least 32 UTF-8 bytes');
  }

  return createHmac('sha256', input.secret)
    .update([
      VERSION,
      'account-deletion-fence',
      input.projectId,
      input.provider,
      input.issuer,
      input.subject,
    ].join('\0'))
    .digest('hex');
}
