import { pathToFileURL } from 'node:url';
import Fastify, { type FastifyReply } from 'fastify';
import { parseUpdaterConfig } from './config.js';
import {
  UpdateOperationInProgressError,
  UpdatePreconditionError,
  UpdateService,
  type UpdateRouteService,
} from './update-service.js';

export interface BuildUpdaterAppOptions {
  updaterSecret?: string;
  service?: UpdateRouteService;
}

export function buildApp(options: BuildUpdaterAppOptions = {}) {
  const config = options.updaterSecret || options.service ? null : parseUpdaterConfig();
  const updaterSecret = options.updaterSecret ?? config?.updaterSecret;
  const service = options.service ?? new UpdateService(config!);
  const app = Fastify({
    logger: process.env.NODE_ENV === 'test' ? false : true,
  });

  app.addHook('onRequest', async (request, reply) => {
    if (!request.url.startsWith('/internal/')) return;
    if (request.headers['x-druvia-updater-secret'] !== updaterSecret) {
      return reply.status(401).send({
        error: { code: 'UNAUTHORIZED', message: 'Invalid updater secret' },
      });
    }
  });

  app.get('/health', async () => ({
    status: 'ok',
    service: 'druvia-updater',
  }));

  app.get('/internal/update/status', async () => service.getStatus());
  app.post('/internal/update/check', async (_request, reply) => sendMutation(reply, () => service.checkForUpdates()));
  app.post('/internal/update/download', async (_request, reply) => sendMutation(reply, () => service.downloadUpdate()));
  app.post('/internal/update/apply', async (_request, reply) => sendMutation(reply, () => service.applyUpdate()));
  app.post('/internal/update/rollback', async (_request, reply) => sendMutation(reply, () => service.rollbackUpdate()));
  app.post('/internal/restart', async (_request, reply) => sendMutation(reply, () => service.restartServices()));

  return app;
}

async function sendMutation<T>(
  reply: FastifyReply,
  action: () => Promise<T>
): Promise<void> {
  try {
    const result = await action();
    reply.status(202).send(result);
  } catch (error) {
    if (error instanceof UpdateOperationInProgressError) {
      reply.status(409).send({
        error: {
          code: 'UPDATE_IN_PROGRESS',
          message: error.message,
          operationId: error.operationId,
        },
      });
      return;
    }
    if (error instanceof UpdatePreconditionError) {
      reply.status(409).send({
        error: {
          code: error.code,
          message: error.message,
        },
      });
      return;
    }
    throw error;
  }
}

async function start(): Promise<void> {
  const app = buildApp();
  const port = Number(process.env.PORT ?? 3010);
  const host = process.env.HOST ?? '0.0.0.0';

  await app.listen({ port, host });
}

const isMainModule = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMainModule) {
  start().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
