import type {
  AppleAuthAdapter,
  AppleAuthenticationResult,
  AppleConfig,
  AppleNativeCredential,
} from './interface.js';
import { createAppleClientSecret } from './apple-client-secret.js';
import {
  APPLE_ISSUER,
  createRemoteAppleTokenVerifier,
  hashAppleNonce,
  readUnverifiedAppleAudience,
  type AppleTokenVerifier,
  type AppleVerifiedIdentity,
} from './apple-token-verifier.js';

const APPLE_TOKEN_ENDPOINT = 'https://appleid.apple.com/auth/token';
const APPLE_REVOKE_ENDPOINT = 'https://appleid.apple.com/auth/revoke';
const REQUEST_TIMEOUT_MS = 5_000;

export type AppleAdapterErrorReason =
  | 'credential_invalid'
  | 'identity_mismatch'
  | 'rate_limited'
  | 'refresh_invalid'
  | 'upstream_unavailable'
  | 'configuration_invalid';

export class AppleAdapterError extends Error {
  constructor(
    public readonly reason: AppleAdapterErrorReason,
    public readonly retryable: boolean,
    public readonly upstreamStatus?: number,
  ) {
    super(`Apple authentication failed: ${reason}`);
    this.name = 'AppleAdapterError';
  }
}

interface AppleTokenResponse {
  access_token?: string;
  expires_in?: number;
  id_token?: string;
  refresh_token?: string;
  token_type?: string;
  error?: string;
}

export interface AppleAuthAdapterDependencies {
  fetch?: typeof fetch;
  tokenVerifier?: AppleTokenVerifier;
  now?: () => Date;
}

function assertAudience(config: AppleConfig, audience: string | undefined): string {
  if (!audience || !config.allowedAudiences.includes(audience)) {
    throw new AppleAdapterError('credential_invalid', false);
  }
  return audience;
}

function identitiesMatch(left: AppleVerifiedIdentity, right: AppleVerifiedIdentity): boolean {
  return left.issuer === right.issuer
    && left.audience === right.audience
    && left.subject === right.subject
    && left.nonce === right.nonce;
}

function getNickname(profile: AppleNativeCredential['profile']): string | undefined {
  const values = [profile?.givenName, profile?.familyName]
    .map((value) => value?.trim())
    .filter((value): value is string => Boolean(value));
  return values.length ? values.join(' ') : undefined;
}

function mapUpstreamError(
  status: number,
  providerError?: string,
  operation: 'authenticate' | 'refresh' | 'revoke' = 'authenticate',
): AppleAdapterError {
  if (status === 429) {
    return new AppleAdapterError('rate_limited', true, status);
  }
  if (status >= 500) {
    return new AppleAdapterError('upstream_unavailable', true, status);
  }
  if (providerError === 'invalid_client') {
    return new AppleAdapterError('configuration_invalid', false, status);
  }
  if (operation === 'refresh' && providerError === 'invalid_grant') {
    return new AppleAdapterError('refresh_invalid', false, status);
  }
  return new AppleAdapterError('credential_invalid', false, status);
}

async function parseTokenResponse(
  response: Response,
  operation: 'authenticate' | 'refresh' = 'authenticate',
): Promise<AppleTokenResponse> {
  let data: AppleTokenResponse = {};
  try {
    data = await response.json() as AppleTokenResponse;
  } catch {
    if (response.ok) {
      throw new AppleAdapterError('upstream_unavailable', true, response.status);
    }
  }
  if (!response.ok || data.error) {
    throw mapUpstreamError(response.status, data.error, operation);
  }
  return data;
}

export function createAppleAuthAdapter(
  config: AppleConfig,
  dependencies: AppleAuthAdapterDependencies = {},
): AppleAuthAdapter {
  const fetchImpl = dependencies.fetch ?? fetch;
  const tokenVerifier = dependencies.tokenVerifier ?? createRemoteAppleTokenVerifier();

  async function createClientSecret(audience: string): Promise<string> {
    try {
      return await createAppleClientSecret({
        teamId: config.teamId,
        keyId: config.keyId,
        audience,
        privateKeyPem: config.privateKeyPem,
        now: dependencies.now?.(),
      });
    } catch {
      throw new AppleAdapterError('configuration_invalid', false);
    }
  }

  async function postForm(endpoint: string, body: URLSearchParams): Promise<Response> {
    try {
      return await fetchImpl(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch {
      throw new AppleAdapterError('upstream_unavailable', true);
    }
  }

  async function verifyToken(
    token: string,
    input: { audience: string; nonceHash?: string; expectedSubject?: string },
  ): Promise<AppleVerifiedIdentity> {
    try {
      return await tokenVerifier.verify(token, input);
    } catch (error) {
      if (error instanceof AppleAdapterError) throw error;
      throw new AppleAdapterError('credential_invalid', false);
    }
  }

  return {
    provider: 'apple',

    async authenticateNative(credential): Promise<AppleAuthenticationResult> {
      const audience = assertAudience(config, readUnverifiedAppleAudience(credential.identityToken));
      const nonceHash = hashAppleNonce(credential.rawNonce);
      const requestIdentity = await verifyToken(credential.identityToken, { audience, nonceHash });
      const clientSecret = await createClientSecret(audience);
      const response = await postForm(APPLE_TOKEN_ENDPOINT, new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: audience,
        client_secret: clientSecret,
        code: credential.authorizationCode,
      }));
      const tokenData = await parseTokenResponse(response);
      if (!tokenData.id_token || !tokenData.refresh_token) {
        throw new AppleAdapterError('credential_invalid', false, response.status);
      }
      const responseIdentity = await verifyToken(tokenData.id_token, { audience, nonceHash });
      if (!identitiesMatch(requestIdentity, responseIdentity)) {
        throw new AppleAdapterError('identity_mismatch', false);
      }

      return {
        user: {
          provider: 'apple',
          providerId: requestIdentity.subject,
          email: requestIdentity.email,
          nickname: getNickname(credential.profile),
        },
        providerSession: {
          audience,
          refreshToken: tokenData.refresh_token,
        },
      };
    },

    async validateRefreshToken(input): Promise<void> {
      const audience = assertAudience(config, input.audience);
      const response = await postForm(APPLE_TOKEN_ENDPOINT, new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: audience,
        client_secret: await createClientSecret(audience),
        refresh_token: input.refreshToken,
      }));
      const tokenData = await parseTokenResponse(response, 'refresh');
      if (!tokenData.id_token) {
        throw new AppleAdapterError('credential_invalid', false, response.status);
      }
      await verifyToken(tokenData.id_token, {
        audience,
        expectedSubject: input.expectedSubject,
      });
    },

    async revoke(input): Promise<void> {
      const audience = assertAudience(config, input.audience);
      const response = await postForm(APPLE_REVOKE_ENDPOINT, new URLSearchParams({
        client_id: audience,
        client_secret: await createClientSecret(audience),
        token: input.refreshToken,
        token_type_hint: 'refresh_token',
      }));
      if (!response.ok) {
        let providerError: string | undefined;
        try {
          providerError = (await response.json() as { error?: string }).error;
        } catch {
          // The response body is deliberately discarded.
        }
        throw mapUpstreamError(response.status, providerError, 'revoke');
      }
    },
  };
}

export { APPLE_ISSUER };
