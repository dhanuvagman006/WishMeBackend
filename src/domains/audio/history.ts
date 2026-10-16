/**
 * Server-written generation history rows (tts_generations, music_generations, …). The exact Supabase columns are only
 * known by introspection, so only columns that exist in the schema cache are written; json/uuid values are cast
 * through text (CONTRIBUTING rule 7). Table names come from a fixed allowlist, never from the request.
 */
import type { Deps } from '../../deps.js';
import type { Db, Tx } from '../../lib/db.js';

export const HISTORY_TABLES = [
  'music_generations',
  'tts_generations',
  'voice_conversion_generations',
  'sound_effect_generations',
  'audio_isolation_generations',
  'image_music_generations',
] as const;
export type HistoryTable = (typeof HISTORY_TABLES)[number];

function prepare(deps: Deps, table: HistoryTable, row: Record<string, unknown>) {
  const info = deps.schema.table(table);
  if (!info) return null;
  const cols = Object.keys(row).filter((c) => info.columns.has(c) && row[c] !== undefined);
  const values = cols.map((c) => {
    const v = row[c];
    return v !== null && typeof v === 'object' && !(v instanceof Date) ? JSON.stringify(v) : v instanceof Date ? v.toISOString() : v;
  });
  const casts = cols.map((c, i) => {
    const t = info.columns.get(c)!.type;
    if (t === 'json' || t === 'jsonb') return `$${i + 1}::text::jsonb`;
    if (t === 'uuid') return `$${i + 1}::text::uuid`;
    if (t.startsWith('timestamp')) return `$${i + 1}::text::timestamptz`;
    return `$${i + 1}`;
  });
  return { cols, values, casts };
}

/** Inserts a history row; returns its id (text) or null when the table does not exist. */
export async function insertHistory(deps: Deps, q: Db | Tx, table: HistoryTable, row: Record<string, unknown>): Promise<string | null> {
  const p = prepare(deps, table, row);
  if (!p || p.cols.length === 0) return null;
  const res = await q.unsafe(
    `insert into public.${table} (${p.cols.map((c) => `"${c}"`).join(', ')}) values (${p.casts.join(', ')}) returning id::text as id`,
    p.values as never[],
  );
  return (res[0] as { id: string } | undefined)?.id ?? null;
}

/**
 * Best-effort insert for rows written after the user has been charged and served: a failure is logged, not thrown,
 * because the money and the audio are already settled and the response must still reach the app.
 */
export async function recordHistory(deps: Deps, table: HistoryTable, row: Record<string, unknown>): Promise<string | null> {
  try {
    return await insertHistory(deps, deps.db, table, row);
  } catch (e) {
    deps.log.error({ table, err: (e as Error).message }, 'could not write generation history row');
    return null;
  }
}

/** Updates a history row by id; `where` adds a guard (e.g. status = 'processing'). Returns rows changed. */
export async function updateHistory(
  deps: Deps,
  q: Db | Tx,
  table: HistoryTable,
  id: string,
  set: Record<string, unknown>,
  guardStatus?: string,
): Promise<number> {
  const p = prepare(deps, table, set);
  if (!p || p.cols.length === 0) return 0;
  const n = p.cols.length;
  const assignments = p.cols.map((c, i) => `"${c}" = ${p.casts[i]}`).join(', ');
  const guard = guardStatus !== undefined ? ` and status = $${n + 2}` : '';
  const res = await q.unsafe(
    `update public.${table} set ${assignments} where id = $${n + 1}::text::uuid${guard}`,
    [...p.values, id, ...(guardStatus !== undefined ? [guardStatus] : [])] as never[],
  );
  return res.count;
}
