/**
 * Where generated audio (and the images used for Img+Music) is kept: Backblaze B2, under a per-user prefix
 * `audio/<profileId>/<kind>/<random>.<ext>`. The caller of b2-get-signed-url may sign anything under its own prefix.
 *
 * As the deployed functions did, generated audio goes to the main bucket and the app gets its public URL
 * (B2_PUBLIC_BASE), because history rows keep `audio_url` and the app plays it later without re-signing; keys are
 * unguessable. Without a public base a 7-day signed URL is returned. Without B2 at all (development) the audio is
 * returned inline as a data: URI, which is what the deployed functions returned as `audioUrl`.
 */
import { randomUUID } from 'node:crypto';
import type { Deps } from '../../deps.js';
import { B2 } from '../../vendors/b2.js';
import { toDataUri } from './media.js';

export const SIGNED_FALLBACK_TTL_SEC = 7 * 24 * 3600;

export function b2Of(deps: Deps): B2 {
  return deps.memo('b2', () => new B2(deps.env));
}

export function audioPrefix(profileId: string): string {
  return `audio/${profileId}/`;
}

export interface StoredMedia {
  url: string;
  /** B2 object key, or null when returned inline. */
  key: string | null;
}

export async function storeMedia(
  deps: Deps,
  input: { profileId: string; kind: string; data: Buffer; mime: string; ext: string },
): Promise<StoredMedia> {
  const b2 = b2Of(deps);
  if (!b2.configured) {
    if (deps.env.NODE_ENV === 'production') deps.log.warn({ kind: input.kind }, 'B2 not configured; returning media inline');
    return { url: toDataUri(input.data, input.mime), key: null };
  }
  const key = `${audioPrefix(input.profileId)}${input.kind}/${randomUUID()}.${input.ext}`;
  await b2.putBuffer(key, input.data, input.mime, false);
  const url = b2.publicUrl(key) ?? (await b2.signedGetUrl(key, { isPrivate: false, expiresSec: SIGNED_FALLBACK_TTL_SEC }));
  return { url, key };
}
