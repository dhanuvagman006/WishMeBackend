/**
 * Realtime compat: a Phoenix-protocol WebSocket (what the app's hand-written Supabase Realtime clients speak), fed by
 * Postgres NOTIFY from the triggers in migrations/0003. Each replica LISTENs on its own direct connection and delivers
 * to its own sockets, so replicas scale out without a shared broker.
 *
 * Only `postgres_changes` with a simple `column=eq.value` filter is supported, and each subscription is authorised by
 * the table policy's realtime rule. Events carry the primary key only, never row data: the app only uses them as a
 * signal to refetch over REST, where the normal policies apply.
 */
import type { WebSocket } from 'ws';
import type postgres from 'postgres';
import type { AuthContext } from '../../auth/context.js';
import type { Deps } from '../../deps.js';
import { createDb } from '../../lib/db.js';
import { realtimeSockets } from '../../lib/metrics.js';

interface ChangeEvent {
  t: string;
  op: 'INSERT' | 'UPDATE' | 'DELETE';
  id: unknown;
  f: Record<string, unknown>;
  ts: string;
}

interface Subscription {
  id: number;
  topic: string;
  table: string;
  event: '*' | 'INSERT' | 'UPDATE' | 'DELETE';
  column: string;
  value: string;
  filter: string;
}

interface Client {
  socket: WebSocket;
  auth: AuthContext | null;
  subs: Subscription[];
  alive: boolean;
}

interface PhxMessage {
  topic?: string;
  event?: string;
  payload?: Record<string, unknown>;
  ref?: string | null;
  join_ref?: string | null;
}

const MAX_SUBS_PER_SOCKET = 20;
const MAX_MESSAGE_BYTES = 16 * 1024;

export class RealtimeHub {
  private readonly clients = new Set<Client>();
  private listener: postgres.Sql | null = null;
  private nextSubId = 1;
  private pingTimer: NodeJS.Timeout | null = null;

  constructor(private readonly deps: Deps) {}

  async start(): Promise<void> {
    this.listener = createDb(this.deps.env, this.deps.log, { max: 1, direct: true });
    await this.listener.listen('wishme_changes', (payload) => {
      try {
        this.dispatch(JSON.parse(payload) as ChangeEvent);
      } catch (e) {
        this.deps.log.warn({ err: (e as Error).message }, 'bad change notification');
      }
    });
    this.pingTimer = setInterval(() => this.heartbeat(), 30_000);
    this.pingTimer.unref();
    this.deps.log.info('realtime listening for changes');
  }

  async stop(): Promise<void> {
    if (this.pingTimer) clearInterval(this.pingTimer);
    for (const c of this.clients) c.socket.close(1001, 'server restarting');
    this.clients.clear();
    await this.listener?.end({ timeout: 5 }).catch(() => {});
  }

  get size(): number {
    return this.clients.size;
  }

  attach(socket: WebSocket): void {
    const client: Client = { socket, auth: null, subs: [], alive: true };
    this.clients.add(client);
    realtimeSockets.set(this.clients.size);
    socket.on('pong', () => (client.alive = true));
    socket.on('message', (data, isBinary) => {
      const size = Array.isArray(data) ? data.reduce((n, b) => n + b.length, 0) : (data as Buffer).byteLength;
      if (isBinary || size > MAX_MESSAGE_BYTES) return socket.close(1009, 'message too large');
      let msg: PhxMessage;
      try {
        msg = JSON.parse(data.toString()) as PhxMessage;
      } catch {
        return;
      }
      this.onMessage(client, msg).catch((e: unknown) => {
        this.deps.log.warn({ err: (e as Error).message }, 'realtime message failed');
        this.reply(client, msg, 'error', { reason: 'internal error' });
      });
    });
    socket.on('close', () => {
      this.clients.delete(client);
      realtimeSockets.set(this.clients.size);
    });
    socket.on('error', () => socket.terminate());
  }

  private send(client: Client, msg: Record<string, unknown>) {
    if (client.socket.readyState === client.socket.OPEN) client.socket.send(JSON.stringify(msg));
  }

  private reply(client: Client, msg: PhxMessage, status: 'ok' | 'error', response: Record<string, unknown>) {
    this.send(client, { topic: msg.topic ?? 'phoenix', event: 'phx_reply', payload: { status, response }, ref: msg.ref ?? null, join_ref: msg.join_ref ?? msg.ref ?? null });
  }

