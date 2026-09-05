import type { FastifyReply, FastifyRequest } from 'fastify';
import { isPlatformUser, isProjectUser } from '../../middleware/auth.js';
import { checkProjectAccess } from '../../lib/access.js';
import { assertProjectCapability, AuthorizationError } from '../../lib/project-authorization.js';
import {
  ProjectAuthError,
  appleLogin as appleLoginService,
  issueTrustedProjectSession as issueTrustedProjectSessionService,
  logoutProjectUser,
  providerLogin as providerLoginService,
  providerSilentLogin as providerSilentLoginService,
  refreshProjectSession,
  wechatLogin as wechatLoginService,
  wechatSilentLogin as wechatSilentLoginService,
} from './project-auth.service.js';
import { validateTrustedBackendKey } from '../trusted-backend-keys/trusted-backend-keys.service.js';
import {
  acknowledgeAppleLifecycleEvent,
  listPendingAppleLifecycleEvents,
  processAppleNotification,
  revokeAppleProjectUser,
} from './apple-lifecycle.service.js';
import { listProjectAuthIdentities } from './project-identity.repository.js';

type ProjectParams = {
  projectId: string;
};

type ProviderParams = ProjectParams & {
  provider: string;
};

type WechatLoginBody = {
  code?: string;
  userInfo?: {
    nickName?: string;
    avatarUrl?: string;
  };
};

type AppleLoginBody = {
  authorizationCode?: string;
  identityToken?: string;
  rawNonce?: string;
  profile?: {
    givenName?: string;
    familyName?: string;
  };
};

type RefreshBody = {
  refresh_token?: string;
};

type TrustedIssueSessionBody = {
  userId?: string;
};

function sendProjectAuthError(reply: FastifyReply, error: unknown) {
  if (error instanceof ProjectAuthError) {
    return reply.status(error.statusCode).send({
      success: false,
      error: {
        code: error.code,
        message: error.message,
      },
    });
  }

  throw error;
}

