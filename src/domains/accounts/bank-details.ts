/**
 * bank_details: the caller's own payout accounts.
 *
 * Production stores the number in `account_number` (audit schema). WalletTab posts and reads `bank_account_number`
 * (and would crash on `.slice(-4)` of a missing value), WithdrawModal reads `account_number`. So inserts accept either
 * spelling, and star reads carry both.
 */
import { z } from 'zod';
import type { CompatResult, CustomArgs, PolicyCtx } from '../../compat/postgrest/policy.js';
import { pgrstError } from '../../compat/postgrest/parser.js';
import { AppError, forbidden } from '../../lib/errors.js';
import { ACCOUNT_RE, IFSC_RE } from './profiles.js';
import { cleanText, insertRow, readViaPolicy, represent } from './rows.js';

const MAX_ACCOUNTS = 10;
const invalid = (message: string) => new AppError(400, '22023', message);

const Row = z.object({
  bank_name: z.string().max(100),
  bank_account_number: z.union([z.string().max(40), z.number()]).nullish(),
  account_number: z.union([z.string().max(40), z.number()]).nullish(),
  ifsc_code: z.string().max(20),
  account_holder_name: z.string().max(100),
  account_type: z.enum(['savings', 'current']).nullish(),
  is_default: z.boolean().nullish(),
});

function normalised(raw: z.infer<typeof Row>): Record<string, unknown> {
  const accountNumber = String(raw.account_number ?? raw.bank_account_number ?? '').replace(/[\s-]/g, '');
  if (!ACCOUNT_RE.test(accountNumber)) throw invalid('Invalid bank account number');
  const ifsc = raw.ifsc_code.trim().toUpperCase();
  if (!IFSC_RE.test(ifsc)) throw invalid('Invalid IFSC code');
  const bankName = cleanText(raw.bank_name, 100);
  const holder = cleanText(raw.account_holder_name, 100);
  if (!bankName) throw invalid('Invalid bank name');
  if (!holder) throw invalid('Invalid account holder name');
  return { bank_name: bankName, account_number: accountNumber, ifsc_code: ifsc, account_holder_name: holder, account_type: raw.account_type ?? 'savings', is_default: raw.is_default ?? false };
}

export async function insertBankDetails(a: CustomArgs): Promise<CompatResult> {
  const profileId = a.identity.profileId;
  if (a.auth.kind === 'anon' || !profileId) throw forbidden('A profile is required', '42501');
  const body = Array.isArray(a.body) && a.body.length === 1 ? a.body[0] : a.body;
  const r = Row.safeParse(body);
  if (!r.success) throw invalid(`Invalid ${r.error.issues[0]?.path.join('.') || 'bank details'}`);
  const row = normalised(r.data);
  await a.deps.limiter.hit('bank-details', profileId, { limit: 10, windowSec: 3600 }, 'Too many changes. Please try again later.');
  const id = await a.deps.db.begin(async (tx) => {
    await tx`select pg_advisory_xact_lock(hashtext(${`bank:${profileId}`}))`;
    const count = await tx<{ n: number }[]>`select count(*)::int as n from public.bank_details where user_id = ${profileId}`;
    if ((count[0]?.n ?? 0) >= MAX_ACCOUNTS) throw invalid(`At most ${MAX_ACCOUNTS} bank accounts can be saved`);
    if (row.is_default) await tx`update public.bank_details set is_default = false where user_id = ${profileId} and is_default`;
    const written = await insertRow(tx, a.deps.schema, 'bank_details', { ...row, user_id: profileId });
    return String(written?.id ?? '');
  });
  return represent(a, 'bank_details', id ? [id] : []);
}

/** Star reads also carry `bank_account_number` (WalletTab's name for account_number). */
export async function readBankDetails(a: CustomArgs): Promise<CompatResult | 'default'> {
  const select = (a.params.get('select') ?? '*').replace(/\s/g, '');
  if (select !== '*' || a.prefer.count) return 'default';
  const { body, n } = await readViaPolicy(a, 'bank_details', a.params);
  const rows = (JSON.parse(body) as Array<Record<string, unknown>>).map((r) =>
    'account_number' in r && !('bank_account_number' in r) ? { ...r, bank_account_number: r.account_number } : r,
  );
  if (a.single) {
    if (n !== 1) throw pgrstError(406, 'PGRST116', 'JSON object requested, multiple (or no) rows returned', `The result contains ${n} rows`);
    return { status: 200, body: rows[0] };
  }
  const offset = Number(a.params.get('offset') ?? 0) || 0;
  return { status: 200, headers: { 'content-range': n === 0 ? '*/*' : `${offset}-${offset + n - 1}/*` }, body: rows };
}

/** PATCH validation (owner rows only, see the policy). */
export function checkBankUpdate(row: Record<string, unknown>, _c: PolicyCtx): void {
  if ('ifsc_code' in row) {
    const v = typeof row.ifsc_code === 'string' ? row.ifsc_code.trim().toUpperCase() : '';
    if (!IFSC_RE.test(v)) throw invalid('Invalid IFSC code');
    row.ifsc_code = v;
  }
  if ('account_number' in row) {
    const v = typeof row.account_number === 'string' || typeof row.account_number === 'number' ? String(row.account_number).replace(/[\s-]/g, '') : '';
    if (!ACCOUNT_RE.test(v)) throw invalid('Invalid bank account number');
    row.account_number = v;
  }
  for (const k of ['bank_name', 'account_holder_name']) {
    if (k in row) {
      const v = cleanText(row[k], 100);
      if (!v) throw invalid(`Invalid ${k.replace(/_/g, ' ')}`);
      row[k] = v;
    }
  }
  if ('account_type' in row && row.account_type !== 'savings' && row.account_type !== 'current') throw invalid('Invalid account type');
  if ('is_default' in row && typeof row.is_default !== 'boolean') throw invalid('Invalid is_default');
}
