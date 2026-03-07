import type { FastifyRequest, FastifyReply, FastifyInstance } from 'fastify';
import fp from 'fastify-plugin';
import jwt from 'jsonwebtoken';
import { config } from '../config/index.js';
import { checkSchemaAccess } from '../lib/access.js';

// JWT Payload 类型
export interface JwtPayload {
  userId: string;
  uid: number;
  tenantId?: string;
  role?: string;
  iat?: number;
  exp?: number;
}

// 扩展 FastifyRequest
declare module 'fastify' {
  interface FastifyRequest {
    user?: JwtPayload;
  }
}

// 验证 JWT Token
function verifyToken(token: string): JwtPayload {
  if (!config.jwt.secret) {
    throw new Error('JWT_SECRET is not configured');
  }
  return jwt.verify(token, config.jwt.secret) as JwtPayload;
}

// 生成 JWT Token
export function signToken(payload: Omit<JwtPayload, 'iat' | 'exp'>, expiresIn: string | number = '7d'): string {
  if (!config.jwt.secret) {
    throw new Error('JWT_SECRET is not configured');
  }
  return jwt.sign(payload, config.jwt.secret, { expiresIn } as jwt.SignOptions);
}

// 认证中间件 - 必须认证
export async function authenticate(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  const authHeader = request.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return reply.status(401).send({
      success: false,
      error: { code: 'UNAUTHORIZED', message: 'Missing or invalid authorization header' },
    });
  }

  const token = authHeader.slice(7);

  try {
    request.user = verifyToken(token);
  } catch (error) {
    return reply.status(401).send({
      success: false,
      error: { code: 'UNAUTHORIZED', message: 'Invalid or expired token' },
    });
  }
}

// 可选认证中间件 - 有 token 则解析，无 token 则跳过
export async function optionalAuth(
  request: FastifyRequest,
  _reply: FastifyReply
): Promise<void> {
  const authHeader = request.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return;
  }

  const token = authHeader.slice(7);

  try {
    request.user = verifyToken(token);
  } catch {
    // 忽略无效 token，继续处理请求
  }
}

// Schema 访问验证中间件 - 验证用户是否有权访问指定 schema
// 用于 /schemas/:schema/* 或 /schemas/:schemaName/* 路由
export async function verifySchemaAccess(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  const userId = request.user?.userId;
  if (!userId) {
    return reply.status(401).send({
      success: false,
      error: { code: 'UNAUTHORIZED', message: 'Authentication required' },
    });
  }

  // 支持 :schema 和 :schemaName 两种参数名
  const params = request.params as { schema?: string; schemaName?: string };
  const schemaName = params.schema || params.schemaName;

  if (!schemaName) {
    return reply.status(400).send({
      success: false,
      error: { code: 'BAD_REQUEST', message: 'Schema name is required' },
    });
  }

  const hasAccess = await checkSchemaAccess(userId, schemaName);
  if (!hasAccess) {
    return reply.status(403).send({
      success: false,
      error: { code: 'FORBIDDEN', message: 'Access denied to this schema' },
    });
  }
}

// Fastify 插件 - 注册装饰器
async function authPlugin(app: FastifyInstance): Promise<void> {
  app.decorateRequest('user', undefined);
}

export default fp(authPlugin, {
  name: 'auth',
  fastify: '5.x',
});
