/**
 * TBO Air results → the `TBOFlight` / `TBOSearchResult` / `TBOFareQuote` shapes services/tboService.ts declares and
 * the flight screens render. Pure functions, unit-tested in test/unit/tbo-*.test.ts.
 */

export interface TboAirport {
  AirportCode?: string;
  AirportName?: string;
  Terminal?: string;
  CityCode?: string;
  CityName?: string;
  CountryCode?: string;
}

export interface TboSegment {
  Baggage?: string;
  CabinBaggage?: string;
  NoOfSeatAvailable?: number;
  Airline?: { AirlineCode?: string; AirlineName?: string; FlightNumber?: string; FareClass?: string };
  Origin?: { Airport?: TboAirport; DepTime?: string };
  Destination?: { Airport?: TboAirport; ArrTime?: string };
  Duration?: number;
  GroundTime?: number;
  Craft?: string;
}

export interface TboFare {
  Currency?: string;
  BaseFare?: number;
  Tax?: number;
  YQTax?: number;
  AdditionalTxnFeeOfrd?: number;
  AdditionalTxnFeePub?: number;
  PGCharge?: number;
  OtherCharges?: number;
  Discount?: number;
  PublishedFare?: number;
  OfferedFare?: number;
  ServiceFee?: number;
  [k: string]: unknown;
}

export interface TboFareBreakdown {
  Currency?: string;
  PassengerType?: number;
  PassengerCount?: number;
  BaseFare?: number;
  Tax?: number;
  YQTax?: number;
  AdditionalTxnFeeOfrd?: number;
  AdditionalTxnFeePub?: number;
  PGCharge?: number;
  [k: string]: unknown;
}

export interface TboResult {
  ResultIndex?: string;
  Source?: number;
  IsLCC?: boolean;
  IsRefundable?: boolean;
  ResultFareType?: string;
  Fare?: TboFare;
  FareBreakdown?: TboFareBreakdown[];
  Segments?: TboSegment[][];
  IsPanRequiredAtBook?: boolean;
  IsPassportRequiredAtBook?: boolean;
  IsGSTMandatory?: boolean;
  IsHoldAllowed?: boolean;
  IsHoldAllowedWithSSR?: boolean;
  FareClassification?: { Type?: string } | string;
  [k: string]: unknown;
}

export interface TBOFlight {
  id: number;
  resultIndex: string;
  traceId: string;
  isLCC: boolean;
  source: number;
  airline: string;
  airlineName: string;
  airlineCode: string;
  flightNumber: string;
  logo: string;
  depart: string;
  arrive: string;
  departTime: string;
  arriveTime: string;
  fromCode: string;
  toCode: string;
  depAirport: string;
  arrAirport: string;
  depTerminal: string;
  arrTerminal: string;
  depCity: string;
  arrCity: string;
  duration: string;
  durationMins: number;
  stops: 0 | 1 | 2;
  layoverAirport?: string;
  layoverMins?: number;
  price: number;
  originalPrice: number;
  baseFare: number;
  tax: number;
  currency: string;
  refundable: boolean;
  fareType: string;
  fareClass: string;
  baggage: string;
  cabinBaggage: string;
  seatsAvailable: number;
  craft: string;
  isPanRequired: boolean;
  isPassportRequired: boolean;
  isHoldAllowed: boolean;
}

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : Number(v) || 0);

/** "2026-11-04T06:05:00" → "06:05" (TBO times are local to the airport, without an offset). */
export function hhmm(iso: string | undefined): string {
  const m = /T(\d{2}):(\d{2})/.exec(iso ?? '');
  return m ? `${m[1]}:${m[2]}` : '';
}

