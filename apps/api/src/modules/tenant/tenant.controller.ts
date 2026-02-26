import type { FastifyRequest, FastifyReply } from 'fastify';
import * as tenantService from './tenant.service.js';
import type { CreateTenantInput, UpdateTenantInput } from '@druvia/shared';

interface TenantParams {
  tenantId: string;
}

interface ListTenantsQuery {
  ownerUid?: string;
  limit?: string;
  offset?: string;
}

export async function createTenant(
  request: FastifyRequest<{ Body: CreateTenantInput }>,
  reply: FastifyReply
) {
  try {
    const tenant = await tenantService.createTenant({
      ...request.body,
      ownerUid: request.user!.uid,
    });
    return reply.status(201).send({ success: true, data: tenant });
  } catch (error: unknown) {
    const err = error as { code?: string; message?: string };
    if (err.code === '23505') {
      return reply.status(409).send({
        success: false,
        error: { code: 'CONFLICT', message: 'Tenant alias already exists' },
      });
    }
    if (err.code === '23503') {
      return reply.status(400).send({
        success: false,
        error: { code: 'INVALID_OWNER', message: 'Owner user does not exist' },
      });
    }
    throw error;
  }
}

export async function getTenant(
  request: FastifyRequest<{ Params: TenantParams }>,
  reply: FastifyReply
) {
  const tenant = await tenantService.getTenantById(request.params.tenantId);
  if (!tenant) {
    return reply.status(404).send({
      success: false,
      error: { code: 'NOT_FOUND', message: 'Tenant not found' },
    });
  }
  return reply.send({ success: true, data: tenant });
}

export async function getTenantByAlias(
  request: FastifyRequest<{ Params: { alias: string } }>,
  reply: FastifyReply
) {
  const tenant = await tenantService.getTenantByAlias(request.params.alias);
  if (!tenant) {
    return reply.status(404).send({
      success: false,
      error: { code: 'NOT_FOUND', message: 'Tenant not found' },
    });
  }
  return reply.send({ success: true, data: tenant });
}

export async function listTenants(
  request: FastifyRequest<{ Querystring: ListTenantsQuery }>,
  reply: FastifyReply
) {
  const ownerUid = request.query.ownerUid ? parseInt(request.query.ownerUid, 10) : undefined;
  const limit = parseInt(request.query.limit || '50', 10);
  const offset = parseInt(request.query.offset || '0', 10);

  const tenants = await tenantService.listTenants(ownerUid, limit, offset);

  return reply.send({
    success: true,
    data: tenants,
    pagination: { limit, offset, count: tenants.length },
  });
}

export async function updateTenant(
  request: FastifyRequest<{ Params: TenantParams; Body: UpdateTenantInput }>,
  reply: FastifyReply
) {
  try {
    const tenant = await tenantService.updateTenant(request.params.tenantId, request.body);
    if (!tenant) {
      return reply.status(404).send({
        success: false,
        error: { code: 'NOT_FOUND', message: 'Tenant not found' },
      });
    }
    return reply.send({ success: true, data: tenant });
  } catch (error: unknown) {
    const err = error as { code?: string };
    if (err.code === '23505') {
      return reply.status(409).send({
        success: false,
        error: { code: 'CONFLICT', message: 'Tenant alias already exists' },
      });
    }
    throw error;
  }
}

export async function deleteTenant(
  request: FastifyRequest<{ Params: TenantParams }>,
  reply: FastifyReply
) {
  const deleted = await tenantService.deleteTenant(request.params.tenantId);
  if (!deleted) {
    return reply.status(404).send({
      success: false,
      error: { code: 'NOT_FOUND', message: 'Tenant not found' },
    });
  }
  return reply.status(204).send();
}
