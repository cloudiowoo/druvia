import Fastify from 'fastify';
import { config } from './config/index.js';
import authPlugin from './middleware/auth.js';
import { tenantRoutes } from './modules/tenant/tenant.routes.js';
import { userRoutes } from './modules/user/user.routes.js';
import { projectRoutes } from './modules/project/project.routes.js';

const app = Fastify({
  logger: true,
});

// Register plugins
app.register(authPlugin);

// Health check
app.get('/health', async () => {
  return { status: 'ok', timestamp: new Date().toISOString() };
});

// Register routes
app.register(userRoutes, { prefix: '/api/v1' });
app.register(tenantRoutes, { prefix: '/api/v1' });
app.register(projectRoutes, { prefix: '/api/v1' });

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
