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
