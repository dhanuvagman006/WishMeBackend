/**
 * /rest/v1/:table and /rest/v1/rpc/:name — the PostgREST-compatible surface.
 *
 * Status codes and headers follow PostgREST: GET 200 (+ Content-Range), HEAD with `Prefer: count=exact` for counters,
 * POST 201, PATCH/DELETE 204 unless `Prefer: return=representation`, single-object responses on
 * `Accept: application/vnd.pgrst.object+json`, and errors as { code, message, details, hint }.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { AuthContext } from '../../auth/context.js';
import { dbClaims } from '../../auth/context.js';
import type { Deps } from '../../deps.js';
import { run, runAs } from '../../lib/db.js';
import { AppError } from '../../lib/errors.js';
import { apikeyOf, bearerOf, jsonBody, searchParams } from '../common.js';
import type { SelectItem } from './ast.js';
import { compileDelete, compileInsert, compileRead, compileUpdate, prepareRows, tableOrThrow, type CompileEnv } from './compiler.js';
import { parseOnConflict, parsePrefer, parseRead, parseSelect, pgrstError } from './parser.js';
import type { CompatResult, PolicyCtx } from './policy.js';
import { ident } from '../../lib/sql.js';

const SINGLE = 'application/vnd.pgrst.object+json';

interface Ctx {
  deps: Deps;
  auth: AuthContext;
}

async function authenticate(deps: Deps, req: FastifyRequest): Promise<AuthContext> {
  await deps.resolver.checkApiKey(apikeyOf(req));
  return deps.resolver.resolve(bearerOf(req));
}

function roleFor(deps: Deps, auth: AuthContext): 'anon' | 'authenticated' | null {
  if (!deps.env.DB_RLS_PASSTHROUGH) return null;
  if (auth.kind === 'service') return null;
  return auth.kind === 'anon' ? 'anon' : 'authenticated';
}

async function execute(c: Ctx, compiled: { query: import('../../lib/sql.js').Sql; count?: import('../../lib/sql.js').Sql }) {
  return runAs(
    c.deps.db,
    { role: roleFor(c.deps, c.auth), claims: dbClaims(c.auth), statementTimeoutMs: c.deps.env.DB_STATEMENT_TIMEOUT_MS },
    async (tx) => {
      const rows = await run<{ body: string; n: number }>(tx, compiled.query);
      const total = compiled.count ? Number((await run<{ total: string }>(tx, compiled.count))[0]?.total ?? 0) : null;
      return { body: rows[0]?.body ?? '[]', n: rows[0]?.n ?? 0, total };
    },
  );
}

function sendResult(reply: FastifyReply, r: CompatResult): FastifyReply {
  reply.code(r.status);
  for (const [k, v] of Object.entries(r.headers ?? {})) reply.header(k, v);
  if (r.body === undefined) return reply.send();
  reply.header('content-type', 'application/json; charset=utf-8');
  return reply.send(typeof r.body === 'string' ? r.body : JSON.stringify(r.body));
}

/** Shapes a json_agg body for single-object requests (406 unless exactly one row). */
function singleOrList(body: string, n: number, single: boolean): string {
  if (!single) return body;
  if (n !== 1) {
    throw pgrstError(406, 'PGRST116', 'JSON object requested, multiple (or no) rows returned', `The result contains ${n} rows`);
  }
  return JSON.stringify((JSON.parse(body) as unknown[])[0]);
}

function contentRange(n: number, offset: number, total: number | null): string {
  const t = total === null ? '*' : String(total);
  return n === 0 ? `*/${t}` : `${offset}-${offset + n - 1}/${t}`;
}

