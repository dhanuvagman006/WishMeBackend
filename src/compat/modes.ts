/**
 * Local or proxy, per route group. Groups are hierarchical: `rest:profiles` falls back to `rest`, which falls back to
 * COMPAT_DEFAULT_MODE. Examples of ROUTE_MODES:
 *   {"auth":"local"}                              GoTrue served here, everything else proxied
 *   {"rest":"local","rest:wallet_transactions":"proxy"}
 */
import type { Env } from '../config/env.js';

export type Mode = 'local' | 'proxy';

export class RouteModes {
  constructor(private readonly env: Env) {}

  modeFor(group: string): Mode {
    const overrides = this.env.ROUTE_MODES;
    if (overrides[group]) return overrides[group];
    const family = group.split(':')[0]!;
    if (overrides[family]) return overrides[family];
    return this.env.COMPAT_DEFAULT_MODE;
  }

  get canProxy(): boolean {
    return !!this.env.SUPABASE_URL;
  }

  /** All overrides plus the default, for /api/v1/config and the admin status page. */
  snapshot(): { default: Mode; overrides: Record<string, Mode> } {
    return { default: this.env.COMPAT_DEFAULT_MODE, overrides: { ...this.env.ROUTE_MODES } };
  }
}
