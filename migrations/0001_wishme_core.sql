-- WishMe backend core tables. Everything here lives in the `wishme` schema, which this server owns.
-- Additive only: safe to run against the shared Supabase database (DB_MODE=shared).

create schema if not exists wishme;
create extension if not exists pgcrypto;

-- ── Sessions ────────────────────────────────────────────────────────────────────────────────────────────────
-- Refresh tokens are stored only as keyed hashes. A family is one login; rotation chains tokens within it, and
-- presenting a revoked token outside the grace window revokes the whole family (theft detection).
create table if not exists wishme.refresh_tokens (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null,
  family_id      uuid not null,
  token_hash     text not null unique,
  created_at     timestamptz not null default now(),
  expires_at     timestamptz not null,
  revoked_at     timestamptz,
  revoked_reason text,
  replaced_by    uuid,
  user_agent     text,
  ip             inet
);
create index if not exists refresh_tokens_user_idx on wishme.refresh_tokens (user_id);
create index if not exists refresh_tokens_family_idx on wishme.refresh_tokens (family_id);
create index if not exists refresh_tokens_expiry_idx on wishme.refresh_tokens (expires_at);

-- ── One-time codes ──────────────────────────────────────────────────────────────────────────────────────────
-- A verified sign-up challenge authorises exactly one following /auth/v1/signup for the same email, inside a window.
create table if not exists wishme.otp_challenges (
  id           uuid primary key default gen_random_uuid(),
  email        text not null,
  purpose      text not null check (purpose in ('signup', 'reset')),
  code_hash    text not null,
  attempts     int not null default 0,
  created_at   timestamptz not null default now(),
  expires_at   timestamptz not null,
  verified_at  timestamptz,
  consumed_at  timestamptz,
  ip           inet
);
create index if not exists otp_challenges_lookup_idx on wishme.otp_challenges (email, purpose, created_at desc);

-- Password reset links (single use, short lived).
create table if not exists wishme.password_resets (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null,
  token_hash  text not null unique,
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null,
  used_at     timestamptz,
  ip          inet
);

-- ── Money ───────────────────────────────────────────────────────────────────────────────────────────────────
-- Razorpay orders created by this server. The amount is decided here, never by the client.
create table if not exists wishme.payment_orders (
  razorpay_order_id   text primary key,
  user_id             uuid not null,
  profile_id          uuid,
  purpose             text not null,
  amount_paise        bigint not null check (amount_paise > 0),
  currency            text not null default 'INR',
  receipt             text,
  notes               jsonb not null default '{}'::jsonb,
  status              text not null default 'created' check (status in ('created', 'paid', 'fulfilled', 'failed')),
  razorpay_payment_id text unique,
  wishme_payment_id   text unique,
  fulfilment          jsonb,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  fulfilled_at        timestamptz
);
create index if not exists payment_orders_user_idx on wishme.payment_orders (user_id, created_at desc);

-- Every movement of money, append-only. Positive = credit, negative = debit. The idempotency key makes retries,
-- duplicate webhooks and double taps harmless.
create table if not exists wishme.ledger_entries (
  id                  uuid primary key default gen_random_uuid(),
  account_kind        text not null check (account_kind in ('user_wallet', 'celebrity_earnings')),
  account_id          uuid not null,
  -- 0 is a record-only movement (e.g. a plan paid with Razorpay: history row, no wallet effect).
  amount_paise        bigint not null,
  kind                text not null,
  idempotency_key     text not null unique,
  reference_type      text,
  reference_id        text,
  public_row_id       text,
  balance_after_paise bigint,
  metadata            jsonb not null default '{}'::jsonb,
  created_by          text not null,
  created_at          timestamptz not null default now()
);
create index if not exists ledger_account_idx on wishme.ledger_entries (account_kind, account_id, created_at desc);
create index if not exists ledger_reference_idx on wishme.ledger_entries (reference_type, reference_id);

-- Raw Razorpay webhook deliveries, de-duplicated by Razorpay's event id.
create table if not exists wishme.razorpay_events (
  event_id      text primary key,
  event         text not null,
  payload       jsonb not null,
  received_at   timestamptz not null default now(),
  processed_at  timestamptz,
  error         text
);

-- Generic idempotency for non-ledger side effects (e.g. "send this wish once").
create table if not exists wishme.idempotency_keys (
  key         text primary key,
  scope       text not null,
  status      int,
  response    jsonb,
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null
);

-- ── Operations ──────────────────────────────────────────────────────────────────────────────────────────────
create table if not exists wishme.audit_log (
  id          bigserial primary key,
  at          timestamptz not null default now(),
  actor       text not null,
  action      text not null,
  subject     text,
  ip          inet,
  request_id  text,
  details     jsonb not null default '{}'::jsonb
);
create index if not exists audit_log_at_idx on wishme.audit_log (at desc);
create index if not exists audit_log_actor_idx on wishme.audit_log (actor, at desc);

-- Transactional outbox: rows written in the same transaction as the change, published to the job queue after commit
-- by the worker, so a crash between "commit" and "enqueue" never loses a notification.
create table if not exists wishme.outbox (
  id            bigserial primary key,
  topic         text not null,
  payload       jsonb not null,
  created_at    timestamptz not null default now(),
  available_at  timestamptz not null default now(),
  processed_at  timestamptz,
  attempts      int not null default 0,
  last_error    text
);
create index if not exists outbox_pending_idx on wishme.outbox (available_at) where processed_at is null;

-- The schema is not reachable through Supabase's PostgREST or Realtime (no grants to anon/authenticated).
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on schema wishme from anon';
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'revoke all on schema wishme from authenticated';
  end if;
end $$;
