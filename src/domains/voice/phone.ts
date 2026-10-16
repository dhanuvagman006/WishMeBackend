/**
 * Which numbers the platform will dial on a user's behalf (AI calls, reminder calls, celebrity and voice wishes).
 *
 * The app runs the same check for UX (services/assistant/aiCalls.ts checkPhoneNumber), but the server decides: a
 * modified client must not be able to make our Vapi number ring an emergency line, a premium-rate service or a
 * foreign number. Only Indian geographic numbers are accepted:
 *   - mobiles:   10 digits starting 6-9
 *   - landlines: 10 digits = STD code + subscriber number, starting 2-5, or 11 (Delhi)
 * Refused: emergency and helpline short codes, toll-free / premium / shared-cost (1800, 1860, 1900, 1909 …),
 * telemarketing (140…), anything starting 0 or 1 apart from Delhi's 11, and numbers outside India.
 */

/** Emergency and government helplines (the app's list, plus a few more). Never dialled, whatever the format. */
const EMERGENCY = new Set([
  '100', '101', '102', '103', '104', '108', '112', '139', '181', '1033', '1064', '1070', '1077', '1078', '1091', '1098',
  '1363', '1930', '14567',
]);

export type NumberCheck = { ok: true; e164: string; national: string } | { ok: false; reason: string };

export function checkIndianNumber(input: unknown): NumberCheck {
  if (typeof input !== 'string' && typeof input !== 'number') return { ok: false, reason: 'A phone number is required.' };
  const raw = String(input).trim();
  if (raw.length > 32) return { ok: false, reason: 'That does not look like a valid 10-digit Indian phone number.' };
  if (EMERGENCY.has(raw.replace(/\D/g, ''))) {
    return { ok: false, reason: 'The assistant never calls emergency numbers. Please dial those yourself.' };
  }
  let d = raw.replace(/[^\d+]/g, '');
  if (d.indexOf('+') > 0) return { ok: false, reason: 'That does not look like a valid 10-digit Indian phone number.' };
  if (d.startsWith('+')) {
    if (!d.startsWith('+91')) return { ok: false, reason: 'AI calls only work for Indian phone numbers for now.' };
    d = d.slice(3);
  } else if (d.startsWith('0091')) d = d.slice(4);
  else if (d.startsWith('91') && d.length === 12) d = d.slice(2);
  else if (d.startsWith('0') && d.length === 11) d = d.slice(1);

  if (!/^\d{10}$/.test(d)) return { ok: false, reason: 'That does not look like a valid 10-digit Indian phone number.' };
  // Toll-free, premium-rate, shared-cost and telemarketing series.
  if (/^(18|19|140)/.test(d) || d.startsWith('900') || d.startsWith('909')) {
    return { ok: false, reason: 'That number cannot be called by the assistant.' };
  }
  const mobile = /^[6-9]\d{9}$/.test(d);
  const landline = /^[2-5]\d{9}$/.test(d) || /^11[2-9]\d{7}$/.test(d);
  if (!mobile && !landline) return { ok: false, reason: 'That does not look like a valid 10-digit Indian phone number.' };
  return { ok: true, e164: `+91${d}`, national: d };
}
