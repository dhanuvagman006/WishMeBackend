/**
 * Builds the Fastify application. Used by server.ts and by the integration tests (which call app.inject()).
 *
 * Body handling differs per surface:
 *  - compat routes (/auth/v1, /rest/v1, /functions/v1) keep the raw bytes, so a proxied request is forwarded exactly
 *    as received and local handlers parse JSON themselves;
 *  - storage uploads are streamed straight to B2, never buffered;
 *  - /api/v1 parses JSON normally, except webhooks, which need the raw bytes for signature checks.
 */
import Fastify, { type FastifyError, type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import underPressure from '@fastify/under-pressure';
import websocket from '@fastify/websocket';
import { registerV1 } from './api/v1/routes.js';
import { apikeyOf, searchParams } from './compat/common.js';
import { registerFunctions } from './compat/functions/routes.js';
import { registerGotrue } from './compat/gotrue/routes.js';
import { registerPostgrest } from './compat/postgrest/routes.js';
import { RealtimeHub } from './compat/realtime/hub.js';
import { registerStorage } from './compat/storage/routes.js';
import type { Deps } from './deps.js';
import { AppError, fromPostgresError, isAppError } from './lib/errors.js';
import { loggerOptions } from './lib/logger.js';
import { httpDuration } from './lib/metrics.js';
import { uuid } from './lib/crypto.js';

type Surface = 'postgrest' | 'gotrue' | 'functions' | 'storage' | 'v1';

function surfaceOf(url: string): Surface {
  if (url.startsWith('/rest/v1')) return 'postgrest';
  if (url.startsWith('/auth/')) return 'gotrue';
  if (url.startsWith('/functions/v1')) return 'functions';
  if (url.startsWith('/storage/v1')) return 'storage';
  return 'v1';
}

function groupOf(url: string): string {
  const path = url.split('?')[0]!;
  const parts = path.split('/').filter(Boolean);
  if (parts[0] === 'rest') return parts[2] === 'rpc' ? `rpc:${parts[3]}` : `rest:${parts[2]}`;
  if (parts[0] === 'functions') return `functions:${parts[2]}`;
  if (parts[0] === 'auth') return 'auth';
  if (parts[0] === 'storage') return 'storage';
  if (parts[0] === 'realtime') return 'realtime';
  return parts.slice(0, 3).join('/') || 'root';
}

/** Renders an error in the shape the calling surface's clients parse. */
function render(surface: Surface, e: AppError, requestId: string) {
  switch (surface) {
    case 'postgrest':
      return { code: e.code, message: e.message, details: typeof e.details === 'string' ? e.details : (e.details ?? null), hint: e.hint ?? null };
    case 'gotrue': {
      const legacy = (e.details as { error?: string } | undefined)?.error;
      return { code: e.status, error_code: e.code, msg: e.message, error: legacy ?? e.code, error_description: e.message };
    }
    case 'functions': {
      const extra = e.code === 'rate_limited' ? (e.details as Record<string, unknown>) : {};
      return { error: e.message, message: e.message, code: e.code, ...(extra ?? {}), ...(e.code === 'rate_limited' ? { retry_after: (extra as { retryAfter?: number }).retryAfter } : {}) };
    }
    case 'storage':
      return { statusCode: String(e.status), error: e.code, message: e.message };
    default:
      return { error: { code: e.code, message: e.message, requestId } };
  }
}

export async function buildApp(deps: Deps, opts: { realtime?: boolean } = {}): Promise<{ app: FastifyInstance; hub: RealtimeHub | null }> {
  const { env } = deps;
  const app = Fastify({
    logger: loggerOptions(env.LOG_LEVEL, env.NODE_ENV === 'development' && !!process.stdout.isTTY),
    // Trust exactly N proxy hops (Caddy = 1); never the whole chain, so clients cannot spoof their IP.
    trustProxy: (_address: string, hop: number) => hop < env.TRUST_PROXY_HOPS,
    bodyLimit: env.BODY_LIMIT_MB * 1024 * 1024,
    requestIdHeader: 'x-request-id',
    genReqId: (req) => {
      const given = req.headers['x-request-id'];
      return typeof given === 'string' && /^[\w-]{8,64}$/.test(given) ? given : uuid();
    },
    return503OnClosing: true,
    forceCloseConnections: 'idle',
  });

  await app.register(helmet, { contentSecurityPolicy: false, crossOriginResourcePolicy: { policy: 'cross-origin' } });
  await app.register(cors, {
    origin: env.CORS_ORIGINS.length ? env.CORS_ORIGINS : false,
    credentials: false,
    allowedHeaders: ['authorization', 'apikey', 'content-type', 'prefer', 'accept', 'range', 'x-client-info', 'x-upsert', 'x-request-id'],
    exposedHeaders: ['content-range', 'x-request-id', 'retry-after'],
    maxAge: 600,
  });
  await app.register(underPressure, {
    maxEventLoopDelay: 1000,
    maxHeapUsedBytes: 0,
    maxRssBytes: 0,
    maxEventLoopUtilization: 0.98,
    retryAfter: 5,
    exposeStatusRoute: false,
  });
  await app.register(rateLimit, {
    global: true,
    max: env.RATE_LIMIT_PER_MIN,
    timeWindow: '1 minute',
    ...(deps.redis ? { redis: deps.redis, nameSpace: `${env.REDIS_PREFIX}:rlg:` } : {}),
    keyGenerator: (req) => req.ip,
    allowList: (req) => req.url.startsWith('/api/healthz') || req.url.startsWith('/api/readyz'),
  });
  await app.register(websocket, { options: { maxPayload: 1024 * 1024 } });

  app.addHook('onResponse', async (req, reply) => {
    const group = groupOf(req.url);
    const mode = reply.getHeader('x-wishme-route') === 'proxy' ? 'proxy' : 'local';
    httpDuration.observe({ group, mode, method: req.method, status: `${Math.floor(reply.statusCode / 100)}xx` }, reply.elapsedTime / 1000);
  });

  app.setErrorHandler((err: FastifyError | AppError | Error, req: FastifyRequest, reply: FastifyReply) => {
    const surface = surfaceOf(req.url);
    let e: AppError;
    if (isAppError(err)) e = err;
    else if (fromPostgresError(err)) e = fromPostgresError(err)!;
    else if ((err as FastifyError).statusCode && (err as FastifyError).statusCode! < 500) {
      const fe = err as FastifyError;
      e = new AppError(fe.statusCode!, fe.code ?? 'bad_request', fe.message);
    } else {
      req.log.error({ err }, 'unhandled error');
      e = new AppError(500, 'internal_error', 'Something went wrong. Please try again.');
    }
    if (e.status >= 500 && isAppError(err)) req.log.error({ err, code: e.code }, 'request failed');
    for (const [k, v] of Object.entries(e.headers ?? {})) reply.header(k, v);
    reply.header('x-request-id', String(req.id));
    return reply.code(e.status).send(render(surface, e, String(req.id)));
  });

  app.setNotFoundHandler((req, reply) => {
    const e = new AppError(404, 'not_found', `Route ${req.method} ${req.url.split('?')[0]} not found`);
    return reply.code(404).send(render(surfaceOf(req.url), e, String(req.id)));
  });

  // ── compat: raw bodies ─────────────────────────────────────────────────────────────────────────────────────
  await app.register(async (compat) => {
    compat.removeAllContentTypeParsers();
    compat.addContentTypeParser('*', { parseAs: 'buffer', bodyLimit: env.BODY_LIMIT_MB * 1024 * 1024 }, (_req, body, done) => done(null, body));
    registerGotrue(compat, deps);
    registerPostgrest(compat, deps);
    registerFunctions(compat, deps);
  });

  // ── compat: streamed uploads ───────────────────────────────────────────────────────────────────────────────
  await app.register(async (storage) => {
    storage.removeAllContentTypeParsers();
    storage.addContentTypeParser('*', { bodyLimit: env.UPLOAD_LIMIT_MB * 1024 * 1024 }, (_req, payload, done) => done(null, payload));
    registerStorage(storage, deps);
  });

  // ── realtime + websocket functions ─────────────────────────────────────────────────────────────────────────
  let hub: RealtimeHub | null = null;
  if (opts.realtime !== false) {
    hub = new RealtimeHub(deps);
    app.get('/realtime/v1/websocket', { websocket: true }, async (socket, req) => {
      try {
        await deps.resolver.checkApiKey(apikeyOf(req));
      } catch {
        socket.close(4001, 'Invalid API key');
        return;
      }
      hub!.attach(socket);
    });
  }
  for (const name of deps.functions.names()) {
    const fn = deps.functions.get(name)!;
    if (!fn.websocket) continue;
    app.get(`/functions/v1/${name}`, { websocket: true }, async (socket, req) => {
      try {
        await deps.resolver.checkApiKey(apikeyOf(req));
        const q = searchParams(req);
        const token = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '') || q.get('access_token') || q.get('token');
        const auth = await deps.resolver.resolve(token || null);
        if (fn.access === 'user' && auth.kind === 'anon') {
          socket.close(4001, 'Unauthorized');
          return;
        }
        await fn.websocket!(socket, {
          deps,
          auth,
          identity: () => auth.identity(),
          query: q,
          headers: req.headers,
          ip: req.ip,
          log: req.log,
          requestId: String(req.id),
        });
      } catch (e) {
        req.log.warn({ err: (e as Error).message, fn: name }, 'websocket function rejected');
        socket.close(4001, 'Unauthorized');
      }
    });
  }

  // ── clean API: JSON bodies; webhooks keep raw bytes ─────────────────────────────────────────────────────────
  await app.register(async (v1) => {
    v1.addContentTypeParser('application/json', { parseAs: 'buffer' }, (req, body, done) => {
      if ((req.routeOptions.config as { rawBody?: boolean } | undefined)?.rawBody) return done(null, body);
      const text = (body as Buffer).toString('utf8');
      if (text.length === 0) return done(null, {});
      try {
        done(null, JSON.parse(text));
      } catch {
        done(new AppError(400, 'invalid_json', 'Request body is not valid JSON'), undefined);
      }
    });
    registerV1(v1, deps, hub);
  });

  return { app, hub };
}
