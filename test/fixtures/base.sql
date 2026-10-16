-- Test approximation of the Supabase `public` tables shared by every domain. The real schema arrives with the audit
-- dump; columns here are the ones the app reads and writes (docs/BACKEND_CONTRACT_INVENTORY.md in the app repository).
-- Domain-specific tables live in their own fixture files (accounts.sql, celebrities.sql, content.sql, hub.sql).

create extension if not exists pgcrypto;

create table public.profiles (
  id                            uuid primary key default gen_random_uuid(),
  user_id                       uuid unique,
  first_name                    text,
  last_name                     text,
  email                         text,
  phone                         text,
  role                          text default 'user',
  wallet_balance                numeric(12, 2) not null default 0,
  member_since                  date default current_date,
  referral_code                 text unique,
  referral_url                  text,
  referred_by                   uuid,
  plan                          text,
  address                       text,
  avatar_url                    text,
  aadhaar_number                text,
  pan_number                    text,
  aadhaar_verified              boolean default false,
  pan_verified                  boolean default false,
  pan_document_url              text,
  bank_name                     text,
  bank_account_number           text,
  bank_ifsc                     text,
  bank_account_holder_name      text,
  profile_completion_percentage int default 20,
  created_at                    timestamptz not null default now(),
  updated_at                    timestamptz not null default now()
);

create table public.celebrities (
  id                 uuid primary key default gen_random_uuid(),
  profile_id         uuid references public.profiles (id),
  name               text not null,
  category           text,
  bio                text,
  image_url          text,
  available_balance  numeric(12, 2) not null default 0,
  rating             numeric(3, 2) default 0,
  review_count       int default 0,
  consent_status     text default 'pending',
  status             text default 'approved',
  is_verified        boolean default true,
  is_active          boolean default true,
  service_prices     jsonb default '{}'::jsonb,
  social_media       jsonb default '{}'::jsonb,
  created_at         timestamptz not null default now()
);

create table public.plans (
  id                          uuid primary key default gen_random_uuid(),
  name                        text not null unique,
  price                       numeric(12, 2) not null,
  original_price              numeric(12, 2),
  service_discount_percentage numeric(5, 2) default 0,
  referral_commission_l1      numeric(5, 2),
  referral_commission_l2      numeric(5, 2),
  is_active                   boolean default true,
  features                    jsonb default '[]'::jsonb,
  created_at                  timestamptz not null default now()
);

create table public.wallet_transactions (
  id                  uuid primary key default gen_random_uuid(),
  user_id             uuid not null,
  transaction_type    text not null,
  amount              numeric(12, 2) not null,
  status              text not null default 'completed',
  payment_method      text,
  description         text,
  transaction_details jsonb default '{}'::jsonb,
  reference_id        text,
  created_at          timestamptz not null default now()
);

create table public.payment_transactions (
  id                   uuid primary key default gen_random_uuid(),
  wishme_payment_id    text,
  user_id              uuid,
  amount               numeric(12, 2),
  payment_method       text,
  service_type         text,
  razorpay_payment_id  text,
  razorpay_order_id    text,
  booking_id           uuid,
  photo_wish_id        uuid,
  image_promotion_id   uuid,
  description          text,
  status               text,
  paid_at              timestamptz,
  created_at           timestamptz not null default now()
);

create table public.platform_settings (
  id             uuid primary key default gen_random_uuid(),
  setting_key    text unique not null,
  setting_value  jsonb,
  updated_at     timestamptz default now()
);

-- Emulates Supabase's on_auth_user_created trigger: a profile with its own referral code for every new auth user.
create or replace function public.handle_new_user() returns trigger language plpgsql security definer as $$
begin
  insert into public.profiles (user_id, email, first_name, last_name, phone, role, referral_code)
  values (
    new.id,
    new.email,
    new.raw_user_meta_data ->> 'first_name',
    new.raw_user_meta_data ->> 'last_name',
    new.raw_user_meta_data ->> 'phone',
    case when new.raw_user_meta_data ->> 'role' = 'celebrity_pending' then 'user' else coalesce(new.raw_user_meta_data ->> 'role', 'user') end,
    upper(substr(md5(new.id::text), 1, 8))
  );
  return new;
end $$;
