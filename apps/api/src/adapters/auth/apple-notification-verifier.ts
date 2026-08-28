import {
  createRemoteJWKSet,
  jwtVerify,
  type CryptoKey,
  type JWTVerifyGetKey,
} from 'jose';
import { APPLE_ISSUER, APPLE_JWKS_URL } from './apple-token-verifier.js';

const EVENT_TYPES = [
  'email-enabled',
  'email-disabled',
  'consent-revoked',
  'account-deleted',
] as const;

export type AppleNotificationEventType = typeof EVENT_TYPES[number];

export interface AppleNotification {
  issuer: string;
  audience: string;
  eventId: string;
  eventType: AppleNotificationEventType;
  subject: string;
  occurredAt: Date;
}

export class AppleNotificationError extends Error {
  readonly code = 'PROVIDER_NOTIFICATION_INVALID';

  constructor() {
    super('Invalid Apple server notification');
    this.name = 'AppleNotificationError';
  }
}

export interface AppleNotificationVerifier {
  verify(payload: string, input: { audience: string }): Promise<AppleNotification>;
}

type VerificationKey = CryptoKey | Uint8Array | JWTVerifyGetKey;

function parseOccurredAt(value: unknown): Date | null {
  const numeric = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return null;
  const date = new Date(numeric > 10_000_000_000 ? numeric : numeric * 1000);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function createAppleNotificationVerifier(input: {
  key: VerificationKey;
  now?: () => Date;
}): AppleNotificationVerifier {
  return {
    async verify(token, expected) {
      try {
        const now = input.now?.() ?? new Date();
        const { payload } = await jwtVerify(token, input.key, {
          algorithms: ['RS256'],
          issuer: APPLE_ISSUER,
          audience: expected.audience,
          clockTolerance: 60,
          maxTokenAge: '10m',
          currentDate: now,
        });
        if (
          typeof payload.jti !== 'string'
          || typeof payload.events !== 'string'
          || typeof payload.iat !== 'number'
          || payload.iat > Math.floor(now.getTime() / 1000) + 60
        ) {
          throw new AppleNotificationError();
        }
        const event = JSON.parse(payload.events) as Record<string, unknown>;
        const eventType = typeof event.type === 'string' ? event.type : '';
        const subject = typeof event.sub === 'string' ? event.sub : '';
        const occurredAt = parseOccurredAt(event.event_time);
        if (!EVENT_TYPES.includes(eventType as AppleNotificationEventType) || !subject || !occurredAt) {
          throw new AppleNotificationError();
        }
        if (occurredAt.getTime() > now.getTime() + 60_000) {
          throw new AppleNotificationError();
        }
        return {
          issuer: APPLE_ISSUER,
          audience: expected.audience,
          eventId: payload.jti,
          eventType: eventType as AppleNotificationEventType,
          subject,
          occurredAt,
        };
      } catch (error) {
        if (error instanceof AppleNotificationError) throw error;
        throw new AppleNotificationError();
      }
    },
  };
}

export function createRemoteAppleNotificationVerifier(): AppleNotificationVerifier {
  const remoteKeySet = createRemoteJWKSet(new URL(APPLE_JWKS_URL), {
    timeoutDuration: 5_000,
    cooldownDuration: 30_000,
    cacheMaxAge: 10 * 60_000,
  });
  return createAppleNotificationVerifier({ key: remoteKeySet });
}
