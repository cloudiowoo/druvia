import jwt from 'jsonwebtoken';
import { config } from '../../config/index.js';
import {
  PROJECT_ACTOR_CONTRACT_VERSION,
  parseProjectActorContext,
  type ProjectActorContext,
} from '../../lib/project-actor.js';

export interface InternalFunctionTokenPayload {
  tokenType: 'function_internal';
  actorContractVersion: 1;
  projectId: string;
  functionName: string;
  actor: ProjectActorContext;
  iat?: number;
  exp?: number;
}

interface SignInternalFunctionTokenInput {
  projectId: string;
  functionName: string;
  actor: ProjectActorContext;
  expiresIn?: number;
}

function getInternalTokenSecret(): string {
  if (!config.functions.internalTokenSecret) {
    throw new Error('FUNCTIONS_INTERNAL_TOKEN_SECRET or JWT_SECRET must be configured');
  }

  return config.functions.internalTokenSecret;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function signInternalFunctionToken(input: SignInternalFunctionTokenInput): string {
  const secret = getInternalTokenSecret();
  const actor = parseProjectActorContext(input.actor);
  if (
    !isNonEmptyString(input.projectId)
    || !isNonEmptyString(input.functionName)
    || actor.projectId !== input.projectId
  ) {
    throw new Error('Invalid internal function token input');
  }

  return jwt.sign({
    tokenType: 'function_internal',
    actorContractVersion: PROJECT_ACTOR_CONTRACT_VERSION,
    projectId: input.projectId,
    functionName: input.functionName,
    actor,
  }, secret, {
    expiresIn: input.expiresIn ?? config.functions.internalTokenTtlSeconds,
  });
}

export function verifyInternalFunctionToken(token: string): InternalFunctionTokenPayload {
  const decoded = jwt.verify(token, getInternalTokenSecret());
  if (
    !isRecord(decoded)
    || decoded.tokenType !== 'function_internal'
    || decoded.actorContractVersion !== PROJECT_ACTOR_CONTRACT_VERSION
    || !isNonEmptyString(decoded.projectId)
    || !isNonEmptyString(decoded.functionName)
    || (decoded.iat !== undefined && typeof decoded.iat !== 'number')
    || (decoded.exp !== undefined && typeof decoded.exp !== 'number')
  ) {
    throw new Error('Invalid internal function token');
  }

  let actor: ProjectActorContext;
  try {
    actor = parseProjectActorContext(decoded.actor);
  } catch {
    throw new Error('Invalid internal function token');
  }
  if (
    decoded.actorContractVersion !== actor.version
    || decoded.projectId !== actor.projectId
  ) {
    throw new Error('Invalid internal function token');
  }

  return {
    tokenType: 'function_internal',
    actorContractVersion: PROJECT_ACTOR_CONTRACT_VERSION,
    projectId: decoded.projectId,
    functionName: decoded.functionName,
    actor,
    ...(typeof decoded.iat === 'number' ? { iat: decoded.iat } : {}),
    ...(typeof decoded.exp === 'number' ? { exp: decoded.exp } : {}),
  };
}
