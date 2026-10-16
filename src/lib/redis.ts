/**
 * Redis client factory and a minimal key-value interface with an in-memory fallback, so unit tests and a single
 * developer machine work without Redis. Production requires REDIS_URL (enforced in config).
 */
import { Redis } from 'ioredis';
import type { Env } from '../config/env.js';

export interface Kv {
  /** Increments a counter in a fixed window; returns the new count and the window's remaining seconds. */
  incrWindow(key: string, windowSec: number): Promise<{ count: number; ttlSec: number }>;
  get(key: string): Promise<string | null>;
  /** SET with TTL. With `nx`, only sets when absent and returns false if the key existed. */
  set(key: string, value: string, ttlSec: number, nx?: boolean): Promise<boolean>;
  del(key: string): Promise<void>;
  ping(): Promise<boolean>;
  close(): Promise<void>;
}

export function createRedis(env: Env, purpose: string): Redis | null {
  if (!env.REDIS_URL) return null;
  return new Redis(env.REDIS_URL, {
    connectionName: `wishme-${purpose}`,
    maxRetriesPerRequest: purpose === 'bullmq' ? null : 3,
    enableReadyCheck: true,
    lazyConnect: false,
  });
}

export class RedisKv implements Kv {
  constructor(
    private readonly r: Redis,
    private readonly prefix: string,
  ) {}
  private k(key: string) {
    return `${this.prefix}:${key}`;
  }
  async incrWindow(key: string, windowSec: number) {
    const k = this.k(key);
    const res = await this.r.multi().incr(k).expire(k, windowSec, 'NX').ttl(k).exec();
    const count = Number(res?.[0]?.[1] ?? 0);
    const ttl = Number(res?.[2]?.[1] ?? windowSec);
    return { count, ttlSec: ttl > 0 ? ttl : windowSec };
  }
  async get(key: string) {
    return this.r.get(this.k(key));
  }
  async set(key: string, value: string, ttlSec: number, nx = false) {
    const res = nx
      ? await this.r.set(this.k(key), value, 'EX', ttlSec, 'NX')
      : await this.r.set(this.k(key), value, 'EX', ttlSec);
    return res === 'OK';
  }
  async del(key: string) {
    await this.r.del(this.k(key));
  }
  async ping() {
    try {
      return (await this.r.ping()) === 'PONG';
    } catch {
      return false;
    }
  }
  async close() {
    this.r.disconnect();
  }
}

/** Single-process fallback. Correct for one replica only; never used in production. */
export class MemoryKv implements Kv {
  private store = new Map<string, { value: string; expires: number }>();
  private live(key: string) {
    const e = this.store.get(key);
    if (!e) return null;
    if (e.expires <= Date.now()) {
      this.store.delete(key);
      return null;
    }
    return e;
  }
  async incrWindow(key: string, windowSec: number) {
    const e = this.live(key);
    if (!e) {
      this.store.set(key, { value: '1', expires: Date.now() + windowSec * 1000 });
      return { count: 1, ttlSec: windowSec };
    }
    e.value = String(Number(e.value) + 1);
    return { count: Number(e.value), ttlSec: Math.max(1, Math.ceil((e.expires - Date.now()) / 1000)) };
  }
  async get(key: string) {
    return this.live(key)?.value ?? null;
  }
  async set(key: string, value: string, ttlSec: number, nx = false) {
    if (nx && this.live(key)) return false;
    this.store.set(key, { value, expires: Date.now() + ttlSec * 1000 });
    return true;
  }
  async del(key: string) {
    this.store.delete(key);
  }
  async ping() {
    return true;
  }
  async close() {
    this.store.clear();
  }
}
