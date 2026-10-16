/** Small helpers shared by the compat route groups. */
import type { FastifyRequest } from 'fastify';
import type { ClientMeta } from '../auth/service.js';
import { pgrstError } from './postgrest/parser.js';

export function clientMeta(req: FastifyRequest): ClientMeta {
  const ua = req.headers['user-agent'];
  return { ip: req.ip, ...(typeof ua === 'string' ? { userAgent: ua } : {}) };
}

export function bearerOf(req: FastifyRequest): string | null {
  const h = req.headers.authorization;
  if (typeof h !== 'string') return null;
  const m = /^Bearer\s+(.+)$/i.exec(h.trim());
  return m ? m[1]!.trim() : null;
}

export function apikeyOf(req: FastifyRequest): string | undefined {
  const h = req.headers.apikey;
  if (typeof h === 'string' && h) return h;
  // Supabase also accepts the key as a query parameter (used by the Realtime URL).
  const q = (req.query as Record<string, unknown> | undefined)?.apikey;
  return typeof q === 'string' ? q : undefined;
}

/** Parses a JSON body captured as a Buffer by the compat content parser. Empty body = undefined. */
export function jsonBody(raw: unknown): unknown {
  if (raw === undefined || raw === null) return undefined;
  if (Buffer.isBuffer(raw)) {
    if (raw.length === 0) return undefined;
    try {
      return JSON.parse(raw.toString('utf8'));
    } catch {
      throw pgrstError(400, 'PGRST102', 'Empty or invalid json');
    }
  }
  return raw;
}

export function searchParams(req: FastifyRequest): URLSearchParams {
  const i = req.url.indexOf('?');
  return new URLSearchParams(i >= 0 ? req.url.slice(i + 1) : '');
}
