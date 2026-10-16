/**
 * Edge-function replacements. Each handler module under ./handlers exports `functions: FunctionDef[]`; the index wires
 * them up. A function answers at /functions/v1/<name> with the same request and response shapes the app already uses.
 *
 * Conventions every handler follows (see CONTRIBUTING.md):
 *  - access: 'anon' only when the app calls it signed out today; otherwise 'user'.
 *  - Validate the body with zod (`parseBody`); never trust ids for ownership: use ctx.identity().
 *  - Errors: throw AppError; the route renders { error, message } with the status.
 *  - Money: only through deps.ledger / deps.payments. Never compute a charge from client-sent prices.
 *  - Vendors: through src/vendors/* clients (timeouts, retries, logging); return 503 when not configured.
 */
import type { FastifyBaseLogger } from 'fastify';
import type { WebSocket } from 'ws';
import type { ZodType, ZodTypeDef } from 'zod';
import type { AuthContext, Identity } from '../../auth/context.js';
import type { Deps } from '../../deps.js';
import { AppError } from '../../lib/errors.js';

export interface FnContext {
  deps: Deps;
  auth: AuthContext;
  identity: () => Promise<Identity>;
  body: unknown;
  rawBody: Buffer | null;
  query: URLSearchParams;
  headers: Record<string, string | string[] | undefined>;
  ip: string;
  log: FastifyBaseLogger;
  requestId: string;
}

export interface FnResult {
  status?: number;
  /** JSON body. */
  body?: unknown;
  /** Binary or text body (audio, files). Takes precedence over `body`. */
  raw?: Buffer | string;
  contentType?: string;
  headers?: Record<string, string>;
}

export interface FnRateLimit {
  limit: number;
  windowSec: number;
  by: 'user' | 'ip';
}

export interface FunctionDef {
  name: string;
  access: 'anon' | 'user';
  /** Allowed HTTP methods (default POST). OPTIONS is always answered for CORS pre-warm calls. */
  methods?: ReadonlyArray<'GET' | 'POST'>;
  rateLimit?: FnRateLimit;
  /** Max request body in bytes (default 1 MB; uploads that arrive as base64 may need more). */
  bodyLimit?: number;
  handler: (c: FnContext) => Promise<FnResult>;
  /** For relay functions (sarvam-voice): handles the WebSocket upgrade instead of HTTP. */
  websocket?: (socket: WebSocket, c: Omit<FnContext, 'body' | 'rawBody'>) => void | Promise<void>;
}

export const DEFAULT_FN_BODY_LIMIT = 1024 * 1024;

export class FunctionRegistry {
  private readonly fns = new Map<string, FunctionDef>();

  add(list: readonly FunctionDef[]): this {
    for (const f of list) {
      if (this.fns.has(f.name)) throw new Error(`Function ${f.name} registered twice`);
      this.fns.set(f.name, f);
    }
    return this;
  }

  get(name: string): FunctionDef | undefined {
    return this.fns.get(name);
  }

  /** Largest body any local function accepts (default 1 MB each). */
  maxBodyLimit(): number {
    let max = DEFAULT_FN_BODY_LIMIT;
    for (const f of this.fns.values()) max = Math.max(max, f.bodyLimit ?? DEFAULT_FN_BODY_LIMIT);
    return max;
  }

  names(): string[] {
    return [...this.fns.keys()].sort();
  }
}

/** Validates a body with zod and turns failures into a 400 the app can show. */
export function parseBody<T>(schema: ZodType<T, ZodTypeDef, unknown>, body: unknown): T {
  const r = schema.safeParse(body ?? {});
  if (!r.success) {
    const first = r.error.issues[0];
    const field = first?.path.join('.') || 'body';
    throw new AppError(400, 'invalid_request', `Invalid ${field}: ${first?.message ?? 'invalid value'}`, r.error.issues.slice(0, 5));
  }
  return r.data;
}

export function defineFunctions(list: FunctionDef[]): FunctionDef[] {
  return list;
}
