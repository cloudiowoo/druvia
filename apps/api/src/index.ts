import Fastify from 'fastify';
import type { FastifyCorsOptions } from '@fastify/cors';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import { pathToFileURL } from 'node:url';
import { config } from './config/index.js';
import { pool } from './db/index.js';
import { assertSupportedDatabaseMigrationVersion } from './db/migration-compatibility.js';
import { mergeApiLogContext } from './lib/log-context.js';
import { toFastifySerializedError } from './lib/logger.js';
import authPlugin from './middleware/auth.js';
import { tenantRoutes } from './modules/tenant/tenant.routes.js';
import { userRoutes } from './modules/user/user.routes.js';
import { projectRoutes } from './modules/project/project.routes.js';
import { fileRoutes } from './modules/file/file.routes.js';
import { oauthRoutes } from './modules/oauth/oauth.routes.js';
import { tableRoutes } from './modules/table/table.routes.js';
import { backupRoutes } from './modules/backup/backup.routes.js';
import { actionsRoutes } from './modules/actions/actions.routes.js';
import { dataRoutes } from './modules/data/data.routes.js';
import { settingsRoutes } from './modules/settings/settings.routes.js';
import { dashboardRoutes } from './modules/dashboard/dashboard.routes.js';
import { storageRoutes } from './modules/storage/storage.routes.js';
import { authAdminRoutes } from './modules/auth-admin/auth-admin.routes.js';
import { projectAuthRoutes } from './modules/project-auth/project-auth.routes.js';
import { realtimeRoutes } from './modules/realtime/realtime.routes.js';
import { sqlRoutes } from './modules/sql/sql.routes.js';
import { functionsRoutes } from './modules/functions/functions.routes.js';
import { internalFunctionsGraphqlRoutes } from './modules/functions/internal-graphql.routes.js';
import { internalFunctionsStorageRoutes } from './modules/functions/internal-storage.routes.js';
import { openapiRoutes } from './modules/openapi/openapi.routes.js';
import { apiKeysRoutes } from './modules/api-keys/api-keys.routes.js';
import { trustedBackendKeysRoutes } from './modules/trusted-backend-keys/trusted-backend-keys.routes.js';
import { environmentRoutes } from './modules/environment/environment.routes.js';
import { rpcRoutes } from './modules/rpc/rpc.routes.js';
import { systemUpdateRoutes } from './modules/system-update/system-update.routes.js';
import { dataAccessRoutes } from './modules/data-access/data-access.routes.js';
import { projectMemberRoutes } from './modules/project-members/project-members.routes.js';
import {
  recoverPendingTableDeletions,
  startTableDeletionRecoveryLoop,
} from './modules/table/table-deletion-recovery.service.js';
import {
  getAccountDeletionExecutorHealth,
  startAccountDeletionExecutor,
} from './modules/project-auth/project-account-deletion.executor.js';

export const appCorsOptions: FastifyCorsOptions = {
  origin:
    config.nodeEnv === 'development'
      ? true // 开发环境允许所有来源
      : config.corsOrigins.length > 0
        ? config.corsOrigins
        : false,
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: [
    'Content-Type',
    'Authorization',
    'apikey',
    'Idempotency-Key',
    'X-Druvia-Deletion-Token',
    'X-Druvia-Binding-Token',
    'x-druvia-storage-ticket',
    'x-druvia-trusted-backend-key',
  ],
};

