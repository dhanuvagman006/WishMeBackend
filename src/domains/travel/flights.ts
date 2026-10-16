/**
 * Flight search and booking through TBO, with the wallet charged server-side.
 *
 * The app's review screen re-quotes, then books (non-LCC) and tickets, and never charges anyone. Here every booking
 * call re-quotes on the server, prices the booking from that quote (plus seat and meal prices from TBO's own SSR
 * answer for LCC fares), debits the wallet BEFORE Book/Ticket, and refunds through the ledger when TBO says no.
 * When the outcome is unknown (timeout on Book/Ticket) the money is kept and the booking is flagged needs_review,
 * because refunding a ticket that was in fact issued would hand out free tickets.
 */
import { z } from 'zod';
import type { Deps } from '../../deps.js';
import { AppError, badRequest, conflict, notFound } from '../../lib/errors.js';
import { configuredEndUserIp, Tbo, TboRejected, TboUncertain } from '../../vendors/tbo.js';
import { chargeBooking, findOwnedBooking, refundBooking, transition, type Payer, type TravelBooking } from './bookings.js';
import { chargeRupees, mapFareQuote, mapSearch, type TboResult } from './flight-map.js';
import { buildPassengers, PassengersSchema, type PassengerIn } from './passengers.js';

export function tboOf(deps: Deps): Tbo {
  return deps.memo('tbo', () => new Tbo(deps.env, deps.log, deps.kv));
}

const IATA = z.string().trim().toUpperCase().pipe(z.string().regex(/^[A-Z]{3}$/, 'must be a 3-letter airport code'));
const DATE = z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/, 'must be YYYY-MM-DD');
const traceId = z.string().trim().min(1).max(100);
const resultIndex = z.string().trim().min(1).max(100);

export const SearchBody = z
  .object({
    origin: IATA,
    destination: IATA,
    departDate: DATE,
    returnDate: DATE.optional().nullable(),
    adults: z.coerce.number().int().min(1).max(9).default(1),
    children: z.coerce.number().int().min(0).max(8).default(0),
    infants: z.coerce.number().int().min(0).max(9).default(0),
    // TBO cabin classes 1 (all) … 6 (first); the deployed function defaulted to 1.
    cabinClass: z.coerce.number().int().min(1).max(6).default(1),
    directOnly: z.boolean().default(false),
  })
  .superRefine((b, ctx) => {
    if (b.origin === b.destination) ctx.addIssue({ code: 'custom', path: ['destination'], message: 'must differ from origin' });
    if (b.adults + b.children > 9) ctx.addIssue({ code: 'custom', path: ['adults'], message: 'at most 9 travellers' });
    if (b.infants > b.adults) ctx.addIssue({ code: 'custom', path: ['infants'], message: 'each infant needs an adult' });
    const today = new Date(Date.now() + 5.5 * 3600 * 1000).toISOString().slice(0, 10);
    const max = new Date(Date.now() + 366 * 86400 * 1000).toISOString().slice(0, 10);
    if (b.departDate < today || b.departDate > max) ctx.addIssue({ code: 'custom', path: ['departDate'], message: 'must be within the next year' });
    if (b.returnDate && (b.returnDate < b.departDate || b.returnDate > max)) ctx.addIssue({ code: 'custom', path: ['returnDate'], message: 'must be after the departure date' });
  });

export const QuoteBody = z.object({ traceId, resultIndex });
export const BookBody = z.object({ traceId, resultIndex, passengers: PassengersSchema });
export const TicketBody = z.union([
  z.object({ traceId, resultIndex, passengers: PassengersSchema }),
  z.object({ traceId: traceId.optional(), pnr: z.string().trim().min(1).max(20), bookingId: z.coerce.number().int().positive() }),
]);
export const DetailsBody = z.object({ bookingId: z.coerce.number().int().positive(), pnr: z.string().trim().max(20).optional(), traceId: traceId.optional() });

interface Ctx {
  deps: Deps;
  ip: string;
}

/**
 * EndUserIp for TBO: the agency's configured TBO_END_USER_IP (what the deployed function sent), else the caller's
 * IPv4 address. ASSUMPTION: callers without an IPv4 address are reported as 127.0.0.1.
 */
