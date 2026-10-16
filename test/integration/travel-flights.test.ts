/**
 * tbo-flights with TBO stubbed at globalThis.fetch: open search, server-side charging before Book/Ticket, refunds on
 * a definitive "no", needs_review on an unknown outcome, and ownership of bookings.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { anon, bearer, bootTest, profileIdOf, signUp, type TestCtx, type TestSession } from '../helpers.js';
import { sweepStaleFlightBookings } from '../../src/domains/travel/flights.js';

let t: TestCtx;
const realFetch = globalThis.fetch;

interface Call {
  method: string;
  body: Record<string, unknown>;
}
let calls: Call[] = [];
type Handler = (body: Record<string, unknown>) => Response | Promise<Response>;
let routes: Record<string, Handler> = {};

const json = (x: unknown, status = 200) => new Response(JSON.stringify(x), { status, headers: { 'content-type': 'application/json' } });
const ok = (inner: Record<string, unknown>) => json({ Response: { ResponseStatus: 1, Error: { ErrorCode: 0, ErrorMessage: '' }, TraceId: 'trace-1', ...inner } });

const TRAVEL_BOOKINGS_DDL = `
  create table if not exists wishme.travel_bookings (
    id uuid primary key default gen_random_uuid(),
    kind text not null check (kind in ('flight', 'hotel')),
    user_id uuid not null,
    profile_id uuid not null,
    status text not null check (status in ('charged','booked','ticketing','confirmed','refunded','needs_review')),
    amount_paise bigint not null check (amount_paise > 0),
    currency text not null default 'INR',
    ledger_id uuid,
    trace_id text,
    result_index text,
    is_lcc boolean,
    pnr text,
    tbo_booking_id text,
    confirmation_no text,
    summary jsonb not null default '{}'::jsonb,
    error text,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
  );
  create unique index if not exists travel_bookings_tbo_idx on wishme.travel_bookings (kind, tbo_booking_id) where tbo_booking_id is not null;`;

function result(o: { lcc: boolean; offered?: number; index?: string }) {
  return {
    ResultIndex: o.index ?? (o.lcc ? 'OB-LCC' : 'OB-GDS'),
    Source: 6,
    IsLCC: o.lcc,
    IsRefundable: true,
    Fare: { Currency: 'INR', BaseFare: 4000, Tax: 600, PublishedFare: 4800, OfferedFare: o.offered ?? 4599.4 },
    FareBreakdown: [{ PassengerType: 1, PassengerCount: 1, BaseFare: 4000, Tax: 600, Currency: 'INR' }],
    Segments: [
      [
        {
          Airline: { AirlineCode: '6E', AirlineName: 'IndiGo', FlightNumber: '2041' },
          Origin: { Airport: { AirportCode: 'DEL', CityName: 'Delhi' }, DepTime: '2027-03-01T06:05:00' },
          Destination: { Airport: { AirportCode: 'BOM', CityName: 'Mumbai' }, ArrTime: '2027-03-01T08:15:00' },
          Duration: 130,
        },
      ],
    ],
  };
}

const passenger = (o: Record<string, unknown> = {}) => ({
  Title: 'Mr',
  FirstName: 'Ravi',
  LastName: 'Kumar',
  PaxType: 1,
  DateOfBirth: '1990-05-01',
  Gender: 1,
  ContactNo: '9876543210',
  Email: 'ravi@example.com',
  IsLeadPax: true,
  ...o,
});

const ticketOk = (bookingId: number, pnr: string) =>
  ok({
    Response: {
      BookingId: bookingId,
      PNR: pnr,
      TicketStatus: 1,
      FlightItinerary: {
        PNR: pnr,
        InvoiceNo: 'INV-1',
        InvoiceCreatedOn: '2027-01-01T10:00:00',
        Fare: { PublishedFare: 4800, Currency: 'INR' },
        Passenger: [{ Ticket: { TicketNumber: '0981234567' } }],
      },
    },
  });

let alice: TestSession;
let bob: TestSession;
let aliceProfile: string;

const flight = (token: string | null, payload: Record<string, unknown>) =>
  t.app.inject({ method: 'POST', url: '/functions/v1/tbo-flights', headers: token ? bearer(token) : anon(), payload });
async function setBalance(rupees: number) {
  await t.sql`update public.profiles set wallet_balance = ${rupees} where id = ${aliceProfile}`;
}
async function balance(): Promise<number> {
  return Number((await t.sql<{ b: number }[]>`select wallet_balance as b from public.profiles where id = ${aliceProfile}`)[0]!.b);
}
async function lastBooking() {
  return (await t.sql<{ id: string; status: string; amount_paise: string; pnr: string | null; tbo_booking_id: string | null }[]>`
    select id::text, status, amount_paise::text, pnr, tbo_booking_id from wishme.travel_bookings order by created_at desc limit 1`)[0];
}

beforeAll(async () => {
  t = await bootTest({ env: { TBO_ENV: 'test', TBO_CLIENT_ID: 'ApiIntegrationNew', TBO_USERNAME: 'agent', TBO_PASSWORD: 'secret' } });
  await t.sql.unsafe(TRAVEL_BOOKINGS_DDL);
  await t.deps.schema.load();
  alice = await signUp(t, 'alice-fly@example.com');
  bob = await signUp(t, 'bob-fly@example.com');
  aliceProfile = await profileIdOf(t, alice.user.id);

  globalThis.fetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    const method = url.pathname.split('/').pop()!;
    const body = typeof init.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : {};
    calls.push({ method, body });
    if (method === 'Authenticate') return json({ Status: 1, TokenId: 'token-1', Error: { ErrorCode: 0 } });
    const route = routes[method];
    if (!route) throw new TypeError(`unexpected TBO call ${method}`);
    return route(body);
  }) as typeof fetch;
});

afterEach(() => {
  calls = [];
  routes = {};
});

afterAll(async () => {
  globalThis.fetch = realFetch;
  await t.close();
});

describe('open actions (anon key, as the flight screens call them)', () => {
  it('searches with the anon key and maps results; the token is cached', async () => {
    routes.Search = () => ok({ Results: [[result({ lcc: true })]] });
    const res = await flight(null, { action: 'search', origin: 'del', destination: 'BOM', departDate: '2027-03-01', adults: 1 });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({ success: true, traceId: 'trace-1', isReturn: false, totalResults: 1 });
    expect(body.outbound[0]).toMatchObject({ resultIndex: 'OB-LCC', price: 4599, originalPrice: 4800, flightNumber: '6E-2041', depart: '06:05' });
    const search = calls.find((c) => c.method === 'Search')!;
    expect(search.body).toMatchObject({ AdultCount: '1', JourneyType: '1', TokenId: 'token-1', Segments: [{ Origin: 'DEL', Destination: 'BOM', FlightCabinClass: '1' }] });
    routes.Search = () => ok({ Results: [[]] });
    calls = [];
    await flight(null, { action: 'search', origin: 'DEL', destination: 'BOM', departDate: '2027-03-01' });
    expect(calls.filter((c) => c.method === 'Authenticate')).toHaveLength(0);
  });

  it('validates search input', async () => {
    const res = await flight(null, { action: 'search', origin: 'DEL', destination: 'DEL', departDate: '2027-03-01' });
    expect(res.statusCode).toBe(400);
    const bad = await flight(null, { action: 'search', origin: 'DELHI', destination: 'BOM', departDate: '2027-03-01' });
    expect(bad.statusCode).toBe(400);
  });

  it('answers farequote with the app’s TBOFareQuote shape', async () => {
    routes.FareQuote = () => ok({ IsPriceChanged: false, Results: result({ lcc: true }) });
    const res = await flight(null, { action: 'farequote', traceId: 'trace-1', resultIndex: 'OB-LCC' });
    expect(res.json()).toMatchObject({ success: true, isPriceChanged: false, isLCC: true, flight: { price: 4599 } });
  });

  it('refuses unknown actions', async () => {
    expect((await flight(null, { action: 'cancel' })).statusCode).toBe(400);
  });
});

describe('LCC: ticket with passengers', () => {
  it('needs a signed-in user', async () => {
    const res = await flight(null, { action: 'ticket', traceId: 'trace-1', resultIndex: 'OB-LCC', passengers: [passenger()] });
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toMatch(/sign in/i);
    expect(calls).toHaveLength(0);
  });

  it('re-quotes, charges the offered fare plus the seat, then tickets with server fares', async () => {
    await setBalance(10_000);
    routes.FareQuote = () => ok({ IsPriceChanged: false, Results: result({ lcc: true }) });
    routes.SSR = () => ok({ SeatDynamic: [{ SegmentSeat: [{ RowSeats: [{ Seats: [{ Code: '1A', SeatNo: '1A', AvailablityType: 1, Price: 299 }] }] }] }] });
    routes.Ticket = (body) => {
      expect(body.Passengers).toMatchObject([{ Fare: { BaseFare: 4000, Tax: 600 }, SeatDynamic: [{ SeatNo: '1A' }] }]);
      return ticketOk(5001, 'PNR1');
    };
    const res = await flight(alice.access_token, {
      action: 'ticket',
      traceId: 'trace-1',
      resultIndex: 'OB-LCC',
      passengers: [passenger({ Seat: { SeatNo: '1A', Price: 1 }, Fare: { PublishedFare: 1 } })],
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.success).toBe(true);
    expect(body.ticket).toMatchObject({ BookingId: 5001, PNR: 'PNR1', Error: { ErrorCode: 0 } });
    expect(await balance()).toBe(10_000 - 4600 - 299);
    expect(await lastBooking()).toMatchObject({ status: 'confirmed', amount_paise: String((4600 + 299) * 100), pnr: 'PNR1', tbo_booking_id: '5001' });
    const l = await t.sql`select kind, amount_paise::text from wishme.ledger_entries where account_id = ${aliceProfile} order by created_at desc limit 1`;
    expect(l[0]).toMatchObject({ kind: 'flight_booking', amount_paise: String(-(4600 + 299) * 100) });
    // Ticket ran after the charge: the order of vendor calls proves it went FareQuote → SSR → Ticket.
    expect(calls.map((c) => c.method)).toEqual(['FareQuote', 'SSR', 'Ticket']);
  });

  it('refunds when TBO declines the ticket', async () => {
    await setBalance(10_000);
    routes.FareQuote = () => ok({ IsPriceChanged: false, Results: result({ lcc: true }) });
    routes.Ticket = () => json({ Response: { ResponseStatus: 2, Error: { ErrorCode: 3, ErrorMessage: 'Fare not available' } } });
    const res = await flight(alice.access_token, { action: 'ticket', traceId: 'trace-1', resultIndex: 'OB-LCC', passengers: [passenger()] });
    expect(res.statusCode).toBe(422);
    expect(res.json().error).toBe('Fare not available');
    expect(await balance()).toBe(10_000);
    expect((await lastBooking())!.status).toBe('refunded');
  });

  it('keeps the money and flags the booking when the ticket outcome is unknown', async () => {
    await setBalance(10_000);
    routes.FareQuote = () => ok({ IsPriceChanged: false, Results: result({ lcc: true }) });
    routes.Ticket = () => {
      throw new TypeError('socket hang up');
    };
    const res = await flight(alice.access_token, { action: 'ticket', traceId: 'trace-1', resultIndex: 'OB-LCC', passengers: [passenger()] });
    expect(res.statusCode).toBe(502);
    expect(res.json().code).toBe('booking_unconfirmed');
    expect(await balance()).toBe(10_000 - 4600);
    expect((await lastBooking())!.status).toBe('needs_review');
    // Not retried: a retried Ticket could issue a second ticket.
    expect(calls.filter((c) => c.method === 'Ticket')).toHaveLength(1);
  });

  it('does not charge when the price changed or the balance is short', async () => {
    await setBalance(10_000);
    routes.FareQuote = () => ok({ IsPriceChanged: true, Results: result({ lcc: true, offered: 5200 }) });
    const changed = await flight(alice.access_token, { action: 'ticket', traceId: 'trace-1', resultIndex: 'OB-LCC', passengers: [passenger()] });
    expect(changed.statusCode).toBe(409);
    expect(changed.json().error).toMatch(/changed this fare to ₹5,200/);

    await setBalance(100);
    routes.FareQuote = () => ok({ IsPriceChanged: false, Results: result({ lcc: true }) });
    const poor = await flight(alice.access_token, { action: 'ticket', traceId: 'trace-1', resultIndex: 'OB-LCC', passengers: [passenger()] });
    expect(poor.statusCode).toBe(400);
    expect(poor.json().error).toMatch(/insufficient wallet balance/i);
    expect(calls.some((c) => c.method === 'Ticket')).toBe(false);
  });

  it('validates passengers before charging', async () => {
    await setBalance(10_000);
    routes.FareQuote = () => ok({ IsPriceChanged: false, Results: result({ lcc: true }) });
    const res = await flight(alice.access_token, { action: 'ticket', traceId: 'trace-1', resultIndex: 'OB-LCC', passengers: [passenger({ PaxType: 2 })] });
    expect(res.statusCode).toBe(400);
    const res2 = await flight(alice.access_token, { action: 'ticket', traceId: 'trace-1', resultIndex: 'OB-LCC', passengers: [passenger({ Email: 'not-an-email' })] });
    expect(res2.statusCode).toBe(400);
    expect(await balance()).toBe(10_000);
  });
});

describe('non-LCC: book then ticket the PNR', () => {
  it('charges at book, tickets only the caller’s own booking, and replays a finished ticket', async () => {
    await setBalance(10_000);
    routes.FareQuote = () => ok({ IsPriceChanged: false, Results: result({ lcc: false }) });
    routes.Book = () => ok({ Response: { BookingId: 7001, PNR: 'GDS1', IsPriceChanged: false } });
    const book = await flight(alice.access_token, { action: 'book', traceId: 'trace-1', resultIndex: 'OB-GDS', passengers: [passenger()] });
    expect(book.statusCode).toBe(200);
    expect(book.json().booking).toMatchObject({ BookingId: 7001, PNR: 'GDS1' });
    expect(await balance()).toBe(10_000 - 4600);
    expect((await lastBooking())!.status).toBe('booked');

    const stolen = await flight(bob.access_token, { action: 'ticket', traceId: 'trace-1', pnr: 'GDS1', bookingId: 7001 });
    expect(stolen.statusCode).toBe(404);

    routes.Ticket = (body) => {
      expect(body).toMatchObject({ PNR: 'GDS1', BookingId: 7001 });
      return ticketOk(7001, 'GDS1');
    };
    const ticket = await flight(alice.access_token, { action: 'ticket', traceId: 'trace-1', pnr: 'GDS1', bookingId: 7001 });
    expect(ticket.statusCode).toBe(200);
    expect(ticket.json().ticket.FlightItinerary.Passenger[0].Ticket.TicketNumber).toBe('0981234567');
    expect((await lastBooking())!.status).toBe('confirmed');

    const replay = await flight(alice.access_token, { action: 'ticket', traceId: 'trace-1', pnr: 'GDS1', bookingId: 7001 });
    expect(replay.statusCode).toBe(200);
    expect(replay.json().ticket).toMatchObject({ BookingId: 7001, PNR: 'GDS1', FlightItinerary: { InvoiceNo: 'INV-1', Passenger: [{ Ticket: { TicketNumber: '0981234567' } }] } });
    expect(calls.filter((c) => c.method === 'Ticket')).toHaveLength(1);
    expect(await balance()).toBe(10_000 - 4600);
  });

  it('refunds and releases the PNR when ticketing is declined', async () => {
    await setBalance(10_000);
    routes.FareQuote = () => ok({ IsPriceChanged: false, Results: result({ lcc: false, index: 'OB-GDS-2' }) });
    routes.Book = () => ok({ Response: { BookingId: 7002, PNR: 'GDS2' } });
    await flight(alice.access_token, { action: 'book', traceId: 'trace-1', resultIndex: 'OB-GDS-2', passengers: [passenger()] });
    routes.Ticket = () => json({ Response: { ResponseStatus: 2, Error: { ErrorCode: 2, ErrorMessage: 'Ticketing failed' } } });
    routes.ReleasePNRRequest = () => ok({});
    const res = await flight(alice.access_token, { action: 'ticket', traceId: 'trace-1', pnr: 'GDS2', bookingId: 7002 });
    expect(res.statusCode).toBe(422);
    expect(await balance()).toBe(10_000);
    expect(calls.find((c) => c.method === 'ReleasePNRRequest')!.body).toMatchObject({ BookingId: 7002, Source: 6 });
  });

  it('bookingdetails only for the owner', async () => {
    routes.GetBookingDetails = () => ok({ FlightItinerary: { PNR: 'GDS1', BookingId: 7001 } });
    const mine = await flight(alice.access_token, { action: 'bookingdetails', bookingId: 7001 });
    expect(mine.json()).toMatchObject({ success: true, booking: { PNR: 'GDS1' } });
    expect((await flight(bob.access_token, { action: 'bookingdetails', bookingId: 7001 })).statusCode).toBe(404);
  });

  it('the sweep refunds holds that were never ticketed', async () => {
    await setBalance(10_000);
    routes.FareQuote = () => ok({ IsPriceChanged: false, Results: result({ lcc: false, index: 'OB-GDS-3' }) });
    routes.Book = () => ok({ Response: { BookingId: 7003, PNR: 'GDS3' } });
    await flight(alice.access_token, { action: 'book', traceId: 'trace-1', resultIndex: 'OB-GDS-3', passengers: [passenger()] });
    expect(await balance()).toBe(10_000 - 4600);
    await t.sql`update wishme.travel_bookings set updated_at = now() - interval '1 hour' where tbo_booking_id = '7003'`;
    routes.ReleasePNRRequest = () => ok({});
    const r = await sweepStaleFlightBookings(t.deps, 30);
    expect(r.refunded).toBe(1);
    expect(await balance()).toBe(10_000);
    expect(await sweepStaleFlightBookings(t.deps, 30)).toEqual({ refunded: 0, flagged: 0 });
  });
});
