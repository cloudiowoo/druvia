import type { FastifyRequest, FastifyReply } from 'fastify';
import type { JwtPayload } from '../../middleware/auth.js';
import * as oauthService from './oauth.service.js';

interface OAuthParams {
  tenantId: string;
  provider: string;
}

interface AuthUrlQuery {
  redirectUri: string;
  state?: string;
}

interface CallbackBody {
  code: string;
  state?: string;
}

interface BindBody {
  code: string;
}

// Get OAuth authorization URL
export async function getAuthUrl(
  request: FastifyRequest<{ Params: OAuthParams; Querystring: AuthUrlQuery }>,
  reply: FastifyReply
) {
  const { tenantId, provider } = request.params;
  const { redirectUri, state } = request.query;

  if (!redirectUri) {
    return reply.status(400).send({
      success: false,
      error: { code: 'INVALID_INPUT', message: 'redirectUri is required' },
    });
  }

  try {
    const url = await oauthService.getAuthUrl(tenantId, provider, redirectUri, state);
    return reply.send({ success: true, data: { url } });
  } catch (error) {
    const err = error as Error;
    return reply.status(400).send({
      success: false,
      error: { code: 'AUTH_ERROR', message: err.message },
    });
  }
}

// Handle OAuth callback
export async function handleCallback(
  request: FastifyRequest<{ Params: OAuthParams; Body: CallbackBody }>,
  reply: FastifyReply
) {
  const { tenantId, provider } = request.params;
  const { code, state } = request.body;

  if (!code) {
    return reply.status(400).send({
      success: false,
      error: { code: 'INVALID_INPUT', message: 'code is required' },
    });
  }

  try {
    const result = await oauthService.handleOAuthCallback(tenantId, provider, code, state);
    return reply.send({ success: true, data: result });
  } catch (error) {
    const err = error as Error;
    return reply.status(401).send({
      success: false,
      error: { code: 'AUTH_FAILED', message: err.message },
    });
  }
}

// Bind OAuth provider to current user
export async function bindProvider(
  request: FastifyRequest<{ Params: OAuthParams; Body: BindBody }>,
  reply: FastifyReply
) {
  if (!request.user) {
    return reply.status(401).send({
      success: false,
      error: { code: 'UNAUTHORIZED', message: 'Not authenticated' },
    });
  }

  const { tenantId, provider } = request.params;
  const { code } = request.body;

  if (!code) {
    return reply.status(400).send({
      success: false,
      error: { code: 'INVALID_INPUT', message: 'code is required' },
    });
  }

  try {
    await oauthService.bindOAuthProvider((request.user as JwtPayload).userId, tenantId, provider, code);
    return reply.send({ success: true, message: 'Provider bound successfully' });
  } catch (error) {
    const err = error as Error;
    return reply.status(400).send({
      success: false,
      error: { code: 'BIND_FAILED', message: err.message },
    });
  }
}

// List user's bound providers
export async function listProviders(
  request: FastifyRequest,
  reply: FastifyReply
) {
  if (!request.user) {
    return reply.status(401).send({
      success: false,
      error: { code: 'UNAUTHORIZED', message: 'Not authenticated' },
    });
  }

  const providers = await oauthService.listUserProviders((request.user as JwtPayload).userId);
  return reply.send({ success: true, data: providers });
}

// Unbind provider from user
export async function unbindProvider(
  request: FastifyRequest<{ Params: { provider: string } }>,
  reply: FastifyReply
) {
  if (!request.user) {
    return reply.status(401).send({
      success: false,
      error: { code: 'UNAUTHORIZED', message: 'Not authenticated' },
    });
  }

  const unbound = await oauthService.unbindProvider((request.user as JwtPayload).userId, request.params.provider);

  if (!unbound) {
    return reply.status(404).send({
      success: false,
      error: { code: 'NOT_FOUND', message: 'Provider not bound' },
    });
  }

  return reply.send({ success: true, message: 'Provider unbound successfully' });
}