export function endUserIp(deps: Deps, ip: string): string {
  const fixed = configuredEndUserIp(deps.env);
  if (fixed) return fixed;
  const v4 = ip.replace(/^::ffff:/, '');
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(v4) ? v4 : '127.0.0.1';
}

// ── Read-only actions ─────────────────────────────────────────────────────────────────────────────────────────
export async function search(c: Ctx, b: z.infer<typeof SearchBody>) {
  const segment = (from: string, to: string, date: string) => ({
    Origin: from,
    Destination: to,
    FlightCabinClass: String(b.cabinClass),
    PreferredDepartureTime: `${date}T00:00:00`,
    PreferredArrivalTime: `${date}T00:00:00`,
  });
  // Strings, exactly as the deployed function sent them.
  const body = {
    AdultCount: String(b.adults),
    ChildCount: String(b.children),
    InfantCount: String(b.infants),
    DirectFlight: String(b.directOnly),
    OneStopFlight: 'false',
    JourneyType: b.returnDate ? '2' : '1',
    PreferredAirlines: null,
    Segments: [segment(b.origin, b.destination, b.departDate), ...(b.returnDate ? [segment(b.destination, b.origin, b.returnDate)] : [])],
    Sources: null,
  };
  try {
    const r = await tboOf(c.deps).air<{ TraceId?: string; Results?: TboResult[][] }>('Search', body, { endUserIp: endUserIp(c.deps, c.ip), timeoutMs: 45_000 });
    return mapSearch(r, !!b.returnDate);
  } catch (e) {
    // "No result found" is an empty search, not a failure: the screen shows its own empty state.
    if (e instanceof TboRejected && /no result/i.test(e.message)) return { traceId: '', isReturn: !!b.returnDate, outbound: [], inbound: [], totalResults: 0 };
    throw e;
  }
}

export async function fareRule(c: Ctx, b: z.infer<typeof QuoteBody>) {
  const r = await tboOf(c.deps).air<{ FareRules?: unknown[] }>('FareRule', { TraceId: b.traceId, ResultIndex: b.resultIndex }, { endUserIp: endUserIp(c.deps, c.ip) });
  return { fareRules: r.FareRules ?? [] };
}

async function quoteRaw(c: Ctx, traceIdValue: string, resultIndexValue: string) {
  return tboOf(c.deps).air<{ TraceId?: string; IsPriceChanged?: boolean; Results?: TboResult }>(
    'FareQuote',
    { TraceId: traceIdValue, ResultIndex: resultIndexValue },
    { endUserIp: endUserIp(c.deps, c.ip) },
  );
}

export async function fareQuote(c: Ctx, b: z.infer<typeof QuoteBody>) {
  const r = await quoteRaw(c, b.traceId, b.resultIndex);
  if (!r.Results) throw new AppError(409, 'fare_unavailable', 'Fare is no longer available. Please search again.');
  return mapFareQuote(r, b.traceId);
}

interface SsrResponse {
  SeatDynamic?: unknown[];
  SeatPreference?: unknown[];
  MealDynamic?: unknown[];
  Meal?: unknown[];
  Baggage?: unknown[];
}

async function ssrRaw(c: Ctx, traceIdValue: string, resultIndexValue: string): Promise<SsrResponse> {
  return tboOf(c.deps).air<SsrResponse>('SSR', { TraceId: traceIdValue, ResultIndex: resultIndexValue }, { endUserIp: endUserIp(c.deps, c.ip) });
}

export async function ssr(c: Ctx, b: z.infer<typeof QuoteBody>) {
  const r = await ssrRaw(c, b.traceId, b.resultIndex);
  return { seats: r.SeatDynamic ?? r.SeatPreference ?? [], meals: r.MealDynamic ?? r.Meal ?? [], baggage: r.Baggage ?? [] };
}

// ── Booking ───────────────────────────────────────────────────────────────────────────────────────────────────

/** Finds the first object in a nested SSR tree for which `match` holds. */
export function findInTree(node: unknown, match: (o: Record<string, unknown>) => boolean, depth = 0): Record<string, unknown> | null {
  if (depth > 10 || !node || typeof node !== 'object') return null;
  if (Array.isArray(node)) {
    for (const n of node) {
      const hit = findInTree(n, match, depth + 1);
      if (hit) return hit;
    }
    return null;
  }
  const o = node as Record<string, unknown>;
  if (match(o)) return o;
  for (const v of Object.values(o)) {
    const hit = findInTree(v, match, depth + 1);
    if (hit) return hit;
  }
  return null;
}

