import type { FastifyReply, FastifyRequest } from 'fastify';
import { isProjectUser } from '../../middleware/auth.js';
import {
  ProjectAuthError,
  issueTrustedProjectSession as issueTrustedProjectSessionService,
  logoutProjectUser,
  providerLogin as providerLoginService,
  providerSilentLogin as providerSilentLoginService,
  refreshProjectSession,
  wechatLogin as wechatLoginService,
  wechatSilentLogin as wechatSilentLoginService,
} from './project-auth.service.js';
import { validateTrustedBackendKey } from '../trusted-backend-keys/trusted-backend-keys.service.js';

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
