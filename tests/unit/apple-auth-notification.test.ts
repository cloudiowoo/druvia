import { generateKeyPair, SignJWT, type CryptoKey } from 'jose';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  AppleNotificationError,
  createAppleNotificationVerifier,
} from '../../apps/api/src/adapters/auth/apple-notification-verifier.js';

let privateKey: CryptoKey;
let publicKey: CryptoKey;

beforeAll(async () => {
  const keys = await generateKeyPair('RS256');
  privateKey = keys.privateKey;
  publicKey = keys.publicKey;
});

async function signNotification(
  event: Record<string, unknown>,
  overrides: Record<string, unknown> = {},
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({
    events: JSON.stringify(event),
    ...overrides,
  })
    .setProtectedHeader({ alg: 'RS256', kid: 'apple-notification-key' })
    .setIssuer('https://appleid.apple.com')
    .setAudience('com.example.pitchetch')
    .setJti('notification-123')
    .setIssuedAt(now)
    .sign(privateKey);
}

describe('Apple server notification verifier', () => {
  it('verifies and normalizes a consent-revoked event without retaining raw JWS or email', async () => {
    const verifier = createAppleNotificationVerifier({ key: publicKey });
    const notification = await verifier.verify(await signNotification({
      type: 'consent-revoked',
      sub: 'external-apple-subject',
      email: 'private@example.com',
      event_time: Date.now(),
    }), { audience: 'com.example.pitchetch' });

    expect(notification).toEqual({
      issuer: 'https://appleid.apple.com',
      audience: 'com.example.pitchetch',
      eventId: 'notification-123',
      eventType: 'consent-revoked',
      subject: 'external-apple-subject',
      occurredAt: expect.any(Date),
    });
    expect(notification).not.toHaveProperty('email');
    expect(notification).not.toHaveProperty('payload');
  });

  it.each([
    ['wrong audience', { audience: 'com.other.app', algorithm: 'RS256' }],
    ['unapproved algorithm', { audience: 'com.example.pitchetch', algorithm: 'HS256' }],
    ['unknown event', { audience: 'com.example.pitchetch', algorithm: 'RS256', type: 'unknown' }],
  ])('rejects %s', async (_label, options) => {
    const verifier = createAppleNotificationVerifier({ key: publicKey });
    let token: string;
    if (options.algorithm === 'HS256') {
      token = await new SignJWT({
        events: JSON.stringify({ type: 'consent-revoked', sub: 'subject', event_time: Date.now() }),
      })
        .setProtectedHeader({ alg: 'HS256' })
        .setIssuer('https://appleid.apple.com')
        .setAudience(options.audience)
        .setJti('notification-bad')
        .setIssuedAt()
        .sign(new TextEncoder().encode('a-secret-key-at-least-32-characters'));
    } else {
      token = await signNotification({
        type: options.type ?? 'consent-revoked',
        sub: 'subject',
        event_time: Date.now(),
      });
    }

    await expect(verifier.verify(token, { audience: options.audience }))
      .rejects.toBeInstanceOf(AppleNotificationError);
  });
});
