import type { FastifyRequest, FastifyReply } from 'fastify';
import { config } from '../config/index.js';

// Verify Hasura webhook secret
export async function verifyHasuraWebhook(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  const secret = request.headers['x-hasura-admin-secret'] as string | undefined;

  // Skip verification in development if no secret configured
  if (!config.hasura.adminSecret) {
    return;
  }

  if (!secret || secret !== config.hasura.adminSecret) {
    return reply.status(401).send({
      message: 'Invalid or missing Hasura admin secret',
      code: 'UNAUTHORIZED',
    });
  }
}
