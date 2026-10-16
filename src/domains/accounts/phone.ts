/**
 * Indian mobile numbers as the app stores them. Profiles hold the phone the user typed at sign-up, which may be
 * "+91XXXXXXXXXX", "91XXXXXXXXXX" or "XXXXXXXXXX" (AuthContext.forgotPasswordByPhone tries all three).
 */

/** The 10-digit national number, or null when the input is not an Indian mobile number. */
export function tenDigitMobile(raw: unknown): string | null {
  if (typeof raw !== 'string' && typeof raw !== 'number') return null;
  const digits = String(raw).replace(/[\s\-().]/g, '');
  const m = /^(?:\+?91|0)?([6-9]\d{9})$/.exec(digits);
  return m ? m[1]! : null;
}

/** Every stored spelling of a mobile number, for lookups. */
export function phoneVariants(ten: string): string[] {
  return [`+91${ten}`, ten, `91${ten}`];
}

/** E.164 form for messaging vendors. */
export function e164India(raw: unknown): string | null {
  const ten = tenDigitMobile(raw);
  return ten ? `+91${ten}` : null;
}
