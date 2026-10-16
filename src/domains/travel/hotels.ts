/**
 * Hotels through TBO's Hotel API, with the same actions and response shapes as the deployed tbo-hotels function
 * (no screen calls them yet; the hotel flow in the app is still static data). Booking is charged server-side: the
 * server re-runs PreBook for the authoritative price, debits the wallet, then books, refunding if TBO says no.
 */
import { z } from 'zod';
import type { Deps } from '../../deps.js';
import { AppError, conflict, notFound } from '../../lib/errors.js';
import { TboRejected, TboUncertain } from '../../vendors/tbo.js';
import { chargeBooking, refundBooking, transition, type Payer } from './bookings.js';
import { tboOf } from './flights.js';

const DATE = z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/, 'must be YYYY-MM-DD');
const code = z.string().trim().min(1).max(500);
const NAME = /^[A-Za-z][A-Za-z ]{0,48}[A-Za-z]$|^[A-Za-z]$/;

export const CityBody = z.object({ countryCode: z.string().trim().toUpperCase().pipe(z.string().regex(/^[A-Z]{2}$/)).default('IN') });
export const CodesBody = z.object({ cityCode: z.coerce.string().trim().min(1).max(20) });
export const SearchBody = z
  .object({
    checkIn: DATE,
    checkOut: DATE,
    hotelCodes: z.union([z.string(), z.array(z.coerce.string())]).transform((v) => (Array.isArray(v) ? v.join(',') : v).trim()).pipe(z.string().min(1).max(5000)),
    adults: z.coerce.number().int().min(1).max(8).default(2),
    children: z.coerce.number().int().min(0).max(4).default(0),
    childrenAges: z.array(z.coerce.number().int().min(0).max(17)).max(4).default([]),
    rooms: z.coerce.number().int().min(1).max(6).default(1),
    guestNationality: z.string().trim().toUpperCase().pipe(z.string().regex(/^[A-Z]{2}$/)).default('IN'),
    refundableOnly: z.boolean().default(false),
    mealType: z.enum(['All', 'WithMeal', 'RoomOnly']).default('All'),
  })
  .superRefine((b, ctx) => {
    if (b.checkOut <= b.checkIn) ctx.addIssue({ code: 'custom', path: ['checkOut'], message: 'must be after check-in' });
    if (b.childrenAges.length && b.childrenAges.length !== b.children) ctx.addIssue({ code: 'custom', path: ['childrenAges'], message: 'one age per child' });
  });
export const PreBookBody = z.object({ bookingCode: code });

const CustomerName = z.object({
  Title: z.string().trim().max(10).refine((t) => /^(mr|mrs|ms|miss|mstr|master)\.?$/i.test(t), 'invalid title'),
  FirstName: z.string().trim().refine((n) => NAME.test(n), 'letters and spaces only'),
  LastName: z.string().trim().refine((n) => NAME.test(n), 'letters and spaces only'),
  Type: z.enum(['Adult', 'Child']),
});
export const BookBody = z.object({
  bookingCode: code,
  customerDetails: z.array(z.object({ CustomerNames: z.array(CustomerName).min(1).max(10) })).min(1).max(6),
  clientReferenceId: z.string().trim().max(50).optional(),
  guestNationality: z.string().trim().toUpperCase().pipe(z.string().regex(/^[A-Z]{2}$/)).default('IN'),
  totalFare: z.coerce.number().positive().optional(),
  emailId: z.string().trim().email().max(100),
  phoneNumber: z.string().trim().transform((p) => p.replace(/[\s()+-]/g, '')).pipe(z.string().regex(/^\d{10,15}$/, 'invalid phone number')),
});
export const DetailBody = z
  .object({ confirmationNumber: z.string().trim().max(50).optional(), bookingReferenceId: z.string().trim().max(50).optional() })
  .refine((b) => b.confirmationNumber || b.bookingReferenceId, 'confirmationNumber or bookingReferenceId is required');

type Status = { Status?: { Code?: number; Description?: string } };
interface TboRoom {
  BookingCode?: string;
  Name?: string[] | string;
  BedTypes?: string;
  MaxOccupancy?: number;
  Amenities?: string[];
  TotalFare?: number;
  MealType?: string;
  IsRefundable?: boolean;
  CancelPolicies?: unknown[];
  [k: string]: unknown;
}
interface TboHotel {
  HotelCode?: string | number;
  HotelName?: string;
  Address?: string;
  CityName?: string;
  HotelRating?: number | string;
  StarRating?: number | string;
  TripAdvisorRating?: number;
  TripAdvisorReviewCount?: number;
  Currency?: string;
  HotelFacilities?: string[];
  Description?: string;
  Images?: string[];
  Latitude?: number | string;
  Longitude?: number | string;
  Rooms?: TboRoom[];
}

