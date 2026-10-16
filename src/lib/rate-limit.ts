/**
 * Named, fixed-window rate limits backed by the shared KV store. Used for sensitive endpoints (OTP, login, payments,
 * uploads) on top of the global per-IP limit configured in app.ts.
 */
import { tooMany } from './errors.js';
import type { Kv } from './redis.js';

export interface LimitRule {
  /** Max hits in the window. */
  limit: number;
  windowSec: number;
}

export class RateLimiter {
  constructor(private readonly kv: Kv) {}

  /** Counts a hit; throws 429 with Retry-After when over the limit. */
  async hit(name: string, subject: string, rule: LimitRule, message?: string): Promise<void> {
    const { count, ttlSec } = await this.kv.incrWindow(`rl:${name}:${subject}`, rule.windowSec);
    if (count > rule.limit) throw tooMany(ttlSec, message);
  }

  /** Checks several rules; every rule counts the hit. */
  async hitAll(name: string, checks: Array<{ subject: string; rule: LimitRule }>, message?: string): Promise<void> {
    for (const c of checks) await this.hit(name, c.subject, c.rule, message);
  }
}
