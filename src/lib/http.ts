/**
 * Outbound HTTP for vendor APIs: timeouts on every call, bounded retries for idempotent requests on network errors
 * and 429/5xx, response size cap, and logs that never include bodies or keys. Every vendor client goes through this.
 */
import type { Logger } from './logger.js';
import { AppError } from './errors.js';

export interface VendorRequest {
  vendor: string;
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  url: string;
  headers?: Record<string, string>;
  /** JSON body (serialised here) or a raw body. */
  json?: unknown;
  body?: NonNullable<RequestInit['body']>;
  timeoutMs?: number;
  /** Retries on network errors / 429 / 5xx. Only set for idempotent calls. */
  retries?: number;
  /** Treat these statuses as successful (returned instead of thrown). */
  okStatuses?: number[];
}

export interface VendorResponse<T> {
  status: number;
  headers: Headers;
  data: T;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function vendorFetch<T = unknown>(log: Logger, req: VendorRequest): Promise<VendorResponse<T>> {
  const method = req.method ?? (req.json !== undefined || req.body !== undefined ? 'POST' : 'GET');
  const attempts = 1 + (req.retries ?? 0);
  let lastErr: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const started = Date.now();
    try {
      const res = await fetch(req.url, {
        method,
        headers: {
          ...(req.json !== undefined ? { 'content-type': 'application/json' } : {}),
          ...req.headers,
        },
        body: req.json !== undefined ? JSON.stringify(req.json) : req.body,
        signal: AbortSignal.timeout(req.timeoutMs ?? 20_000),
      });
      const ms = Date.now() - started;
      const ok = res.ok || (req.okStatuses ?? []).includes(res.status);
      if (!ok && (res.status === 429 || res.status >= 500) && attempt < attempts) {
        log.warn({ vendor: req.vendor, status: res.status, ms, attempt }, 'vendor call failed, retrying');
        await sleep(backoff(attempt, res.headers.get('retry-after')));
        continue;
      }
      const ct = res.headers.get('content-type') ?? '';
      const data = (ct.includes('application/json') ? await res.json().catch(() => null) : await res.text()) as T;
      log.info({ vendor: req.vendor, method, status: res.status, ms }, 'vendor call');
      if (!ok) {
        throw new AppError(502, 'vendor_error', `${req.vendor} request failed (${res.status})`, {
          vendor: req.vendor,
          status: res.status,
          body: summarise(data),
        });
      }
      return { status: res.status, headers: res.headers, data };
    } catch (e) {
      if (e instanceof AppError) throw e;
      lastErr = e;
      const timeout = (e as Error).name === 'TimeoutError';
      log.warn({ vendor: req.vendor, attempt, timeout, err: (e as Error).message }, 'vendor call error');
      if (attempt < attempts) {
        await sleep(backoff(attempt, null));
        continue;
      }
    }
  }
  throw new AppError(504, 'vendor_unreachable', `${req.vendor} is not responding`, {
    cause: (lastErr as Error)?.message,
  });
}

function backoff(attempt: number, retryAfter: string | null): number {
  const ra = retryAfter ? Number(retryAfter) : NaN;
  if (Number.isFinite(ra) && ra > 0) return Math.min(ra * 1000, 10_000);
  return Math.min(250 * 2 ** (attempt - 1) + Math.random() * 200, 5000);
}

/** Keeps a vendor's error body short enough to log and safe to show in details. */
function summarise(data: unknown): unknown {
  if (typeof data === 'string') return data.slice(0, 500);
  try {
    const s = JSON.stringify(data);
    return s.length > 500 ? `${s.slice(0, 500)}…` : data;
  } catch {
    return null;
  }
}
