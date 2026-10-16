/**
 * The dependency container: one instance per process, built once at startup. Route handlers, policies and job
 * processors receive it instead of importing singletons, which keeps tests able to swap the mailer, KV store or job
 * queue.
 */
import type { Redis } from 'ioredis';
import type { Env } from './config/env.js';
import { AuthResolver } from './auth/context.js';
import { createTokenService, type TokenService } from './auth/jwt.js';
import { Otps } from './auth/otp.js';
import { Passwords } from './auth/passwords.js';
import { RefreshTokens } from './auth/refresh-tokens.js';
import { AuthService } from './auth/service.js';
import { UsersRepo } from './auth/users-repo.js';
import { FunctionRegistry } from './compat/functions/registry.js';
import { allFunctions } from './compat/functions/index.js';
import { RouteModes } from './compat/modes.js';
import { allPolicies, allRpcs } from './compat/postgrest/policies/index.js';
import { PolicyRegistry } from './compat/postgrest/policy.js';
import { SchemaCache } from './compat/postgrest/schema-cache.js';
import { SupabaseProxy } from './compat/proxy.js';
import { Payments } from './domains/payments/service.js';
import { registerPaymentPurposes } from './domains/payments/purposes.js';
import { Ledger } from './domains/wallet/ledger.js';
import { BullJobs, MemoryJobs, type Jobs } from './jobs/queues.js';
import { createDb, type Db } from './lib/db.js';
import type { Logger } from './lib/logger.js';
import { RateLimiter } from './lib/rate-limit.js';
import { createRedis, MemoryKv, RedisKv, type Kv } from './lib/redis.js';
import { createMailer, type Mailer } from './vendors/email.js';
import { Razorpay } from './vendors/razorpay.js';

export interface Deps {
  env: Env;
  log: Logger;
  db: Db;
  redis: Redis | null;
  kv: Kv;
  limiter: RateLimiter;
  tokens: TokenService;
  resolver: AuthResolver;
  passwords: Passwords;
  users: UsersRepo;
  refresh: RefreshTokens;
  otps: Otps;
  auth: AuthService;
  mailer: Mailer;
  schema: SchemaCache;
  policies: PolicyRegistry;
  functions: FunctionRegistry;
  modes: RouteModes;
  proxy: SupabaseProxy;
  jobs: Jobs;
  razorpay: Razorpay;
  ledger: Ledger;
  payments: Payments;
  /** Per-process cache for vendor clients and other lazily built helpers. */
  memo<T>(key: string, make: () => T): T;
  close(): Promise<void>;
}

export interface DepsOverrides {
  db?: Db;
  kv?: Kv;
  mailer?: Mailer;
  jobs?: Jobs;
  redis?: Redis | null;
}

export async function createDeps(env: Env, log: Logger, o: DepsOverrides = {}): Promise<Deps> {
  const db = o.db ?? createDb(env, log);
  const redis = o.redis !== undefined ? o.redis : createRedis(env, 'app');
  const kv = o.kv ?? (redis ? new RedisKv(redis, env.REDIS_PREFIX) : new MemoryKv());
  const limiter = new RateLimiter(kv);
  const tokens = await createTokenService(env);
  const resolver = new AuthResolver(env, tokens, db, kv);
  const passwords = new Passwords(env.DB_MODE, log);
  const users = new UsersRepo(db, env.DB_MODE);
  const refresh = new RefreshTokens(db, env);
  const otps = new Otps(db, env, limiter);
  const mailer = o.mailer ?? createMailer(env, log);
  const auth = new AuthService(env, db, log, users, passwords, refresh, tokens, otps, mailer, limiter, resolver);
  const schema = new SchemaCache(db, log);
  const policies = new PolicyRegistry().addTables(allPolicies).addRpcs(allRpcs);
  const functions = new FunctionRegistry().add(allFunctions);
  const modes = new RouteModes(env);
  const proxy = new SupabaseProxy(env);
  let bullRedis: Redis | null = null;
  let jobs: Jobs;
  if (o.jobs) jobs = o.jobs;
  else if (env.REDIS_URL) {
    bullRedis = createRedis(env, 'bullmq');
    jobs = new BullJobs(bullRedis!, env.REDIS_PREFIX);
  } else jobs = new MemoryJobs();
  const razorpay = new Razorpay(env, log);
  const ledger = new Ledger(db, schema, log);
  const payments = new Payments(db, schema, razorpay, ledger, log);
  const memoStore = new Map<string, unknown>();

  const deps: Deps = {
    env,
    log,
    db,
    redis,
    kv,
    limiter,
    tokens,
    resolver,
    passwords,
    users,
    refresh,
    otps,
    auth,
    mailer,
    schema,
    policies,
    functions,
    modes,
    proxy,
    jobs,
    razorpay,
    ledger,
    payments,
    memo<T>(key: string, make: () => T): T {
      if (!memoStore.has(key)) memoStore.set(key, make());
      return memoStore.get(key) as T;
    },
    async close() {
      await jobs.close().catch(() => {});
      bullRedis?.disconnect();
      await kv.close().catch(() => {});
      await db.end({ timeout: 10 }).catch(() => {});
    },
  };
  registerPaymentPurposes(deps);
  return deps;
}
