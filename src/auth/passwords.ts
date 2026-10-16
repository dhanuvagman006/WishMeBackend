/**
 * Password hashing.
 *  - Shared mode: bcrypt (cost 10), because Supabase GoTrue still verifies the same auth.users rows for old app builds
 *    and proxied routes. Upgrading a hash to Argon2 there would lock those users out of Supabase.
 *  - Standalone mode: Argon2id with OWASP parameters; bcrypt hashes are verified and upgraded on the next login.
 */
import { hash as argonHash, verify as argonVerify } from '@node-rs/argon2';
import bcrypt from 'bcryptjs';
import { createHash } from 'node:crypto';
import type { Logger } from '../lib/logger.js';

const ARGON = { memoryCost: 19_456, timeCost: 2, parallelism: 1, outputLen: 32 } as const;

/** A real bcrypt hash of a random string, compared against when the user does not exist (equalises timing). */
let dummyBcrypt: string | null = null;
const dummyHash = () => (dummyBcrypt ??= bcrypt.hashSync(crypto.randomUUID(), 10));

export class Passwords {
  constructor(
    private readonly mode: 'shared' | 'standalone',
    private readonly log: Logger,
  ) {}

  async hash(password: string): Promise<string> {
    if (this.mode === 'shared') return bcrypt.hash(password, 10);
    return argonHash(password, { ...ARGON, algorithm: 2 });
  }

  async verify(storedHash: string | null | undefined, password: string): Promise<boolean> {
    if (!storedHash) {
      await bcrypt.compare(password, dummyHash());
      return false;
    }
    try {
      if (storedHash.startsWith('$argon2')) return await argonVerify(storedHash, password);
      if (storedHash.startsWith('$2')) return await bcrypt.compare(password, storedHash);
    } catch (e) {
      this.log.warn({ err: (e as Error).message }, 'password verify failed on malformed hash');
    }
    return false;
  }

  needsRehash(storedHash: string): boolean {
    return this.mode === 'standalone' && !storedHash.startsWith('$argon2');
  }
}

/**
 * Have I Been Pwned range check (k-anonymity: only the first 5 hex chars of the SHA-1 leave the server).
 * Fails open after 2 s so an outage at HIBP never blocks sign-up.
 */
export async function isBreachedPassword(password: string, log: Logger): Promise<boolean> {
  const sha1 = createHash('sha1').update(password).digest('hex').toUpperCase();
  const prefix = sha1.slice(0, 5);
  const suffix = sha1.slice(5);
  try {
    const res = await fetch(`https://api.pwnedpasswords.com/range/${prefix}`, {
      headers: { 'Add-Padding': 'true', 'User-Agent': 'wishme-backend' },
      signal: AbortSignal.timeout(2000),
    });
    if (!res.ok) return false;
    const body = await res.text();
    return body.split('\n').some((line) => {
      const [hashSuffix, count] = line.trim().split(':');
      return hashSuffix === suffix && Number(count) > 0;
    });
  } catch (e) {
    log.debug({ err: (e as Error).message }, 'breach check skipped');
    return false;
  }
}
