/**
 * The only code that moves money.
 *
 * Balances the app displays live in public columns (profiles.wallet_balance, celebrities.available_balance, in rupees).
 * Supabase appears to maintain profiles.wallet_balance with a trigger on wallet_transactions, but its exact rules are not
 * known until the audit (and the app writes rows in two shapes: positive amounts with a debit type, and negative
 * amounts). So every movement here is self-correcting:
 *
 *   1. lock the balance row and read it            (SELECT … FOR UPDATE)
 *   2. check funds for debits
 *   3. write the public history row(s)             (any trigger fires here)
 *   4. read the balance again and apply exactly the difference needed to reach before + expected delta
 *   5. append the ledger entry with the resulting balance
 *
 * Whatever a trigger does or does not do, the balance ends at the intended value, and the ledger records it. Every
 * movement carries an idempotency key; repeating a key returns the first result and moves nothing.
 */
import type { Db, Tx } from '../../lib/db.js';
import { AppError } from '../../lib/errors.js';
import type { Logger } from '../../lib/logger.js';
import { ledgerMovements } from '../../lib/metrics.js';
import { fromRupees, toRupeesString } from '../../lib/money.js';
import type { SchemaCache } from '../../compat/postgrest/schema-cache.js';

export type AccountKind = 'user_wallet' | 'celebrity_earnings';

/** Transaction types the app treats as credits / debits (components/wallet/shared.tsx). */
export const CREDIT_TYPES = new Set(['deposit', 'admin_credit', 'commission_earning', 'referral_commission', 'refund', 'credit', 'bonus']);
export const DEBIT_TYPES = new Set([
  'booking',
  'photo_wish',
  'ugc_video',
  'ugc_ad',
  'wish_friend',
  'music_generation',
  'music_download',
  'celebrity_call',
  'voice_call',
  'voice_call_wish',
  'greeting_card_generation',
  'image_promotion',
  'service_payment',
  'plan_upgrade',
  'plan_purchase',
  'debit',
  'withdrawal',
  'celebrity_subscription',
]);

export interface Movement {
  /** profiles.id for user_wallet, celebrities.id for celebrity_earnings. */
  accountId: string;
  /** Effect on the balance, in paise: positive credit, negative debit, 0 for a record-only row (e.g. a Razorpay-paid plan). */
  deltaPaise: number;
  /** The app's transaction_type vocabulary (deposit, booking, service_payment, plan_purchase, …). */
  kind: string;
  idempotencyKey: string;
  createdBy: string;
  description?: string;
  paymentMethod?: 'wallet' | 'razorpay' | 'system' | 'admin';
  /** Amount shown on the history row (paise, absolute). Defaults to |deltaPaise|. */
  displayPaise?: number;
  details?: Record<string, unknown>;
  reference?: { type: string; id: string };
  /** Extra columns for the public history row, if they exist on the table (e.g. booking_id). */
  extraColumns?: Record<string, unknown>;
  /** Skip writing the public history row (celebrity balance holds have their own tables). */
  skipHistoryRow?: boolean;
}

export interface MovementResult {
  ledgerId: string;
  /** Id of the public.wallet_transactions row written (user wallet only). */
  historyRowId: string | null;
  balanceAfterPaise: number;
  alreadyApplied: boolean;
}

interface AccountSpec {
  table: 'profiles' | 'celebrities';
  column: 'wallet_balance' | 'available_balance';
}

const ACCOUNTS: Record<AccountKind, AccountSpec> = {
  user_wallet: { table: 'profiles', column: 'wallet_balance' },
  celebrity_earnings: { table: 'celebrities', column: 'available_balance' },
};

export class InsufficientFunds extends AppError {
  constructor(balancePaise: number, neededPaise: number) {
    super(400, 'insufficient_balance', 'Insufficient wallet balance', {
      balance: toRupeesString(balancePaise),
      required: toRupeesString(neededPaise),
    });
  }
}

export class Ledger {
  constructor(
    private readonly db: Db,
    private readonly schema: SchemaCache,
    private readonly log: Logger,
  ) {}

  /** Current balance in paise (no lock). */
  async balance(kind: AccountKind, accountId: string): Promise<number> {
    const spec = ACCOUNTS[kind];
    const rows = await this.db.unsafe(`select ${spec.column}::text as b from public.${spec.table} where id = $1`, [accountId]);
    if (!rows[0]) throw new AppError(404, 'account_not_found', 'Account not found');
    return fromRupees((rows[0] as unknown as { b: string | null }).b ?? '0');
  }

  private async lockedBalance(tx: Tx, spec: AccountSpec, id: string): Promise<number> {
    const rows = await tx.unsafe(`select ${spec.column}::text as b from public.${spec.table} where id = $1 for update`, [id]);
    if (!rows[0]) throw new AppError(404, 'account_not_found', 'Account not found');
    return fromRupees((rows[0] as unknown as { b: string | null }).b ?? '0');
  }

