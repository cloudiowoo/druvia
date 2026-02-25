import type { FastifyRequest, FastifyReply } from 'fastify';
import * as userService from '../user/user.service.js';
import * as tenantService from '../tenant/tenant.service.js';
import { signToken } from '../../middleware/auth.js';

// Hasura Action request format
interface HasuraActionRequest<T> {
  action: {
    name: string;
  };
  input: T;
  session_variables: {
    'x-hasura-user-id'?: string;
    'x-hasura-role'?: string;
    'x-hasura-tenant-id'?: string;
  };
}

// Action: User Registration
interface RegisterInput {
  email: string;
  password: string;
  username?: string;
}

export async function actionRegister(
  request: FastifyRequest<{ Body: HasuraActionRequest<RegisterInput> }>,
  reply: FastifyReply
) {
  const { email, password, username } = request.body.input;

  if (!email || !password) {
    return reply.status(400).send({
      message: 'Email and password are required',
      code: 'INVALID_INPUT',
    });
  }

  if (password.length < 8) {
    return reply.status(400).send({
      message: 'Password must be at least 8 characters',
      code: 'INVALID_INPUT',
    });
  }

  try {
    const user = await userService.register({ email, password, username });
    const token = signToken({ userId: user.userId, uid: user.id });

    return reply.send({
      user_id: user.userId,
      email: user.email,
      username: user.username,
      token,
    });
  } catch (error: unknown) {
    const err = error as { code?: string };
    if (err.code === '23505') {
      return reply.status(409).send({
        message: 'Email already registered',
        code: 'CONFLICT',
      });
    }
    throw error;
  }
}

// Action: User Login
interface LoginInput {
  email: string;
  password: string;
}

export async function actionLogin(
  request: FastifyRequest<{ Body: HasuraActionRequest<LoginInput> }>,
  reply: FastifyReply
) {
  const { email, password } = request.body.input;

  if (!email || !password) {
    return reply.status(400).send({
      message: 'Email and password are required',
      code: 'INVALID_INPUT',
    });
  }

  const user = await userService.login({ email, password });

  if (!user) {
    return reply.status(401).send({
      message: 'Invalid email or password',
      code: 'UNAUTHORIZED',
    });
  }

  const token = signToken({ userId: user.userId, uid: user.id });

  return reply.send({
    user_id: user.userId,
    email: user.email,
    username: user.username,
    token,
  });
}

// Action: Create Tenant
interface CreateTenantInput {
  alias: string;
  name: string;
  plan?: string;
}

export async function actionCreateTenant(
  request: FastifyRequest<{ Body: HasuraActionRequest<CreateTenantInput> }>,
  reply: FastifyReply
) {
  const { alias, name, plan } = request.body.input;
  const session = request.body.session_variables;

  // Get user UID from session
  const userId = session['x-hasura-user-id'];
  if (!userId) {
    return reply.status(401).send({
      message: 'Not authenticated',
      code: 'UNAUTHORIZED',
    });
  }

  // Get user's numeric ID
  const user = await userService.getUserById(userId);
  if (!user) {
    return reply.status(404).send({
      message: 'User not found',
      code: 'NOT_FOUND',
    });
  }

  try {
    const tenant = await tenantService.createTenant({
      alias,
      name,
      ownerUid: user.id,
      plan: plan as 'free' | 'pro' | 'enterprise' | undefined,
    });

    return reply.send({
      tenant_id: tenant.tenantId,
      alias: tenant.alias,
      name: tenant.name,
      plan: tenant.plan,
      status: tenant.status,
    });
  } catch (error: unknown) {
    const err = error as { code?: string };
    if (err.code === '23505') {
      return reply.status(409).send({
        message: 'Tenant alias already exists',
        code: 'CONFLICT',
      });
    }
    throw error;
  }
}

// Action: Get Current User
export async function actionGetMe(
  request: FastifyRequest<{ Body: HasuraActionRequest<Record<string, never>> }>,
  reply: FastifyReply
) {
  const session = request.body.session_variables;
  const userId = session['x-hasura-user-id'];

  if (!userId) {
    return reply.status(401).send({
      message: 'Not authenticated',
      code: 'UNAUTHORIZED',
    });
  }

  const user = await userService.getUserById(userId);

  if (!user) {
    return reply.status(404).send({
      message: 'User not found',
      code: 'NOT_FOUND',
    });
  }

  return reply.send({
    user_id: user.userId,
    email: user.email,
    username: user.username,
    avatar_url: user.avatarUrl,
    status: user.status,
  });
}
