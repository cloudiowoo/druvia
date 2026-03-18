import type { FastifyInstance } from 'fastify';
import * as controller from './rpc.controller.js';
import { authenticate } from '../../middleware/auth.js';

const auth = { preHandler: authenticate };

export async function rpcRoutes(fastify: FastifyInstance) {
  fastify.post('/projects/:projectId/rpc/:functionName', auth, controller.invokeRpc as never);
}
