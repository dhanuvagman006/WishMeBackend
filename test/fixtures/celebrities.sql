-- Test fixture tables for the celebrities domain. Loaded after base.sql and before migrations.
--
-- Column names, types, defaults, checks, unique keys and foreign keys follow the Supabase audit export of
-- 16 Oct 2026 (schema.sql). Only the columns this server reads or writes are reproduced. The production database also
-- has triggers on these tables that this fixture does not emulate; the domain code relies on them and does not
-- re-implement them (see src/domains/celebrities/*.ts):
--   bookings            booking_commission_trigger (celebrity_commission/platform_fee/TDS, and the celebrity's earning
--                       + available_balance credit on confirmed/completed), referral commission triggers
--   messages            enforce_conversation_limit (message_count, conversation_message_number, closing at the limit),
--                       auto_reply_trigger (calls celebrity-conversation-auto-reply)
--   celebrity_reviews   update_celebrity_rating (celebrities.rating / review_count)
--   celebrity_favorites trigger_celebrity_favorite_referral_commission (L1/L2 referral commission on insert)

do $$ begin
  create type public.service_type as enum ('video_wish', 'image_promotion', 'video_promotion');
exception when duplicate_object then null; end $$;
do $$ begin
  create type public.booking_status as enum ('pending', 'confirmed', 'in_progress', 'completed', 'cancelled', 'video_sent', 'failed');
exception when duplicate_object then null; end $$;

-- celebrities, profiles, platform_settings, wallet_transactions: base.sql; celebrity_wallet_transactions: accounts.sql.

-- ── bookings ────────────────────────────────────────────────────────────────────────────────────────────────
create table if not exists public.bookings (
  id                   uuid primary key default gen_random_uuid(),
  user_id              uuid not null references public.profiles (id),
  celebrity_id         uuid not null references public.celebrities (id),
  service_type         public.service_type not null,
  original_price       int not null,
  discount_amount      int default 0,
  final_price          int not null,
  status               public.booking_status default 'pending',
  message              text,
  instructions         text,
  delivery_date        timestamptz,
  created_at           timestamptz default now(),
  updated_at           timestamptz default now(),
  celebrity_commission int,
  platform_fee         int,
  commission_percentage int,
  delivery_type        text default 'video' check (delivery_type = any (array['video', 'card', 'both'])),
  generated_prompt     text,
  card_url             text,
  video_url            text,
  completed_at         timestamptz,
  recipient_name       text,
  video_file_key       text,
  video_status         text default 'pending',
  generation_status    text default 'pending',
  generation_error     text,
  wishme_payment_id    text
);
create index if not exists idx_bookings_user_created on public.bookings (user_id, created_at desc);
create index if not exists idx_bookings_celebrity_created on public.bookings (celebrity_id, created_at desc);

-- ── subscriptions ("favourites") ────────────────────────────────────────────────────────────────────────────
create table if not exists public.celebrity_favorite_pricing (
  id                              uuid primary key default gen_random_uuid(),
  celebrity_id                    uuid not null unique references public.celebrities (id) on delete cascade,
  price                           int not null default 999,
  referrer_commission_percentage  int not null default 10,
  celebrity_commission_percentage int not null default 5,
  is_enabled                      boolean not null default true,
  created_at                      timestamptz not null default now(),
  updated_at                      timestamptz not null default now()
);

create table if not exists public.celebrity_favorites (
  id                      uuid primary key default gen_random_uuid(),
  user_id                 uuid not null references public.profiles (id) on delete cascade,
  celebrity_id            uuid not null references public.celebrities (id) on delete cascade,
  price_paid              int not null,
  referrer_commission     int default 0,
  celebrity_commission    int default 0,
  status                  text not null default 'active' check (status = any (array['active', 'cancelled'])),
  created_at              timestamptz not null default now(),
  cancelled_at            timestamptz,
  subscription_start_date timestamptz default now(),
  subscription_expires_at timestamptz,
  auto_renew              boolean default false,
  payment_method          text check (payment_method = any (array['wallet', 'razorpay'])),
  unique (user_id, celebrity_id)
);
create index if not exists idx_celebrity_favorites_celebrity on public.celebrity_favorites (celebrity_id);

-- ── catalogue extras ────────────────────────────────────────────────────────────────────────────────────────
create table if not exists public.celebrity_events (
  id           uuid primary key default gen_random_uuid(),
  celebrity_id uuid not null references public.celebrities (id) on delete cascade,
  title        text not null,
  description  text,
  event_date   date not null,
  event_type   text check (event_type = any (array['movie_release', 'award_show', 'concert', 'premiere', 'anniversary', 'birthday', 'other'])),
  location     text,
  is_public    boolean default true,
  created_at   timestamptz default now(),
  updated_at   timestamptz default now()
);

create table if not exists public.celebrity_media (
  id                uuid primary key default gen_random_uuid(),
  celebrity_id      uuid not null references public.celebrities (id) on delete cascade,
  title             text not null,
  description       text,
  media_type        text not null check (media_type = any (array['photo', 'video', 'audio'])),
  file_url          text not null,
  thumbnail_url     text,
  is_promotional    boolean default false,
  is_public         boolean default false,
  created_at        timestamptz default now()
);

create table if not exists public.celebrity_occasions (
  id                  uuid primary key default gen_random_uuid(),
  celebrity_id        uuid not null references public.celebrities (id) on delete cascade,
  occasion_type       text not null check (occasion_type = any (array['birthday', 'anniversary', 'custom'])),
  occasion_name       text not null,
  occasion_date       date not null,
  auto_reply_enabled  boolean not null default true,
  auto_reply_template text,
  is_public           boolean not null default true,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

create table if not exists public.celebrity_reviews (
  id           uuid primary key default gen_random_uuid(),
  celebrity_id uuid not null references public.celebrities (id) on delete cascade,
  booking_id   uuid not null references public.bookings (id) on delete cascade,
  -- The app embeds the reviewer as profiles(first_name,last_name), which needs this key (as in production).
  user_id      uuid not null references public.profiles (id) on delete cascade,
  rating       int not null check (rating >= 1 and rating <= 5),
  review_text  text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create table if not exists public.celebrity_settings (
  id                    uuid primary key default gen_random_uuid(),
  celebrity_id          uuid not null unique references public.celebrities (id) on delete cascade,
  email_notifications   boolean default true,
  booking_alerts        boolean default true,
  auto_accept_bookings  boolean default false,
  created_at            timestamptz default now(),
  updated_at            timestamptz default now(),
  ai_auto_reply_enabled boolean default false,
  auto_reply_enabled    boolean default false
);

-- ── chat ────────────────────────────────────────────────────────────────────────────────────────────────────
create table if not exists public.conversations (
  id                     uuid primary key default gen_random_uuid(),
  user_id                uuid not null references public.profiles (id) on delete cascade,
  celebrity_id           uuid not null,
  last_message_at        timestamptz not null default now(),
  unread_count_user      int not null default 0,
  unread_count_celebrity int not null default 0,
  created_at             timestamptz not null default now(),
  message_count          int default 0,
  is_closed              boolean default false,
  closed_reason          text,
  closed_at              timestamptz,
  constraint conversations_celebrity_id_fkey foreign key (celebrity_id) references public.celebrities (id) on delete cascade,
  unique (user_id, celebrity_id)
);

create table if not exists public.messages (
  id                          uuid primary key default gen_random_uuid(),
  conversation_id             uuid not null references public.conversations (id) on delete cascade,
  sender_type                 text not null check (sender_type = any (array['user', 'celebrity', 'system'])),
  sender_id                   uuid not null references public.profiles (id) on delete cascade,
  message_text                text not null,
  is_ai_generated             boolean not null default false,
  is_read                     boolean not null default false,
  created_at                  timestamptz not null default now(),
  conversation_message_number int
);
create index if not exists idx_messages_conversation on public.messages (conversation_id);

-- ── occasions and loved ones ────────────────────────────────────────────────────────────────────────────────
create table if not exists public.occasions (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  description text,
  date        date not null,
  image_url   text,
  is_active   boolean default true,
  is_featured boolean default false,
  created_at  timestamptz default now(),
  updated_at  timestamptz default now()
);

create table if not exists public.occasion_bookings (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null,
  occasion_id     uuid not null references public.occasions (id) on delete cascade,
  celebrity_id    uuid not null references public.celebrities (id) on delete cascade,
  booking_type    text not null check (booking_type = any (array['video', 'greeting_card'])),
  recipient_name  text not null,
  recipient_email text,
  recipient_phone text,
  message         text not null,
  status          text default 'pending' check (status = any (array['pending', 'processing', 'completed', 'failed'])),
  price           int not null,
  created_at      timestamptz default now(),
  updated_at      timestamptz default now()
);

create table if not exists public.occasion_wishes (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references public.profiles (id) on delete cascade,
  celebrity_id  uuid not null references public.celebrities (id) on delete cascade,
  occasion_id   uuid not null references public.celebrity_occasions (id) on delete cascade,
  message       text not null,
  reply_message text,
  reply_sent_at timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create table if not exists public.loved_ones (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references public.profiles (id) on delete cascade,
  first_name    text not null,
  last_name     text,
  email         text,
  phone         text,
  date_of_birth date,
  relationship  text,
  notes         text,
  import_source text check (import_source = any (array['manual', 'gmail', 'facebook', 'phonebook'])),
  created_at    timestamptz default now(),
  updated_at    timestamptz default now(),
  occasions     jsonb default '[]'::jsonb
);

create table if not exists public.occasion_alerts (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid not null references public.profiles (id) on delete cascade,
  loved_one_id      uuid references public.loved_ones (id) on delete cascade,
  celebrity_id      uuid,
  occasion_type     text not null check (occasion_type = any (array['birthday', 'anniversary', 'wedding', 'festival', 'other', 'custom', 'celebrity_event'])),
  occasion_name     text,
  occasion_date     date not null,
  alert_enabled     boolean default true,
  auto_send_enabled boolean default false,
  alert_days_before int default 3,
  reminder_time     time default '09:00:00',
  created_at        timestamptz default now(),
  updated_at        timestamptz default now(),
  constraint occasion_alerts_celebrity_id_fkey foreign key (celebrity_id) references public.celebrities (id) on delete cascade
);
create unique index if not exists occasion_alerts_unique_person_occasion on public.occasion_alerts (user_id, loved_one_id, occasion_name);

-- ── celebrity_notifications (written by the messaging functions; no app read path, so no policy) ─────────────
create table if not exists public.celebrity_notifications (
  id           uuid primary key default gen_random_uuid(),
  celebrity_id uuid not null references public.celebrities (id) on delete cascade,
  title        text not null,
  message      text not null,
  type         text not null default 'info',
  is_read      boolean default false,
  created_at   timestamptz default now(),
  read_at      timestamptz
);
create index if not exists idx_notifications_celebrity_unread on public.celebrity_notifications (celebrity_id, is_read, created_at desc);