const AMENITIES: Record<string, string> = {
  wifi: 'Wi-Fi',
  pool: 'Pool',
  spa: 'Spa',
  parking: 'Parking',
  breakfast: 'Breakfast',
  gym: 'Gym',
  restaurant: 'Restaurant',
  bar: 'Bar',
};

const starsOf = (rating: unknown): 3 | 4 | 5 => {
  const n = Math.round(Number(rating) || 0);
  return n >= 5 ? 5 : n === 4 ? 4 : 3;
};

function amenitiesOf(list: unknown): string[] {
  if (!Array.isArray(list)) return [];
  const out = new Set<string>();
  for (const raw of list) for (const [needle, label] of Object.entries(AMENITIES)) if (String(raw).toLowerCase().includes(needle)) out.add(label);
  return [...out];
}

const hasBreakfast = (r: TboRoom) => String(r.MealType ?? '').toLowerCase().includes('breakfast');

/** The deployed function's TBOHotel shape (hotel + rooms). */
export function mapHotel(h: TboHotel, id: number) {
  const rooms = h.Rooms ?? [];
  const prices = rooms.map((r) => Number(r.TotalFare ?? 0)).filter((n) => n > 0);
  const cheapest = prices.length ? Math.min(...prices) : 0;
  return {
    id: String(h.HotelCode ?? id),
    hotelCode: String(h.HotelCode ?? ''),
    name: h.HotelName ?? 'Hotel',
    area: h.Address ?? h.CityName ?? '',
    city: h.CityName ?? '',
    stars: starsOf(h.HotelRating ?? h.StarRating),
    rating: Number(h.TripAdvisorRating ?? h.HotelRating ?? 0) || 0,
    reviews: String(h.TripAdvisorReviewCount ?? ''),
    price: Math.round(cheapest),
    originalPrice: Math.round(cheapest),
    currency: h.Currency ?? 'INR',
    tags: [] as string[],
    amenities: amenitiesOf(h.HotelFacilities),
    propertyType: 'Hotel',
    freeCancel: rooms.some((r) => r.IsRefundable),
    breakfast: rooms.some(hasBreakfast),
    distance: '',
    description: h.Description ?? '',
    image: Array.isArray(h.Images) ? (h.Images[0] ?? '') : '',
    images: Array.isArray(h.Images) ? h.Images.slice(0, 8) : [],
    latitude: h.Latitude ?? null,
    longitude: h.Longitude ?? null,
    rooms: rooms.map((r, i) => ({
      id: String(r.BookingCode ?? i),
      bookingCode: r.BookingCode ?? '',
      name: Array.isArray(r.Name) ? (r.Name[0] ?? 'Room') : (r.Name ?? 'Room'),
      bed: r.BedTypes ?? '',
      size: '',
      guests: Number(r.MaxOccupancy ?? 2) || 2,
      amenities: Array.isArray(r.Amenities) ? r.Amenities.slice(0, 6) : [],
      price: Math.round(Number(r.TotalFare ?? 0)),
      originalPrice: Math.round(Number(r.TotalFare ?? 0)),
      mealType: r.MealType ?? '',
      freeCancel: !!r.IsRefundable,
      breakfast: hasBreakfast(r),
      cancelPolicies: r.CancelPolicies ?? [],
    })),
    fanReviews: [] as unknown[],
    tint: '#0F766E',
  };
}

export async function cityList(deps: Deps, b: z.infer<typeof CityBody>) {
  const r = await tboOf(deps).hotel<Status & { CityList?: unknown[] }>('CityList', { CountryCode: b.countryCode });
  return { cities: r.CityList ?? [] };
}

export async function hotelCodes(deps: Deps, b: z.infer<typeof CodesBody>) {
  const r = await tboOf(deps).hotel<Status & { Hotels?: unknown[] }>('TBOHotelCodeList', { CityCode: b.cityCode, IsDetailedResponse: 'false' });
  return { hotels: r.Hotels ?? [] };
}

export async function search(deps: Deps, b: z.infer<typeof SearchBody>) {
  const paxRooms = Array.from({ length: b.rooms }, () => ({ Adults: b.adults, Children: b.children, ChildrenAges: b.childrenAges }));
  try {
    const r = await tboOf(deps).hotel<Status & { HotelResult?: TboHotel[]; HotelSearchResult?: TboHotel[] }>(
      'Search',
      {
        CheckIn: b.checkIn,
        CheckOut: b.checkOut,
        HotelCodes: b.hotelCodes,
        GuestNationality: b.guestNationality,
        PaxRooms: paxRooms,
        ResponseTime: 23,
        IsDetailedResponse: true,
        Filters: { Refundable: b.refundableOnly, NoOfRooms: b.rooms, MealType: b.mealType },
      },
      { timeoutMs: 40_000 },
    );
    const list = r.HotelResult ?? r.HotelSearchResult ?? [];
    return { hotels: list.map((h, i) => mapHotel(h, i + 1)), totalResults: list.length };
  } catch (e) {
    if (e instanceof TboRejected && /no (available )?(hotel|room|result)/i.test(e.message)) return { hotels: [], totalResults: 0 };
    throw e;
  }
}

