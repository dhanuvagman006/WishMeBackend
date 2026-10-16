/**
 * Images for generated content: decoding the app's data URIs, fetching reference images from our own
 * storage only (never an arbitrary URL: no SSRF), and storing results in B2 under a per-user prefix.
 */
import type { Deps } from '../../deps.js';
import { AppError, badRequest, unavailable } from '../../lib/errors.js';
import { randomToken } from '../../lib/crypto.js';
import { B2 } from '../../vendors/b2.js';
import { Gemini, type InlineImage } from '../../vendors/gemini.js';

export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

/** The public prefix the app has always used for celebrity media (relative image_url values hang off it). */
export const LEGACY_B2_PUBLIC = 'https://f005.backblazeb2.com/file/wishmetoday/';

export const b2Of = (deps: Deps): B2 => deps.memo('b2', () => new B2(deps.env));
export const geminiOf = (deps: Deps): Gemini => deps.memo('gemini', () => new Gemini(deps.env, deps.log));

const IMAGE_TYPES: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/heic': 'heic',
  'image/heif': 'heif',
};

/** Decodes `data:image/...;base64,...` (the app's uploads) into an inline image, enforcing type and size. */
export function imageFromDataUri(value: string, field: string): InlineImage {
  const m = /^data:(image\/[a-z]+);base64,([A-Za-z0-9+/=\r\n]+)$/.exec(value.trim());
  if (!m || !IMAGE_TYPES[m[1]!]) throw badRequest(`${field} must be a JPEG, PNG or WebP image`);
  const data = m[2]!.replace(/[\r\n]/g, '');
  if (Math.floor((data.length * 3) / 4) > MAX_IMAGE_BYTES) throw new AppError(413, 'payload_too_large', 'The image is too large (max 8 MB)');
  return { mimeType: m[1] === 'image/jpg' ? 'image/jpeg' : m[1]!, data };
}

/** URL prefixes that point at storage this platform controls; reference images are only ever read from these. */
export function ownStoragePrefixes(deps: Deps): string[] {
  const env = deps.env;
  const list = [LEGACY_B2_PUBLIC, `${env.PUBLIC_URL.replace(/\/$/, '')}/storage/v1/object/public/`];
  if (env.B2_PUBLIC_BASE) list.push(`${env.B2_PUBLIC_BASE.replace(/\/$/, '')}/`);
  if (env.SUPABASE_URL) list.push(`${env.SUPABASE_URL.replace(/\/$/, '')}/storage/v1/object/public/`);
  return list;
}

/** Public URLs of one Storage bucket as the app builds them (`<base>/storage/v1/object/public/<bucket>/<path>`). */
export function bucketPrefixes(deps: Deps, bucket: string): string[] {
  return [deps.env.PUBLIC_URL, deps.env.SUPABASE_URL]
    .filter((b): b is string => !!b)
    .map((b) => `${b.replace(/\/$/, '')}/storage/v1/object/public/${bucket}/`);
}

/** True for a well-formed http(s) URL under our own storage (optionally: under one bucket). */
export function isOwnStorageUrl(deps: Deps, url: string, bucket?: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return false;
  if (parsed.username || parsed.password || url.includes('..') || url.length > 1000) return false;
  const prefixes = bucket ? bucketPrefixes(deps, bucket) : ownStoragePrefixes(deps);
  return prefixes.some((p) => url.startsWith(p));
}

/** Resolves a celebrity image_url (absolute or a bare B2 key) to an absolute URL. */
export function celebrityImageUrl(imageUrl: string | null | undefined): string | null {
  if (!imageUrl) return null;
  return /^https?:\/\//.test(imageUrl) ? imageUrl : `${LEGACY_B2_PUBLIC}${imageUrl.replace(/^\/+/, '')}`;
}

/**
 * Downloads an image from our own storage for use as a model reference. Returns null (and logs) on any problem:
 * a missing reference image degrades the result, it never fails a paid generation.
 */
export async function fetchOwnImage(deps: Deps, url: string | null | undefined): Promise<InlineImage | null> {
  if (!url) return null;
  if (url.startsWith('data:')) {
    try {
      return imageFromDataUri(url, 'reference image');
    } catch {
      return null;
    }
  }
  if (!isOwnStorageUrl(deps, url)) {
    deps.log.warn({ host: safeHost(url) }, 'reference image outside own storage ignored');
    return null;
  }
  try {
    const res = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(15_000) });
    const type = (res.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
    if (!res.ok || !IMAGE_TYPES[type]) return null;
    const len = Number(res.headers.get('content-length') ?? 0);
    if (len > MAX_IMAGE_BYTES) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > MAX_IMAGE_BYTES || buf.length === 0) return null;
    return { mimeType: type === 'image/jpg' ? 'image/jpeg' : type, data: buf.toString('base64') };
  } catch (e) {
    deps.log.warn({ err: (e as Error).message, host: safeHost(url) }, 'reference image fetch failed');
    return null;
  }
}

function safeHost(url: string): string | null {
  try {
    return new URL(url).host;
  } catch {
    return null;
  }
}

/** Fails fast (503) before anything is charged when generated files could not be stored and served. */
export function assertStorageReady(deps: Deps): void {
  const b2 = b2Of(deps);
  if (!b2.configured || !deps.env.B2_PUBLIC_BASE) throw unavailable('File storage is not configured');
}

export function assertAiReady(deps: Deps): void {
  if (!geminiOf(deps).configured) throw unavailable('AI generation is not configured');
}

/** Stores a generated image publicly under content/<profileId>/<folder>/ and returns its URL and key. */
export async function storeImage(
  deps: Deps,
  profileId: string,
  folder: string,
  id: string,
  image: { mimeType: string; data: Buffer },
): Promise<{ url: string; key: string }> {
  const ext = IMAGE_TYPES[image.mimeType] ?? 'png';
  const key = `content/${profileId}/${folder}/${id}-${randomToken(6)}.${ext}`;
  const b2 = b2Of(deps);
  await b2.putBuffer(key, image.data, image.mimeType, false);
  const url = b2.publicUrl(key);
  if (!url) throw unavailable('File storage is not configured');
  return { url, key };
}

/** Uploads an inline (base64) image the user sent, so jobs can refer to it by URL instead of carrying the bytes. */
export async function storeUpload(deps: Deps, profileId: string, folder: string, image: InlineImage): Promise<string> {
  const stored = await storeImage(deps, profileId, folder, 'ref', { mimeType: image.mimeType, data: Buffer.from(image.data, 'base64') });
  return stored.url;
}
