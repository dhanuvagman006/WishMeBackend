/**
 * Passenger input for flight Book / Ticket: validated against what the airline needs (names, ages on the travel
 * date, counts matching the quote, passport and PAN when the fare requires them) and turned into TBO's passenger
 * objects with fares taken from the server's own FareQuote, never from the client.
 */
import { z } from 'zod';
import { badRequest } from '../../lib/errors.js';
import type { TboFareBreakdown, TboResult } from './flight-map.js';

const NAME = /^[A-Za-z][A-Za-z ]*[A-Za-z]$|^[A-Za-z]$/;
const PASSPORT = /^[A-Z0-9]{6,9}$/;
const PAN = /^[A-Z]{5}[0-9]{4}[A-Z]$/;
const TITLES: Record<string, string> = { mr: 'Mr', mrs: 'Mrs', ms: 'Ms', miss: 'Miss', mstr: 'Mstr', master: 'Mstr' };

const isoDate = z
  .string()
  .trim()
  .regex(/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/, 'must be a date (YYYY-MM-DD)')
  .refine((s) => !Number.isNaN(Date.parse(s.slice(0, 10))), 'must be a valid date');

export const PassengerSchema = z.object({
  Title: z.string().trim().max(10),
  FirstName: z.string().trim().min(1).max(32),
  LastName: z.string().trim().min(1).max(32),
  PaxType: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  DateOfBirth: isoDate,
  Gender: z.union([z.literal(1), z.literal(2)]),
  PassportNo: z.string().trim().max(20).optional(),
  PassportExpiry: isoDate.optional(),
  PAN: z.string().trim().max(10).optional(),
  AddressLine1: z.string().trim().max(100).optional(),
  City: z.string().trim().max(50).optional(),
  CountryCode: z.string().trim().length(2).optional(),
  CountryName: z.string().trim().max(50).optional(),
  Nationality: z.string().trim().length(2).optional(),
  ContactNo: z.string().trim().max(20),
  Email: z.string().trim().email().max(100),
  IsLeadPax: z.boolean(),
  Seat: z.object({ SeatNo: z.string().trim().min(1).max(5), Price: z.number().optional() }).optional(),
  Meal: z.object({ Code: z.string().trim().min(1).max(20), Price: z.number().optional() }).optional(),
  // Client-sent fares are ignored: the server fills Fare from its own quote.
  Fare: z.unknown().optional(),
});
export type PassengerIn = z.infer<typeof PassengerSchema>;
export const PassengersSchema = z.array(PassengerSchema).min(1).max(9);

/** Whole years between two YYYY-MM-DD dates. */
export function ageOn(dob: string, on: string): number {
  const [by, bm, bd] = dob.slice(0, 10).split('-').map(Number) as [number, number, number];
  const [y, m, d] = on.slice(0, 10).split('-').map(Number) as [number, number, number];
  let age = y - by;
  if (m < bm || (m === bm && d < bd)) age--;
  return age;
}

const round2 = (n: number) => Math.round(n * 100) / 100;
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : Number(v) || 0);

/** Per-passenger Fare for one passenger type, from the quote's breakdown. */
export function paxFare(quote: TboResult, paxType: number): Record<string, unknown> {
  const b: TboFareBreakdown | undefined = (quote.FareBreakdown ?? []).find((x) => num(x.PassengerType) === paxType);
  const n = Math.max(num(b?.PassengerCount), 1);
  const all = Math.max((quote.FareBreakdown ?? []).reduce((s, x) => s + num(x.PassengerCount), 0), 1);
  const f = quote.Fare ?? {};
  const per = (v: unknown) => round2(num(v) / n);
  const share = (v: unknown) => round2(num(v) / all);
  return {
    Currency: b?.Currency ?? f.Currency ?? 'INR',
    BaseFare: per(b?.BaseFare),
    Tax: per(b?.Tax),
    YQTax: per(b?.YQTax),
    AdditionalTxnFeePub: per(b?.AdditionalTxnFeePub),
    AdditionalTxnFeeOfrd: per(b?.AdditionalTxnFeeOfrd),
    PGCharge: per(b?.PGCharge),
    OtherCharges: share(f.OtherCharges),
    Discount: share(f.Discount),
    PublishedFare: share(f.PublishedFare),
    OfferedFare: share(f.OfferedFare),
    ServiceFee: share(f.ServiceFee),
  };
}

