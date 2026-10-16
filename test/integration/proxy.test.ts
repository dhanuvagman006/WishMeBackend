/**
 * Strangler proxy: route groups in `proxy` mode are forwarded to the upstream Supabase project byte for byte (method,
 * path, query, body, the headers Supabase needs), the upstream status and body come back unchanged, and groups
 * switched to `local` are served here. A tiny HTTP server stands in for Supabase.
 */
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { anon, bootTest, type TestCtx } from '../helpers.js';

interface Seen {
  method: string;
  url: string;
  headers: IncomingMessage['headers'];
  body: string;
}

let upstream: Server;
let seen: Seen[] = [];
let t: TestCtx;

beforeAll(async () => {
  upstream = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      seen.push({ method: req.method!, url: req.url!, headers: req.headers, body });
      res.writeHead(req.url!.startsWith('/rest/v1/missing') ? 404 : 200, { 'content-type': 'application/json', 'content-range': '0-0/1', 'set-cookie': 'x=1' });
      res.end(JSON.stringify({ upstream: true, path: req.url }));
    });
  });
  await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', () => r()));
  const port = (upstream.address() as { port: number }).port;
  t = await bootTest({
    env: {
      SUPABASE_URL: `http://127.0.0.1:${port}`,
      COMPAT_DEFAULT_MODE: 'proxy',
      ROUTE_MODES: JSON.stringify({ auth: 'local', 'functions:send-email-otp': 'local' }),
    },
  });
});
afterAll(async () => {
  await t.close();
  await new Promise<void>((r) => upstream.close(() => r()));
  process.env.COMPAT_DEFAULT_MODE = 'local';
  delete process.env.ROUTE_MODES;
  delete process.env.SUPABASE_URL;
});

describe('proxy mode', () => {
  it('forwards REST calls with the query, body and Supabase headers, and returns the upstream answer', async () => {
    seen = [];
    const res = await t.app.inject({
      method: 'POST',
      url: '/rest/v1/bookings?select=id&on_conflict=id',
      headers: { ...anon(), authorization: 'Bearer some-user-token', prefer: 'return=representation', 'content-type': 'application/json', cookie: 'secret=1' },
      payload: { a: 1 },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ upstream: true, path: '/rest/v1/bookings?select=id&on_conflict=id' });
    expect(res.headers['content-range']).toBe('0-0/1');
    expect(res.headers['set-cookie']).toBeUndefined();
    expect(res.headers['x-wishme-route']).toBe('proxy');
    const s = seen[0]!;
    expect(s.method).toBe('POST');
    expect(s.headers.apikey).toBe('test-anon-key');
    expect(s.headers.authorization).toBe('Bearer some-user-token');
    expect(s.headers.prefer).toBe('return=representation');
    expect(s.headers.cookie).toBeUndefined();
    expect(JSON.parse(s.body)).toEqual({ a: 1 });
  });

  it('passes upstream errors through unchanged', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/rest/v1/missing', headers: anon() });
    expect(res.statusCode).toBe(404);
  });

  it('serves groups switched to local here (auth, one function), proxying the rest of that family', async () => {
    seen = [];
    const health = await t.app.inject({ method: 'GET', url: '/auth/v1/health', headers: anon() });
    expect(health.json().name).toBe('GoTrue-compatible');
    const otp = await t.app.inject({ method: 'POST', url: '/functions/v1/send-email-otp', headers: anon(), payload: { email: 'proxy-mode@example.com' } });
    expect(otp.statusCode).toBe(200);
    const other = await t.app.inject({ method: 'POST', url: '/functions/v1/generate-lyrics', headers: anon(), payload: {} });
    expect(other.json().upstream).toBe(true);
    expect(seen.map((s) => s.url)).toEqual(['/functions/v1/generate-lyrics']);
  });
});