export function registerPostgrest(app: FastifyInstance, deps: Deps): void {
  const handle = async (req: FastifyRequest<{ Params: { table: string } }>, reply: FastifyReply) => {
    const table = req.params.table;
    const group = `rest:${table}`;
    const policy = deps.policies.table(table);
    const mode = deps.modes.modeFor(group);
    if (mode === 'proxy' || (!policy && deps.proxy.enabled)) {
      return deps.proxy.forward(req, reply, req.body as Buffer | null);
    }

    const auth = await authenticate(deps, req);
    const identity = await auth.identity();
    const env: CompileEnv = { schema: deps.schema, policies: deps.policies, auth, identity };
    const { info, policy: p } = tableOrThrow(env, table);
    const params = searchParams(req);
    const prefer = parsePrefer(req.headers.prefer);
    const single = (req.headers.accept ?? '').includes(SINGLE);
    const method = req.method;
    const ctx: Ctx = { deps, auth };

    const customKey = method === 'GET' || method === 'HEAD' ? 'read' : method === 'POST' ? 'insert' : method === 'PATCH' ? 'update' : 'delete';
    const custom = p.custom?.[customKey];
    if (custom) {
      const r = await custom({ auth, identity, table: info, params, prefer, body: jsonBody(req.body), single });
      if (r !== 'default') return sendResult(reply, r);
    }

    const pc: PolicyCtx = { auth, identity, col: (name) => ident(table, name) };

    if (method === 'GET' || method === 'HEAD') {
      const read = parseRead(params);
      // Anonymous public catalogue reads can be served from a short cache.
      const cacheKey = auth.kind === 'anon' && p.anonCacheSec && method === 'GET' && !prefer.count ? `pgrst:${req.url}` : null;
      if (cacheKey) {
        const hit = await deps.kv.get(cacheKey);
        if (hit) {
          reply.header('x-cache', 'hit');
          const cached = JSON.parse(hit) as { body: string; n: number };
          reply.header('content-range', contentRange(cached.n, read.offset ?? 0, null));
          return sendResult(reply, { status: 200, body: singleOrList(cached.body, cached.n, single) });
        }
      }
      const compiled = compileRead(env, table, read, prefer.count !== null);
      const res = await execute(ctx, compiled);
      if (cacheKey) await deps.kv.set(cacheKey, JSON.stringify({ body: res.body, n: res.n }), p.anonCacheSec!);
      reply.header('content-range', contentRange(res.n, read.offset ?? 0, res.total));
      if (method === 'HEAD') return reply.code(200).send();
      return sendResult(reply, { status: 200, body: singleOrList(res.body, res.n, single) });
    }

    const select: readonly SelectItem[] | null = prefer.returnRepresentation ? parseSelect(params.get('select') ?? undefined) : null;

    if (method === 'POST') {
      if (!p.insert) throw new AppError(403, '42501', `permission denied to insert into ${table}`);
      const body = jsonBody(req.body);
      const rows = Array.isArray(body) ? body : [body];
      const max = p.insert.maxRows ?? 50;
      if (rows.length > max) throw pgrstError(400, 'PGRST102', `At most ${max} rows per request`);
      const prepared = await prepareRows(info, p.insert, rows, pc);
      const compiled = compileInsert(env, table, prepared, {
        onConflict: parseOnConflict(params.get('on_conflict')),
        merge: prefer.mergeDuplicates,
        ignore: prefer.ignoreDuplicates,
        select,
      });
      const res = await execute(ctx, compiled);
      if (!select) return reply.code(201).send();
      return sendResult(reply, { status: 201, body: singleOrList(res.body, res.n, single) });
    }

    if (method === 'PATCH') {
      if (!p.update) throw new AppError(403, '42501', `permission denied to update ${table}`);
      const body = jsonBody(req.body);
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw pgrstError(400, 'PGRST102', 'PATCH body must be a JSON object');
      const [patch] = await prepareRows(info, p.update, [body], pc);
      const read = parseRead(params);
      const compiled = compileUpdate(env, table, patch!, read.where, select);
      const res = await execute(ctx, compiled);
      if (!select) return reply.code(204).send();
      return sendResult(reply, { status: 200, body: singleOrList(res.body, res.n, single) });
    }

    if (method === 'DELETE') {
      const read = parseRead(params);
      const compiled = compileDelete(env, table, read.where, select);
      const res = await execute(ctx, compiled);
      if (!select) return reply.code(204).send();
      return sendResult(reply, { status: 200, body: singleOrList(res.body, res.n, single) });
    }

    throw new AppError(405, 'PGRST117', `Unsupported HTTP method: ${method}`);
  };

  app.route({ method: ['GET', 'HEAD', 'POST', 'PATCH', 'DELETE'], url: '/rest/v1/:table', handler: handle });

  app.post('/rest/v1/rpc/:name', async (req: FastifyRequest<{ Params: { name: string } }>, reply) => {
    const name = req.params.name;
    const rpc = deps.policies.rpc(name);
    const mode = deps.modes.modeFor(`rpc:${name}`);
    if (mode === 'proxy' || (!rpc && deps.proxy.enabled)) return deps.proxy.forward(req, reply, req.body as Buffer | null);
    if (!rpc) throw new AppError(404, 'PGRST202', `Could not find the function public.${name} in the schema cache`);
    const auth = await authenticate(deps, req);
    if (rpc.access === 'user' && auth.kind === 'anon') throw new AppError(401, '42501', 'permission denied: sign in required');
    const args = jsonBody(req.body) ?? {};
    if (typeof args !== 'object' || Array.isArray(args)) throw pgrstError(400, 'PGRST102', 'RPC arguments must be a JSON object');
    const r = await rpc.handler({ auth, identity: await auth.identity(), args: args as Record<string, unknown> });
    return sendResult(reply, r);
  });
}
