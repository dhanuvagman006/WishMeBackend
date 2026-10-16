import { describe, expect, it } from 'vitest';
import { attachSsr, findInTree } from '../../src/domains/travel/flights.js';
import { chargeRupees, mapFareQuote, mapFlight, mapSearch, type TboResult } from '../../src/domains/travel/flight-map.js';
import { ageOn, buildPassengers, paxFare, type PassengerIn } from '../../src/domains/travel/passengers.js';
import { mapHotel } from '../../src/domains/travel/hotels.js';
import { redactTbo, tokenTtlSec } from '../../src/vendors/tbo.js';

const RESULT: TboResult = {
  ResultIndex: 'OB1',
  Source: 6,
  IsLCC: true,
  IsRefundable: true,
  ResultFareType: 'RegularFare',
  FareClassification: { Type: 'Publish' },
  IsPanRequiredAtBook: false,
  IsPassportRequiredAtBook: false,
  Fare: { Currency: 'INR', BaseFare: 8000, Tax: 1200.5, PublishedFare: 9500.5, OfferedFare: 9200.2, OtherCharges: 20 },
  FareBreakdown: [
    { PassengerType: 1, PassengerCount: 2, BaseFare: 6000, Tax: 900, Currency: 'INR' },
    { PassengerType: 2, PassengerCount: 1, BaseFare: 2000, Tax: 300.5, Currency: 'INR' },
  ],
  Segments: [
    [
      {
        Baggage: '15 KG',
        CabinBaggage: '7 KG',
        NoOfSeatAvailable: 4,
        Airline: { AirlineCode: '6E', AirlineName: 'IndiGo', FlightNumber: '2041', FareClass: 'R' },
        Origin: { Airport: { AirportCode: 'DEL', AirportName: 'Indira Gandhi', Terminal: '1', CityName: 'Delhi' }, DepTime: '2027-01-10T06:05:00' },
        Destination: { Airport: { AirportCode: 'JAI', CityName: 'Jaipur' }, ArrTime: '2027-01-10T07:00:00' },
        Duration: 55,
        GroundTime: 0,
        Craft: '320',
      },
      {
        Airline: { AirlineCode: '6E', AirlineName: 'IndiGo', FlightNumber: '311' },
        Origin: { Airport: { AirportCode: 'JAI' }, DepTime: '2027-01-10T08:00:00' },
        Destination: { Airport: { AirportCode: 'BOM', Terminal: '2', CityName: 'Mumbai' }, ArrTime: '2027-01-10T09:40:00' },
        Duration: 100,
        GroundTime: 60,
      },
    ],
  ],
};

describe('flight mapping (deployed tbo-flights shape)', () => {
  it('flattens an itinerary the way the screens expect', () => {
    const f = mapFlight(RESULT, 'trace-1', 3)!;
    expect(f).toMatchObject({
      id: 3,
      resultIndex: 'OB1',
      traceId: 'trace-1',
      isLCC: true,
      airline: 'IndiGo',
      airlineCode: '6E',
      flightNumber: '6E-2041',
      logo: '🟦',
      depart: '06:05',
      arrive: '09:40',
      departTime: '2027-01-10T06:05:00',
      arriveTime: '2027-01-10T09:40:00',
      fromCode: 'DEL',
      toCode: 'BOM',
      depAirport: 'DEL',
      arrAirport: 'BOM',
      duration: '3h 35m',
      durationMins: 215,
      stops: 1,
      layoverAirport: 'JAI',
      layoverMins: 60,
      price: 9200,
      originalPrice: 9501,
      fareType: 'RegularFare',
      fareClass: 'Publish',
      seatsAvailable: 4,
    });
  });

  it('maps search groups and quotes', () => {
    const s = mapSearch({ TraceId: 't', Results: [[RESULT], [RESULT]] }, true);
    expect(s.outbound[0]!.id).toBe(1);
    expect(s.inbound[0]!.id).toBe(2);
    expect(s.totalResults).toBe(2);
    const q = mapFareQuote({ IsPriceChanged: true, Results: RESULT }, 't');
    expect(q).toMatchObject({ isPriceChanged: true, isLCC: true, flight: { id: 0, price: 9200 } });
  });

  it('charges the offered fare rounded up to whole rupees', () => {
    expect(chargeRupees(RESULT)).toBe(9201);
    expect(chargeRupees({ Fare: { PublishedFare: 100.01 } })).toBe(101);
  });
});

const pax = (o: Partial<PassengerIn> = {}): PassengerIn => ({
  Title: 'Mr',
  FirstName: 'Ravi',
  LastName: 'Kumar',
  PaxType: 1,
  DateOfBirth: '1990-05-01',
  Gender: 1,
  ContactNo: '+91 98765 43210',
  Email: 'ravi@example.com',
  IsLeadPax: false,
  ...o,
});
const defaults = { travelDate: '2027-01-10', city: 'Delhi', address: 'Delhi' };

