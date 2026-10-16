/**
 * The assistant's web research (web-search). Request and response keep production's contract
 * (supabase audit, functions/web-search):
 *
 *   { queries: string[1..3], recency?: any|day|week|month, depth?, query?, kind? }   (older builds send query/kind)
 *   → { ok, results: "<short, dated, source-named text for the model>", provider, credits, cached, took_ms, instruction? }
 *
 * Production read the web through Tavily with keyless fallbacks; this server grounds Gemini with Google Search
 * (decision for this backend; WEB_SEARCH_PROVIDER). Each query is answered in parallel within the app's 10 s budget,
 * answers are cached by freshness, and per-user limits match production (30 queries a minute, 300 a day).
 */
import type { Deps } from '../../deps.js';
import { geminiOf } from './ai-calls.js';

export type Recency = 'any' | 'day' | 'week' | 'month';

const TTL_SEC: Record<Recency, number> = { day: 300, week: 900, month: 6 * 3600, any: 6 * 3600 };
const PER_QUERY_MS = 8500;
export const SEARCH_LIMITS = { perMinute: { limit: 30, windowSec: 60 }, perDay: { limit: 300, windowSec: 86_400 } };

export const NOTHING =
  'Try one different query (another name or spelling, the office instead of the person, a broader or more specific subject), or say you could not find it. Do not guess.';
export const OFFLINE = "Say in one sentence that you couldn't reach the internet just now, give what you know, say it may be out of date, and offer to try again.";

export function normaliseQueries(body: { queries?: unknown; query?: unknown }): string[] {
  const raw = [...(Array.isArray(body.queries) ? body.queries : typeof body.queries === 'string' ? [body.queries] : []), body.query];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const q of raw) {
    const clean = typeof q === 'string' ? q.replace(/[\u0000-\u001F\u007F]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120) : '';
    if (clean.length >= 2 && !seen.has(clean.toLowerCase())) {
      seen.add(clean.toLowerCase());
      out.push(clean);
    }
  }
  return out.slice(0, 3);
}

const nowLabel = (ms: number) =>
  new Date(ms).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'long', year: 'numeric', hour: 'numeric', minute: '2-digit' });

interface Found {
  query: string;
  answer: string;
  sources: string[];
}

async function searchOne(deps: Deps, query: string, recency: Recency, now: number): Promise<{ found: Found | null; cached: boolean }> {
  const key = `websearch:${recency}:${query.toLowerCase()}`;
  const hit = await deps.kv.get(key);
  if (hit) return { found: JSON.parse(hit) as Found, cached: true };
  const fresh =
    recency === 'day' ? 'Only use information from the last 24 hours.' : recency === 'week' ? 'Prefer information from the last 7 days.' : recency === 'month' ? 'Prefer information from the last month.' : '';
  try {
    const { text, sources } = await geminiOf(deps).text({
      prompt:
        `Today is ${nowLabel(now)} (India time). Search the web and answer briefly and factually: ${JSON.stringify(query)}. ${fresh} ` +
        'Give dates for anything time-sensitive and name the sources in the text. At most 120 words. If nothing reliable is found, say so.',
      search: true,
      temperature: 0.2,
      maxTokens: 400,
      timeoutMs: PER_QUERY_MS,
    });
    const found: Found = { query, answer: text.slice(0, 1500), sources: [...new Set(sources.map((s) => s.title).filter(Boolean))].slice(0, 5) };
    await deps.kv.set(key, JSON.stringify(found), TTL_SEC[recency]);
    return { found, cached: false };
  } catch (e) {
    deps.log.warn({ err: (e as Error).message }, 'web search query failed');
    return { found: null, cached: false };
  }
}

export async function research(deps: Deps, queries: string[], recency: Recency): Promise<{ text: string; credits: number; cached: boolean; nothing: boolean } | null> {
  const now = Date.now();
  const sets = await Promise.all(queries.map((q) => searchOne(deps, q, recency, now)));
  const found = sets.filter((s) => s.found).map((s) => s.found!);
  if (!found.length) return null;
  const text = [
    `Searched ${nowLabel(now)}.`,
    ...found.map((f, i) => `\n[${i + 1}] ${f.query}\n${f.answer}${f.sources.length ? `\nSources: ${f.sources.join('; ')}` : ''}`),
  ].join('\n');
  const nothing = found.every((f) => /no reliable|could not find|couldn't find|no information/i.test(f.answer));
  return { text, credits: sets.filter((s) => s.found && !s.cached).length, cached: sets.every((s) => s.cached), nothing };
}
