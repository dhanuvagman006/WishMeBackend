/**
 * Wallet charges for the AI Music Studio. The price is a server constant (the app shows the same numbers and only
 * pre-checks the balance); the debit happens before the vendor call, and a vendor failure refunds it through the
 * ledger with a deterministic key, so a retry of the refund can never pay twice.
 */
import type { Deps } from '../../deps.js';
import type { Tx } from '../../lib/db.js';
import { AppError } from '../../lib/errors.js';
import { markMirrorable } from '../wallet/mirrors.js';

/**
 * Prices in whole rupees (wallet_balance is an integer column), identical to `COSTS` in the app
 * (components/music/shared.tsx), which shows them on every button and pre-checks the balance against them. The
 * deployed generate-music charged 150 / 100 with no plan discount; the deployed ElevenLabs functions charged nothing,
 * so charging those tabs is new server behaviour at the prices the app already displays.
 */
export const AUDIO_PRICES_RUPEES = {
  tts: 50,
  voice_conversion: 75,
  sfx: 60,
  audio_isolation: 40,
  instrumental: 100,
  full_song: 150,
  voice_clone: 150,
  image_music_instrumental: 120,
  image_music_vocals: 150,
} as const;
export type AudioService = keyof typeof AUDIO_PRICES_RUPEES;

export const pricePaise = (s: AudioService): number => AUDIO_PRICES_RUPEES[s] * 100;

/**
 * transaction_type 'music_generation' as the deployed generate-music wrote it (and the only audio type in the
 * wallet_transactions CHECK constraint); details.service_type tells the tabs apart.
 */
export const AUDIO_TX_KIND = 'music_generation';

const DESCRIPTIONS: Record<AudioService, string> = {
  tts: 'AI Text to Speech',
  voice_conversion: 'AI Voice Conversion',
  sfx: 'AI Sound Effect',
  audio_isolation: 'AI Audio Isolation',
  instrumental: 'AI Music - Instrumental',
  full_song: 'AI Music - Full Song',
  voice_clone: 'AI Voice Clone',
  image_music_instrumental: 'AI Image + Music',
  image_music_vocals: 'AI Image + Music (Vocals)',
};

export interface Payer {
  userId: string;
  profileId: string;
}

export interface Charge {
  service: AudioService;
  orderId: string;
  amountPaise: number;
  ledgerId: string;
}

function debit(payer: Payer, service: AudioService, orderId: string) {
  return {
    accountId: payer.profileId,
    deltaPaise: -pricePaise(service),
    kind: AUDIO_TX_KIND,
    idempotencyKey: `audio:${orderId}:debit`,
    createdBy: payer.userId,
    description: DESCRIPTIONS[service],
    paymentMethod: 'wallet' as const,
    details: markMirrorable({ service_type: service, order_id: orderId }),
    reference: { type: 'audio_generation', id: orderId },
  };
}

/** Debits inside the caller's transaction (so a history row can be created atomically with the charge). */
export async function chargeIn(deps: Deps, tx: Tx, payer: Payer, service: AudioService, orderId: string): Promise<Charge> {
  const r = await deps.ledger.apply(tx, 'user_wallet', debit(payer, service, orderId));
  return { service, orderId, amountPaise: pricePaise(service), ledgerId: r.ledgerId };
}

export async function charge(deps: Deps, payer: Payer, service: AudioService, orderId: string): Promise<Charge> {
  const r = await deps.ledger.run('user_wallet', debit(payer, service, orderId));
  return { service, orderId, amountPaise: pricePaise(service), ledgerId: r.ledgerId };
}

/** Refunds a charge. Idempotent: the key is derived from the order, so concurrent or repeated calls credit once. */
export async function refund(deps: Deps, payer: Payer, c: Pick<Charge, 'service' | 'orderId' | 'amountPaise'>, reason: string): Promise<void> {
  try {
    await deps.ledger.run('user_wallet', {
      accountId: payer.profileId,
      deltaPaise: c.amountPaise,
      kind: 'refund',
      idempotencyKey: `audio:${c.orderId}:refund`,
      createdBy: 'system',
      description: `Refund: ${DESCRIPTIONS[c.service]}`,
      // wallet_transactions.payment_method has a CHECK constraint without 'system'.
      paymentMethod: 'wallet',
      details: { service_type: c.service, order_id: c.orderId, reason: reason.slice(0, 200) },
      reference: { type: 'audio_generation', id: c.orderId },
    });
  } catch (e) {
    // The user was charged and not served: this must page someone. The order id lets support find it.
    deps.log.error({ orderId: c.orderId, service: c.service, err: (e as Error).message }, 'AUDIO REFUND FAILED');
    throw e;
  }
}

/**
 * Charge, run the vendor work, refund if it throws. The work's error is rethrown (the app shows its message).
 */
export async function withCharge<T>(deps: Deps, payer: Payer, service: AudioService, orderId: string, work: (c: Charge) => Promise<T>): Promise<T> {
  const c = await charge(deps, payer, service, orderId);
  try {
    return await work(c);
  } catch (e) {
    await refund(deps, payer, c, e instanceof AppError ? e.code : 'internal_error');
    throw e;
  }
}
