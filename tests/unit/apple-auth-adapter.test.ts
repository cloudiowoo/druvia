import { createHash } from 'node:crypto';
import {
  decodeProtectedHeader,
  exportPKCS8,
  generateKeyPair,
  jwtVerify,
  SignJWT,
  type CryptoKey,
} from 'jose';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import {
  AppleAdapterError,
  createAppleAuthAdapter,
} from '../../apps/api/src/adapters/auth/apple.adapter.js';
import { createAppleClientSecret } from '../../apps/api/src/adapters/auth/apple-client-secret.js';
import { createAppleTokenVerifier } from '../../apps/api/src/adapters/auth/apple-token-verifier.js';

const APPLE_ISSUER = 'https://appleid.apple.com';
const AUDIENCE = 'com.example.pitchetch';
const RAW_NONCE = 'a'.repeat(43);
const NONCE_HASH = createHash('sha256').update(RAW_NONCE).digest('hex');
const SUBJECT = 'apple-user-123';

let applePrivateKey: CryptoKey;
let applePublicKey: CryptoKey;
let clientPublicKey: CryptoKey;
let clientPrivateKeyPem: string;

beforeAll(async () => {
  const appleKeys = await generateKeyPair('RS256');
  applePrivateKey = appleKeys.privateKey;
  applePublicKey = appleKeys.publicKey;

  const clientKeys = await generateKeyPair('ES256', { extractable: true });
  clientPublicKey = clientKeys.publicKey;
  clientPrivateKeyPem = await exportPKCS8(clientKeys.privateKey);
});

async function signIdentityToken(overrides: Record<string, unknown> = {}): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const subject = typeof overrides.sub === 'string' ? overrides.sub : SUBJECT;
  const audience = typeof overrides.aud === 'string' ? overrides.aud : AUDIENCE;
  const { sub: _sub, aud: _aud, ...customClaims } = overrides;
  return new SignJWT({
    nonce: NONCE_HASH,
    email: 'player@example.com',
    email_verified: 'true',
    ...customClaims,
  })
    .setProtectedHeader({ alg: 'RS256', kid: 'apple-test-key' })
    .setIssuer(APPLE_ISSUER)
    .setAudience(audience)
    .setSubject(subject)
    .setIssuedAt(now)
    .setExpirationTime(now + 300)
    .sign(applePrivateKey);
}

function createAdapter(fetchImpl: typeof fetch) {
  return createAppleAuthAdapter(
    {
      clientId: AUDIENCE,
      teamId: 'TEAMID1234',
      keyId: 'KEYID12345',
      privateKeyPem: clientPrivateKeyPem,
      allowedAudiences: [AUDIENCE],
    },
    {
      fetch: fetchImpl,
      tokenVerifier: createAppleTokenVerifier({ key: applePublicKey }),
    },
  );
}

function createMultiAudienceAdapter(fetchImpl: typeof fetch) {
  return createAppleAuthAdapter(
    {
      clientId: AUDIENCE,
      teamId: 'TEAMID1234',
      keyId: 'KEYID12345',
      privateKeyPem: clientPrivateKeyPem,
      allowedAudiences: [AUDIENCE, 'com.example.pitchetch.web'],
    },
    {
      fetch: fetchImpl,
      tokenVerifier: createAppleTokenVerifier({ key: applePublicKey }),
    },
  );
}

describe('Apple client secret', () => {
  it('uses ES256 and the fixed five-minute Apple claims', async () => {
    const now = new Date('2026-08-28T08:00:00.000Z');
    const secret = await createAppleClientSecret({
      teamId: 'TEAMID1234',
      keyId: 'KEYID12345',
      audience: AUDIENCE,
      privateKeyPem: clientPrivateKeyPem,
      now,
    });

    const header = decodeProtectedHeader(secret);
    expect(header).toMatchObject({ alg: 'ES256', kid: 'KEYID12345' });

    await expect(jwtVerify(secret, clientPublicKey, {
      issuer: 'TEAMID1234',
      audience: APPLE_ISSUER,
      subject: AUDIENCE,
      currentDate: now,
    })).resolves.toBeDefined();

    const [, payload] = secret.split('.');
    const claims = JSON.parse(Buffer.from(payload!, 'base64url').toString('utf8'));
    const nowSeconds = Math.floor(now.getTime() / 1000);
    expect(claims).toMatchObject({
      iss: 'TEAMID1234',
      sub: AUDIENCE,
      aud: APPLE_ISSUER,
      iat: nowSeconds - 60,
      exp: nowSeconds + 300,
    });
  });
});

