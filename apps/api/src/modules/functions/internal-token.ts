import jwt from 'jsonwebtoken';
import { config } from '../../config/index.js';

export interface InternalFunctionTokenPayload {
  projectId: string;
  functionName: string;
  authType: 'jwt' | 'apikey';
  iat?: number;
  exp?: number;
}

interface SignInternalFunctionTokenInput {
  projectId: string;
  functionName: string;
  authType: 'jwt' | 'apikey';
  expiresIn?: number;
}

function getInternalTokenSecret(): string {
  if (!config.functions.internalTokenSecret) {
    throw new Error('FUNCTIONS_INTERNAL_TOKEN_SECRET or JWT_SECRET must be configured');
  }

  return config.functions.internalTokenSecret;
}

export function signInternalFunctionToken(input: SignInternalFunctionTokenInput): string {
  const secret = getInternalTokenSecret();
  const { expiresIn = config.functions.internalTokenTtlSeconds, ...payload } = input;

  return jwt.sign(payload, secret, {
    expiresIn,
  });
}

export function verifyInternalFunctionToken(token: string): InternalFunctionTokenPayload {
  const secret = getInternalTokenSecret();
  return jwt.verify(token, secret) as InternalFunctionTokenPayload;
}
