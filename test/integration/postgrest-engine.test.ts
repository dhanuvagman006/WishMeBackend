/**
 * The PostgREST-compatible engine against a real database, with hand-written policies (independent of the domain
 * policy files): grants and column masking, filters on hidden columns, embeds (FK column, constraint hint, !inner,
 * count), single-object responses, counts, upserts, write rules and errors.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from '../../src/lib/sql.js';
import { definePolicy } from '../../src/compat/postgrest/policy.js';
import { anon, bearer, bootTest, profileIdOf, signUp, type TestCtx, type TestSession } from '../helpers.js';

let t: TestCtx;
let alice: TestSession;
let bob: TestSession;
let aliceProfile: string;
let bobProfile: string;
let celebId: string;

const policies = [
  definePolicy({
    table: 'profiles',
    read: [
      { name: 'owner', rows: (c) => (c.identity.profileId ? sql`${c.col('id')} = ${c.identity.profileId}` : 'none'), columns: '*' },
      { name: 'public-card', rows: (c) => (c.auth.kind === 'anon' ? 'none' : 'all'), columns: ['id', 'first_name', 'avatar_url'] },
    ],
    update: {
      rows: (c) => (c.identity.profileId ? sql`${c.col('id')} = ${c.identity.profileId}` : 'none'),
      columns: ['first_name', 'last_name', 'phone', 'address'],
    },
  }),
  definePolicy({
    table: 'celebrities',
    read: [{ name: 'catalogue', rows: () => sql`true`, columns: ['id', 'name', 'category', 'image_url', 'rating', 'profile_id'] }],
  }),
  definePolicy({
    table: 'platform_settings',
    read: [{ name: 'public', rows: () => 'all', columns: '*' }],
    insert: { columns: ['setting_key', 'setting_value'] },
    update: { rows: () => 'all', columns: ['setting_value'] },
    upsertOn: [['setting_key']],
  }),
];

beforeAll(async () => {
  t = await bootTest({ policies });
  alice = await signUp(t, 'alice@example.com', undefined, { first_name: 'Alice', phone: '9000000001' });
  bob = await signUp(t, 'bob@example.com', undefined, { first_name: 'Bob', phone: '9000000002' });
  aliceProfile = await profileIdOf(t, alice.user.id);
  bobProfile = await profileIdOf(t, bob.user.id);
  await t.sql`update public.profiles set wallet_balance = 250, aadhaar_number = '123412341234' where id = ${aliceProfile}`;
  const c = await t.sql<{ id: string }[]>`insert into public.celebrities (profile_id, name, category) values (${bobProfile}, 'Bob Star', 'Singer') returning id`;
  celebId = c[0]!.id;
});
afterAll(async () => {
  await t.close();
});

describe('reads', () => {
  it('returns the owner every column and numbers as numbers', async () => {
    const res = await t.app.inject({ method: 'GET', url: `/rest/v1/profiles?select=id,wallet_balance,aadhaar_number&id=eq.${aliceProfile}`, headers: bearer(alice.access_token) });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([{ id: aliceProfile, wallet_balance: 250, aadhaar_number: '123412341234' }]);
    expect(res.headers['content-range']).toBe('0-0/*');
  });

  it("masks another user's private columns and cannot be probed with filters", async () => {
    const res = await t.app.inject({ method: 'GET', url: `/rest/v1/profiles?select=id,first_name,aadhaar_number&id=eq.${aliceProfile}`, headers: bearer(bob.access_token) });
    expect(res.json()).toEqual([{ id: aliceProfile, first_name: 'Alice', aadhaar_number: null }]);
    const probe = await t.app.inject({ method: 'GET', url: `/rest/v1/profiles?select=id&aadhaar_number=eq.123412341234`, headers: bearer(bob.access_token) });
    expect(probe.json()).toEqual([]);
  });

  it('shows anonymous callers nothing from a table without an anon grant', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/rest/v1/profiles?select=id', headers: anon() });
    expect(res.json()).toEqual([]);
  });

  it('embeds many-to-one by FK column and one-to-many by table, applying the embedded policy', async () => {
    const m2o = await t.app.inject({
      method: 'GET',
      url: `/rest/v1/celebrities?select=name,owner:profile_id(first_name,aadhaar_number)&id=eq.${celebId}`,
      headers: bearer(alice.access_token),
    });
    expect(m2o.statusCode).toBe(200);
    expect(m2o.json()).toEqual([{ name: 'Bob Star', owner: { first_name: 'Bob', aadhaar_number: null } }]);

    const o2m = await t.app.inject({ method: 'GET', url: `/rest/v1/profiles?select=first_name,celebrities(id,name)&id=eq.${bobProfile}`, headers: bearer(bob.access_token) });
    expect(o2m.json()).toEqual([{ first_name: 'Bob', celebrities: [{ id: celebId, name: 'Bob Star' }] }]);

    const count = await t.app.inject({ method: 'GET', url: `/rest/v1/profiles?select=id,celebrities(count)&id=eq.${bobProfile}`, headers: bearer(bob.access_token) });
    expect(count.json()).toEqual([{ id: bobProfile, celebrities: [{ count: 1 }] }]);
  });

  it('filters parents with !inner embeds', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/rest/v1/profiles?select=id,celebrities!inner(id)', headers: bearer(bob.access_token) });
    expect(res.json().map((r: { id: string }) => r.id)).toEqual([bobProfile]);
  });

  it('supports or=, in., is.null, not.is.null and ordering', async () => {
    const res = await t.app.inject({
      method: 'GET',
      url: `/rest/v1/profiles?select=first_name&or=(id.eq.${aliceProfile},id.eq.${bobProfile})&first_name=not.is.null&order=first_name.desc`,
      headers: bearer(alice.access_token),
    });
    expect(res.json()).toEqual([{ first_name: 'Bob' }, { first_name: 'Alice' }]);
    const inList = await t.app.inject({ method: 'GET', url: `/rest/v1/profiles?select=first_name&id=in.(${aliceProfile})`, headers: bearer(alice.access_token) });
    expect(inList.json()).toEqual([{ first_name: 'Alice' }]);
  });

  it('answers HEAD with an exact count in Content-Range', async () => {
    const res = await t.app.inject({ method: 'HEAD', url: '/rest/v1/profiles?select=id&limit=1', headers: { ...bearer(alice.access_token), prefer: 'count=exact' } });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-range']).toBe('0-0/2');
  });

  it('returns a single object for vnd.pgrst.object+json and 406 otherwise', async () => {
    const one = await t.app.inject({ method: 'GET', url: `/rest/v1/profiles?select=id&id=eq.${aliceProfile}`, headers: { ...bearer(alice.access_token), accept: 'application/vnd.pgrst.object+json' } });
    expect(one.json()).toEqual({ id: aliceProfile });
    const many = await t.app.inject({ method: 'GET', url: '/rest/v1/profiles?select=id', headers: { ...bearer(alice.access_token), accept: 'application/vnd.pgrst.object+json' } });
    expect(many.statusCode).toBe(406);
    expect(many.json().code).toBe('PGRST116');
  });

  it('rejects unknown tables, columns and operators with PostgREST errors', async () => {
    const table = await t.app.inject({ method: 'GET', url: '/rest/v1/secrets', headers: anon() });
    expect(table.statusCode).toBe(404);
    const col = await t.app.inject({ method: 'GET', url: '/rest/v1/celebrities?select=nope', headers: anon() });
    expect(col.statusCode).toBe(400);
    expect(col.json().code).toBe('42703');
    const op = await t.app.inject({ method: 'GET', url: '/rest/v1/celebrities?name=fts.x', headers: anon() });
    expect(op.statusCode).toBe(400);
    const badUuid = await t.app.inject({ method: 'GET', url: '/rest/v1/celebrities?id=eq.not-a-uuid', headers: anon() });
    expect(badUuid.statusCode).toBe(400);
  });
});

describe('writes', () => {
  it('updates only allowed columns of the caller\'s own row', async () => {
    const ok = await t.app.inject({ method: 'PATCH', url: `/rest/v1/profiles?id=eq.${aliceProfile}`, headers: bearer(alice.access_token), payload: { first_name: 'Alicia' } });
    expect(ok.statusCode).toBe(204);
    const money = await t.app.inject({ method: 'PATCH', url: `/rest/v1/profiles?id=eq.${aliceProfile}`, headers: bearer(alice.access_token), payload: { wallet_balance: 1e6 } });
    expect(money.statusCode).toBe(403);
    const other = await t.app.inject({
      method: 'PATCH',
      url: `/rest/v1/profiles?id=eq.${bobProfile}`,
      headers: { ...bearer(alice.access_token), prefer: 'return=representation' },
      payload: { first_name: 'Hacked' },
    });
    expect(other.statusCode).toBe(200);
    expect(other.json()).toEqual([]);
    const bobRow = await t.sql`select first_name from public.profiles where id = ${bobProfile}`;
    expect(bobRow[0]!.first_name).toBe('Bob');
  });

  it('refuses PATCH and DELETE without a filter', async () => {
    const res = await t.app.inject({ method: 'PATCH', url: '/rest/v1/profiles', headers: bearer(alice.access_token), payload: { first_name: 'X' } });
    expect(res.statusCode).toBe(400);
  });

  it('upserts on an allowed conflict target and returns the representation', async () => {
    const first = await t.app.inject({
      method: 'POST',
      url: '/rest/v1/platform_settings?on_conflict=setting_key',
      headers: { ...bearer(alice.access_token), prefer: 'resolution=merge-duplicates,return=representation' },
      payload: { setting_key: 'ugc_video_price', setting_value: '499' },
    });
    expect(first.statusCode).toBe(201);
    const second = await t.app.inject({
      method: 'POST',
      url: '/rest/v1/platform_settings?on_conflict=setting_key',
      headers: { ...bearer(alice.access_token), prefer: 'resolution=merge-duplicates,return=representation' },
      payload: { setting_key: 'ugc_video_price', setting_value: '599' },
    });
    expect(second.json()[0].setting_value).toBe('599');
    const rows = await t.sql`select count(*)::int as n from public.platform_settings`;
    expect(rows[0]!.n).toBe(1);
  });

  it('refuses inserts into tables without an insert rule', async () => {
    const res = await t.app.inject({ method: 'POST', url: '/rest/v1/celebrities', headers: bearer(alice.access_token), payload: { name: 'Fake' } });
    expect(res.statusCode).toBe(403);
  });
});