describe('Apple native adapter', () => {
  it('accepts every configured audience instead of only the primary client ID', async () => {
    const secondaryAudience = 'com.example.pitchetch.web';
    const requestToken = await signIdentityToken({ aud: secondaryAudience });
    const responseToken = await signIdentityToken({ aud: secondaryAudience });
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
      id_token: responseToken,
      refresh_token: 'apple-refresh-token',
    }), { status: 200, headers: { 'content-type': 'application/json' } }));

    const result = await createMultiAudienceAdapter(fetchImpl).authenticateNative({
      authorizationCode: 'one-time-code',
      identityToken: requestToken,
      rawNonce: RAW_NONCE,
    });

    expect(result.providerSession.audience).toBe(secondaryAudience);
    const body = new URLSearchParams(String(fetchImpl.mock.calls[0]![1]?.body));
    expect(body.get('client_id')).toBe(secondaryAudience);
  });
  it('verifies both identity tokens and exchanges the native authorization code', async () => {
    const requestToken = await signIdentityToken();
    const responseToken = await signIdentityToken();
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
      access_token: 'apple-access-token',
      expires_in: 3600,
      id_token: responseToken,
      refresh_token: 'apple-refresh-token',
      token_type: 'Bearer',
    }), { status: 200, headers: { 'content-type': 'application/json' } }));

    const result = await createAdapter(fetchImpl).authenticateNative({
      authorizationCode: 'one-time-code',
      identityToken: requestToken,
      rawNonce: RAW_NONCE,
      profile: { givenName: 'Ada', familyName: 'Lovelace' },
    });

    expect(result).toEqual({
      user: {
        provider: 'apple',
        providerId: SUBJECT,
        email: 'player@example.com',
        nickname: 'Ada Lovelace',
      },
      providerSession: {
        audience: AUDIENCE,
        refreshToken: 'apple-refresh-token',
      },
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe('https://appleid.apple.com/auth/token');
    const body = new URLSearchParams(String(init?.body));
    expect(body.get('grant_type')).toBe('authorization_code');
    expect(body.get('code')).toBe('one-time-code');
    expect(body.get('client_id')).toBe(AUDIENCE);
    expect(body.get('redirect_uri')).toBeNull();
    expect(body.get('client_secret')).toBeTruthy();
  });

  it.each([
    ['an audience outside the allowlist', { aud: 'com.attacker.app' }],
    ['an invalid nonce', { nonce: 'not-the-expected-hash' }],
  ])('rejects %s before code exchange', async (_label, overrides) => {
    const fetchImpl = vi.fn<typeof fetch>();
    const adapter = createAdapter(fetchImpl);

    await expect(adapter.authenticateNative({
      authorizationCode: 'one-time-code',
      identityToken: await signIdentityToken(overrides),
      rawNonce: RAW_NONCE,
    })).rejects.toMatchObject({
      name: 'AppleAdapterError',
      reason: 'credential_invalid',
      retryable: false,
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('rejects a token endpoint identity mismatch without exposing its response body', async () => {
    const requestToken = await signIdentityToken();
    const responseToken = await signIdentityToken({ sub: 'different-user' });
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
      id_token: responseToken,
      refresh_token: 'secret-refresh-token',
      diagnostic: 'must not escape',
    }), { status: 200, headers: { 'content-type': 'application/json' } }));

    const error = await createAdapter(fetchImpl).authenticateNative({
      authorizationCode: 'one-time-code',
      identityToken: requestToken,
      rawNonce: RAW_NONCE,
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(AppleAdapterError);
    expect(error).toMatchObject({ reason: 'identity_mismatch', retryable: false });
    expect(String(error)).not.toContain('secret-refresh-token');
    expect(String(error)).not.toContain('must not escape');
  });

  it('validates an Apple refresh token against the expected subject', async () => {
    const responseToken = await signIdentityToken();
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
      id_token: responseToken,
      access_token: 'short-lived-token',
      expires_in: 3600,
    }), { status: 200, headers: { 'content-type': 'application/json' } }));

    await createAdapter(fetchImpl).validateRefreshToken({
      audience: AUDIENCE,
      refreshToken: 'server-only-refresh-token',
      expectedSubject: SUBJECT,
    });

    const body = new URLSearchParams(String(fetchImpl.mock.calls[0]![1]?.body));
    expect(body.get('grant_type')).toBe('refresh_token');
    expect(body.get('refresh_token')).toBe('server-only-refresh-token');
  });

  it('distinguishes an invalid Apple refresh grant from a temporary upstream failure', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
      error: 'invalid_grant',
      error_description: 'must not escape',
    }), { status: 400, headers: { 'content-type': 'application/json' } }));

    const error = await createAdapter(fetchImpl).validateRefreshToken({
      audience: AUDIENCE,
      refreshToken: 'invalid-server-token',
      expectedSubject: SUBJECT,
    }).catch((caught: unknown) => caught);

    expect(error).toMatchObject({ reason: 'refresh_invalid', retryable: false, upstreamStatus: 400 });
    expect(String(error)).not.toContain('must not escape');
  });

  it('revokes only the supplied server-side token and maps retryable upstream failures', async () => {
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 200 }))
      .mockResolvedValueOnce(new Response('private upstream detail', { status: 503 }));
    const adapter = createAdapter(fetchImpl);

    await adapter.revoke({ audience: AUDIENCE, refreshToken: 'server-only-refresh-token' });
    const firstBody = new URLSearchParams(String(fetchImpl.mock.calls[0]![1]?.body));
    expect(fetchImpl.mock.calls[0]![0]).toBe('https://appleid.apple.com/auth/revoke');
    expect(firstBody.get('token')).toBe('server-only-refresh-token');
    expect(firstBody.get('token_type_hint')).toBe('refresh_token');

    const error = await adapter.revoke({
      audience: AUDIENCE,
      refreshToken: 'another-server-token',
    }).catch((caught: unknown) => caught);
    expect(error).toMatchObject({
      name: 'AppleAdapterError',
      reason: 'upstream_unavailable',
      retryable: true,
      upstreamStatus: 503,
    });
    expect(String(error)).not.toContain('private upstream detail');
  });
});
