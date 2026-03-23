import type { FastifyReply, FastifyRequest } from 'fastify';
import { isProjectUser } from '../../middleware/auth.js';
import {
  ProjectAuthError,
  logoutProjectUser,
  providerLogin as providerLoginService,
  providerSilentLogin as providerSilentLoginService,
  refreshProjectSession,
  wechatLogin as wechatLoginService,
  wechatSilentLogin as wechatSilentLoginService,
} from './project-auth.service.js';

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