/** SSR prices in whole rupees, rounded up (wallet balances are integer rupees). */
const rupeesToPaise = (r: unknown) => Math.ceil(typeof r === 'number' ? r : Number(r) || 0) * 100;

/**
 * Attaches SeatDynamic / MealDynamic objects from TBO's SSR answer to LCC passengers and returns their total price.
 * A seat or meal the airline no longer offers is an error before any charge, not a silent omission.
 * ASSUMPTION: AvailablityType 2 means taken (the app's own seat map uses the same rule).
 */
export function attachSsr(passengers: Array<Record<string, unknown>>, input: PassengerIn[], s: SsrResponse): number {
  let paise = 0;
  input.forEach((p, i) => {
    const out = passengers[i]!;
    if (p.Seat) {
      const seat = findInTree(s.SeatDynamic, (o) => typeof o.SeatNo === 'string' && o.SeatNo === p.Seat!.SeatNo && o.AvailablityType !== 2 && 'Code' in o);
      if (!seat) throw conflict(`Seat ${p.Seat.SeatNo} is no longer available. Please choose another seat.`, 'seat_unavailable');
      out.SeatDynamic = [seat];
      paise += rupeesToPaise(seat.Price);
    }
    if (p.Meal) {
      const meal = findInTree(s.MealDynamic, (o) => o.Code === p.Meal!.Code && 'Description' in o);
      if (!meal) throw conflict('The selected meal is no longer available. Please choose another.', 'meal_unavailable');
      out.MealDynamic = [meal];
      paise += rupeesToPaise(meal.Price);
    }
  });
  return paise;
}

