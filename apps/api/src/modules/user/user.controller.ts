import type { FastifyRequest, FastifyReply } from 'fastify';
import * as userService from './user.service.js';
import { signToken } from '../../middleware/auth.js';

interface RegisterBody {
  email: string;
  password: string;
  username?: string;
}

interface LoginBody {
  email: string;
  password: string;
}

interface UpdateProfileBody {
  username?: string;
  avatarUrl?: string;
}

export async function register(
  request: FastifyRequest<{ Body: RegisterBody }>,
  reply: FastifyReply
) {
  const { email, password, username } = request.body;

  // 验证输入
  if (!email || !password) {
    return reply.status(400).send({
      success: false,
      error: { code: 'INVALID_INPUT', message: 'Email and password are required' },
    });
  }

  if (password.length < 8) {
    return reply.status(400).send({
      success: false,
      error: { code: 'INVALID_INPUT', message: 'Password must be at least 8 characters' },
    });
  }

  try {
    const user = await userService.register({ email, password, username });
    const token = signToken({ userId: user.userId, uid: user.id });

    return reply.status(201).send({
      success: true,
      data: { user, token },
    });
  } catch (error: unknown) {
    const err = error as { code?: string };
    if (err.code === '23505') {
      return reply.status(409).send({
        success: false,
        error: { code: 'CONFLICT', message: 'Email already registered' },
      });
    }
    throw error;
  }
}

export async function login(
  request: FastifyRequest<{ Body: LoginBody }>,
  reply: FastifyReply
) {
  const { email, password } = request.body;

  if (!email || !password) {
    return reply.status(400).send({
      success: false,
      error: { code: 'INVALID_INPUT', message: 'Email and password are required' },
    });
  }

  const user = await userService.login({ email, password });

  if (!user) {
    return reply.status(401).send({
      success: false,
      error: { code: 'UNAUTHORIZED', message: 'Invalid email or password' },
    });
  }

  const token = signToken({ userId: user.userId, uid: user.id });

  return reply.send({
    success: true,
    data: { user, token },
  });
}

export async function getProfile(
  request: FastifyRequest,
  reply: FastifyReply
) {
  if (!request.user) {
    return reply.status(401).send({
      success: false,
      error: { code: 'UNAUTHORIZED', message: 'Not authenticated' },
    });
  }

  const user = await userService.getUserById(request.user.userId);

  if (!user) {
    return reply.status(404).send({
      success: false,
      error: { code: 'NOT_FOUND', message: 'User not found' },
    });
  }

  return reply.send({ success: true, data: user });
}

export async function updateProfile(
  request: FastifyRequest<{ Body: UpdateProfileBody }>,
  reply: FastifyReply
) {
  if (!request.user) {
    return reply.status(401).send({
      success: false,
      error: { code: 'UNAUTHORIZED', message: 'Not authenticated' },
    });
  }

  const user = await userService.updateUser(request.user.userId, request.body);

  if (!user) {
    return reply.status(404).send({
      success: false,
      error: { code: 'NOT_FOUND', message: 'User not found' },
    });
  }

  return reply.send({ success: true, data: user });
}

export async function changePassword(
  request: FastifyRequest<{ Body: { currentPassword: string; newPassword: string } }>,
  reply: FastifyReply
) {
  if (!request.user) {
    return reply.status(401).send({
      success: false,
      error: { code: 'UNAUTHORIZED', message: 'Not authenticated' },
    });
  }

  const { currentPassword, newPassword } = request.body;

  if (!currentPassword || !newPassword) {
    return reply.status(400).send({
      success: false,
      error: { code: 'INVALID_INPUT', message: 'Current and new password are required' },
    });
  }

  if (newPassword.length < 8) {
    return reply.status(400).send({
      success: false,
      error: { code: 'INVALID_INPUT', message: 'New password must be at least 8 characters' },
    });
  }

  // 获取用户信息
  const user = await userService.getUserById(request.user.userId);
  if (!user || !user.email) {
    return reply.status(400).send({
      success: false,
      error: { code: 'INVALID_INPUT', message: 'Cannot change password for this account' },
    });
  }

  // 验证当前密码
  const validLogin = await userService.login({ email: user.email, password: currentPassword });
  if (!validLogin) {
    return reply.status(401).send({
      success: false,
      error: { code: 'UNAUTHORIZED', message: 'Current password is incorrect' },
    });
  }

  await userService.changePassword(request.user.userId, newPassword);

  return reply.send({ success: true, message: 'Password changed successfully' });
}

// List all users (admin)
export async function listUsers(
  request: FastifyRequest<{ Querystring: { limit?: string; offset?: string } }>,
  reply: FastifyReply
) {
  const limit = parseInt(request.query.limit || '50', 10);
  const offset = parseInt(request.query.offset || '0', 10);

  const { users, total } = await userService.listUsers(limit, offset);

  return reply.send({
    success: true,
    data: users,
    pagination: { limit, offset, total },
  });
}

// Get user by ID (admin)
export async function getUser(
  request: FastifyRequest<{ Params: { userId: string } }>,
  reply: FastifyReply
) {
  const user = await userService.getUserById(request.params.userId);

  if (!user) {
    return reply.status(404).send({
      success: false,
      error: { code: 'NOT_FOUND', message: 'User not found' },
    });
  }

  return reply.send({ success: true, data: user });
}

// Delete user (admin)
export async function deleteUser(
  request: FastifyRequest<{ Params: { userId: string } }>,
  reply: FastifyReply
) {
  // Prevent self-deletion
  if (request.user?.userId === request.params.userId) {
    return reply.status(400).send({
      success: false,
      error: { code: 'INVALID_OPERATION', message: 'Cannot delete your own account' },
    });
  }

  const deleted = await userService.deleteUser(request.params.userId);

  if (!deleted) {
    return reply.status(404).send({
      success: false,
      error: { code: 'NOT_FOUND', message: 'User not found' },
    });
  }

  return reply.status(204).send();
}

// Update user status (admin)
export async function updateUserStatus(
  request: FastifyRequest<{ Params: { userId: string }; Body: { status: string } }>,
  reply: FastifyReply
) {
  const { status } = request.body;

  if (!['active', 'inactive', 'suspended'].includes(status)) {
    return reply.status(400).send({
      success: false,
      error: { code: 'INVALID_INPUT', message: 'Invalid status value' },
    });
  }

  const user = await userService.updateUserStatus(
    request.params.userId,
    status as 'active' | 'inactive' | 'suspended'
  );

  if (!user) {
    return reply.status(404).send({
      success: false,
      error: { code: 'NOT_FOUND', message: 'User not found' },
    });
  }

  return reply.send({ success: true, data: user });
}
