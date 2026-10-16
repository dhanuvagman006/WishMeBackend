/**
 * Test environment: real Postgres and Redis from docker-compose.test.yml (ports 55432 / 56379), never production
 * secrets. Values can be overridden by the CI environment.
 */
process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL ??= 'silent';
process.env.PUBLIC_URL ??= 'http://localhost:3000';
process.env.DATABASE_URL ??= 'postgres://postgres:postgres@127.0.0.1:55432/wishme_test';
process.env.DB_MODE ??= 'standalone';
process.env.DB_RLS_PASSTHROUGH ??= 'false';
process.env.COMPAT_DEFAULT_MODE ??= 'local';
process.env.SUPABASE_ANON_KEY ??= 'test-anon-key';
process.env.SUPABASE_JWT_SECRET ??= 'test-jwt-secret-that-is-at-least-32-characters-long';
process.env.AUTH_PEPPER ??= 'test-pepper-0123456789abcdef0123456789abcdef';
process.env.PASSWORD_BREACH_CHECK ??= 'false';
process.env.EMAIL_PROVIDER ??= 'log';
