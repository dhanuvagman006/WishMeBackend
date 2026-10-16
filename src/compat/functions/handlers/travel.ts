/**
 * tbo-flights and tbo-hotels: `{ action, ...payload }` in, `{ success: true, ... }` out, exactly the actions and
 * shapes services/tboService.ts uses and the deployed functions served. See ../registry.ts for the conventions.
 *
 * Differences from the deployed functions, all on the server side:
 *  - Booking actions (flight book / ticket / bookingdetails, hotel book / bookingdetail) need a signed-in user and
 *    charge that user's wallet through the ledger before TBO is asked to book (the deployed functions booked and
 *    ticketed real airline seats without charging anyone). Search, fare rules, quotes and seat maps stay open to the
 *    anon key, as the flight screens call them without a token, and are rate-limited per IP.
 *  - Inputs are validated (codes, dates, counts, passenger names, ages, passport and PAN when required).
 *  - Bodies are never logged (see vendors/tbo.ts).
 */
import { z } from 'zod';
import { AppError, badRequest, forbidden, unauthorized } from '../../../lib/errors.js';
import type { LimitRule } from '../../../lib/rate-limit.js';
import * as flights from '../../../domains/travel/flights.js';
import * as hotels from '../../../domains/travel/hotels.js';
import type { Payer } from '../../../domains/travel/bookings.js';
import { defineFunctions, parseBody, type FnContext } from '../registry.js';

const ActionBody = z.object({ action: z.string().trim().min(1).max(30).transform((a) => a.toLowerCase()) });

const READ_LIMIT: LimitRule = { limit: 60, windowSec: 600 };
const SEARCH_LIMIT: LimitRule = { limit: 30, windowSec: 600 };
const BOOK_LIMIT: LimitRule = { limit: 10, windowSec: 600 };

async function limit(c: FnContext, fn: string, action: string, rule: LimitRule): Promise<void> {
  const subject = c.auth.userId ? `u:${c.auth.userId}` : `ip:${c.ip}`;
  await c.deps.limiter.hit(`fn:${fn}:${action}`, subject, rule);
}

async function payerOf(c: FnContext, what: string): Promise<Payer> {
  if (c.auth.kind !== 'user' || !c.auth.userId) throw unauthorized(`Please sign in to ${what}.`, 'sign_in_required');
  const identity = await c.identity();
  if (!identity.profileId) throw forbidden('Profile not found. Please sign in again.', 'profile_not_found');
  return { userId: c.auth.userId, profileId: identity.profileId };
}

const ok = (data: object) => ({ body: { success: true, ...data } });

export const functions = defineFunctions([
  {
    name: 'tbo-flights',
    access: 'anon',
    bodyLimit: 256 * 1024,
    handler: async (c) => {
      const { action } = parseBody(ActionBody, c.body);
      const ctx = { deps: c.deps, ip: c.ip };
      switch (action) {
        case 'search':
          await limit(c, 'tbo-flights', action, SEARCH_LIMIT);
          return ok(await flights.search(ctx, parseBody(flights.SearchBody, c.body)));
        case 'farerule':
          await limit(c, 'tbo-flights', action, READ_LIMIT);
          return ok(await flights.fareRule(ctx, parseBody(flights.QuoteBody, c.body)));
        case 'farequote':
          await limit(c, 'tbo-flights', action, READ_LIMIT);
          return ok(await flights.fareQuote(ctx, parseBody(flights.QuoteBody, c.body)));
        case 'ssr':
          await limit(c, 'tbo-flights', action, READ_LIMIT);
          return ok(await flights.ssr(ctx, parseBody(flights.QuoteBody, c.body)));
        case 'book': {
          const payer = await payerOf(c, 'book flights');
          await limit(c, 'tbo-flights', action, BOOK_LIMIT);
          return ok(await flights.book(ctx, payer, parseBody(flights.BookBody, c.body)));
        }
        case 'ticket': {
          const payer = await payerOf(c, 'book flights');
          await limit(c, 'tbo-flights', action, BOOK_LIMIT);
          return ok(await flights.ticket(ctx, payer, parseBody(flights.TicketBody, c.body)));
        }
        case 'bookingdetails': {
          const payer = await payerOf(c, 'see your bookings');
          await limit(c, 'tbo-flights', action, READ_LIMIT);
          return ok(await flights.bookingDetails(ctx, payer, parseBody(flights.DetailsBody, c.body)));
        }
        default:
          throw badRequest(`Unknown action "${action.slice(0, 30)}"`);
      }
    },
  },
  {
    name: 'tbo-hotels',
    access: 'anon',
    bodyLimit: 256 * 1024,
    handler: async (c) => {
      const { action } = parseBody(ActionBody, c.body);
      switch (action) {
        case 'citylist':
          await limit(c, 'tbo-hotels', action, READ_LIMIT);
          return ok(await hotels.cityList(c.deps, parseBody(hotels.CityBody, c.body)));
        case 'hotelcodes':
          await limit(c, 'tbo-hotels', action, READ_LIMIT);
          return ok(await hotels.hotelCodes(c.deps, parseBody(hotels.CodesBody, c.body)));
        case 'search':
          await limit(c, 'tbo-hotels', action, SEARCH_LIMIT);
          return ok(await hotels.search(c.deps, parseBody(hotels.SearchBody, c.body)));
        case 'prebook':
          await limit(c, 'tbo-hotels', action, READ_LIMIT);
          return ok(await hotels.preBook(c.deps, parseBody(hotels.PreBookBody, c.body)));
        case 'book': {
          const payer = await payerOf(c, 'book hotels');
          await limit(c, 'tbo-hotels', action, BOOK_LIMIT);
          return ok(await hotels.book(c.deps, payer, parseBody(hotels.BookBody, c.body)));
        }
        case 'bookingdetail': {
          const payer = await payerOf(c, 'see your bookings');
          await limit(c, 'tbo-hotels', action, READ_LIMIT);
          return ok(await hotels.bookingDetail(c.deps, payer, parseBody(hotels.DetailBody, c.body)));
        }
        default:
          throw new AppError(400, 'bad_request', `Unknown action "${action.slice(0, 30)}"`);
      }
    },
  },
]);
