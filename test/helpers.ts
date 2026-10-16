/**
 * Integration test harness: a fresh database per test file (fixtures, then migrations), the real app built in-process,
 * a mailer that records messages, and a job queue that records jobs. Requests go through app.inject(), so routing,
 * parsing, auth, policies and SQL are all exercised for real.
 *
 *   const t = await bootTest();
 *   const session = await signUp(t, 'a@example.com');
 *   const res = await t.app.inject({ method: 'GET', url: '/rest/v1/profiles?select=id', headers: bearer(session.access_token) });
 */
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pino from 'pino';
import postgres from 'postgres';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { loadEnv, resetEnvCache, type Env } from '../src/config/env.js';
import { createDeps, type Deps } from '../src/deps.js';
import { MemoryJobs } from '../src/jobs/queues.js';
import { MemoryKv } from '../src/lib/redis.js';
import { migrate } from '../src/migrate.js';
import { LogMailer } from '../src/vendors/email.js';
import { PolicyRegistry, type RpcDefinition, type TablePolicy } from '../src/compat/postgrest/policy.js';

const here = dirname(fileURLToPath(import.meta.url));
export const FIXTURES = ['base.sql', 'accounts.sql', 'celebrities.sql', 'content.sql', 'hub.sql'];
export const ANON_KEY = 'test-anon-key';

export interface TestCtx {
  app: FastifyInstance;
  deps: Deps;
  env: Env;
  mailer: LogMailer;
  jobs: MemoryJobs;
  /** A superuser connection for arranging and asserting state directly. */
  sql: postgres.Sql;
  close(): Promise<void>;
}

export interface BootOptions {
  /** Replace all registered policies with these (unit-style tests of the engine). */
  policies?: TablePolicy[];
  rpcs?: RpcDefinition[];
  /** Extra fixture files to load after the standard ones (e.g. 'balance-trigger.sql'). */
  extraFixtures?: string[];
  /** Environment overrides for this test file. */
  env?: Record<string, string>;
}

export async function bootTest(opts: BootOptions = {}): Promise<TestCtx> {
  for (const [k, v] of Object.entries(opts.env ?? {})) process.env[k] = v;
  resetEnvCache();
  const env = loadEnv();
  const log = pino({ level: 'silent' });

  const admin = postgres(env.DATABASE_URL, { max: 1, onnotice: () => {} });
  await admin.unsafe(`
    drop schema if exists wishme cascade;
    drop schema if exists auth cascade;
    drop schema if exists public cascade;
    create schema public;`);
  for (const f of [...FIXTURES, ...(opts.extraFixtures ?? [])]) {
    const text = await readFile(resolve(here, 'fixtures', f), 'utf8');
    if (text.trim()) await admin.unsafe(text);
  }
  await admin.end();
  await migrate();
  // The profile trigger needs auth.users, which migration 0002 creates in standalone mode.
  const sql = postgres(env.DATABASE_URL, { max: 2, onnotice: () => {} });
  await sql.unsafe(`
    do $$ begin
      if exists (select 1 from pg_proc where proname = 'handle_new_user') then
        drop trigger if exists on_auth_user_created on auth.users;
        create trigger on_auth_user_created after insert on auth.users for each row execute function public.handle_new_user();
      end if;
    end $$;`);

  const mailer = new LogMailer(log);
  const jobs = new MemoryJobs();
  const deps = await createDeps(env, log, { mailer, jobs, kv: new MemoryKv(), redis: null });
  if (opts.policies || opts.rpcs) {
    deps.policies = new PolicyRegistry().addTables(opts.policies ?? []).addRpcs(opts.rpcs ?? []);
  }
  await deps.schema.load();
  const { app } = await buildApp(deps, { realtime: false });
  await app.ready();
  return {
    app,
    deps,
    env,
    mailer,
    jobs,
    sql,
    async close() {
      await app.close();
      await deps.close();
      await sql.end({ timeout: 5 });
    },
  };
}

export const anon = () => ({ apikey: ANON_KEY });
export const bearer = (token: string) => ({ apikey: ANON_KEY, authorization: `Bearer ${token}` });

/** The most recent OTP mailed to `email`. */
export function lastOtp(mailer: LogMailer, email: string): string {
  const msg = [...mailer.sent].reverse().find((m) => m.to === email);
  const code = msg?.subject.match(/\b(\d{6})\b/)?.[1];
  if (!code) throw new Error(`no OTP mailed to ${email}`);
  return code;
}

export interface TestSession {
  access_token: string;
  refresh_token: string;
  user: { id: string; email: string };
}

/** Runs the app's real sign-up flow: send-email-otp → verify-email-otp → /auth/v1/signup. */
export async function signUp(
  t: TestCtx,
  email: string,
  password = 'Str0ng-and-l0ng-pass',
  data: Record<string, unknown> = { first_name: 'Test', last_name: 'User', phone: '9876543210' },
): Promise<TestSession> {
  const send = await t.app.inject({ method: 'POST', url: '/functions/v1/send-email-otp', headers: anon(), payload: { email } });
  if (send.statusCode !== 200) throw new Error(`send-email-otp ${send.statusCode}: ${send.body}`);
  const otp = lastOtp(t.mailer, email);
  const verify = await t.app.inject({ method: 'POST', url: '/functions/v1/verify-email-otp', headers: anon(), payload: { email, otp } });
  if (verify.statusCode !== 200) throw new Error(`verify-email-otp ${verify.statusCode}: ${verify.body}`);
  const res = await t.app.inject({ method: 'POST', url: '/auth/v1/signup', headers: anon(), payload: { email, password, data } });
  if (res.statusCode !== 200) throw new Error(`signup ${res.statusCode}: ${res.body}`);
  return res.json() as TestSession;
}

/** profiles.id for an auth user. */
export async function profileIdOf(t: TestCtx, userId: string): Promise<string> {
  const rows = await t.sql<{ id: string }[]>`select id from public.profiles where user_id = ${userId}`;
  if (!rows[0]) throw new Error('profile not created');
  return rows[0].id;
}
