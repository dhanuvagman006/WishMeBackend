-- Travel bookings this server paid for (TBO flights and hotels): one row per attempt, created in the same transaction
-- as the wallet debit. States and transitions are documented in src/domains/travel/bookings.ts. `summary` holds
-- non-personal facts only (route, airline, fare, ticket numbers); passenger details stay with TBO.

create table if not exists wishme.travel_bookings (
  id              uuid primary key default gen_random_uuid(),
  kind            text not null check (kind in ('flight', 'hotel')),
  user_id         uuid not null,
  profile_id      uuid not null,
  status          text not null check (status in ('charged', 'booked', 'ticketing', 'confirmed', 'refunded', 'needs_review')),
  amount_paise    bigint not null check (amount_paise > 0),
  currency        text not null default 'INR',
  ledger_id       uuid,
  trace_id        text,
  result_index    text,
  is_lcc          boolean,
  pnr             text,
  tbo_booking_id  text,
  confirmation_no text,
  summary         jsonb not null default '{}'::jsonb,
  error           text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index if not exists travel_bookings_profile_idx on wishme.travel_bookings (profile_id, created_at desc);
create index if not exists travel_bookings_status_idx on wishme.travel_bookings (status, updated_at);
create unique index if not exists travel_bookings_tbo_idx
  on wishme.travel_bookings (kind, tbo_booking_id) where tbo_booking_id is not null;

revoke all on wishme.travel_bookings from public;
