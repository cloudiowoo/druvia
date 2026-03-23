import Fastify from 'fastify';
import type { FastifyCorsOptions } from '@fastify/cors';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import { pathToFileURL } from 'node:url';
import { config } from './config/index.js';
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
import { realtimeRoutes } from './modules/realtime/realtime.routes.js';
import { sqlRoutes } from './modules/sql/sql.routes.js';
import { functionsRoutes } from './modules/functions/functions.routes.js';
import { internalFunctionsGraphqlRoutes } from './modules/functions/internal-graphql.routes.js';
import { openapiRoutes } from './modules/openapi/openapi.routes.js';
import { apiKeysRoutes } from './modules/api-keys/api-keys.routes.js';
import { environmentRoutes } from './modules/environment/environment.routes.js';
import { rpcRoutes } from './modules/rpc/rpc.routes.js';

export const appCorsOptions: FastifyCorsOptions = {
  origin:
    config.nodeEnv === 'development'
      ? true // 开发环境允许所有来源
      : config.corsOrigins.length > 0
        ? config.corsOrigins
        : false,
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'apikey'],
};

export function buildApp() {
  const app = Fastify({
    logger: true,
  });

  app.register(cors, appCorsOptions);
  app.register(authPlugin);
  app.register(multipart, {
    limits: {
      fileSize: 50 * 1024 * 1024, // 50MB
    },
  });

  // Health check
  app.get('/health', async () => {
    return { status: 'ok', timestamp: new Date().toISOString() };
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
  app.register(realtimeRoutes, { prefix: '/api/v1' });
  app.register(sqlRoutes, { prefix: '/api/v1' });
  app.register(functionsRoutes, { prefix: '/api/v1' });
  app.register(internalFunctionsGraphqlRoutes, { prefix: '/api' });
  app.register(openapiRoutes, { prefix: '/api/v1' });
  app.register(apiKeysRoutes, { prefix: '/api/v1' });
  app.register(environmentRoutes, { prefix: '/api/v1' });
  app.register(rpcRoutes, { prefix: '/api/v1' });

  return app;
}

async function start() {
  const app = buildApp();
  try {
    await app.listen({ port: config.port, host: config.host });
    console.log(`Server running at http://${config.host}:${config.port}`);
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
