-- Test fixture tables for the accounts domain, matching the real Supabase definitions (audit export of 16 Oct 2026,
-- schema.sql): same column names, types, NOT NULL, defaults and checks. Foreign keys to auth.users are omitted because
-- auth.users is created by migrations after the fixtures load.
-- Loaded after base.sql and before migrations. Use 'create table if not exists' / 'alter table ... add column if not exists'.
-- Note: profiles, plans, wallet_transactions, payment_transactions and platform_settings live in base.sql; in the real
-- schema their amounts are integer rupees and platform_settings.setting_value is text.

create table if not exists public.bank_details (
  id                   uuid primary key default gen_random_uuid(),
  user_id              uuid not null,
  bank_name            text not null,
  account_holder_name  text not null,
  account_number       text not null,
  ifsc_code            text not null,
  account_type         text default 'savings',
  is_default           boolean default false,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);

create table if not exists public.payout_requests (
  id                   uuid primary key default gen_random_uuid(),
  celebrity_id         uuid not null references public.celebrities (id),
  profile_id           uuid not null references public.profiles (id),
  requested_amount     integer not null,
  bank_account_number  text not null,
  bank_name            text not null,
  ifsc_code            text not null,
  account_holder_name  text not null,
  status               text not null default 'pending',
  admin_notes          text,
  requested_at         timestamptz not null default now(),
  processed_at         timestamptz,
  processed_by         uuid references public.profiles (id)
);

create table if not exists public.referral_transactions (
  id                 uuid primary key default gen_random_uuid(),
  referrer_id        uuid not null references public.profiles (id),
  referred_id        uuid not null references public.profiles (id),
  booking_id         uuid,
  commission_amount  integer not null,
  commission_level   integer not null,
  status             text default 'pending',
  created_at         timestamptz default now(),
  order_type         text
);

create table if not exists public.celebrity_wallet_transactions (
  id                     uuid primary key default gen_random_uuid(),
  celebrity_id           uuid not null references public.celebrities (id) on delete cascade,
  booking_id             uuid,
  transaction_type       text not null,
  amount                 integer not null,
  commission_percentage  integer,
  platform_fee           integer,
  description            text,
  status                 text default 'pending',
  created_at             timestamptz default now(),
  processed_at           timestamptz,
  tds_percentage         integer default 0,
  tds_amount             integer default 0,
  gross_amount           integer,
  order_type             text,
  constraint celebrity_wallet_transactions_status_check check (status = any (array['pending', 'completed', 'failed'])),
  constraint celebrity_wallet_transactions_transaction_type_check check (transaction_type = any (array['earning', 'withdrawal',
    'bonus', 'penalty', 'favorite_subscription', 'ugc_commission', 'image_promotion_commission', 'video_promotion_commission']))
);

create table if not exists public.push_tokens (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null,
  token         text not null unique,
  platform      text not null,
  created_at    timestamptz not null default now(),
  last_seen_at  timestamptz not null default now(),
  constraint push_tokens_platform_check check (platform = any (array['android', 'ios', 'web']))
);

create table if not exists public.celebrity_applications (
  id                    uuid primary key default gen_random_uuid(),
  first_name            text not null,
  last_name             text not null,
  email                 text not null,
  phone                 text not null,
  date_of_birth         date,
  stage_name            text not null,
  category              text,
  bio                   text not null,
  achievements          text,
  portfolio_link        text,
  social_media          jsonb default '{}'::jsonb,
  status                text not null default 'pending',
  admin_notes           text,
  applied_at            timestamptz default now(),
  reviewed_at           timestamptz,
  reviewed_by           uuid,
  created_celebrity_id  uuid references public.celebrities (id),
  created_at            timestamptz default now(),
  updated_at            timestamptz default now(),
  constraint celebrity_applications_status_check check (status = any (array['pending', 'approved', 'rejected']))
);

create table if not exists public.celebrity_categories (
  id           uuid primary key default gen_random_uuid(),
  name         text not null unique,
  description  text,
  is_active    boolean default true,
  created_at   timestamptz default now(),
  updated_at   timestamptz default now()
);
