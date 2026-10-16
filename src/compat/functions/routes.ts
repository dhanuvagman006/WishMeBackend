/** /functions/v1/:name — dispatch to the registered replacement, or proxy while the function is not migrated. */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Deps } from '../../deps.js';
import { AppError, unauthorized } from '../../lib/errors.js';
import { apikeyOf, bearerOf, jsonBody, searchParams } from '../common.js';
import type { FnContext } from './registry.js';

export function registerFunctions(app: FastifyInstance, deps: Deps): void {
  const handle = async (req: FastifyRequest<{ Params: { name: string } }>, reply: FastifyReply) => {
    const name = req.params.name;
    const fn = deps.functions.get(name);
    const mode = deps.modes.modeFor(`functions:${name}`);
    if (mode === 'proxy' || (!fn && deps.proxy.enabled)) return deps.proxy.forward(req, reply, req.body as Buffer | null);
    if (!fn) throw new AppError(404, 'not_found', `Function ${name} not found`);

    // Pre-warm calls from the app: answer immediately.
    if (req.method === 'OPTIONS') return reply.code(204).send();
    const allowed = fn.methods ?? ['POST'];
    if (!allowed.includes(req.method as 'GET' | 'POST')) throw new AppError(405, 'method_not_allowed', `Use ${allowed.join(' or ')}`);

    await deps.resolver.checkApiKey(apikeyOf(req));
    const auth = await deps.resolver.resolve(bearerOf(req));
    if (fn.access === 'user' && auth.kind === 'anon') throw unauthorized('Missing authorization header');

    const raw = Buffer.isBuffer(req.body) ? req.body : null;
    if (raw && raw.length > (fn.bodyLimit ?? 1024 * 1024)) throw new AppError(413, 'payload_too_large', 'Request body too large');

    if (fn.rateLimit) {
      const subject = fn.rateLimit.by === 'user' && auth.userId ? `u:${auth.userId}` : `ip:${req.ip}`;
      await deps.limiter.hit(`fn:${name}`, subject, fn.rateLimit);
    }

    const ctx: FnContext = {
      deps,
      auth,
      identity: () => auth.identity(),
      body: jsonBody(raw),
      rawBody: raw,
      query: searchParams(req),
      headers: req.headers,
      ip: req.ip,
      log: req.log,
      requestId: String(req.id),
    };
    const result = await fn.handler(ctx);
    reply.code(result.status ?? 200);
    for (const [k, v] of Object.entries(result.headers ?? {})) reply.header(k, v);
    if (result.raw !== undefined) {
      reply.header('content-type', result.contentType ?? 'application/octet-stream');
      return reply.send(result.raw);
    }
    if (result.body === undefined) return reply.send();
    return reply.header('content-type', 'application/json; charset=utf-8').send(JSON.stringify(result.body));
  };

  app.route({ method: ['GET', 'POST', 'OPTIONS'], url: '/functions/v1/:name', handler: handle });
}
