import type { FastifyRequest, FastifyReply } from 'fastify';
import * as tenantService from './tenant.service.js';

interface CreateTenantBody {
  name: string;
  slug: string;
}

interface UpdateTenantBody {
  name?: string;
  slug?: string;
}

interface TenantParams {
  id: string;
}

interface ListTenantsQuery {
  limit?: string;
  offset?: string;
}

export async function createTenant(
  request: FastifyRequest<{ Body: CreateTenantBody }>,
  reply: FastifyReply
) {
  try {
    const tenant = await tenantService.createTenant(request.body);
    return reply.status(201).send(tenant);
  } catch (error: unknown) {
    const err = error as { code?: string };
    if (err.code === '23505') {
      return reply.status(409).send({ error: 'Tenant slug already exists' });
    }
    throw error;
  }
}

export async function getTenant(
  request: FastifyRequest<{ Params: TenantParams }>,
  reply: FastifyReply
) {
  const tenant = await tenantService.getTenantById(request.params.id);
  if (!tenant) {
    return reply.status(404).send({ error: 'Tenant not found' });
  }
  return tenant;
}

export async function listTenants(
  request: FastifyRequest<{ Querystring: ListTenantsQuery }>,
  reply: FastifyReply
) {
  const limit = parseInt(request.query.limit || '50', 10);
  const offset = parseInt(request.query.offset || '0', 10);
  const tenants = await tenantService.listTenants(limit, offset);
  return { data: tenants, limit, offset };
}

export async function updateTenant(
  request: FastifyRequest<{ Params: TenantParams; Body: UpdateTenantBody }>,
  reply: FastifyReply
) {
  try {
    const tenant = await tenantService.updateTenant(request.params.id, request.body);
    if (!tenant) {
      return reply.status(404).send({ error: 'Tenant not found' });
    }
    return tenant;
  } catch (error: unknown) {
    const err = error as { code?: string };
    if (err.code === '23505') {
      return reply.status(409).send({ error: 'Tenant slug already exists' });
    }
    throw error;
  }
}

export async function deleteTenant(
  request: FastifyRequest<{ Params: TenantParams }>,
  reply: FastifyReply
) {
  const deleted = await tenantService.deleteTenant(request.params.id);
  if (!deleted) {
    return reply.status(404).send({ error: 'Tenant not found' });
  }
  return reply.status(204).send();
}

export async function getTenantConfig(
  request: FastifyRequest<{ Params: TenantParams }>,
  reply: FastifyReply
) {
  const config = await tenantService.getTenantConfig(request.params.id);
  if (!config) {
    return reply.status(404).send({ error: 'Tenant not found' });
  }
  return config;
}