export function formatDuration(mins: number): string {
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

/**
 * The amount charged for a quote, in whole rupees for every passenger: Fare.OfferedFare, which the screens show as
 * the price (`price`), rounded up. ASSUMPTION (owner to confirm): charge the displayed OfferedFare rather than the
 * struck-through PublishedFare.
 */
export function chargeRupees(r: TboResult): number {
  const offered = num(r.Fare?.OfferedFare);
  return Math.ceil(offered > 0 ? offered : num(r.Fare?.PublishedFare));
}

/** Airline marks the deployed function used as `logo` (the screens render them as text). */
const AIRLINE_MARKS: Record<string, string> = { '6E': '🟦', AI: '🔴', UK: '🟪', QP: '🟧', IX: '🟥', SG: '🟨', G8: '🟩' };

/**
 * One itinerary in the deployed function's flat shape. Note its conventions, which the screens depend on:
 * `depart`/`arrive` are "HH:MM", `departTime`/`arriveTime` the full TBO timestamps, `flightNumber` is "6E-2041",
 * `price` is the OfferedFare and `originalPrice` the PublishedFare, both totals for the searched passengers.
 */
export function mapFlight(r: TboResult, traceId: string, id: number): TBOFlight | null {
  const legs = (r.Segments ?? []).flat();
  const first = legs[0];
  if (!first) return null;
  const last = legs[legs.length - 1] ?? first;
  const airline = first.Airline ?? {};
  const fare = r.Fare ?? {};
  const published = Math.round(num(fare.PublishedFare));
  const offered = fare.OfferedFare !== undefined ? Math.round(num(fare.OfferedFare)) : published;
  const durationMins = legs.reduce((s, x) => s + num(x.Duration) + num(x.GroundTime), 0);
  const fc = r.FareClassification;
  const connecting = legs.length > 1 ? legs[1] : undefined;
  const flight: TBOFlight = {
    id,
    resultIndex: String(r.ResultIndex ?? ''),
    traceId,
    isLCC: !!r.IsLCC,
    source: num(r.Source),
    airline: airline.AirlineName ?? '',
    airlineName: airline.AirlineName ?? '',
    airlineCode: airline.AirlineCode ?? '',
    flightNumber: `${airline.AirlineCode ?? ''}-${airline.FlightNumber ?? ''}`,
    logo: AIRLINE_MARKS[airline.AirlineCode ?? ''] ?? '✈️',
    depart: hhmm(first.Origin?.DepTime),
    arrive: hhmm(last.Destination?.ArrTime),
    departTime: first.Origin?.DepTime ?? '',
    arriveTime: last.Destination?.ArrTime ?? '',
    fromCode: first.Origin?.Airport?.AirportCode ?? '',
    toCode: last.Destination?.Airport?.AirportCode ?? '',
    depAirport: first.Origin?.Airport?.AirportCode ?? '',
    arrAirport: last.Destination?.Airport?.AirportCode ?? '',
    depTerminal: first.Origin?.Airport?.Terminal ?? '',
    arrTerminal: last.Destination?.Airport?.Terminal ?? '',
    depCity: first.Origin?.Airport?.CityName ?? '',
    arrCity: last.Destination?.Airport?.CityName ?? '',
    duration: formatDuration(durationMins),
    durationMins,
    stops: Math.min(legs.length - 1, 2) as 0 | 1 | 2,
    price: offered,
    originalPrice: published,
    baseFare: Math.round(num(fare.BaseFare)),
    tax: Math.round(num(fare.Tax)),
    currency: fare.Currency ?? 'INR',
    refundable: !!r.IsRefundable,
    fareType: r.ResultFareType ?? '',
    fareClass: (typeof fc === 'string' ? fc : fc?.Type) ?? '',
    baggage: first.Baggage ?? '',
    cabinBaggage: first.CabinBaggage ?? '',
    seatsAvailable: num(first.NoOfSeatAvailable),
    craft: first.Craft ?? '',
    isPanRequired: !!r.IsPanRequiredAtBook,
    isPassportRequired: !!r.IsPassportRequiredAtBook,
    isHoldAllowed: !!r.IsHoldAllowed,
  };
  if (connecting) {
    // TBO reports the wait on the arriving leg, so the stopover airport is the first leg's destination.
    flight.layoverAirport = first.Destination?.Airport?.AirportCode ?? '';
    flight.layoverMins = num(connecting.GroundTime);
  }
  return flight;
}

export function mapSearch(response: { TraceId?: string; Results?: TboResult[][] }, isReturn: boolean) {
  const traceId = response.TraceId ?? '';
  let counter = 0;
  const groups = (response.Results ?? []).map((g) => g.map((r) => mapFlight(r, traceId, ++counter)).filter((f): f is TBOFlight => !!f));
  const outbound = groups[0] ?? [];
  const inbound = groups[1] ?? [];
  return { traceId, isReturn, outbound, inbound, totalResults: groups.reduce((n, g) => n + g.length, 0) };
}

export function mapFareQuote(response: { TraceId?: string; IsPriceChanged?: boolean; Results?: TboResult }, traceId: string) {
  const r = response.Results ?? {};
  return {
    isPriceChanged: !!response.IsPriceChanged,
    flight: mapFlight(r, traceId, 0),
    fare: (r.Fare ?? {}) as Record<string, unknown>,
    fareBreakdown: (r.FareBreakdown ?? []) as Array<Record<string, unknown>>,
    isPanRequiredAtBook: !!r.IsPanRequiredAtBook,
    isPassportRequiredAtBook: !!r.IsPassportRequiredAtBook,
    isGSTMandatory: !!r.IsGSTMandatory,
    isLCC: !!r.IsLCC,
  };
}
