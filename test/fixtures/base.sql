-- Shared test tables, matching the production Supabase schema (audit export, 16 Oct 2026) for the columns and types
-- this server reads and writes. Money is INTEGER rupees in production. Domain-specific tables live in their own
-- fixture files (accounts.sql, celebrities.sql, content.sql, hub.sql).

create extension if not exists pgcrypto;

create type public.user_role as enum ('user', 'celebrity', 'admin');
create type public.user_plan as enum ('basic', 'premium', 'elite');

create table public.profiles (
  id                            uuid primary key default gen_random_uuid(),
  user_id                       uuid not null unique,
  email                         text not null,
  first_name                    text,
  last_name                     text,
  phone                         text,
  role                          public.user_role not null default 'user',
  plan                          public.user_plan default 'basic',
  avatar_url                    text,
  is_active                     boolean default true,
  referral_code                 text unique,
  referred_by                   uuid,
  created_at                    timestamptz default now(),
  updated_at                    timestamptz default now(),
  address                       text,
  bank_account_number           text,
  bank_name                     text,
  bank_ifsc                     text,
  bank_account_holder_name      text,
  aadhaar_number                text,
  pan_number                    text,
  aadhaar_verified              boolean default false,
  pan_verified                  boolean default false,
  profile_completion_percentage integer default 20,
  pan_document_url              text,
  referral_url                  text,
  wallet_balance                integer default 0,
  is_flagged                    boolean default false,
  referral_4day_reminder_sent   boolean default false
);

create table public.celebrities (
  id                       uuid primary key default gen_random_uuid(),
  profile_id               uuid references public.profiles (id),
  name                     text not null,
  category                 text not null default 'Other',
  bio                      text,
  location                 text,
  rating                   numeric(2, 1) default 0,
  review_count             integer default 0,
  followers                text,
  image_url                text,
  is_verified              boolean default false,
  is_active                boolean default true,
  delivery_time            text default '24 hours',
  created_at               timestamptz default now(),
  updated_at               timestamptz default now(),
  date_of_birth            date,
  anniversary_date         date,
  other_occasions          text,
  social_media             jsonb default '{}'::jsonb,
  commission_percentage    integer default 70,
  avatar_trained           boolean default false,
  verification_status      text default 'pending',
  total_earnings           integer default 0,
  available_balance        integer default 0,
  service_prices           jsonb default '{"general_wish": 5000, "text_message": 2000, "image_promotion": 25000, "video_promotion": 50000}'::jsonb,
  consent_photo_url        text,
  consent_video_url        text,
  consent_status           text default 'pending',
  consent_given_at         timestamptz,
  promotional_image_url    text,
  video_thumbnail_url      text,
  heygen_avatar_id         text,
  heygen_voice_id          text,
  vapi_voice_id            text,
  voice_call_price         integer default 500,
  vapi_phone_id            text,
  webhook_url              text,
  video_generation_provider text not null default 'heygen',
  elevenlabs_professional_voice_id text,
  base_video_celebratory_key text,
  base_video_festive_key   text,
  base_video_heartfelt_key text,
  base_video_traditional_key text
);

create table public.plans (
  id                          uuid primary key default gen_random_uuid(),
  name                        text not null unique,
  price                       integer not null,
  original_price              integer,
  discount_percentage         integer default 0,
  features                    jsonb default '[]'::jsonb,
  referral_commission_l1      integer default 0,
  referral_commission_l2      integer default 0,
  service_discount_percentage integer default 0,
  is_popular                  boolean default false,
  is_active                   boolean default true,
  created_at                  timestamptz default now(),
  updated_at                  timestamptz default now()
);

create table public.wallet_transactions (
  id                     uuid primary key default gen_random_uuid(),
  user_id                uuid not null,
  transaction_type       text not null,
  amount                 integer not null,
  status                 text not null default 'pending',
  payment_method         text,
  payment_screenshot_url text,
  transaction_details    jsonb,
  admin_note             text,
  processed_by           uuid,
  processed_at           timestamptz,
  created_at             timestamptz default now(),
  updated_at             timestamptz default now(),
  description            text,
  constraint wallet_transactions_payment_method_check
    check (payment_method = any (array['upi', 'bank_transfer', 'online', 'admin', 'wallet', 'razorpay'])),
  constraint wallet_transactions_status_check
    check (status = any (array['pending', 'approved', 'rejected', 'completed'])),
  constraint wallet_transactions_transaction_type_check
    check (transaction_type = any (array['deposit', 'withdrawal', 'admin_credit', 'music_generation', 'music_download',
      'greeting_card_generation', 'celebrity_subscription', 'ugc_video', 'image_promotion', 'booking',
      'referral_commission', 'earning', 'favorite_subscription', 'photo_wish', 'celebrity_call', 'voice_call',
      'plan_upgrade', 'service_payment', 'debit']))
);

create table public.payment_transactions (
  id                   uuid primary key default gen_random_uuid(),
  wishme_payment_id    text not null,
  razorpay_payment_id  text,
  razorpay_order_id    text,
  booking_id           uuid,
  music_generation_id  uuid,
  voice_call_id        uuid,
  greeting_card_id     uuid,
  photo_wish_id        uuid,
  image_promotion_id   uuid,
  wish_order_id        uuid,
  user_id              uuid,
  amount               integer not null,
  currency             text default 'INR',
  payment_method       text not null,
  status               text default 'completed',
  service_type         text,
  description          text,
  paid_at              timestamptz default now(),
  created_at           timestamptz default now()
);

create table public.platform_settings (
  id             uuid primary key default gen_random_uuid(),
  setting_key    text not null unique,
  setting_value  text not null,
  description    text,
  created_at     timestamptz default now(),
  updated_at     timestamptz default now()
);

-- Production's handle_new_user (on_auth_user_created): a profile with a generated referral code. The trigger itself is
-- attached by test/helpers.ts once migrations have created auth.users.
create or replace function public.generate_referral_code() returns text language sql volatile as $$
  select upper(substr(md5(gen_random_uuid()::text), 1, 8))
$$;

create or replace function public.handle_new_user() returns trigger language plpgsql security definer
set search_path to 'public' as $$
begin
  insert into public.profiles (user_id, email, referral_code, first_name, last_name)
  values (new.id, new.email, public.generate_referral_code(),
          coalesce(new.raw_user_meta_data ->> 'first_name', ''), coalesce(new.raw_user_meta_data ->> 'last_name', ''));
  return new;
end $$;