function departure(r: TboResult): { date: string; city: string; summary: Record<string, unknown> } {
  const segs = r.Segments?.[0] ?? [];
  const first = segs[0];
  const last = segs[segs.length - 1];
  const date = (first?.Origin?.DepTime ?? '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new AppError(502, 'tbo_error', 'The airline returned an incomplete fare. Please search again.');
  return {
    date,
    city: first?.Origin?.Airport?.CityName ?? 'India',
    summary: {
      from: first?.Origin?.Airport?.AirportCode ?? '',
      to: last?.Destination?.Airport?.AirportCode ?? '',
      airline: first?.Airline?.AirlineCode ?? '',
      flightNumber: first?.Airline?.FlightNumber ?? '',
      depart: first?.Origin?.DepTime ?? '',
      source: r.Source ?? null,
    },
  };
}

async function withLock<T>(deps: Deps, key: string, fn: () => Promise<T>): Promise<T> {
  const lockKey = `tbo:lock:${key}`;
  if (!(await deps.kv.set(lockKey, '1', 180, true))) throw conflict('This booking is already being processed. Please wait.', 'booking_in_progress');
  try {
    return await fn();
  } finally {
    await deps.kv.del(lockKey).catch(() => {});
  }
}

interface Prepared {
  quote: TboResult;
  passengers: Array<Record<string, unknown>>;
  amountPaise: number;
  summary: Record<string, unknown>;
}

async function prepare(c: Ctx, payer: Payer, b: { traceId: string; resultIndex: string; passengers: PassengerIn[] }, lcc: boolean): Promise<Prepared> {
  const fq = await quoteRaw(c, b.traceId, b.resultIndex);
  const quote = fq.Results;
  if (!quote) throw new AppError(409, 'fare_unavailable', 'Fare is no longer available. Please search again.');
  const fareRupees = chargeRupees(quote);
  if (fq.IsPriceChanged) {
    // Same wording as the review screen's own check.
    throw conflict(`The airline changed this fare to ₹${fareRupees.toLocaleString('en-IN')}. Please go back and reselect to continue at the new price.`, 'price_changed');
  }
  if (!!quote.IsLCC !== lcc) {
    throw badRequest(lcc ? 'This fare must be booked before it is ticketed' : 'This fare is ticketed directly; please use ticket');
  }
  const dep = departure(quote);
  const address = await profileAddress(c.deps, payer.profileId);
  const passengers = buildPassengers(b.passengers, quote, { travelDate: dep.date, city: dep.city, address: address ?? dep.city });
  let ssrPaise = 0;
  if (lcc && b.passengers.some((p) => p.Seat || p.Meal)) ssrPaise = attachSsr(passengers, b.passengers, await ssrRaw(c, b.traceId, b.resultIndex));
  // Non-LCC seat and meal choices are preferences without a price in this flow; they are not sent.
  const farePaise = fareRupees * 100;
  if (farePaise <= 0) throw new AppError(502, 'tbo_error', 'The airline returned no price for this fare. Please search again.');
  return {
    quote,
    passengers,
    amountPaise: farePaise + ssrPaise,
    summary: { ...dep.summary, passengers: passengers.length, farePaise, ssrPaise, isLCC: lcc },
  };
}

async function profileAddress(deps: Deps, profileId: string): Promise<string | null> {
  if (!deps.schema.table('profiles')?.columns.has('address')) return null;
  const rows = await deps.db<{ address: string | null }[]>`select address from public.profiles where id = ${profileId}`;
  const a = rows[0]?.address?.replace(/[^\w ,./-]+/g, ' ').trim();
  return a ? a.slice(0, 100) : null;
}

const describe = (s: Record<string, unknown>) => `Flight ${String(s.from)}-${String(s.to)} ${String(s.airline)}${String(s.flightNumber)}`.trim();

const UNCERTAIN_MESSAGE =
  'We could not get a confirmation from the airline yet. Please do not book again: check your bookings shortly. If no ticket is issued, the amount will be refunded to your wallet.';

/** Best-effort release of a held (non-LCC) PNR after a failure. */
async function releasePnr(c: Ctx, bookingId: string | number, source: unknown): Promise<void> {
  try {
    await tboOf(c.deps).air('ReleasePNRRequest', { BookingId: Number(bookingId), Source: source ?? null }, { endUserIp: endUserIp(c.deps, c.ip) });
  } catch (e) {
    c.deps.log.warn({ bookingId: String(bookingId), err: e instanceof AppError ? e.code : 'error' }, 'could not release PNR');
  }
}

/** Handles a failed Book/Ticket: refund on a definitive no, flag for review when the outcome is unknown. */
async function onFailure(c: Ctx, id: string, from: Array<'charged' | 'booked' | 'ticketing'>, e: unknown, release?: { bookingId: string | number; source: unknown }): Promise<never> {
  if (e instanceof TboUncertain) {
    await transition(c.deps.db, id, from, 'needs_review', { error: `uncertain:${e.method}` });
    c.deps.log.error({ travelBookingId: id, method: e.method }, 'TBO outcome unknown; booking needs review');
    throw new AppError(502, 'booking_unconfirmed', UNCERTAIN_MESSAGE);
  }
  if (release) await releasePnr(c, release.bookingId, release.source);
  await refundBooking(c.deps, id, from, e instanceof AppError ? `${e.code}: ${e.message}` : 'internal_error');
  if (e instanceof AppError) throw e;
  throw new AppError(502, 'booking_failed', 'Booking failed. The amount has been refunded to your wallet.');
}

interface InnerResponse {
  PNR?: string;
  BookingId?: number;
  IsPriceChanged?: boolean;
  TicketStatus?: number;
  FlightItinerary?: Record<string, unknown> & {
    PNR?: string;
    InvoiceNo?: string;
    InvoiceCreatedOn?: string;
    Fare?: { PublishedFare?: number; Currency?: string };
    Passenger?: Array<{ Ticket?: { TicketNumber?: string } | Array<{ TicketNumber?: string }> }>;
  };
  [k: string]: unknown;
}

/** Non-LCC: hold the seats (Book). The wallet is charged here; `ticket {pnr, bookingId}` then issues the ticket. */
export async function book(c: Ctx, payer: Payer, b: z.infer<typeof BookBody>) {
  return withLock(c.deps, `${payer.profileId}:${b.traceId}:${b.resultIndex}`, async () => {
    const p = await prepare(c, payer, b, false);
    const { id } = await chargeBooking(c.deps, payer, {
      kind: 'flight',
      amountPaise: p.amountPaise,
      description: describe(p.summary),
      traceId: b.traceId,
      resultIndex: b.resultIndex,
      isLcc: false,
      summary: p.summary,
    });
    let inner: InnerResponse;
    try {
      const r = await tboOf(c.deps).air<{ Response?: InnerResponse }>(
        'Book',
        { TraceId: b.traceId, ResultIndex: b.resultIndex, Passengers: p.passengers },
        { endUserIp: endUserIp(c.deps, c.ip), timeoutMs: 90_000 },
      );
      inner = r.Response ?? {};
      if (!inner.BookingId || !inner.PNR) throw new TboRejected('Book', undefined, 'The airline did not confirm the booking. Please search again.');
      if (inner.IsPriceChanged) {
        throw Object.assign(conflict('The airline changed this fare while booking. Please search again.', 'price_changed'), { release: true });
      }
    } catch (e) {
      const bookingId = (e as { release?: boolean }).release ? (inner! ?? {}).BookingId : undefined;
      return onFailure(c, id, ['charged'], e, bookingId ? { bookingId, source: p.summary.source } : undefined);
    }
    await transition(c.deps.db, id, ['charged'], 'booked', { pnr: inner.PNR, tboBookingId: String(inner.BookingId) });
    return { booking: inner };
  });
}

function ticketSummary(inner: InnerResponse) {
  const it = inner.FlightItinerary ?? {};
  const numbers = (it.Passenger ?? [])
    .map((px) => (Array.isArray(px.Ticket) ? px.Ticket[0]?.TicketNumber : px.Ticket?.TicketNumber))
    .filter((n): n is string => !!n);
  return {
    pnr: String(inner.PNR ?? it.PNR ?? ''),
    bookingId: inner.BookingId ?? null,
    ticketNumbers: numbers,
    invoiceNo: it.InvoiceNo ?? null,
    invoiceCreatedOn: it.InvoiceCreatedOn ?? null,
    publishedFare: it.Fare?.PublishedFare ?? null,
    currency: it.Fare?.Currency ?? 'INR',
  };
}

/** The fields the app reads from a ticket (services/tboService.ts tboBookAndTicket), rebuilt for idempotent replays. */
function replayTicket(b: TravelBooking) {
  const t = (b.summary.ticket ?? {}) as ReturnType<typeof ticketSummary>;
  return {
    BookingId: t.bookingId ?? Number(b.tbo_booking_id),
    PNR: t.pnr || b.pnr,
    FlightItinerary: {
      PNR: t.pnr || b.pnr,
      InvoiceNo: t.invoiceNo,
      InvoiceCreatedOn: t.invoiceCreatedOn,
      Fare: { PublishedFare: t.publishedFare, Currency: t.currency },
      Passenger: (t.ticketNumbers ?? []).map((n) => ({ Ticket: { TicketNumber: n } })),
    },
    Error: { ErrorCode: 0, ErrorMessage: '' },
  };
}

// ASSUMPTION: TBO TicketStatus 1 = issued, 6 = already issued; any other value is a failure.
const TICKETED = new Set([1, 6]);

async function issue(c: Ctx, id: string, from: Array<'charged' | 'ticketing'>, body: Record<string, unknown>, release?: { bookingId: string; source: unknown }) {
  let r: { Response?: InnerResponse; Error?: { ErrorCode?: number; ErrorMessage?: string } };
  try {
    r = await tboOf(c.deps).air<{ Response?: InnerResponse }>('Ticket', body, { endUserIp: endUserIp(c.deps, c.ip), timeoutMs: 120_000 });
    const inner = r.Response ?? {};
    if (inner.IsPriceChanged) throw new TboRejected('Ticket', undefined, 'The airline changed this fare while ticketing. Please search again.');
    if (inner.TicketStatus !== undefined && !TICKETED.has(inner.TicketStatus)) {
      // 5 = in progress: the ticket may still be issued.
      if (inner.TicketStatus === 5) throw new TboUncertain('Ticket');
      throw new TboRejected('Ticket', inner.TicketStatus, 'The airline could not issue the ticket. Please search again.');
    }
    if (!inner.BookingId && !inner.FlightItinerary) throw new TboUncertain('Ticket');
  } catch (e) {
    return onFailure(c, id, from, e, release);
  }
  const inner = r.Response!;
  const summary = ticketSummary(inner);
  await transition(c.deps.db, id, [...from, 'needs_review'], 'confirmed', {
    pnr: summary.pnr || null,
    tboBookingId: inner.BookingId ? String(inner.BookingId) : null,
    summary: { ticket: summary },
  });
  return { ticket: { ...inner, Error: r.Error ?? { ErrorCode: 0, ErrorMessage: '' } } };
}

export async function ticket(c: Ctx, payer: Payer, b: z.infer<typeof TicketBody>) {
  if ('passengers' in b) {
    // LCC: price, charge and ticket in one step.
    return withLock(c.deps, `${payer.profileId}:${b.traceId}:${b.resultIndex}`, async () => {
      const p = await prepare(c, payer, b, true);
      const { id } = await chargeBooking(c.deps, payer, {
        kind: 'flight',
        amountPaise: p.amountPaise,
        description: describe(p.summary),
        traceId: b.traceId,
        resultIndex: b.resultIndex,
        isLcc: true,
        summary: p.summary,
      });
      return issue(c, id, ['charged'], { TraceId: b.traceId, ResultIndex: b.resultIndex, Passengers: p.passengers });
    });
  }

  // Non-LCC: ticket a booking this caller paid for in `book`.
  const owned = await findOwnedBooking(c.deps, payer.profileId, 'flight', String(b.bookingId));
  if (!owned) throw notFound('Booking not found');
  if (owned.status === 'confirmed') return { ticket: replayTicket(owned) };
  if (owned.status !== 'booked') {
    if (owned.status === 'refunded') throw conflict('This booking was cancelled and refunded. Please search again.', 'booking_refunded');
    throw conflict('This booking is already being ticketed. Please check your bookings shortly.', 'booking_in_progress');
  }
  if (!(await transition(c.deps.db, owned.id, ['booked'], 'ticketing'))) {
    throw conflict('This booking is already being ticketed. Please check your bookings shortly.', 'booking_in_progress');
  }
  return issue(
    c,
    owned.id,
    ['ticketing'],
    { TraceId: b.traceId ?? owned.trace_id, PNR: owned.pnr ?? b.pnr, BookingId: Number(owned.tbo_booking_id) },
    { bookingId: String(owned.tbo_booking_id), source: owned.summary.source },
  );
}

export async function bookingDetails(c: Ctx, payer: Payer, b: z.infer<typeof DetailsBody>) {
  const owned = await findOwnedBooking(c.deps, payer.profileId, 'flight', String(b.bookingId));
  if (!owned) throw notFound('Booking not found');
  const r = await tboOf(c.deps).air<{ FlightItinerary?: Record<string, unknown> }>(
    'GetBookingDetails',
    { BookingId: b.bookingId, PNR: owned.pnr ?? b.pnr ?? '', ...(owned.trace_id ? { TraceId: owned.trace_id } : {}) },
    { endUserIp: endUserIp(c.deps, c.ip) },
  );
  return { booking: r.FlightItinerary ?? r };
}

/**
 * For a maintenance job: non-LCC holds that were paid for but never ticketed (the app closed between `book` and
 * `ticket`) are released and refunded after `olderThanMin`; attempts stuck in 'charged' (process died mid-call) are
 * flagged needs_review. Returns what it did.
 */
export async function sweepStaleFlightBookings(deps: Deps, olderThanMin = 30): Promise<{ refunded: number; flagged: number }> {
  const stale = await deps.db<{ id: string; status: string; tbo_booking_id: string | null; summary: Record<string, unknown> }[]>`
    select id::text, status, tbo_booking_id, summary from wishme.travel_bookings
    where kind = 'flight' and status in ('booked', 'charged') and updated_at < now() - make_interval(mins => ${olderThanMin})
    order by updated_at limit 100`;
  let refunded = 0;
  let flagged = 0;
  const c: Ctx = { deps, ip: '127.0.0.1' };
  for (const b of stale) {
    if (b.status === 'charged') {
      if (await transition(deps.db, b.id, ['charged'], 'needs_review', { error: 'stale:charged' })) flagged++;
      continue;
    }
    if (b.tbo_booking_id) await releasePnr(c, b.tbo_booking_id, b.summary.source);
    if (await refundBooking(deps, b.id, ['booked'], 'not ticketed')) refunded++;
  }
  return { refunded, flagged };
}
