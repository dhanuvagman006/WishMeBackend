/**
 * Songs (Suno via sunoapi.org, as in the deployed generate-music / check-music-status functions).
 *
 *   generate-music      charge + music_generations row ('pending') in one transaction → start the Suno task →
 *                       row 'processing' with api_task_id (refund + 'failed' if Suno refuses)
 *   check-music-status  on demand: ask Suno about the task; on SUCCESS copy the song into B2 and complete the row;
 *                       on a Suno failure or after TIMEOUT_MS fail the row and refund
 *
 * Every transition is guarded on the current status, so concurrent polls, late finishes and the maintenance sweep
 * cannot complete or refund twice; the refund's ledger key is derived from the generation id.
 * Completing the row fires the database's referral-commission trigger, which reads `price_paid`.
 */
import { randomUUID } from 'node:crypto';
import type { Deps } from '../../deps.js';
import { AppError } from '../../lib/errors.js';
import { downloadSong, Suno, SUNO_FAILED } from '../../vendors/suno.js';
import { chargeIn, pricePaise, refund, type Payer } from './charge.js';
import { insertHistory, updateHistory } from './history.js';
import { storeMedia } from './storage.js';

/** Same limit as the deployed check-music-status: Suno often needs 2–3+ minutes. */
export const TIMEOUT_MS = 10 * 60 * 1000;
const TIMEOUT_MESSAGE = 'Generation timed out. Your wallet has been refunded.';
const LYRICS_MAX = 3000;
const DESCRIPTION_MAX = 500;

const PROGRESS: Record<string, string> = {
  PENDING: 'Starting composition...',
  TEXT_SUCCESS: 'Creating melody...',
  FIRST_SUCCESS: 'Adding vocals and mixing...',
};

export function sunoOf(deps: Deps): Suno {
  return deps.memo('suno', () => new Suno(deps.env, deps.log));
}

export interface SongRequest {
  title: string;
  type: 'with_lyrics' | 'instrumental';
  genre: string;
  mood: string;
  prompt: string;
  voiceType?: 'any' | 'male' | 'female' | undefined;
  language?: string | undefined;
  lyrics?: string | undefined;
  description?: string | undefined;
}

/** The Suno request for a song: custom mode sings the given lyrics; without lyrics Suno writes its own. */
export function sunoRequest(r: SongRequest, callBackUrl: string) {
  const full = r.type === 'with_lyrics';
  const voice = r.voiceType === 'female' ? 'female vocalist' : r.voiceType === 'male' ? 'male vocalist' : 'vocalist';
  const style = [r.genre, r.mood, r.language || 'Hindi/English', full ? voice : 'instrumental', 'professional recording'].filter(Boolean).join(', ').slice(0, 200);
  const vocalGender = full && r.voiceType === 'female' ? ('f' as const) : full && r.voiceType === 'male' ? ('m' as const) : undefined;
  if (full && r.lyrics) {
    return { title: r.title, style, prompt: r.lyrics.slice(0, LYRICS_MAX), customMode: true, instrumental: false, ...(vocalGender ? { vocalGender } : {}), callBackUrl };
  }
  if (full) {
    const about = `${r.prompt}${r.language ? ` (sung in ${r.language})` : ''}`.slice(0, DESCRIPTION_MAX);
    return { title: r.title, style, prompt: about, customMode: false, instrumental: false, ...(vocalGender ? { vocalGender } : {}), callBackUrl };
  }
  return { title: r.title, style, prompt: (r.description || r.prompt).slice(0, DESCRIPTION_MAX), customMode: true, instrumental: true, callBackUrl };
}

export async function startSong(deps: Deps, payer: Payer, r: SongRequest): Promise<{ generationId: string; taskId: string }> {
  const suno = sunoOf(deps);
  if (!suno.configured) throw new AppError(503, 'unavailable', 'Music generation is not configured');
  if (!deps.schema.table('music_generations')) throw new AppError(503, 'unavailable', 'Music generation is not available');
  const generationId = randomUUID();
  const service = r.type === 'instrumental' ? 'instrumental' : 'full_song';
  const price = pricePaise(service) / 100;
  await deps.db.begin(async (tx) => {
    await chargeIn(deps, tx, payer, service, generationId);
    await insertHistory(deps, tx, 'music_generations', {
      id: generationId,
      user_id: payer.profileId,
      song_title: r.title,
      genre: r.genre,
      mood: r.mood,
      prompt: r.prompt,
      lyrics: r.type === 'with_lyrics' ? (r.lyrics ?? null) : null,
      generation_type: r.type,
      status: 'pending',
      credits_used: 1,
      price_paid: price,
    });
  });

  let taskId: string;
  try {
    // Suno requires a callback URL. We poll instead; its POSTs to this authenticated function are refused harmlessly.
    taskId = await suno.generate(sunoRequest(r, `${deps.env.PUBLIC_URL.replace(/\/$/, '')}/functions/v1/check-music-status`));
  } catch (e) {
    const message = e instanceof AppError ? e.message : 'Music generation failed';
    await failSong(deps, payer.profileId, generationId, message, e instanceof AppError ? e.code : 'internal_error', ['pending']);
    throw e;
  }
  await updateHistory(deps, deps.db, 'music_generations', generationId, { status: 'processing', api_task_id: taskId }, 'pending');
  return { generationId, taskId };
}

/**
 * Marks a song failed and refunds what this server charged for it; a no-op if it already left `from`.
 * Rows without a server debit (created before this server took over) are failed but not refunded.
 */