export function sanitizeRequestUrlForLogging(url: string): string {
  const path = url.split(/[?#]/, 1)[0]!;
  let classified = url;
  const encodedHandlePrefix = /(?:d|%(?:25)*64)(?:w|%(?:25)*77)(?:b|%(?:25)*62)(?:_|%(?:25)*5f)/i;
  if (encodedHandlePrefix.test(classified)) {
    return '/[REDACTED]/device-wipe/bindings/[REDACTED]';
  }
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const decoded = classified.replace(/%([a-f0-9]{2})/gi, (_, hex: string) => (
      String.fromCharCode(Number.parseInt(hex, 16))
    ));
    if (decoded === classified) break;
    classified = decoded;
  }
  classified = classified.replace(/\\/g, '/').replace(/\/{2,}/g, '/');
  if (/\/device-wipe\/bindings(?:\/|$)/i.test(classified) || /dwb_/i.test(classified)) {
    return '/[REDACTED]/device-wipe/bindings/[REDACTED]';
  }
  return path;
}

export function buildApp(options: { trustProxy?: boolean } = {}) {
  const app = Fastify({
    trustProxy: options.trustProxy ?? config.trustProxy,
    logger: {
      level: config.nodeEnv === 'development' ? 'debug' : 'info',
      messageKey: 'msg',
      base: {
        service: 'api',
        env: config.nodeEnv,
      },
      timestamp: () => `,"ts":"${new Date().toISOString()}"`,
      formatters: {
        level: (label) => ({ level: label }),
      },
      serializers: {
        err: (error) => toFastifySerializedError(error),
        req: (request) => ({
          requestId: request.id,
          method: request.method,
          url: sanitizeRequestUrlForLogging(request.url),
          remoteAddress: request.ip,
        }),
        res: (reply) => ({
          statusCode: reply.statusCode,
        }),
      },
      redact: {
        paths: [
          'req.headers.authorization',
          'req.headers.apikey',
          'req.headers.x-druvia-deletion-token',
          'req.headers.x-druvia-binding-token',
          'authorization',
          'apikey',
          'password',
          'refreshToken',
          'refresh_token',
          'token',
          'req.body.authorizationCode',
          'req.body.authorization_code',
          'req.body.identityToken',
          'req.body.identity_token',
          'req.body.id_token',
          'req.body.rawNonce',
          'req.body.payload',
          'providerRefreshToken',
          'statusToken',
          'bindingIdentity',
          'bindingLookupToken',
          'reauthNonce',
        ],
        remove: true,
      },
    },
  });

  app.addHook('onRequest', async (request) => {
    mergeApiLogContext({ requestId: request.id });
  });

  app.addHook('preHandler', async (request) => {
    const params = (request.params ?? {}) as Record<string, unknown>;
    const user = request.user;

    mergeApiLogContext({
      ...(typeof params.tenantId === 'string' ? { tenantId: params.tenantId } : {}),
      ...(typeof params.projectId === 'string' ? { projectId: params.projectId } : {}),
      ...(
        typeof params.schemaName === 'string'
          ? { schemaName: params.schemaName }
          : typeof params.schema === 'string'
            ? { schemaName: params.schema }
            : {}
      ),
      ...(
        typeof params.tableName === 'string'
          ? { tableName: params.tableName }
          : typeof params.table === 'string'
            ? { tableName: params.table }
            : {}
      ),
      ...(user?.kind === 'platform_user' ? { userId: user.userId } : {}),
      ...(user?.kind === 'project_user'
        ? { projectId: user.projectId, projectUserId: user.sub }
        : {}),
      ...(user?.kind === 'apikey' ? { projectId: user.projectId } : {}),
    });
  });

  app.register(cors, appCorsOptions);
  app.register(authPlugin);
  app.register(multipart, {
    limits: {
      fileSize: 50 * 1024 * 1024, // 50MB
    },
  });

  app.setNotFoundHandler((_request, reply) => reply.status(404).send({
    success: false,
    error: { code: 'NOT_FOUND', message: 'Route not found' },
  }));

  // Health check
  app.get('/health', async (_request, reply) => {
    const accountDeletionHealth = await getAccountDeletionExecutorHealth();
    const accountDeletionExecutor = accountDeletionHealth.healthy;
    if (!accountDeletionExecutor) reply.status(503);
    return {
      status: accountDeletionExecutor ? 'ok' : 'degraded',
      accountDeletionExecutor,
      accountDeletionOverdueOperations: accountDeletionHealth.overdueOperations,
      accountDeletionAttentionRequiredOperations: accountDeletionHealth.attentionRequiredOperations,
      timestamp: new Date().toISOString(),
    };
  });
  app.get('/health/account-deletion-executor', async (_request, reply) => {
    const health = await getAccountDeletionExecutorHealth();
    if (!health.healthy) reply.status(503);
    return {
      status: health.healthy ? 'ok' : 'unavailable',
      overdueOperations: health.overdueOperations,
      attentionRequiredOperations: health.attentionRequiredOperations,
    };
  });

  // Register routes
  app.register(userRoutes, { prefix: '/api/v1' });
  app.register(tenantRoutes, { prefix: '/api/v1' });
  app.register(projectRoutes, { prefix: '/api/v1' });
  app.register(fileRoutes, { prefix: '/api/v1' });
  app.register(oauthRoutes, { prefix: '/api/v1' });
  app.register(tableRoutes, { prefix: '/api/v1' });
  app.register(backupRoutes, { prefix: '/api/v1' });
  app.register(actionsRoutes, { prefix: '/api/v1' });
  app.register(dataRoutes, { prefix: '/api/v1' });
  app.register(settingsRoutes, { prefix: '/api/v1' });
  app.register(dashboardRoutes, { prefix: '/api/v1' });
  app.register(storageRoutes, { prefix: '/api/v1' });
  app.register(authAdminRoutes, { prefix: '/api/v1' });
  app.register(projectAuthRoutes, { prefix: '/api/v1' });
  app.register(realtimeRoutes, { prefix: '/api/v1' });
  app.register(sqlRoutes, { prefix: '/api/v1' });
  app.register(functionsRoutes, { prefix: '/api/v1' });
  app.register(internalFunctionsGraphqlRoutes, { prefix: '/api' });
  app.register(internalFunctionsStorageRoutes, { prefix: '/api' });
  app.register(openapiRoutes, { prefix: '/api/v1' });
  app.register(apiKeysRoutes, { prefix: '/api/v1' });
  app.register(trustedBackendKeysRoutes, { prefix: '/api/v1' });
  app.register(environmentRoutes, { prefix: '/api/v1' });
  app.register(rpcRoutes, { prefix: '/api/v1' });
  app.register(systemUpdateRoutes, { prefix: '/api/v1' });
  app.register(dataAccessRoutes, { prefix: '/api/v1' });
  app.register(projectMemberRoutes, { prefix: '/api/v1' });

  return app;
}

async function start() {
  const app = buildApp();
  try {
    await assertSupportedDatabaseMigrationVersion(pool);
    const tableDeletionRecovery = await recoverPendingTableDeletions();
    if (tableDeletionRecovery.failed > 0) {
      app.log.warn(tableDeletionRecovery, 'some pending table deletions still require recovery');
    }
    const stopTableDeletionRecovery = startTableDeletionRecoveryLoop({
      runImmediately: false,
      onResult: (result) => {
        if (result.failed > 0) {
          app.log.warn(result, 'some pending table deletions still require recovery');
        }
      },
    });
    const stopAccountDeletionExecutor = await startAccountDeletionExecutor();
    app.addHook('onClose', async () => stopTableDeletionRecovery());
    app.addHook('onClose', stopAccountDeletionExecutor);
    await app.listen({ port: config.port, host: config.host });
    app.log.info(
      { host: config.host, port: config.port },
      'server running'
    );
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

const isMainModule = process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMainModule) {
  void start();
}
