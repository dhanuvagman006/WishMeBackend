/**
 * Money is integer paise inside this server. Public tables store rupees (numeric); conversion happens only here,
 * with string arithmetic so no binary floating point ever touches an amount.
 */
import { AppError } from './errors.js';

/** Parses a rupee amount ("123", "123.4", "123.45", 123.45) into paise. Rejects more than two decimals. */
export function fromRupees(value: string | number): number {
  const s = typeof value === 'number' ? value.toFixed(2) : String(value).trim();
  const m = /^(-)?(\d+)(?:\.(\d{1,}))?$/.exec(s);
  if (!m) throw new AppError(400, 'invalid_amount', `Invalid amount: ${s}`);
  const frac = (m[3] ?? '').padEnd(2, '0');
  if (frac.length > 2 && /[1-9]/.test(frac.slice(2))) throw new AppError(400, 'invalid_amount', 'Amounts have at most two decimals');
  const paise = Number(m[2]) * 100 + Number(frac.slice(0, 2));
  if (!Number.isSafeInteger(paise)) throw new AppError(400, 'invalid_amount', 'Amount too large');
  return m[1] ? -paise : paise;
}

/** Formats paise as a rupee string with two decimals ("-12.50"). */
export function toRupeesString(paise: number): string {
  if (!Number.isSafeInteger(paise)) throw new Error(`not an integer paise amount: ${paise}`);
  const neg = paise < 0;
  const abs = Math.abs(paise);
  return `${neg ? '-' : ''}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

/**
 * Value for a rupee column. The production schema stores money as INTEGER rupees (wallet_balance, amount, price,
 * available_balance), so a fractional amount there is refused rather than silently rounded.
 */
export function rupeesForColumn(paise: number, columnType: string | undefined): string {
  const integerColumn = columnType === 'integer' || columnType === 'bigint' || columnType === 'smallint';
  if (integerColumn) {
    if (paise % 100 !== 0) throw new AppError(400, 'invalid_amount', 'Amounts must be in whole rupees');
    return String(paise / 100);
  }
  return toRupeesString(paise);
}

/** Rupees as a JS number for JSON responses that the app expects numeric (balances). */
export function toRupeesNumber(paise: number): number {
  return Number(toRupeesString(paise));
}

/** Validates a client-supplied positive rupee amount within bounds and returns paise. */
export function positiveAmount(value: unknown, opts: { minRupees?: number; maxRupees?: number } = {}): number {
  if (typeof value !== 'number' && typeof value !== 'string') throw new AppError(400, 'invalid_amount', 'Amount is required');
  const paise = fromRupees(value);
  if (paise <= 0) throw new AppError(400, 'invalid_amount', 'Amount must be greater than zero');
  if (opts.minRupees !== undefined && paise < opts.minRupees * 100) {
    throw new AppError(400, 'invalid_amount', `Minimum amount is ₹${opts.minRupees}`);
  }
  if (opts.maxRupees !== undefined && paise > opts.maxRupees * 100) {
    throw new AppError(400, 'invalid_amount', `Maximum amount is ₹${opts.maxRupees}`);
  }
  return paise;
}
