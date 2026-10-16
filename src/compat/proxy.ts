/**
 * Transparent pass-through to the upstream Supabase project for route groups not migrated yet. Streams both ways,
 * forwards only the headers Supabase needs, strips hop-by-hop headers, and bounds the time spent waiting.
 */
import type { FastifyReply, FastifyRequest } from 'fastify';
import { request } from 'undici';
import type { Readable } from 'node:stream';
import type { Env } from '../config/env.js';
import { AppError } from '../lib/errors.js';

const FORWARD_REQUEST_HEADERS = [
  'apikey',
  'authorization',
  'content-type',
  'content-length',
  'accept',
  'accept-profile',
  'content-profile',
  'prefer',
  'range',
  'range-unit',
  'x-client-info',
  'x-upsert',
  'cache-control',
  'x-request-id',
];

const DROP_RESPONSE_HEADERS = new Set([
  'connection',
  'keep-alive',
  'transfer-encoding',
  'upgrade',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'content-encoding',
  'content-length',
  'alt-svc',
  'set-cookie',
]);

export class SupabaseProxy {
  private readonly base: string | null;

  constructor(private readonly env: Env) {
    this.base = env.SUPABASE_URL ? env.SUPABASE_URL.replace(/\/$/, '') : null;
  }

  get enabled(): boolean {
    return !!this.base;
  }

  /**
   * Forwards the request. `body` is the raw request body (Buffer or stream) captured by the compat content parser.
   */
  async forward(req: FastifyRequest, reply: FastifyReply, body?: Buffer | Readable | null): Promise<FastifyReply> {
    if (!this.base) throw new AppError(503, 'upstream_unconfigured', 'This route is not available yet');
    const url = `${this.base}${req.url}`;
    const headers: Record<string, string> = {};
    for (const name of FORWARD_REQUEST_HEADERS) {
      const v = req.headers[name];
      if (typeof v === 'string') headers[name] = v;
    }
    headers['x-forwarded-for'] = req.ip;
    const method = req.method as 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD' | 'OPTIONS';
    const hasBody = !['GET', 'HEAD'].includes(method) && body != null;
    if (!hasBody) delete headers['content-length'];
    try {
      const res = await request(url, {
        method,
        headers,
        body: hasBody ? (body as Buffer | Readable) : null,
        headersTimeout: this.env.PROXY_TIMEOUT_MS,
        bodyTimeout: this.env.PROXY_TIMEOUT_MS * 4,
        maxRedirections: 0,
      } as Parameters<typeof request>[1]);
      reply.code(res.statusCode);
      for (const [k, v] of Object.entries(res.headers)) {
        if (v === undefined || DROP_RESPONSE_HEADERS.has(k.toLowerCase())) continue;
        reply.header(k, v as string | string[]);
      }
      reply.header('x-wishme-route', 'proxy');
      return reply.send(res.body);
    } catch (e) {
      req.log.error({ err: (e as Error).message, url: req.url }, 'proxy request failed');
      throw new AppError(502, 'upstream_error', 'The service is temporarily unavailable. Please try again.');
    }
  }
}
