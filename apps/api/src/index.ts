import Fastify from 'fastify';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
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

const app = Fastify({
  logger: true,
});

// Register plugins
app.register(cors, {
  origin: true, // Allow all origins in development
  credentials: true,
});
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

async function start() {
  try {
    await app.listen({ port: config.port, host: config.host });
    console.log(`Server running at http://${config.host}:${config.port}`);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

start();
