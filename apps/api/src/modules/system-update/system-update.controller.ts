import type { FastifyReply, FastifyRequest } from 'fastify';
import { config } from '../../config/index.js';
import type { PlatformJwtUser, RequestUser } from '../../middleware/auth.js';

type UpdaterMethod = 'GET' | 'POST';

function isSuperAdmin(user: RequestUser | undefined): user is PlatformJwtUser {
  return user?.kind === 'platform_user' && user.role === 'super_admin';
}

function updaterUrl(path: string): string {
  return new URL(path, config.updater.url).toString();
}

async function proxyUpdater(
  request: FastifyRequest,
  reply: FastifyReply,
  method: UpdaterMethod,
  path: string
) {
  if (!isSuperAdmin(request.user)) {
    return reply.status(403).send({
      success: false,
      error: { code: 'FORBIDDEN', message: 'Only super_admin can manage system updates' },
    });
  }

  if (!config.updater.url || !config.updater.secret) {
    return reply.status(503).send({
      success: false,
      error: { code: 'UPDATER_NOT_CONFIGURED', message: 'System updater is not configured' },
    });
  }

  try {
    const response = await fetch(updaterUrl(path), {
      method,
      headers: {
        'x-druvia-updater-secret': config.updater.secret,
      },
    });
    const contentType = response.headers.get('content-type') || '';
    const payload = contentType.includes('application/json')
      ? await response.json()
      : await response.text();
    if (response.status >= 400) {
      const error = typeof payload === 'object' && payload !== null && 'error' in payload
        ? payload.error
        : { code: 'UPDATER_ERROR', message: typeof payload === 'string' ? payload : 'System updater request failed' };
      return reply.status(response.status).send({
        success: false,
        error,
      });
    }

    return reply.status(response.status).send({
      success: true,
      data: payload,
    });
  } catch (error) {
    return reply.status(502).send({
      success: false,
      error: {
        code: 'UPDATER_UNAVAILABLE',
        message: error instanceof Error ? error.message : 'System updater is unavailable',
      },
    });
  }
}

export async function getUpdateStatus(request: FastifyRequest, reply: FastifyReply) {
  return proxyUpdater(request, reply, 'GET', '/internal/update/status');
}

export async function checkUpdate(request: FastifyRequest, reply: FastifyReply) {
  return proxyUpdater(request, reply, 'POST', '/internal/update/check');
}

export async function downloadUpdate(request: FastifyRequest, reply: FastifyReply) {
  return proxyUpdater(request, reply, 'POST', '/internal/update/download');
}

export async function applyUpdate(request: FastifyRequest, reply: FastifyReply) {
  return proxyUpdater(request, reply, 'POST', '/internal/update/apply');
}

export async function rollbackUpdate(request: FastifyRequest, reply: FastifyReply) {
  return proxyUpdater(request, reply, 'POST', '/internal/update/rollback');
}

export async function restartSystem(request: FastifyRequest, reply: FastifyReply) {
  return proxyUpdater(request, reply, 'POST', '/internal/restart');
}