export async function failSong(deps: Deps, profileId: string, id: string, message: string, reason: string, from: string[] = ['pending', 'processing']): Promise<boolean> {
  let changed = 0;
  for (const status of from) {
    changed += await updateHistory(deps, deps.db, 'music_generations', id, { status: 'failed', error_message: message.slice(0, 300) }, status);
    if (changed) break;
  }
  if (changed === 0) return false;
  const debit = await deps.db<{ s: string | null; amount: string }[]>`
    select metadata ->> 'service_type' as s, abs(amount_paise)::text as amount
    from wishme.ledger_entries
    where idempotency_key = ${`audio:${id}:debit`} and account_kind = 'user_wallet' and account_id = ${profileId}`;
  const d = debit[0];
  if (!d) return true;
  const service = d.s === 'instrumental' ? 'instrumental' : 'full_song';
  await refund(deps, { profileId, userId: 'system' }, { service, orderId: id, amountPaise: Number(d.amount) }, reason);
  return true;
}

interface SongRow {
  id: string;
  status: string;
  song_url: string | null;
  download_url: string | null;
  error_message: string | null;
  api_task_id: string | null;
  song_title: string | null;
  created_at: Date;
}

export interface SongStatus {
  status: string;
  song_url?: string;
  download_url?: string;
  error?: string;
  message?: string;
  duration?: number;
}

async function loadSong(deps: Deps, profileId: string, id: string): Promise<SongRow | null> {
  const rows = await deps.db.unsafe(
    `select id::text, status::text as status, song_url, download_url, error_message, api_task_id, song_title, created_at
     from public.music_generations where id = $1::text::uuid and user_id = $2::text::uuid`,
    [id, profileId],
  );
  return (rows[0] as unknown as SongRow | undefined) ?? null;
}

const done = (row: SongRow): SongStatus | null => {
  if (row.status === 'completed') {
    const url = row.song_url ?? row.download_url ?? undefined;
    return { status: 'completed', ...(url ? { song_url: url, download_url: row.download_url ?? url } : {}) };
  }
  if (row.status === 'failed') return { status: 'failed', error: row.error_message ?? 'Music generation failed' };
  return null;
};

/** Status of the caller's own song (null when it is not theirs), advancing it from Suno's answer. */
export async function songStatus(deps: Deps, payer: Payer, id: string): Promise<SongStatus | null> {
  if (!deps.schema.table('music_generations')) return null;
  const row = await loadSong(deps, payer.profileId, id);
  if (!row) return null;
  const final = done(row);
  if (final) return final;

  if (Date.now() - new Date(row.created_at).getTime() > TIMEOUT_MS || !row.api_task_id) {
    if (!row.api_task_id && Date.now() - new Date(row.created_at).getTime() < 60_000) return { status: 'processing', message: PROGRESS.PENDING };
    await failSong(deps, payer.profileId, id, TIMEOUT_MESSAGE, 'timeout');
    return done((await loadSong(deps, payer.profileId, id))!) ?? { status: 'failed', error: TIMEOUT_MESSAGE };
  }

  let info;
  try {
    info = await sunoOf(deps).recordInfo(row.api_task_id);
  } catch {
    // A transient status-check failure is not a song failure: keep the app polling.
    return { status: 'processing', message: 'Checking status...' };
  }

  if (SUNO_FAILED.has(info.status)) {
    const message = info.status === 'SENSITIVE_WORD_ERROR' ? 'The lyrics or description were rejected by the music service. Your wallet has been refunded.' : 'Song generation failed. Your wallet has been refunded.';
    await failSong(deps, payer.profileId, id, message, `suno:${info.status}`);
    return done((await loadSong(deps, payer.profileId, id))!) ?? { status: 'failed', error: message };
  }

  const track = info.tracks[0];
  const audio = track?.audioUrl ?? track?.audio_url;
  if (info.status !== 'SUCCESS' || !audio) return { status: 'processing', message: PROGRESS[info.status] ?? 'Composing your song...' };

  // One poller copies the song; the others keep showing "processing" until it is done.
  const lock = `music:finish:${id}`;
  if (!(await deps.kv.set(lock, '1', 120, true))) return { status: 'processing', message: 'Finishing your song...' };
  try {
    const data = await downloadSong(deps.log, audio);
    const stored = await storeMedia(deps, { profileId: payer.profileId, kind: 'music', data, mime: 'audio/mpeg', ext: 'mp3' });
    await updateHistory(
      deps,
      deps.db,
      'music_generations',
      id,
      { status: 'completed', song_url: stored.url, download_url: stored.url, completed_at: new Date(), duration: track?.duration ? Math.round(track.duration) : null },
      'processing',
    );
  } catch (e) {
    deps.log.warn({ generationId: id, err: e instanceof AppError ? e.code : 'error' }, 'could not finish song yet');
    return { status: 'processing', message: 'Finishing your song...' };
  } finally {
    await deps.kv.del(lock).catch(() => {});
  }
  const after = await loadSong(deps, payer.profileId, id);
  return (after && done(after)) ?? { status: 'processing', message: 'Finishing your song...' };
}

/**
 * For a maintenance job: fails and refunds songs nobody polled to the end (app closed) once they are older than
 * TIMEOUT_MS. Returns how many were refunded or failed.
 */
export async function sweepStaleMusic(deps: Deps, limit = 100): Promise<number> {
  if (!deps.schema.table('music_generations')) return 0;
  const rows = await deps.db<{ id: string; user_id: string }[]>`
    select id::text, user_id::text from public.music_generations
    where status in ('pending', 'processing') and created_at < now() - make_interval(secs => ${TIMEOUT_MS / 1000})
    order by created_at limit ${limit}`;
  let n = 0;
  for (const r of rows) if (await failSong(deps, r.user_id, r.id, TIMEOUT_MESSAGE, 'timeout')) n++;
  return n;
}
