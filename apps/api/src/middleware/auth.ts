import type { FastifyRequest, FastifyReply, FastifyInstance } from 'fastify';
import fp from 'fastify-plugin';
import jwt from 'jsonwebtoken';
import { config } from '../config/index.js';
import { checkSchemaAccess } from '../lib/access.js';
import { validateApiKey } from '../modules/api-keys/api-keys.service.js';

export interface PlatformJwtUser {
  kind: 'platform_user';
  userId: string;
  uid: number;
  tenantId?: string;
  role?: string;
  iat?: number;
  exp?: number;
}

export type JwtPayload = PlatformJwtUser;

export interface ProjectJwtUser {
  kind: 'project_user';
  sub: string;
  projectId: string;
  authType: 'project_user';
  role: 'authenticated';
  provider: string;
  iat?: number;
  exp?: number;
}

export interface ApiKeyIdentity {
  kind: 'apikey';
  projectId: string;
  role: 'anon';
}

export type RequestUser = PlatformJwtUser | ProjectJwtUser | ApiKeyIdentity;

export function isJwtUser(user: RequestUser): user is JwtPayload {
  return isPlatformUser(user);
}

export function isPlatformUser(user: RequestUser): user is PlatformJwtUser {
  return user.kind === 'platform_user';
}

export function isProjectUser(user: RequestUser): user is ProjectJwtUser {
  return user.kind === 'project_user';
}

export function isApiKeyUser(user: RequestUser): user is ApiKeyIdentity {
  return user.kind === 'apikey';
}

// 扩展 FastifyRequest
declare module 'fastify' {
  interface FastifyRequest {
    user?: RequestUser;
  }
}

// 验证 JWT Token
function verifyToken(token: string): RequestUser {
  const decoded = jwt.decode(token) as ({ authType?: string } & Partial<PlatformJwtUser> & Partial<ProjectJwtUser>) | null;
  if (decoded?.authType === 'project_user') {
    return verifyProjectUserToken(token);
  }

  const payload = jwt.verify(token, config.jwt.secret) as Partial<PlatformJwtUser>;
  return {
    kind: 'platform_user',
    userId: payload.userId!,
    uid: payload.uid!,
    tenantId: payload.tenantId,
    role: payload.role,
    iat: payload.iat,
    exp: payload.exp,
  };
}

// 生成 JWT Token
export function signToken(payload: Omit<JwtPayload, 'iat' | 'exp' | 'kind'>, expiresIn: string | number = '7d'): string {
  if (!config.jwt.secret) {
    throw new Error('JWT_SECRET is not configured');
  }
  return jwt.sign({ ...payload, kind: 'platform_user' }, config.jwt.secret, { expiresIn } as jwt.SignOptions);
}

export function signProjectUserToken(
  payload: Omit<ProjectJwtUser, 'iat' | 'exp' | 'kind'>,
  expiresIn: string | number = config.projectAuth.defaultAccessTokenTtlSeconds
): string {
  if (!config.projectAuth.tokenSecret) {
    throw new Error('PROJECT_AUTH_JWT_SECRET or JWT_SECRET is not configured');
  }

  return jwt.sign({ ...payload, kind: 'project_user' }, config.projectAuth.tokenSecret, { expiresIn } as jwt.SignOptions);
}

export function verifyProjectUserToken(token: string): ProjectJwtUser {
  if (!config.projectAuth.tokenSecret) {
    throw new Error('PROJECT_AUTH_JWT_SECRET or JWT_SECRET is not configured');
  }

  const payload = jwt.verify(token, config.projectAuth.tokenSecret) as Partial<ProjectJwtUser>;
  return {
    kind: 'project_user',
    sub: payload.sub!,
    projectId: payload.projectId!,
    authType: 'project_user',
    role: 'authenticated',
    provider: payload.provider!,
    iat: payload.iat,
    exp: payload.exp,
  };
}

// 认证中间件 - 必须认证
export async function authenticate(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  // 1. 优先 Bearer token
  const authHeader = request.headers.authorization;
  if (authHeader?.startsWith('Bearer ')) {
    const token = authHeader.slice(7);
    try {
      request.user = verifyToken(token);
      return;
    } catch {
      return reply.status(401).send({
        success: false,
        error: { code: 'UNAUTHORIZED', message: 'Invalid or expired token' },
      });
    }
  }

  // 2. Fallback: apikey 头
  const apiKey = request.headers.apikey as string | undefined;
  if (apiKey) {
    const result = await validateApiKey(apiKey);
    if (result.valid && result.projectId) {
      request.user = { kind: 'apikey', projectId: result.projectId, role: 'anon' };
      return;
    }
    return reply.status(401).send({
      success: false,
      error: { code: 'UNAUTHORIZED', message: 'Invalid API key' },
    });
  }

  // 3. 都没有
  return reply.status(401).send({
    success: false,
    error: { code: 'UNAUTHORIZED', message: 'Missing authorization' },
  });
}

// 可选认证中间件 - 有 token 则解析，无 token 则跳过
export async function optionalAuth(
  request: FastifyRequest,
  _reply: FastifyReply
): Promise<void> {
  const authHeader = request.headers.authorization;
  if (authHeader?.startsWith('Bearer ')) {
    const token = authHeader.slice(7);
    try {
      request.user = verifyToken(token);
    } catch { /* 忽略 */ }
    return;
  }

  const apiKey = request.headers.apikey as string | undefined;
  if (apiKey) {
    const result = await validateApiKey(apiKey);
    if (result.valid && result.projectId) {
      request.user = { kind: 'apikey', projectId: result.projectId, role: 'anon' };
    }
  }
}

// Schema 访问验证中间件 - 验证用户是否有权访问指定 schema
// 用于 /schemas/:schema/* 或 /schemas/:schemaName/* 路由
export async function verifySchemaAccess(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  const user = request.user;
  const userId = user && isPlatformUser(user) ? user.userId : undefined;
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
