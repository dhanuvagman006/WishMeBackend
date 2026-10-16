/**
 * Realtime compat over a real socket: the app's Phoenix join with a postgres_changes filter, authorisation of the
 * filter, delivery of a change made directly in the database (as Supabase or a legacy function would), heartbeats,
 * and that payloads carry only the primary key.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { sql } from '../../src/lib/sql.js';
import { definePolicy } from '../../src/compat/postgrest/policy.js';
import { RealtimeHub } from '../../src/compat/realtime/hub.js';
import { buildApp } from '../../src/app.js';
import { ANON_KEY, bootTest, profileIdOf, signUp, type TestCtx, type TestSession } from '../helpers.js';
import type { FastifyInstance } from 'fastify';

let t: TestCtx;
let app: FastifyInstance;
let hub: RealtimeHub;
let url: string;
let alice: TestSession;
let aliceProfile: string;
let bobProfile: string;

const policies = [
  definePolicy({
    table: 'profiles',
    read: [{ name: 'owner', rows: (c) => (c.identity.profileId ? sql`${c.col('id')} = ${c.identity.profileId}` : 'none'), columns: '*' }],
    realtime: { filterColumns: ['id'], authorize: (_a, identity, column, value) => column === 'id' && value === identity.profileId },
  }),
];

beforeAll(async () => {
  t = await bootTest({ policies });
  alice = await signUp(t, 'rt-alice@example.com');
  const bob = await signUp(t, 'rt-bob@example.com');
  aliceProfile = await profileIdOf(t, alice.user.id);
  bobProfile = await profileIdOf(t, bob.user.id);
  // A second app instance with realtime enabled, listening on a real port.
  const built = await buildApp(t.deps, { realtime: true });
  app = built.app;
  hub = built.hub!;
  await hub.start();
  await app.listen({ port: 0, host: '127.0.0.1' });
  const addr = app.server.address() as { port: number };
  url = `ws://127.0.0.1:${addr.port}/realtime/v1/websocket?apikey=${ANON_KEY}&vsn=1.0.0`;
});
afterAll(async () => {
  await hub.stop();
  await app.close();
  await t.close();
});

function connect(): Promise<{ ws: WebSocket; next: (pred: (m: Record<string, unknown>) => boolean, ms?: number) => Promise<Record<string, unknown>> }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const inbox: Record<string, unknown>[] = [];
    const waiters: Array<{ pred: (m: Record<string, unknown>) => boolean; done: (m: Record<string, unknown>) => void }> = [];
    ws.on('message', (d) => {
      const m = JSON.parse(d.toString()) as Record<string, unknown>;
      const w = waiters.findIndex((x) => x.pred(m));
      if (w >= 0) waiters.splice(w, 1)[0]!.done(m);
      else inbox.push(m);
    });
    ws.on('open', () =>
      resolve({
        ws,
        next: (pred, ms = 4000) =>
          new Promise((res, rej) => {
            const i = inbox.findIndex(pred);
            if (i >= 0) return res(inbox.splice(i, 1)[0]!);
            const timer = setTimeout(() => rej(new Error('timeout waiting for message')), ms);
            waiters.push({ pred, done: (m) => (clearTimeout(timer), res(m)) });
          }),
      }),
    );
    ws.on('error', reject);
  });
}

const join = (ws: WebSocket, filter: string, ref: string) =>
  ws.send(
    JSON.stringify({
      topic: 'realtime:public:profiles',
      event: 'phx_join',
      payload: {
        config: { broadcast: { ack: false, self: false }, postgres_changes: [{ event: 'UPDATE', schema: 'public', table: 'profiles', filter }] },
        access_token: alice.access_token,
      },
      ref,
    }),
  );

describe('realtime', () => {
  it('delivers an UPDATE on the subscribed row with only the primary key', async () => {
    const { ws, next } = await connect();
    join(ws, `id=eq.${aliceProfile}`, '1');
    const reply = await next((m) => m.event === 'phx_reply' && m.ref === '1');
    expect((reply.payload as { status: string }).status).toBe('ok');
    await t.sql`update public.profiles set first_name = 'Changed' where id = ${aliceProfile}`;
    const change = await next((m) => m.event === 'postgres_changes');
    const payload = change.payload as { eventType: string; data: { type: string; record: Record<string, unknown> } };
    expect(payload.data.type).toBe('UPDATE');
    expect(payload.eventType).toBe('UPDATE');
    expect(payload.data.record).toEqual({ id: aliceProfile });
    ws.close();
  });

  it("refuses a subscription to someone else's row", async () => {
    const { ws, next } = await connect();
    join(ws, `id=eq.${bobProfile}`, '7');
    const reply = await next((m) => m.event === 'phx_reply' && m.ref === '7');
    expect((reply.payload as { status: string }).status).toBe('error');
    ws.close();
  });

  it('answers heartbeats', async () => {
    const { ws, next } = await connect();
    ws.send(JSON.stringify({ topic: 'phoenix', event: 'heartbeat', payload: {}, ref: '99' }));
    const reply = await next((m) => m.event === 'phx_reply' && m.ref === '99');
    expect((reply.payload as { status: string }).status).toBe('ok');
    ws.close();
  });

  it('closes sockets that do not present a valid apikey', async () => {
    const ws = new WebSocket(url.replace(ANON_KEY, 'wrong'));
    const code = await new Promise<number>((resolve) => ws.on('close', (c) => resolve(c)));
    expect(code).toBe(4001);
  });
});
