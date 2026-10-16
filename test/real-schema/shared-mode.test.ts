/**
 * Shared mode against a structure-only restore of the production schema (no data). Skipped unless REAL_SCHEMA_DB
 * points at such a database; see docs/RUNBOOK.md "Validating against the real schema".
 *
 * Proves that this server's writes are acceptable to Supabase itself: users created here have the auth.users,
 * auth.identities and auth.sessions rows GoTrue needs, production's sign-up trigger creates the profile, every table
 * policy names only real columns, and the ledger lands on the right balance under the real wallet trigger.
 */
import pino from 'pino';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import { validatePolicies } from '../../src/compat/postgrest/compiler.js';
import { loadEnv, resetEnvCache } from '../../src/config/env.js';
import { createDeps, type Deps } from '../../src/deps.js';
import { MemoryJobs } from '../../src/jobs/queues.js';
import { MemoryKv } from '../../src/lib/redis.js';
import { migrate } from '../../src/migrate.js';
import { LogMailer } from '../../src/vendors/email.js';
import type { FastifyInstance } from 'fastify';

const DB = process.env.REAL_SCHEMA_DB;
const run = Date.now().toString(36);

describe.skipIf(!DB)('shared mode on the production schema', () => {
  let deps: Deps;
  let app: FastifyInstance;
  let mailer: LogMailer;
  let sql: postgres.Sql;

  beforeAll(async () => {
    process.env.DATABASE_URL = DB!;
    process.env.DB_MODE = 'shared';
    process.env.DB_RLS_PASSTHROUGH = 'false';
    resetEnvCache();
    await migrate();
    const env = loadEnv();
    const log = pino({ level: 'silent' });
    mailer = new LogMailer(log);
    deps = await createDeps(env, log, { mailer, jobs: new MemoryJobs(), kv: new MemoryKv(), redis: null });
    await deps.schema.load();
    app = (await buildApp(deps, { realtime: false })).app;
    await app.ready();
    sql = postgres(DB!, { max: 1, onnotice: () => {} });
  });
  afterAll(async () => {
    await app?.close();
    await deps?.close();
    await sql?.end({ timeout: 5 });
  });

  it('every table policy names only real tables and columns', () => {
    expect(validatePolicies(deps.schema, deps.policies)).toEqual([]);
  });

  it('signs up through the app flow and leaves GoTrue-valid rows plus a trigger-made profile', async () => {
    const email = `shared-${run}@example.com`;
    const anon = { apikey: process.env.SUPABASE_ANON_KEY! };
    await app.inject({ method: 'POST', url: '/functions/v1/send-email-otp', headers: anon, payload: { email } });
    const otp = [...mailer.sent].reverse().find((m) => m.to === email)!.subject.slice(0, 6);
    expect((await app.inject({ method: 'POST', url: '/functions/v1/verify-email-otp', headers: anon, payload: { email, otp } })).statusCode).toBe(200);
    const res = await app.inject({ method: 'POST', url: '/auth/v1/signup', headers: anon, payload: { email, password: 'Str0ng-and-l0ng-pass', data: { first_name: 'Real', last_name: 'Schema' } } });
    expect(res.statusCode, res.body).toBe(200);
    const s = res.json() as { access_token: string; refresh_token: string; user: { id: string } };

    const u = await sql`select aud, role, instance_id::text, encrypted_password like '$2%' as bcrypt, confirmation_token, email_confirmed_at is not null as confirmed from auth.users where id = ${s.user.id}`;
    expect(u[0]).toMatchObject({ aud: 'authenticated', role: 'authenticated', bcrypt: true, confirmation_token: '', confirmed: true });
    expect((await sql`select count(*)::int as n from auth.identities where user_id = ${s.user.id} and provider = 'email'`)[0]!.n).toBe(1);
    expect((await sql`select count(*)::int as n from public.profiles where user_id = ${s.user.id}`)[0]!.n).toBe(1);

    const login = await app.inject({ method: 'POST', url: '/auth/v1/token?grant_type=password', headers: anon, payload: { email, password: 'Str0ng-and-l0ng-pass' } });
    expect(login.statusCode).toBe(200);
    const sessionId = JSON.parse(Buffer.from(login.json().access_token.split('.')[1], 'base64url').toString()).session_id as string;
    expect((await sql`select count(*)::int as n from auth.sessions where id = ${sessionId}`)[0]!.n).toBe(1);
    const refreshed = await app.inject({ method: 'POST', url: '/auth/v1/token?grant_type=refresh_token', headers: anon, payload: { refresh_token: s.refresh_token } });
    expect(refreshed.statusCode).toBe(200);
  });

  it('lands on the intended balance under the real wallet trigger for every kind of movement', async () => {
    const p = await sql<{ id: string }[]>`select id from public.profiles where email = ${`shared-${run}@example.com`}`;
    const id = p[0]!.id;
    await sql`update public.profiles set wallet_balance = 1000 where id = ${id}`;
    const balance = async () => Number((await sql`select wallet_balance from public.profiles where id = ${id}`)[0]!.wallet_balance);
    const move = (deltaPaise: number, kind: string, key: string) =>
      deps.ledger.run('user_wallet', { accountId: id, deltaPaise, kind, idempotencyKey: `${run}:${key}`, createdBy: 'test' });
    await move(50_000, 'deposit', 'a'); // trigger credits deposit
    expect(await balance()).toBe(1500);
    await move(-20_000, 'booking', 'b'); // trigger debits booking
    expect(await balance()).toBe(1300);
    await move(-10_000, 'service_payment', 'c'); // trigger ignores service_payment: ledger debits
    expect(await balance()).toBe(1200);
    await move(5_000, 'refund', 'd'); // not an allowed history type: recorded as admin_credit
    expect(await balance()).toBe(1250);
    await expect(move(-50, 'debit', 'e')).rejects.toMatchObject({ code: 'invalid_amount' });
  });
});