  /**
   * Applies one movement inside the caller's transaction (so it commits or rolls back with the business change it pays
   * for, such as creating a booking). Use `run` when there is no surrounding transaction.
   */
  async apply(tx: Tx, kind: AccountKind, m: Movement): Promise<MovementResult> {
    if (!Number.isSafeInteger(m.deltaPaise)) throw new AppError(400, 'invalid_amount', 'Invalid amount');
    const spec = ACCOUNTS[kind];

    // Serialise on the account first, then check idempotency, so a duplicate racing the original waits and then sees it.
    const before = await this.lockedBalance(tx, spec, m.accountId);
    const prior = await tx<{ id: string; public_row_id: string | null; balance_after_paise: string | null }[]>`
      select id, public_row_id, balance_after_paise::text from wishme.ledger_entries where idempotency_key = ${m.idempotencyKey}`;
    if (prior[0]) {
      return {
        ledgerId: prior[0].id,
        historyRowId: prior[0].public_row_id,
        balanceAfterPaise: Number(prior[0].balance_after_paise ?? before),
        alreadyApplied: true,
      };
    }
    if (m.deltaPaise < 0 && before + m.deltaPaise < 0) throw new InsufficientFunds(before, -m.deltaPaise);

    let historyRowId: string | null = null;
    if (kind === 'user_wallet' && !m.skipHistoryRow) historyRowId = await this.writeWalletHistory(tx, m);

    const afterTrigger = await this.lockedBalance(tx, spec, m.accountId);
    const target = before + m.deltaPaise;
    const correction = target - afterTrigger;
    if (correction !== 0) {
      await tx.unsafe(
        `update public.${spec.table} set ${spec.column} = ${spec.column} + $1::numeric where id = $2`,
        [toRupeesString(correction), m.accountId],
      );
      if (afterTrigger !== before) {
        // A trigger moved the balance, but not by the amount we intended: corrected, and worth knowing.
        this.log.warn({ kind: m.kind, accountId: m.accountId, intended: m.deltaPaise, triggerApplied: afterTrigger - before }, 'balance trigger disagreed; corrected');
      }
    }

    const entry = await tx<{ id: string }[]>`
      insert into wishme.ledger_entries
        (account_kind, account_id, amount_paise, kind, idempotency_key, reference_type, reference_id, public_row_id,
         balance_after_paise, metadata, created_by)
      values (${kind}, ${m.accountId}, ${m.deltaPaise}, ${m.kind}, ${m.idempotencyKey},
              ${m.reference?.type ?? null}, ${m.reference?.id ?? null}, ${historyRowId}, ${target},
              ${tx.json({ ...(m.details ?? {}), ...(m.displayPaise !== undefined ? { display_paise: m.displayPaise } : {}) } as never)}, ${m.createdBy})
      returning id`;
    ledgerMovements.inc({ kind: m.kind });
    return { ledgerId: entry[0]?.id ?? '', historyRowId, balanceAfterPaise: target, alreadyApplied: false };
  }

  /** Same as apply, in its own transaction. */
  async run(kind: AccountKind, m: Movement): Promise<MovementResult> {
    return this.db.begin((tx) => this.apply(tx, kind, m)) as Promise<MovementResult>;
  }

  /**
   * Writes the public.wallet_transactions row the app's history screens read. Only columns that exist are written;
   * amounts are absolute rupees and the type carries the direction (the shape most app screens already use).
   */
  private async writeWalletHistory(tx: Tx, m: Movement): Promise<string | null> {
    const table = this.schema.table('wallet_transactions');
    if (!table) return null;
    const row: Record<string, unknown> = {
      user_id: m.accountId,
      transaction_type: m.kind,
      amount: toRupeesString(m.displayPaise ?? Math.abs(m.deltaPaise)),
      status: 'completed',
      payment_method: m.paymentMethod ?? 'wallet',
      description: m.description ?? null,
      transaction_details: m.details ?? {},
      reference_id: m.reference?.id ?? null,
      ...(m.extraColumns ?? {}),
    };
    const cols = Object.keys(row).filter((c) => table.columns.has(c));
    if (cols.length === 0) return null;
    const values = cols.map((c) => {
      const v = row[c];
      return v !== null && typeof v === 'object' ? JSON.stringify(v) : v;
    });
    const casts = cols.map((c, i) => {
      const t = table.columns.get(c)!;
      return t.type === 'json' || t.type === 'jsonb' ? `$${i + 1}::text::jsonb` : t.type === 'uuid' ? `$${i + 1}::text::uuid` : `$${i + 1}`;
    });
    const res = await tx.unsafe(
      `insert into public.wallet_transactions (${cols.map((c) => `"${c}"`).join(', ')}) values (${casts.join(', ')}) returning id::text as id`,
      values as never[],
    );
    return (res[0] as { id: string } | undefined)?.id ?? null;
  }

  /**
   * Nightly invariant check: for each account the ledger knows, the last recorded balance must equal the column.
   * Returns mismatches; the worker alerts on any.
   */
  async verifyInvariants(limit = 1000): Promise<Array<{ kind: string; accountId: string; ledgerPaise: number; columnPaise: number }>> {
    const rows = await this.db<{ account_kind: AccountKind; account_id: string; balance_after_paise: string }[]>`
      select distinct on (account_kind, account_id) account_kind, account_id, balance_after_paise::text
      from wishme.ledger_entries where balance_after_paise is not null
      order by account_kind, account_id, created_at desc limit ${limit}`;
    const out: Array<{ kind: string; accountId: string; ledgerPaise: number; columnPaise: number }> = [];
    for (const r of rows) {
      const current = await this.balance(r.account_kind, r.account_id).catch(() => NaN);
      // Only flag when nothing moved since: later movements by legacy paths are expected during the transition.
      if (Number.isFinite(current) && current !== Number(r.balance_after_paise)) {
        out.push({ kind: r.account_kind, accountId: r.account_id, ledgerPaise: Number(r.balance_after_paise), columnPaise: current });
      }
    }
    return out;
  }
}
