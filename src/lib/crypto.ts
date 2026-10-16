import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

/** A uniformly random numeric code with leading zeros, e.g. "042917". */
export function randomDigits(length = 6): string {
  let s = '';
  for (let i = 0; i < length; i++) s += String(randomInt(0, 10));
  return s;
}

export function sha256Hex(input: string | Buffer): string {
  return createHash('sha256').update(input).digest('hex');
}

/** Keyed hash for secrets we must look up later (refresh tokens, OTPs). The pepper never leaves the server. */
export function pepperedHash(pepper: string, input: string): string {
  return createHmac('sha256', pepper).update(input).digest('hex');
}

export function hmacSha256Hex(key: string, message: string | Buffer): string {
  return createHmac('sha256', key).update(message).digest('hex');
}

/** Constant-time string comparison (different lengths return false without leaking timing). */
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) {
    timingSafeEqual(ab, ab);
    return false;
  }
  return timingSafeEqual(ab, bb);
}

export function uuid(): string {
  return crypto.randomUUID();
}
