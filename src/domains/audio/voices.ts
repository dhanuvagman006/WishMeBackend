/**
 * Voices a user may see and use: ElevenLabs premade voices plus the voices that user cloned.
 *
 * Ownership of cloned voices lives in public.user_cloned_voices (user_id = profiles.id), as the deployed
 * elevenlabs-clone-voice / get-user-voices functions keep it; voices cloned under Supabase are therefore still found.
 * New clones are also labelled with the owner's auth user id at ElevenLabs (defence in depth, and a way to rebuild
 * the table). A voice id that is neither premade nor on the caller's rows is refused, so one user can neither list
 * nor speak with another user's clone.
 *
 * The premade list comes from ElevenLabs and is cached in the shared KV store for an hour.
 */
import type { Deps } from '../../deps.js';
import { forbidden } from '../../lib/errors.js';
import { ElevenLabs, type ElevenVoice } from '../../vendors/elevenlabs.js';

export const OWNER_LABEL = 'wishme_user_id';
const PREMADE_KEY = 'el:voices:premade';
const MAX_PAGES = 5;

export interface VoiceItem {
  voice_id: string;
  name: string;
  category: string;
  preview_url?: string;
  description?: string | null;
  created_at?: string;
}

export function elevenOf(deps: Deps): ElevenLabs {
  return deps.memo('elevenlabs', () => new ElevenLabs(deps.env, deps.log));
}

const toItem = (v: ElevenVoice): VoiceItem => ({
  voice_id: v.voice_id,
  name: v.name,
  category: v.category,
  ...(v.preview_url ? { preview_url: v.preview_url } : {}),
});

async function fetchPremade(deps: Deps): Promise<VoiceItem[]> {
  const el = elevenOf(deps);
  const out: VoiceItem[] = [];
  let token: string | null | undefined = null;
  for (let page = 0; page < MAX_PAGES; page++) {
    const res = await el.listVoices({ category: 'premade', pageToken: token });
    out.push(...(res.voices ?? []).map(toItem));
    if (!res.has_more || !res.next_page_token) break;
    token = res.next_page_token;
  }
  return out;
}

export async function premadeVoices(deps: Deps): Promise<VoiceItem[]> {
  const hit = await deps.kv.get(PREMADE_KEY);
  if (hit) return JSON.parse(hit) as VoiceItem[];
  const list = await fetchPremade(deps);
  if (list.length) await deps.kv.set(PREMADE_KEY, JSON.stringify(list), 3600);
  return list;
}

/** The caller's cloned voices, newest first (shape of the deployed get-user-voices). */
export async function clonedVoicesOf(deps: Deps, profileId: string): Promise<VoiceItem[]> {
  if (!deps.schema.table('user_cloned_voices')) return [];
  const rows = await deps.db<{ elevenlabs_voice_id: string; voice_name: string; voice_description: string | null; created_at: Date | null }[]>`
    select elevenlabs_voice_id, voice_name, voice_description, created_at
    from public.user_cloned_voices where user_id = ${profileId}
    order by created_at desc nulls last limit 100`;
  return rows.map((r) => ({
    voice_id: r.elevenlabs_voice_id,
    name: r.voice_name,
    category: 'cloned',
    description: r.voice_description,
    ...(r.created_at ? { created_at: new Date(r.created_at).toISOString() } : {}),
  }));
}

/** Records a new clone for its owner (idempotent on the table's unique (user_id, elevenlabs_voice_id)). */
export async function saveClonedVoice(deps: Deps, profileId: string, voiceId: string, name: string, description: string): Promise<void> {
  if (!deps.schema.table('user_cloned_voices')) {
    deps.log.error({ voiceId }, 'user_cloned_voices table missing; clone not recorded');
    return;
  }
  await deps.db`
    insert into public.user_cloned_voices (user_id, elevenlabs_voice_id, voice_name, voice_description)
    values (${profileId}, ${voiceId}, ${name}, ${description || null})
    on conflict (user_id, elevenlabs_voice_id) do nothing`;
}

/** The voice if the caller may use it (their own clone or a premade voice); 403 "Voice not available" otherwise. */
export async function usableVoice(deps: Deps, profileId: string, voiceId: string): Promise<VoiceItem> {
  const own = (await clonedVoicesOf(deps, profileId)).find((v) => v.voice_id === voiceId);
  if (own) return own;
  const premade = (await premadeVoices(deps)).find((v) => v.voice_id === voiceId);
  if (premade) return premade;
  throw forbidden('Voice not available', 'voice_not_available');
}
