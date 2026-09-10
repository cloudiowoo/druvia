import type { FastifyReply, FastifyRequest } from 'fastify';
import { isPlatformUser, isProjectUser } from '../../middleware/auth.js';
import { assertProjectCapability, AuthorizationError } from '../../lib/project-authorization.js';
import { ProjectAuthError } from './project-auth.service.js';
import {
  confirmAccountDeletion,
  createAccountDeletionIntent,
  getAccountDeletionConfig,
  getAccountDeletionStatus,
  updateAccountDeletionConfig,
} from './project-account-deletion.service.js';

type ProjectParams = { projectId: string };
type DeletionParams = ProjectParams & { deletionId: string };

function sendError(reply: FastifyReply, error: unknown) {
  if (error instanceof ProjectAuthError) {
    return reply.status(error.statusCode).send({
      success: false,
      error: { code: error.code, message: error.message },
    });
  }
  throw error;
}

function readHeader(request: FastifyRequest, name: string): string | undefined {
  const value = request.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

function validUuid(value: string | undefined): value is string {
  return typeof value === 'string'
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

async function requireProjectAuthManager(
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
    return true;
  } catch (error) {
    if (!(error instanceof AuthorizationError)) throw error;
    reply.status(error.statusCode).send({
      success: false,
      error: { code: error.code, message: error.message },
    });
    return false;
  }
}

export async function createIntent(
  request: FastifyRequest<{ Params: ProjectParams; Body: Record<string, unknown> }>,
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
      error: { code: 'FORBIDDEN', message: 'Apple Project Session required' },
    });
  }
  if (request.body && Object.keys(request.body).length > 0) {
    return reply.status(400).send({
      success: false,
      error: { code: 'INVALID_INPUT', message: 'Account deletion intent does not accept a request body' },
    });
  }
  const idempotencyKey = readHeader(request, 'idempotency-key');
  if (!validUuid(idempotencyKey)) {
    return reply.status(400).send({
      success: false,
      error: { code: 'INVALID_INPUT', message: 'A UUID Idempotency-Key is required' },
    });
  }
  try {
    const data = await createAccountDeletionIntent({
      projectId: request.params.projectId,
      projectUserId: request.user.sub,
      idempotencyKey,
    });
    return reply.send({ success: true, data });
  } catch (error) {
    return sendError(reply, error);
  }
}

export async function confirm(
  request: FastifyRequest<{
    Params: DeletionParams;
    Body: { authorizationCode?: string; identityToken?: string; rawNonce?: string };
  }>,
  reply: FastifyReply,
) {
  const statusToken = readHeader(request, 'x-druvia-deletion-token');
  const { authorizationCode, identityToken, rawNonce } = request.body ?? {};
  if (!statusToken || !validUuid(request.params.deletionId)) {
    return reply.status(400).send({
      success: false,
      error: { code: 'INVALID_INPUT', message: 'Invalid account deletion confirmation' },
    });
  }
  const credential = (
    typeof authorizationCode === 'string'
    && Boolean(authorizationCode.trim())
    && Buffer.byteLength(authorizationCode, 'utf8') <= 4_096
    && typeof identityToken === 'string'
    && Boolean(identityToken.trim())
    && Buffer.byteLength(identityToken, 'utf8') <= 16_384
    && typeof rawNonce === 'string'
    && /^[A-Za-z0-9_-]{43}$/.test(rawNonce)
  ) ? { authorizationCode, identityToken, rawNonce } : undefined;
  const projectUserId = request.user && isProjectUser(request.user)
    && request.user.projectId === request.params.projectId
    ? request.user.sub
    : undefined;
  try {
    const data = await confirmAccountDeletion({
      projectId: request.params.projectId,
      deletionId: request.params.deletionId,
      statusToken,
      projectUserId,
      credential,
    });
    return reply.status(data.status === 'pending_confirmation' ? 200 : 202).send({ success: true, data });
  } catch (error) {
    return sendError(reply, error);
  }
}

export async function status(
  request: FastifyRequest<{ Params: DeletionParams }>,
  reply: FastifyReply,
) {
  const statusToken = readHeader(request, 'x-druvia-deletion-token');
  if (!statusToken || !validUuid(request.params.deletionId)) {
    return reply.status(401).send({
      success: false,
      error: { code: 'ACCOUNT_DELETION_STATUS_TOKEN_INVALID', message: 'Invalid account deletion status credential' },
    });
  }
  try {
    return reply.send({ success: true, data: await getAccountDeletionStatus({
      projectId: request.params.projectId,
      deletionId: request.params.deletionId,
      statusToken,
    }) });
  } catch (error) {
    return sendError(reply, error);
  }
}

export async function getConfig(
  request: FastifyRequest<{ Params: ProjectParams }>,
  reply: FastifyReply,
) {
  if (!(await requireProjectAuthManager(request, reply))) return;
  return reply.send({ success: true, data: await getAccountDeletionConfig(request.params.projectId) });
}

export async function updateConfig(
  request: FastifyRequest<{ Params: ProjectParams; Body: { enabled?: unknown } }>,
  reply: FastifyReply,
) {
  if (!(await requireProjectAuthManager(request, reply))) return;
  if (typeof request.body?.enabled !== 'boolean' || Object.keys(request.body).some((key) => key !== 'enabled')) {
    return reply.status(400).send({
      success: false,
      error: { code: 'INVALID_INPUT', message: 'Only enabled is supported' },
    });
  }
  try {
    return reply.send({
      success: true,
      data: await updateAccountDeletionConfig(request.params.projectId, request.body.enabled),
    });
  } catch (error) {
    return sendError(reply, error);
  }
}
