import type { FastifyRequest, FastifyReply } from 'fastify';
import type { JwtPayload } from '../../middleware/auth.js';
import * as tenantService from './tenant.service.js';
import type { CreateTenantInput, Tenant, UpdateTenantInput } from '@druvia/shared';
import { isDataAccessMigrationDeleteGuardError } from '../data-access/data-access-mutation-lock.js';
import { assertTenantAccess, AuthorizationError } from '../../lib/project-authorization.js';
import { isPlatformUser } from '../../middleware/auth.js';

interface TenantParams {
  tenantId: string;
}

interface ListTenantsQuery {
  ownerUid?: string;
  limit?: string;
  offset?: string;
}

function presentTenant(tenant: Tenant, fullAccess: boolean) {
  if (fullAccess) return tenant;
  return {
    tenantId: tenant.tenantId,
    alias: tenant.alias,
    name: tenant.name,
    plan: tenant.plan,
    status: tenant.status,
    description: tenant.description,
    createdAt: tenant.createdAt,
    updatedAt: tenant.updatedAt,
  };
}

export async function createTenant(
  request: FastifyRequest<{ Body: CreateTenantInput }>,
  reply: FastifyReply
) {
  try {
    const tenant = await tenantService.createTenant({
      ...request.body,
      ownerUid: (request.user as JwtPayload).uid,
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
  const fullAccess = request.tenantAccess?.isWorkspaceOwner || request.tenantAccess?.isSuperAdmin;
  return reply.send({ success: true, data: presentTenant(tenant, Boolean(fullAccess)) });
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
  try {
    const access = await assertTenantAccess(request.user, tenant.tenantId);
    return reply.send({
      success: true,
      data: presentTenant(tenant, access.isWorkspaceOwner || access.isSuperAdmin),
    });
  } catch (error) {
    if (error instanceof AuthorizationError) {
      return reply.status(error.statusCode).send({
        success: false,
        error: { code: error.code, message: error.message },
      });
    }
    throw error;
  }
}

export async function listTenants(
  request: FastifyRequest<{ Querystring: ListTenantsQuery }>,
  reply: FastifyReply
) {
  const limit = parseInt(request.query.limit || '50', 10);
  const offset = parseInt(request.query.offset || '0', 10);
  if (!request.user || !isPlatformUser(request.user)) {
    return reply.status(401).send({
      success: false,
      error: { code: 'UNAUTHORIZED', message: 'Platform authentication required' },
    });
  }
  const accessibleTenants = await tenantService.listAccessibleTenants(request.user, limit, offset);
  const tenants = accessibleTenants.map(({ tenant, fullAccess }) => presentTenant(tenant, fullAccess));

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
  try {
    const deleted = await tenantService.deleteTenant(request.params.tenantId);
    if (!deleted) {
      return reply.status(404).send({
        success: false,
        error: { code: 'NOT_FOUND', message: 'Tenant not found' },
      });
    }
    return reply.status(204).send();
  } catch (error) {
    if (isDataAccessMigrationDeleteGuardError(error)) {
      return reply.status(409).send({
        success: false,
        error: {
          code: 'DATA_ACCESS_MIGRATION_IN_PROGRESS',
          message: 'A project data access migration must finish before deleting this workspace',
        },
      });
    }
    throw error;
  }
}

export async function getTenantUsage(
  request: FastifyRequest<{ Params: TenantParams }>,
  reply: FastifyReply
) {
  const usage = await tenantService.getTenantUsage(request.params.tenantId);
  if (!usage) {
    return reply.status(404).send({
      success: false,
      error: { code: 'NOT_FOUND', message: 'Tenant not found' },
    });
  }
  return reply.send({ success: true, data: usage });
}