describe('passengers', () => {
  const group = [pax({ IsLeadPax: true }), pax({ Title: 'Mrs', FirstName: 'Asha', Gender: 2 }), pax({ Title: 'Miss', FirstName: 'Nila', PaxType: 2, DateOfBirth: '2018-02-02', Gender: 2 })];

  it('fills fares from the quote, not from the client', () => {
    const out = buildPassengers(group.map((p) => ({ ...p, Fare: { BaseFare: 1 } })), RESULT, defaults);
    expect(out[0]!.Fare).toMatchObject({ BaseFare: 3000, Tax: 450, Currency: 'INR' });
    expect(out[2]!.Fare).toMatchObject({ BaseFare: 2000, Tax: 300.5 });
    expect(out[0]).toMatchObject({ DateOfBirth: '1990-05-01T00:00:00', ContactNo: '919876543210', CountryCode: 'IN', City: 'Delhi' });
    expect(paxFare(RESULT, 1).OtherCharges).toBeCloseTo(6.67, 2);
  });

  it('rejects counts that do not match the fare, bad ages, names and missing lead', () => {
    expect(() => buildPassengers(group.slice(0, 2), RESULT, defaults)).toThrow(/number of travellers/);
    expect(() => buildPassengers([group[0]!, group[1]!, { ...group[2]!, DateOfBirth: '2000-01-01' }], RESULT, defaults)).toThrow(/date of birth/);
    expect(() => buildPassengers([{ ...group[0]!, FirstName: 'R4vi' }, group[1]!, group[2]!], RESULT, defaults)).toThrow(/letters/);
    expect(() => buildPassengers([{ ...group[0]!, IsLeadPax: false }, group[1]!, group[2]!], RESULT, defaults)).toThrow(/lead passenger/);
    expect(() => buildPassengers([{ ...group[0]!, ContactNo: '123' }, group[1]!, group[2]!], RESULT, defaults)).toThrow(/contact/);
  });

  it('requires a valid passport and PAN when the fare does', () => {
    const strict = { ...RESULT, IsPassportRequiredAtBook: true, IsPanRequiredAtBook: true };
    expect(() => buildPassengers(group, strict, defaults)).toThrow(/passport/);
    const ok = group.map((p) => ({ ...p, PassportNo: 'z1234567', PassportExpiry: '2030-01-01', PAN: 'abcde1234f' }));
    const out = buildPassengers(ok, strict, defaults);
    expect(out[0]).toMatchObject({ PassportNo: 'Z1234567', PassportExpiry: '2030-01-01T00:00:00', PAN: 'ABCDE1234F' });
    expect(() => buildPassengers(ok.map((p) => ({ ...p, PassportExpiry: '2026-01-01' })), strict, defaults)).toThrow(/beyond the travel date/);
    expect(() => buildPassengers(ok.map((p) => ({ ...p, PAN: 'ABC' })), strict, defaults)).toThrow(/PAN/);
  });

  it('computes ages on the travel date', () => {
    expect(ageOn('2015-01-11', '2027-01-10')).toBe(11);
    expect(ageOn('2015-01-10', '2027-01-10')).toBe(12);
  });
});

describe('SSR selections', () => {
  const ssr = {
    SeatDynamic: [{ SegmentSeat: [{ RowSeats: [{ Seats: [{ Code: '12A', SeatNo: '12A', AvailablityType: 1, Price: 450.5 }, { Code: '12B', SeatNo: '12B', AvailablityType: 2, Price: 300 }] }] }] }],
    MealDynamic: [[{ Code: 'VGML', Description: 'Veg meal', Price: 200 }]],
  };

  it('attaches the airline’s own seat and meal objects and prices them', () => {
    const out: Array<Record<string, unknown>> = [{}];
    const paise = attachSsr(out, [pax({ Seat: { SeatNo: '12A', Price: 1 }, Meal: { Code: 'VGML' } })], ssr);
    expect(paise).toBe(45100 + 20000);
    expect(out[0]!.SeatDynamic).toEqual([{ Code: '12A', SeatNo: '12A', AvailablityType: 1, Price: 450.5 }]);
  });

  it('refuses a taken seat', () => {
    expect(() => attachSsr([{}], [pax({ Seat: { SeatNo: '12B' } })], ssr)).toThrow(/no longer available/);
    expect(findInTree(ssr, (o) => o.SeatNo === '99Z')).toBeNull();
  });
});

describe('TBO vendor helpers', () => {
  it('redacts personal fields and secrets from bodies', () => {
    const r = redactTbo({ TokenId: 'tok', Passengers: [{ FirstName: 'A', LastName: 'B', PassportNo: 'X', Email: 'e', ContactNo: '1', PaxType: 1 }], TraceId: 't' }) as Record<string, unknown>;
    expect(r.TokenId).toBe('[secret]');
    expect(r.TraceId).toBe('t');
    expect((r.Passengers as Array<Record<string, unknown>>)[0]).toEqual({
      FirstName: '[redacted]',
      LastName: '[redacted]',
      PassportNo: '[redacted]',
      Email: '[redacted]',
      ContactNo: '[redacted]',
      PaxType: 1,
    });
  });

  it('caches the token until shortly before the IST day ends', () => {
    // 10:00 IST = 04:30 UTC → 13h45m left.
    expect(tokenTtlSec(new Date('2027-01-10T04:30:00Z'))).toBe(13 * 3600 + 45 * 60);
    expect(tokenTtlSec(new Date('2027-01-10T18:20:00Z'))).toBe(300);
  });
});

describe('hotel mapping (deployed tbo-hotels shape)', () => {
  it('summarises a hotel from its cheapest room', () => {
    const h = mapHotel(
      {
        HotelCode: 1234,
        HotelName: 'Sea View',
        CityName: 'Goa',
        HotelRating: 4,
        HotelFacilities: ['Free WiFi', 'Outdoor pool'],
        Rooms: [
          { BookingCode: 'b1', Name: ['Deluxe'], TotalFare: 5000.4, MealType: 'Room_Only', IsRefundable: false },
          { BookingCode: 'b2', Name: ['Suite'], TotalFare: 8000, MealType: 'BreakFast', IsRefundable: true },
        ],
      },
      1,
    );
    expect(h).toMatchObject({ id: '1234', name: 'Sea View', stars: 4, price: 5000, freeCancel: true, breakfast: true, amenities: ['Wi-Fi', 'Pool'] });
    expect(h.rooms[1]).toMatchObject({ bookingCode: 'b2', name: 'Suite', price: 8000, breakfast: true });
  });
});
