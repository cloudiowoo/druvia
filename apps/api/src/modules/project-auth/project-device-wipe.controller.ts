import type { FastifyReply, FastifyRequest } from 'fastify';
import { assertProjectCapability, AuthorizationError } from '../../lib/project-authorization.js';
import { isPlatformUser, isProjectUser } from '../../middleware/auth.js';
import {
  acknowledgeProjectDeviceWipeMandate,
  getProjectDeviceWipeConfig,
  listProjectDeviceWipeVerificationKeys,
  queryProjectDeviceWipeMandates,
  registerProjectDeviceWipeBinding,
  retireProjectDeviceWipeSigningKey,
  rotateProjectDeviceWipeSigningKey,
  updateProjectDeviceWipeConfig,
} from './project-device-wipe.service.js';
import { ProjectDeviceWipeError } from './project-device-wipe.types.js';

type ProjectParams = { projectId: string };
type BindingParams = ProjectParams & { bindingHandle: string };
type MandateParams = BindingParams & { deletionId: string };
type KeyParams = ProjectParams & { keyId: string };

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HANDLE_PATTERN = /^dwb_[A-Za-z0-9_-]{22,43}$/;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

function readHeader(request: FastifyRequest, name: string): string | undefined {
  const value = request.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

function sendError(reply: FastifyReply, error: unknown) {
  if (error instanceof ProjectDeviceWipeError) {
    return reply.status(error.statusCode).send({
      success: false,
      error: { code: error.code, message: error.message },
    });
  }
  throw error;
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

function readBindingCredential(
  request: FastifyRequest<{ Params: BindingParams }>,
  reply: FastifyReply,
): string | null {
  const token = readHeader(request, 'x-druvia-binding-token');
  if (!HANDLE_PATTERN.test(request.params.bindingHandle) || !token || !TOKEN_PATTERN.test(token)) {
    reply.status(401).send({
      success: false,
      error: {
        code: 'DEVICE_WIPE_CREDENTIAL_INVALID',
        message: 'Invalid project device wipe credential',
      },
    });
    return null;
  }
  return token;
}

export async function registerBinding(
  request: FastifyRequest<{
    Params: ProjectParams;
    Body: { bindingIdentity?: unknown; bindingRevision?: unknown } & Record<string, unknown>;
  }>,
  reply: FastifyReply,
) {
  if (
    !request.user
    || !isProjectUser(request.user)
    || request.user.projectId !== request.params.projectId
  ) {
    return reply.status(403).send({
      success: false,
      error: { code: 'PROJECT_ACTOR_REQUIRED', message: 'Same-project Project Session required' },
    });
  }
  const idempotencyKey = readHeader(request, 'idempotency-key');
  const body = request.body ?? {};
  if (
    !idempotencyKey
    || !UUID_PATTERN.test(idempotencyKey)
    || typeof body.bindingIdentity !== 'string'
    || !/^[A-Za-z0-9_-]{22,128}$/.test(body.bindingIdentity)
    || !Number.isSafeInteger(body.bindingRevision)
    || Number(body.bindingRevision) <= 0
    || Object.keys(body).some((key) => !['bindingIdentity', 'bindingRevision'].includes(key))
  ) {
    return reply.status(400).send({
      success: false,
      error: { code: 'INVALID_INPUT', message: 'Invalid project device binding registration' },
    });
  }
  try {
    const data = await registerProjectDeviceWipeBinding({
      projectId: request.params.projectId,
      projectUserId: request.user.sub,
      idempotencyKey,
      bindingIdentity: body.bindingIdentity,
      bindingRevision: Number(body.bindingRevision),
    });
    return reply.send({ success: true, data });
  } catch (error) {
    return sendError(reply, error);
  }
}

export async function queryMandates(
  request: FastifyRequest<{ Params: BindingParams }>,
  reply: FastifyReply,
) {
  const bindingLookupToken = readBindingCredential(request, reply);
  if (!bindingLookupToken) return;
  try {
    return reply.send({ success: true, data: await queryProjectDeviceWipeMandates({
      projectId: request.params.projectId,
      bindingHandle: request.params.bindingHandle,
      bindingLookupToken,
    }) });
  } catch (error) {
    return sendError(reply, error);
  }
}

export async function acknowledgeMandate(
  request: FastifyRequest<{ Params: MandateParams; Body: unknown }>,
  reply: FastifyReply,
) {
  const bindingLookupToken = readBindingCredential(request, reply);
  if (!bindingLookupToken) return;
  if (!UUID_PATTERN.test(request.params.deletionId)) {
    return reply.status(400).send({
      success: false,
      error: { code: 'INVALID_INPUT', message: 'Invalid device wipe mandate ID' },
    });
  }
  try {
    return reply.send({ success: true, data: await acknowledgeProjectDeviceWipeMandate({
      projectId: request.params.projectId,
      bindingHandle: request.params.bindingHandle,
      bindingLookupToken,
      deletionId: request.params.deletionId,
      receipt: request.body,
    }) });
  } catch (error) {
    return sendError(reply, error);
  }
}

export async function verificationKeys(
  request: FastifyRequest<{ Params: ProjectParams }>,
  reply: FastifyReply,
) {
  return reply.send({
    success: true,
    data: await listProjectDeviceWipeVerificationKeys(request.params.projectId),
  });
}

export async function getConfig(
  request: FastifyRequest<{ Params: ProjectParams }>,
  reply: FastifyReply,
) {
  if (!(await requireProjectAuthManager(request, reply))) return;
  return reply.send({ success: true, data: await getProjectDeviceWipeConfig(request.params.projectId) });
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
      data: await updateProjectDeviceWipeConfig(request.params.projectId, request.body.enabled),
    });
  } catch (error) {
    return sendError(reply, error);
  }
}

export async function rotateSigningKey(
  request: FastifyRequest<{ Params: ProjectParams }>,
  reply: FastifyReply,
) {
  if (!(await requireProjectAuthManager(request, reply))) return;
  try {
    return reply.status(201).send({
      success: true,
      data: await rotateProjectDeviceWipeSigningKey(request.params.projectId),
    });
  } catch (error) {
    return sendError(reply, error);
  }
}

export async function retireSigningKey(
  request: FastifyRequest<{ Params: KeyParams }>,
  reply: FastifyReply,
) {
  if (!(await requireProjectAuthManager(request, reply))) return;
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(request.params.keyId)) {
    return reply.status(400).send({
      success: false,
      error: { code: 'INVALID_INPUT', message: 'Invalid device wipe signing key ID' },
    });
  }
  try {
    return reply.send({
      success: true,
      data: await retireProjectDeviceWipeSigningKey(request.params.projectId, request.params.keyId),
    });
  } catch (error) {
    return sendError(reply, error);
  }
}
