/**
 * Shared-mode defence in depth: with DB_RLS_PASSTHROUGH=true, compat queries run as the `authenticated` / `anon` role
 * with request.jwt.claims set, so Postgres row-level security written against auth.uid() (as Supabase policies are)
 * still applies underneath our own policies. Here the table policy is deliberately too permissive and RLS has to save us.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { definePolicy } from '../../src/compat/postgrest/policy.js';
import { anon, bearer, bootTest, signUp, type TestCtx, type TestSession } from '../helpers.js';

let t: TestCtx;
let alice: TestSession;
let bob: TestSession;

beforeAll(async () => {
  t = await bootTest({
    env: { DB_RLS_PASSTHROUGH: 'true' },
    policies: [definePolicy({ table: 'profiles', read: [{ name: 'too-wide', rows: () => 'all', columns: ['id', 'user_id', 'first_name'] }] })],
  });
  await t.sql.unsafe(`
    grant usage on schema public to anon, authenticated;
    grant select on public.profiles to anon, authenticated;
    alter table public.profiles enable row level security;
    create policy own_profile on public.profiles for select to authenticated using (user_id = auth.uid());`);
  alice = await signUp(t, 'rls-alice@example.com', undefined, { first_name: 'Alice' });
  bob = await signUp(t, 'rls-bob@example.com', undefined, { first_name: 'Bob' });
});
afterAll(async () => {
  process.env.DB_RLS_PASSTHROUGH = 'false';
  await t.close();
});

describe('RLS passthrough', () => {
  it('lets Postgres RLS narrow what a permissive policy would return', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/rest/v1/profiles?select=first_name', headers: bearer(alice.access_token) });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([{ first_name: 'Alice' }]);
    const other = await t.app.inject({ method: 'GET', url: '/rest/v1/profiles?select=first_name', headers: bearer(bob.access_token) });
    expect(other.json()).toEqual([{ first_name: 'Bob' }]);
  });

  it('runs anonymous callers as the anon role (no RLS policy for anon → nothing)', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/rest/v1/profiles?select=first_name', headers: anon() });
    expect(res.json()).toEqual([]);
  });
});
