/**
 * Media that arrives inside JSON as `data:<mime>;base64,<…>` URIs (how every music tab sends recordings and images).
 * Decoding is strict: the mime must be on an allowlist, the payload must be real base64, and the decoded size is
 * bounded, so a client cannot make us forward arbitrary bytes to a vendor or store them in B2.
 */
import { badRequest } from '../../lib/errors.js';
import type { AudioInput } from '../../vendors/elevenlabs.js';

const AUDIO_MIMES: Record<string, string> = {
  'audio/mpeg': 'mp3',
  'audio/mp3': 'mp3',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/wave': 'wav',
  'audio/m4a': 'm4a',
  'audio/x-m4a': 'm4a',
  'audio/mp4': 'm4a',
  'audio/aac': 'aac',
  'audio/x-caf': 'caf',
  'audio/3gp': '3gp',
  'audio/3gpp': '3gp',
  'audio/ogg': 'ogg',
  'audio/webm': 'webm',
  'audio/flac': 'flac',
  // Some pickers label audio-only m4a files as video/mp4 or octet-stream.
  'video/mp4': 'm4a',
  'application/octet-stream': 'bin',
};

const IMAGE_MIMES: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};

export const MAX_AUDIO_UPLOAD_BYTES = 18 * 1024 * 1024;
export const MAX_IMAGE_UPLOAD_BYTES = 8 * 1024 * 1024;
const MIN_AUDIO_BYTES = 1024;

export interface DecodedMedia {
  data: Buffer;
  mime: string;
  ext: string;
}

function decode(input: string, allow: Record<string, string>, maxBytes: number, what: string, defaultMime: string): DecodedMedia {
  const m = /^data:([\w.+/-]+)(?:;[\w=.-]+)*;base64,/i.exec(input.slice(0, 200));
  let mime = defaultMime;
  let payload = input;
  if (m) {
    mime = m[1]!.toLowerCase();
    payload = input.slice(m[0].length);
  } else if (input.startsWith('data:')) {
    throw badRequest(`Invalid ${what} data`);
  }
  const ext = allow[mime];
  if (!ext) throw badRequest(`Unsupported ${what} format`);
  payload = payload.replace(/\s+/g, '');
  if (!/^[A-Za-z0-9+/_-]*={0,2}$/.test(payload)) throw badRequest(`Invalid ${what} data`);
  // 4 base64 chars per 3 bytes: reject before allocating when it is obviously too large.
  if (Math.floor((payload.length * 3) / 4) > maxBytes + 3) throw badRequest(`The ${what} file is too large (max ${Math.round(maxBytes / 1024 / 1024)} MB)`);
  const data = Buffer.from(payload, payload.includes('-') || payload.includes('_') ? 'base64url' : 'base64');
  if (data.length > maxBytes) throw badRequest(`The ${what} file is too large (max ${Math.round(maxBytes / 1024 / 1024)} MB)`);
  return { data, mime, ext };
}

export function decodeAudio(input: string, filename = 'audio'): AudioInput & { ext: string } {
  const d = decode(input, AUDIO_MIMES, MAX_AUDIO_UPLOAD_BYTES, 'audio', 'audio/wav');
  if (d.data.length < MIN_AUDIO_BYTES) throw badRequest('The audio recording is too short');
  const safeName = filename.replace(/[^\w.-]+/g, '_').slice(0, 80) || 'audio';
  return { data: d.data, mime: d.mime === 'application/octet-stream' ? 'audio/mpeg' : d.mime, ext: d.ext, filename: safeName.includes('.') ? safeName : `${safeName}.${d.ext}` };
}

export function decodeImage(input: string): DecodedMedia {
  const d = decode(input, IMAGE_MIMES, MAX_IMAGE_UPLOAD_BYTES, 'image', 'image/jpeg');
  if (d.data.length < 100) throw badRequest('Invalid image data');
  return d;
}

/** The app accepts audio either as a URL or as a data URI; this builds the latter for the no-storage fallback. */
export function toDataUri(data: Buffer, mime: string): string {
  return `data:${mime};base64,${data.toString('base64')}`;
}