async function preBookRaw(deps: Deps, bookingCode: string) {
  return tboOf(deps).hotel<Status & { HotelResult?: Array<{ Rooms?: TboRoom[]; Currency?: string }> }>('PreBook', { BookingCode: bookingCode, PaymentMode: 'Limit' });
}

export async function preBook(deps: Deps, b: z.infer<typeof PreBookBody>) {
  const r = await preBookRaw(deps, b.bookingCode);
  return { rooms: r.HotelResult?.[0]?.Rooms ?? [], raw: r.HotelResult ?? null };
}

/** Charges the wallet for the server's PreBook price, then books; refunds when TBO declines. */
export async function book(deps: Deps, payer: Payer, b: z.infer<typeof BookBody>) {
  const lockKey = `tbo:lock:hotel:${payer.profileId}:${b.bookingCode.slice(0, 200)}`;
  if (!(await deps.kv.set(lockKey, '1', 180, true))) throw conflict('This booking is already being processed. Please wait.', 'booking_in_progress');
  try {
    const pre = await preBookRaw(deps, b.bookingCode);
    const room = pre.HotelResult?.[0]?.Rooms?.[0];
    const fare = Number(room?.TotalFare ?? 0);
    if (!room || !(fare > 0)) throw new AppError(409, 'fare_unavailable', 'This room is no longer available. Please search again.');
    const rupees = Math.ceil(fare);
    if (b.totalFare !== undefined && Math.abs(b.totalFare - fare) > 1) {
      throw conflict(`The hotel changed this price to ₹${rupees.toLocaleString('en-IN')}. Please review and book again.`, 'price_changed');
    }
    const { id } = await chargeBooking(deps, payer, {
      kind: 'hotel',
      amountPaise: rupees * 100,
      description: 'Hotel booking',
      summary: { rooms: b.customerDetails.length, fare: rupees, currency: pre.HotelResult?.[0]?.Currency ?? 'INR' },
    });
    let res: Status & { ConfirmationNumber?: string; BookingId?: string | number; [k: string]: unknown };
    try {
      res = await tboOf(deps).hotel('Book', {
        BookingCode: b.bookingCode,
        CustomerDetails: b.customerDetails,
        // Our booking id, so TBO's record and ours can always be matched.
        ClientReferenceId: id,
        BookingReferenceId: id,
        TotalFare: fare,
        EmailId: b.emailId,
        PhoneNumber: b.phoneNumber,
        BookingType: 'Voucher',
        PaymentMode: 'Limit',
        GuestNationality: b.guestNationality,
      }, { timeoutMs: 90_000 });
    } catch (e) {
      if (e instanceof TboUncertain) {
        await transition(deps.db, id, ['charged'], 'needs_review', { error: 'uncertain:Book' });
        deps.log.error({ travelBookingId: id }, 'TBO hotel outcome unknown; booking needs review');
        throw new AppError(502, 'booking_unconfirmed', 'We could not get a confirmation from the hotel yet. Please do not book again; if it is not confirmed, the amount will be refunded to your wallet.');
      }
      await refundBooking(deps, id, ['charged'], e instanceof AppError ? `${e.code}: ${e.message}` : 'internal_error');
      throw e;
    }
    await transition(deps.db, id, ['charged'], 'confirmed', {
      confirmationNo: res.ConfirmationNumber ? String(res.ConfirmationNumber) : null,
      tboBookingId: res.BookingId !== undefined ? String(res.BookingId) : null,
    });
    return { booking: { ...res, ClientReferenceId: id } };
  } finally {
    await deps.kv.del(lockKey).catch(() => {});
  }
}

/** Booking detail for a hotel booking the caller made through this server. */
export async function bookingDetail(deps: Deps, payer: Payer, b: z.infer<typeof DetailBody>) {
  const rows = await deps.db<{ id: string; confirmation_no: string | null }[]>`
    select id::text, confirmation_no from wishme.travel_bookings
    where kind = 'hotel' and profile_id = ${payer.profileId}
      and (confirmation_no = ${b.confirmationNumber ?? null} or id::text = ${b.bookingReferenceId ?? null})
    limit 1`;
  const own = rows[0];
  if (!own) throw notFound('Booking not found');
  const r = await tboOf(deps).hotel('BookingDetail', {
    ...(own.confirmation_no ? { ConfirmationNumber: own.confirmation_no } : {}),
    BookingReferenceId: own.id,
    PaymentMode: 'Limit',
  });
  return { booking: r };
}
