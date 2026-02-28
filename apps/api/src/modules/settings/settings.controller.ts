// apps/api/src/modules/settings/settings.controller.ts
import type { FastifyRequest, FastifyReply } from 'fastify';
import * as settingsService from './settings.service.js';
import type { PlatformSettings } from '@druvia/shared';

export async function getSettings(
  request: FastifyRequest,
  reply: FastifyReply
) {
  const settings = await settingsService.getSettings();
  return reply.send({ success: true, data: settings });
}

export async function updateSettings(
  request: FastifyRequest<{ Body: Partial<PlatformSettings> }>,
  reply: FastifyReply
) {
  const currentUser = request.user;
  if (!currentUser || currentUser.role !== 'super_admin') {
    return reply.status(403).send({
      success: false,
      error: { code: 'FORBIDDEN', message: 'Only super_admin can update settings' },
    });
  }

  const settings = await settingsService.updateSettings(request.body);
  return reply.send({ success: true, data: settings });
}