  private async onMessage(client: Client, msg: PhxMessage): Promise<void> {
    switch (msg.event) {
      case 'heartbeat':
        return this.reply(client, msg, 'ok', {});
      case 'access_token': {
        const token = msg.payload?.access_token;
        if (typeof token === 'string') client.auth = await this.deps.resolver.resolve(token).catch(() => client.auth);
        return;
      }
      case 'phx_leave':
        client.subs = client.subs.filter((s) => s.topic !== msg.topic);
        return this.reply(client, msg, 'ok', {});
      case 'phx_join':
        return this.join(client, msg);
      default:
        return;
    }
  }

  private async join(client: Client, msg: PhxMessage): Promise<void> {
    const topic = msg.topic ?? '';
    const payload = msg.payload ?? {};
    const token = payload.access_token;
    try {
      client.auth = await this.deps.resolver.resolve(typeof token === 'string' ? token : null);
    } catch {
      return this.reply(client, msg, 'error', { reason: 'Invalid JWT' });
    }
    const config = (payload.config ?? {}) as { postgres_changes?: Array<{ event?: string; schema?: string; table?: string; filter?: string }> };
    const specs = config.postgres_changes ?? [];
    const accepted: Array<Record<string, unknown>> = [];
    const identity = await client.auth.identity();
    for (const spec of specs) {
      if (client.subs.length >= MAX_SUBS_PER_SOCKET) return this.reply(client, msg, 'error', { reason: 'Too many subscriptions' });
      const table = spec.table ?? '';
      const event = (spec.event ?? '*').toUpperCase() as Subscription['event'];
      const rule = this.deps.policies.table(table)?.realtime;
      const m = /^([A-Za-z_][A-Za-z0-9_]*)=eq\.(.+)$/.exec(spec.filter ?? '');
      if ((spec.schema ?? 'public') !== 'public' || !rule || !m || !['*', 'INSERT', 'UPDATE', 'DELETE'].includes(event)) {
        return this.reply(client, msg, 'error', { reason: `Unable to subscribe to changes with given parameters (${table})` });
      }
      const [, column, value] = m as unknown as [string, string, string];
      if (!rule.filterColumns.includes(column) || !(await rule.authorize(client.auth, identity, column, value, this.deps))) {
        return this.reply(client, msg, 'error', { reason: 'Unauthorized' });
      }
      const sub: Subscription = { id: this.nextSubId++, topic, table, event, column, value, filter: spec.filter! };
      client.subs.push(sub);
      accepted.push({ id: sub.id, event: spec.event ?? '*', schema: 'public', table, filter: sub.filter });
    }
    this.reply(client, msg, 'ok', { postgres_changes: accepted });
    this.send(client, {
      topic,
      event: 'system',
      payload: { status: 'ok', message: 'Subscribed to PostgreSQL', extension: 'postgres_changes', channel: topic.replace(/^realtime:/, '') },
      ref: null,
    });
  }

  private dispatch(ev: ChangeEvent): void {
    for (const client of this.clients) {
      for (const sub of client.subs) {
        if (sub.table !== ev.t) continue;
        if (sub.event !== '*' && sub.event !== ev.op) continue;
        const v = ev.f[sub.column];
        if (v === undefined || v === null || String(v) !== sub.value) continue;
        const record = { id: ev.id };
        this.send(client, {
          topic: sub.topic,
          event: 'postgres_changes',
          payload: {
            ids: [sub.id],
            eventType: ev.op,
            data: {
              schema: 'public',
              table: ev.t,
              commit_timestamp: ev.ts,
              type: ev.op,
              eventType: ev.op,
              columns: [],
              record: ev.op === 'DELETE' ? {} : record,
              old_record: ev.op === 'DELETE' ? record : {},
              new: ev.op === 'DELETE' ? {} : record,
              old: ev.op === 'DELETE' ? record : {},
              errors: null,
            },
          },
          ref: null,
        });
      }
    }
  }

  private heartbeat(): void {
    const now = Math.floor(Date.now() / 1000);
    for (const c of this.clients) {
      if (!c.alive) {
        c.socket.terminate();
        continue;
      }
      c.alive = false;
      c.socket.ping();
      // An expired user token loses its subscriptions; the app opens a new socket with its refreshed token.
      const exp = c.auth?.claims.exp;
      if (c.auth?.kind === 'user' && typeof exp === 'number' && exp < now && c.subs.length) {
        for (const s of c.subs) this.send(c, { topic: s.topic, event: 'system', payload: { status: 'error', message: 'Token has expired' }, ref: null });
        c.subs = [];
      }
    }
  }
}
