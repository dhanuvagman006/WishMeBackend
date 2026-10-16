/** tbo-hotels with TBO stubbed: open search, server-priced and charged booking, refund when TBO declines. */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { anon, bearer, bootTest, profileIdOf, signUp, type TestCtx, type TestSession } from '../helpers.js';

// Same DDL as documented in src/domains/travel/bookings.ts (the migration is requested from core).
const TRAVEL_BOOKINGS_DDL = `
  create table if not exists wishme.travel_bookings (
    id uuid primary key default gen_random_uuid(),
    kind text not null check (kind in ('flight', 'hotel')),
    user_id uuid not null,
    profile_id uuid not null,
    status text not null check (status in ('charged','booked','ticketing','confirmed','refunded','needs_review')),
    amount_paise bigint not null check (amount_paise > 0),
    currency text not null default 'INR',
    ledger_id uuid, trace_id text, result_index text, is_lcc boolean, pnr text, tbo_booking_id text, confirmation_no text,
    summary jsonb not null default '{}'::jsonb,
    error text,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
  );`;

let t: TestCtx;
const realFetch = globalThis.fetch;
let calls: Array<{ method: string; body: Record<string, unknown>; auth: string | null }> = [];
let routes: Record<string, (body: Record<string, unknown>) => Response> = {};
const json = (x: unknown, status = 200) => new Response(JSON.stringify(x), { status, headers: { 'content-type': 'application/json' } });
const ok = (x: Record<string, unknown>) => json({ Status: { Code: 200, Description: 'Successful' }, ...x });

let alice: TestSession;
let aliceProfile: string;
const hotel = (token: string | null, payload: Record<string, unknown>) =>
  t.app.inject({ method: 'POST', url: '/functions/v1/tbo-hotels', headers: token ? bearer(token) : anon(), payload });
const balance = async () => Number((await t.sql<{ b: number }[]>`select wallet_balance as b from public.profiles where id = ${aliceProfile}`)[0]!.b);

const bookBody = {
  action: 'book',
  bookingCode: 'BC-1',
  customerDetails: [{ CustomerNames: [{ Title: 'Mr', FirstName: 'Ravi', LastName: 'Kumar', Type: 'Adult' }] }],
  emailId: 'ravi@example.com',
  phoneNumber: '+91 98765 43210',
};

beforeAll(async () => {
  t = await bootTest({ env: { TBO_HOTEL_USERNAME: 'hoteluser', TBO_HOTEL_PASSWORD: 'hotelpass' } });
  await t.sql.unsafe(TRAVEL_BOOKINGS_DDL);
  alice = await signUp(t, 'alice-hotel@example.com');
  aliceProfile = await profileIdOf(t, alice.user.id);
  globalThis.fetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    const method = url.pathname.split('/').pop()!;
    const headers = new Headers(init.headers);
    calls.push({ method, body: JSON.parse(String(init.body ?? '{}')) as Record<string, unknown>, auth: headers.get('authorization') });
    const route = routes[method];
    if (!route) throw new TypeError(`unexpected TBO hotel call ${method}`);
    return route(calls.at(-1)!.body);
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

describe('tbo-hotels', () => {
  it('searches with HTTP Basic and maps hotels', async () => {
    routes.Search = () => ok({ HotelResult: [{ HotelCode: 99, HotelName: 'Sea View', Rooms: [{ BookingCode: 'BC-1', Name: ['Deluxe'], TotalFare: 3999.5 }] }] });
    const res = await hotel(null, { action: 'search', checkIn: '2027-02-01', checkOut: '2027-02-03', hotelCodes: '99', rooms: 2 });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ success: true, totalResults: 1, hotels: [{ hotelCode: '99', price: 4000, rooms: [{ bookingCode: 'BC-1' }] }] });
    expect(calls[0]!.auth).toBe(`Basic ${Buffer.from('hoteluser:hotelpass').toString('base64')}`);
    expect(calls[0]!.body).toMatchObject({ PaxRooms: [{ Adults: 2 }, { Adults: 2 }], Filters: { NoOfRooms: 2 } });
  });

  it('book needs a user, charges the PreBook price and books with our reference', async () => {
    expect((await hotel(null, bookBody)).statusCode).toBe(401);
    await t.sql`update public.profiles set wallet_balance = 10000 where id = ${aliceProfile}`;
    routes.PreBook = () => ok({ HotelResult: [{ Currency: 'INR', Rooms: [{ BookingCode: 'BC-1', TotalFare: 3999.5 }] }] });
    routes.Book = (body) => ok({ ConfirmationNumber: 'CONF-1', ClientReferenceId: body.ClientReferenceId });
    const res = await hotel(alice.access_token, bookBody);
    expect(res.statusCode).toBe(200);
    expect(res.json().booking).toMatchObject({ ConfirmationNumber: 'CONF-1' });
    expect(await balance()).toBe(10000 - 4000);
    const book = calls.find((c) => c.method === 'Book')!;
    expect(book.body).toMatchObject({ TotalFare: 3999.5, PhoneNumber: '919876543210', BookingType: 'Voucher' });
    const row = await t.sql`select status, confirmation_no, id::text from wishme.travel_bookings where kind = 'hotel'`;
    expect(row[0]).toMatchObject({ status: 'confirmed', confirmation_no: 'CONF-1' });
    expect(book.body.ClientReferenceId).toBe(row[0]!.id);
  });

  it('refuses a changed price and refunds when TBO declines', async () => {
    await t.sql`update public.profiles set wallet_balance = 10000 where id = ${aliceProfile}`;
    routes.PreBook = () => ok({ HotelResult: [{ Rooms: [{ BookingCode: 'BC-1', TotalFare: 4500 }] }] });
    const changed = await hotel(alice.access_token, { ...bookBody, totalFare: 3999.5 });
    expect(changed.statusCode).toBe(409);
    routes.Book = () => json({ Status: { Code: 500, Description: 'Room sold out' } });
    const declined = await hotel(alice.access_token, bookBody);
    expect(declined.statusCode).toBe(422);
    expect(declined.json().error).toBe('Room sold out');
    expect(await balance()).toBe(10000);
  });

  it('validates guest names', async () => {
    const res = await hotel(alice.access_token, { ...bookBody, customerDetails: [{ CustomerNames: [{ Title: 'Mr', FirstName: 'R2', LastName: 'K', Type: 'Adult' }] }] });
    expect(res.statusCode).toBe(400);
  });
});