function utf8Length(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

function sanitizeAppleName(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const sanitized = value.replace(/[\u0000-\u001f\u007f-\u009f]/g, '').trim();
  if (!sanitized) return undefined;
  if ([...sanitized].length > 100) {
    throw new ProjectAuthError('INVALID_INPUT', 'Apple profile name is too long', 400);
  }
  return sanitized;
}

export async function appleLogin(
  request: FastifyRequest<{ Params: ProjectParams; Body: AppleLoginBody }>,
  reply: FastifyReply,
) {
  const { authorizationCode, identityToken, rawNonce } = request.body ?? {};
  if (
    typeof authorizationCode !== 'string'
    || !authorizationCode.trim()
    || utf8Length(authorizationCode) > 4_096
    || typeof identityToken !== 'string'
    || !identityToken.trim()
    || utf8Length(identityToken) > 16_384
    || typeof rawNonce !== 'string'
    || !/^[A-Za-z0-9_-]{43,256}$/.test(rawNonce)
  ) {
    return reply.status(400).send({
      success: false,
      error: { code: 'INVALID_INPUT', message: 'Invalid Apple native credential' },
    });
  }

  try {
    const givenName = sanitizeAppleName(request.body.profile?.givenName);
    const familyName = sanitizeAppleName(request.body.profile?.familyName);
    const profile = givenName || familyName ? { givenName, familyName } : undefined;
    const session = await appleLoginService(request.params.projectId, {
      authorizationCode,
      identityToken,
      rawNonce,
      profile,
    });
    return reply.send({ success: true, data: session });
  } catch (error) {
    return sendProjectAuthError(reply, error);
  }
}

export async function appleRevoke(
  request: FastifyRequest<{ Params: ProjectParams }>,
  reply: FastifyReply,
) {
  if (
    !request.user
    || !isProjectUser(request.user)
    || request.user.projectId !== request.params.projectId
    || request.user.provider !== 'apple'
  ) {
    return reply.status(403).send({
      success: false,
      error: { code: 'FORBIDDEN', message: 'Apple project user authentication required' },
    });
  }
  try {
    await revokeAppleProjectUser(request.params.projectId, request.user.sub);
    return reply.send({ success: true, data: { revoked: true } });
  } catch (error) {
    return sendProjectAuthError(reply, error);
  }
}

export async function retryAppleRevoke(
  request: FastifyRequest<{ Params: ProjectParams & { identityId: string } }>,
  reply: FastifyReply,
) {
  if (!request.user || !isPlatformUser(request.user)) {
    return reply.status(401).send({
      success: false,
      error: { code: 'UNAUTHORIZED', message: 'Platform authentication required' },
    });
  }
  try {
    await assertProjectCapability(request.user, request.params.projectId, 'auth:manage');
  } catch (error) {
    if (!(error instanceof AuthorizationError)) throw error;
    return reply.status(error.statusCode).send({
      success: false,
      error: { code: error.code, message: error.message },
    });
  }
  const identityId = Number(request.params.identityId);
  if (!Number.isSafeInteger(identityId) || identityId < 1) {
    return reply.status(400).send({
      success: false,
      error: { code: 'INVALID_INPUT', message: 'Invalid identity ID' },
    });
  }

  const client = await import('../../db/index.js').then(({ pool }) => pool.connect());
  let projectUserId: string | undefined;
  try {
    const result = await client.query<{ project_user_id: string }>(
      `SELECT project_user_id FROM druvia_project_auth_identities
       WHERE id = $1 AND project_id = $2 AND provider = 'apple'`,
      [identityId, request.params.projectId],
    );
    projectUserId = result.rows[0]?.project_user_id;
  } finally {
    client.release();
  }
  if (!projectUserId) {
    return reply.status(404).send({
      success: false,
      error: { code: 'NOT_FOUND', message: 'Apple identity not found' },
    });
  }
  try {
    await revokeAppleProjectUser(request.params.projectId, projectUserId);
    return reply.send({ success: true, data: { revoked: true } });
  } catch (error) {
    return sendProjectAuthError(reply, error);
  }
}

export async function appleNotification(
  request: FastifyRequest<{ Params: ProjectParams; Body: { payload?: string } }>,
  reply: FastifyReply,
) {
  if (
    typeof request.body?.payload !== 'string'
    || request.body.payload.length < 16
    || Buffer.byteLength(request.body.payload, 'utf8') > 64 * 1024
  ) {
    return reply.status(400).send({
      success: false,
      error: { code: 'INVALID_INPUT', message: 'Invalid notification payload' },
    });
  }
  try {
    const result = await processAppleNotification(request.params.projectId, request.body.payload);
    return reply.send({ success: true, data: result });
  } catch (error) {
    return sendProjectAuthError(reply, error);
  }
}

async function requirePlatformProjectAccess(
  request: FastifyRequest<{ Params: ProjectParams }>,
  reply: FastifyReply,
): Promise<boolean> {
  if (!request.user || !isPlatformUser(request.user)) {
    reply.status(401).send({
      success: false,
      error: { code: 'UNAUTHORIZED', message: 'Platform authentication required' },
    });
    return false;
  }
  try {
    await assertProjectCapability(request.user, request.params.projectId, 'auth:manage');
  } catch (error) {
    if (!(error instanceof AuthorizationError)) throw error;
    reply.status(error.statusCode).send({
      success: false,
      error: { code: error.code, message: error.message },
    });
    return false;
  }
  return true;
}

async function requireAppleLifecycleAccess(
  request: FastifyRequest<{ Params: ProjectParams }>,
  reply: FastifyReply,
): Promise<boolean> {
  if (request.user && isPlatformUser(request.user)) {
    return requirePlatformProjectAccess(request, reply);
  }
  const header = request.headers['x-druvia-trusted-backend-key'];
  const trustedBackendKey = Array.isArray(header) ? header[0] : header;
  if (!trustedBackendKey) {
    reply.status(401).send({
      success: false,
      error: { code: 'UNAUTHORIZED', message: 'Platform or trusted backend authentication required' },
    });
    return false;
  }
  const validation = await validateTrustedBackendKey(trustedBackendKey, {
    requiredScope: 'project_auth_lifecycle:manage',
    requiredProjectId: request.params.projectId,
  });
  if (!validation.valid) {
    reply.status(validation.reason === 'project_mismatch' ? 403 : 401).send({
      success: false,
      error: {
        code: validation.reason === 'scope_missing' ? 'TRUSTED_SCOPE_REQUIRED' : 'UNAUTHORIZED',
        message: 'Trusted backend key cannot manage this project lifecycle',
      },
    });
    return false;
  }
  return true;
}

export async function listAppleLifecycleEvents(
  request: FastifyRequest<{
    Params: ProjectParams;
    Querystring: { limit?: string; cursor?: string; status?: string };
  }>,
  reply: FastifyReply,
) {
  if (!(await requireAppleLifecycleAccess(request, reply))) return;
  const limit = request.query?.limit === undefined ? 100 : Number(request.query.limit);
  if (
    !Number.isSafeInteger(limit)
    || limit < 1
    || limit > 100
    || (request.query?.status !== undefined && request.query.status !== 'application_action_pending')
  ) {
    return reply.status(400).send({
      success: false,
      error: { code: 'INVALID_INPUT', message: 'Invalid lifecycle query' },
    });
  }
  try {
    const events = await listPendingAppleLifecycleEvents(request.params.projectId, {
      limit,
      cursor: request.query?.cursor,
    });
    return reply.send({ success: true, data: events });
  } catch (error) {
    return sendProjectAuthError(reply, error);
  }
}

export async function listAppleIdentities(
  request: FastifyRequest<{ Params: ProjectParams }>,
  reply: FastifyReply,
) {
  if (!(await requirePlatformProjectAccess(request, reply))) return;
  const identities = await listProjectAuthIdentities(request.params.projectId);
  return reply.send({ success: true, data: identities });
}

export async function acknowledgeAppleLifecycle(
  request: FastifyRequest<{ Params: ProjectParams & { eventId: string } }>,
  reply: FastifyReply,
) {
  if (!(await requireAppleLifecycleAccess(request, reply))) return;
  const eventId = Number(request.params.eventId);
  if (!Number.isSafeInteger(eventId) || eventId < 1) {
    return reply.status(400).send({
      success: false,
      error: { code: 'INVALID_INPUT', message: 'Invalid event ID' },
    });
  }
  try {
    await acknowledgeAppleLifecycleEvent(request.params.projectId, eventId);
    return reply.send({ success: true, data: { acknowledged: true } });
  } catch (error) {
    return sendProjectAuthError(reply, error);
  }
}

export async function wechatLogin(
  request: FastifyRequest<{ Params: ProjectParams; Body: WechatLoginBody }>,
  reply: FastifyReply
) {
  if (!request.body.code) {
    return reply.status(400).send({
      success: false,
      error: { code: 'INVALID_INPUT', message: 'code is required' },
    });
  }

  try {
    const session = await wechatLoginService(request.params.projectId, {
      code: request.body.code,
      userInfo: request.body.userInfo,
    });
    return reply.send({ success: true, data: session });
  } catch (error) {
    return sendProjectAuthError(reply, error);
  }
}

export async function providerLogin(
  request: FastifyRequest<{ Params: ProviderParams; Body: WechatLoginBody }>,
  reply: FastifyReply
) {
  if (!request.body.code) {
    return reply.status(400).send({
      success: false,
      error: { code: 'INVALID_INPUT', message: 'code is required' },
    });
  }

  try {
    const session = await providerLoginService(request.params.projectId, request.params.provider, {
      code: request.body.code,
      userInfo: request.body.userInfo,
    });
    return reply.send({ success: true, data: session });
  } catch (error) {
    return sendProjectAuthError(reply, error);
  }
}

export async function wechatSilentLogin(
  request: FastifyRequest<{ Params: ProjectParams; Body: { code?: string } }>,
  reply: FastifyReply
) {
  if (!request.body.code) {
    return reply.status(400).send({
      success: false,
      error: { code: 'INVALID_INPUT', message: 'code is required' },
    });
  }

  try {
    const session = await wechatSilentLoginService(request.params.projectId, { code: request.body.code });
    return reply.send({ success: true, data: session });
  } catch (error) {
    return sendProjectAuthError(reply, error);
  }
}

export async function providerSilentLogin(
  request: FastifyRequest<{ Params: ProviderParams; Body: { code?: string } }>,
  reply: FastifyReply
) {
  if (request.params.provider === 'apple') {
    return reply.status(400).send({
      success: false,
      error: {
        code: 'PROVIDER_FLOW_UNSUPPORTED',
        message: 'Apple silent login is not supported',
      },
    });
  }
  if (!request.body.code) {
    return reply.status(400).send({
      success: false,
      error: { code: 'INVALID_INPUT', message: 'code is required' },
    });
  }

  try {
    const session = await providerSilentLoginService(request.params.projectId, request.params.provider, {
      code: request.body.code,
    });
    return reply.send({ success: true, data: session });
  } catch (error) {
    return sendProjectAuthError(reply, error);
  }
}

export async function refresh(
  request: FastifyRequest<{ Params: ProjectParams; Body: RefreshBody }>,
  reply: FastifyReply
) {
  if (!request.body.refresh_token) {
    return reply.status(400).send({
      success: false,
      error: { code: 'INVALID_INPUT', message: 'refresh_token is required' },
    });
  }

  try {
    const session = await refreshProjectSession(request.params.projectId, request.body.refresh_token);
    return reply.send({ success: true, data: session });
  } catch (error) {
    return sendProjectAuthError(reply, error);
  }
}

export async function issueTrustedSession(
  request: FastifyRequest<{ Params: ProjectParams; Body: TrustedIssueSessionBody }>,
  reply: FastifyReply
) {
  const trustedBackendKey = request.headers['x-druvia-trusted-backend-key'];
  const rawTrustedBackendKey = Array.isArray(trustedBackendKey)
    ? trustedBackendKey[0]
    : trustedBackendKey;

  if (!rawTrustedBackendKey) {
    return reply.status(401).send({
      success: false,
      error: { code: 'UNAUTHORIZED', message: 'Trusted backend key required' },
    });
  }

  if (!request.body?.userId) {
    return reply.status(400).send({
      success: false,
      error: { code: 'INVALID_INPUT', message: 'userId is required' },
    });
  }

  const validation = await validateTrustedBackendKey(rawTrustedBackendKey, {
    requiredScope: 'project_session:issue',
    requiredProjectId: request.params.projectId,
  });
  if (!validation.valid) {
    const statusCode = validation.reason === 'invalid' ? 401 : 403;
    const errorCode = validation.reason === 'invalid' ? 'UNAUTHORIZED' : 'FORBIDDEN';
    const message = validation.reason === 'scope_missing'
      ? 'Trusted backend key is missing required scope'
      : validation.reason === 'project_mismatch'
        ? 'No access to this project'
        : 'Invalid trusted backend key';

    return reply.status(statusCode).send({
      success: false,
      error: { code: errorCode, message },
    });
  }

  try {
    const session = await issueTrustedProjectSessionService(request.params.projectId, request.body.userId);
    request.log.info({
      projectId: request.params.projectId,
      trustedKeyPrefix: validation.keyPrefix,
      issuerScope: 'project_session:issue',
      projectUserId: request.body.userId,
      issuedAt: new Date().toISOString(),
      sourceIp: request.ip,
      userAgent: request.headers['user-agent'] ?? null,
    }, 'trusted project session issued');
    return reply.send({ success: true, data: session });
  } catch (error) {
    return sendProjectAuthError(reply, error);
  }
}

export async function logout(
  request: FastifyRequest<{ Params: ProjectParams }>,
  reply: FastifyReply
) {
  if (!request.user || !isProjectUser(request.user)) {
    return reply.status(403).send({
      success: false,
      error: { code: 'FORBIDDEN', message: 'Project user authentication required' },
    });
  }

  if (request.user.projectId !== request.params.projectId) {
    return reply.status(403).send({
      success: false,
      error: { code: 'FORBIDDEN', message: 'No access to this project' },
    });
  }

  await logoutProjectUser(request.params.projectId, request.user.sub);

  return reply.send({
    success: true,
    data: { loggedOut: true },
  });
}
