import { createHash, timingSafeEqual } from 'node:crypto';
import {
  createRemoteJWKSet,
  decodeJwt,
  jwtVerify,
  type JWTVerifyGetKey,
  type CryptoKey,
  type JWTPayload,
} from 'jose';

export const APPLE_ISSUER = 'https://appleid.apple.com';
export const APPLE_JWKS_URL = 'https://appleid.apple.com/auth/keys';

export interface AppleVerifiedIdentity {
  issuer: string;
  audience: string;
  subject: string;
  nonce?: string;
  email?: string;
}

export interface AppleTokenVerifier {
  verify(token: string, input: {
    audience: string;
    nonceHash?: string;
    expectedSubject?: string;
  }): Promise<AppleVerifiedIdentity>;
}

type AppleVerificationKey = CryptoKey | Uint8Array | JWTVerifyGetKey;

function secureStringEqual(actual: string, expected: string): boolean {
  const actualBytes = Buffer.from(actual);
  const expectedBytes = Buffer.from(expected);
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
}

function getAudience(payload: JWTPayload): string | undefined {
  return typeof payload.aud === 'string' ? payload.aud : undefined;
}

export function readUnverifiedAppleAudience(token: string): string | undefined {
  try {
    return getAudience(decodeJwt(token));
  } catch {
    return undefined;
  }
}

export function hashAppleNonce(rawNonce: string): string {
  return createHash('sha256').update(rawNonce).digest('hex');
}

export function createAppleTokenVerifier(input: {
  key: AppleVerificationKey;
  now?: () => Date;
}): AppleTokenVerifier {
  return {
    async verify(token, expected) {
      const now = input.now?.() ?? new Date();
      const { payload } = await jwtVerify(token, input.key, {
        algorithms: ['RS256'],
        issuer: APPLE_ISSUER,
        audience: expected.audience,
        clockTolerance: 60,
        currentDate: now,
      });

      const audience = getAudience(payload);
      if (!payload.sub || !audience || typeof payload.iat !== 'number') {
        throw new Error('Apple identity token is missing required claims');
      }
      if (payload.iat > Math.floor(now.getTime() / 1000) + 60) {
        throw new Error('Apple identity token was issued in the future');
      }
      if (expected.expectedSubject && !secureStringEqual(payload.sub, expected.expectedSubject)) {
        throw new Error('Apple identity token subject mismatch');
      }
      if (expected.nonceHash) {
        if (typeof payload.nonce !== 'string' || !secureStringEqual(payload.nonce, expected.nonceHash)) {
          throw new Error('Apple identity token nonce mismatch');
        }
      }

      const emailVerified = payload.email_verified === true || payload.email_verified === 'true';
      return {
        issuer: APPLE_ISSUER,
        audience,
        subject: payload.sub,
        nonce: typeof payload.nonce === 'string' ? payload.nonce : undefined,
        email: emailVerified && typeof payload.email === 'string' && payload.email.trim()
          ? payload.email.trim()
          : undefined,
      };
    },
  };
}

export function createRemoteAppleTokenVerifier(): AppleTokenVerifier {
  const remoteKeySet = createRemoteJWKSet(new URL(APPLE_JWKS_URL), {
    timeoutDuration: 5_000,
    cooldownDuration: 30_000,
    cacheMaxAge: 10 * 60_000,
  });
  return createAppleTokenVerifier({ key: remoteKeySet });
}