export interface PassengerDefaults {
  /** Departure date of the first segment (YYYY-MM-DD), for age and passport checks. */
  travelDate: string;
  city: string;
  address: string;
}

/**
 * Validates passengers against the quote and builds TBO passenger objects (without SSR selections).
 * ASSUMPTION: the app does not collect an address, nationality or country, so Indian defaults and the departure
 * city fill those fields (TBO requires them on the lead passenger).
 */
export function buildPassengers(input: PassengerIn[], quote: TboResult, d: PassengerDefaults): Array<Record<string, unknown>> {
  const counts = new Map<number, number>();
  for (const b of quote.FareBreakdown ?? []) counts.set(num(b.PassengerType), num(b.PassengerCount));
  const given = new Map<number, number>();
  for (const p of input) given.set(p.PaxType, (given.get(p.PaxType) ?? 0) + 1);
  for (const t of [1, 2, 3]) {
    if ((counts.get(t) ?? 0) !== (given.get(t) ?? 0)) {
      throw badRequest('Passenger details do not match the number of travellers in this fare. Please search again.');
    }
  }
  if ((given.get(1) ?? 0) < 1) throw badRequest('At least one adult is required');
  if ((given.get(3) ?? 0) > (given.get(1) ?? 0)) throw badRequest('Each infant must travel with an adult');
  const leads = input.filter((p) => p.IsLeadPax);
  if (leads.length !== 1 || leads[0]!.PaxType !== 1) throw badRequest('Exactly one adult must be the lead passenger');

  return input.map((p, i) => {
    const label = `Passenger ${i + 1}`;
    const title = TITLES[p.Title.toLowerCase().replace(/\.$/, '')];
    if (!title) throw badRequest(`${label}: invalid title`);
    if (!NAME.test(p.FirstName) || !NAME.test(p.LastName)) throw badRequest(`${label}: names may contain letters and spaces only`);
    if (p.FirstName.length + p.LastName.length > 60) throw badRequest(`${label}: name is too long`);
    const age = ageOn(p.DateOfBirth, d.travelDate);
    const dobOk = p.PaxType === 1 ? age >= 12 && age <= 120 : p.PaxType === 2 ? age >= 2 && age < 12 : age >= 0 && age < 2;
    if (Date.parse(p.DateOfBirth.slice(0, 10)) > Date.parse(d.travelDate) || !dobOk) {
      throw badRequest(`${label}: date of birth does not match the passenger type (adult 12+, child 2-11, infant under 2)`);
    }
    const contact = p.ContactNo.replace(/[\s()+-]/g, '');
    if (!/^\d{10,15}$/.test(contact)) throw badRequest(`${label}: invalid contact number`);

    const out: Record<string, unknown> = {
      Title: title,
      FirstName: p.FirstName.replace(/\s+/g, ' '),
      LastName: p.LastName.replace(/\s+/g, ' '),
      PaxType: p.PaxType,
      DateOfBirth: `${p.DateOfBirth.slice(0, 10)}T00:00:00`,
      Gender: p.Gender,
      AddressLine1: p.AddressLine1 || d.address,
      City: p.City || d.city,
      CountryCode: (p.CountryCode ?? 'IN').toUpperCase(),
      CountryName: p.CountryName || 'India',
      Nationality: (p.Nationality ?? 'IN').toUpperCase(),
      ContactNo: contact,
      Email: p.Email,
      IsLeadPax: p.IsLeadPax,
      Fare: paxFare(quote, p.PaxType),
    };

    if (quote.IsPassportRequiredAtBook || p.PassportNo) {
      const passport = (p.PassportNo ?? '').toUpperCase();
      if (!PASSPORT.test(passport)) throw badRequest(`${label}: a valid passport number is required for this flight`);
      if (!p.PassportExpiry || Date.parse(p.PassportExpiry.slice(0, 10)) <= Date.parse(d.travelDate)) {
        throw badRequest(`${label}: passport must be valid beyond the travel date`);
      }
      out.PassportNo = passport;
      out.PassportExpiry = `${p.PassportExpiry.slice(0, 10)}T00:00:00`;
    }
    if (quote.IsPanRequiredAtBook || p.PAN) {
      const pan = (p.PAN ?? '').toUpperCase();
      if (!PAN.test(pan)) throw badRequest(`${label}: a valid PAN is required for this flight`);
      out.PAN = pan;
    }
    return out;
  });
}
