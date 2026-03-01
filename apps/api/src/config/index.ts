import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: resolve(__dirname, '../../../../.env') });

export const config = {
  port: parseInt(process.env.PORT || '3001', 10),
  host: process.env.HOST || '0.0.0.0',
  nodeEnv: process.env.NODE_ENV || 'development',
  corsOrigins: process.env.CORS_ORIGINS?.split(',').map((s) => s.trim()) || [],
  database: {
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT || '5432', 10),
    user: process.env.DB_USER || 'postgres',
    password: process.env.POSTGRES_PASSWORD || '',
    database: process.env.DB_NAME || 'druvia',
  },
  jwt: {
    secret: process.env.JWT_SECRET || '',
  },
  redis: {
    url: process.env.REDIS_URL || 'redis://localhost:6379',
  },
  hasura: {
    adminSecret: process.env.HASURA_ADMIN_SECRET || '',
    endpoint: process.env.HASURA_ENDPOINT || 'http://localhost:8080',
  },
};
