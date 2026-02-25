// Set test environment variables before any imports
process.env.JWT_SECRET = 'test-secret-key-for-testing-only-32chars';
process.env.DB_HOST = 'localhost';
process.env.DB_PORT = '5432';
process.env.DB_USER = 'postgres';
process.env.DB_NAME = 'druvia';
process.env.POSTGRES_PASSWORD = 'druvia_dev_password';
process.env.HASURA_ADMIN_SECRET = ''; // Disable Hasura webhook verification in tests
process.env.REDIS_URL = 'redis://localhost:6379';
