import { importPKCS8, SignJWT } from 'jose';

const APPLE_ISSUER = 'https://appleid.apple.com';

export interface AppleClientSecretInput {
  teamId: string;
  keyId: string;
  audience: string;
  privateKeyPem: string;
  now?: Date;
}

export async function createAppleClientSecret(input: AppleClientSecretInput): Promise<string> {
  const now = Math.floor((input.now ?? new Date()).getTime() / 1000);
  const privateKey = await importPKCS8(input.privateKeyPem, 'ES256');

  return new SignJWT({})
    .setProtectedHeader({ alg: 'ES256', kid: input.keyId })
    .setIssuer(input.teamId)
    .setSubject(input.audience)
    .setAudience(APPLE_ISSUER)
    .setIssuedAt(now - 60)
    .setExpirationTime(now + 300)
    .sign(privateKey);
}
