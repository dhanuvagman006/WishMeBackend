-- Test fixture tables for the content domain. Columns, types, defaults and CHECK constraints match the production
-- Supabase schema (audit export, 16 Oct 2026). Loaded after base.sql and celebrities.sql, before migrations.
-- Use 'create table if not exists' / 'alter table ... add column if not exists'.

create table if not exists public.wish_celebrity_orders (
  id                         uuid primary key default gen_random_uuid(),
  user_id                    uuid not null references public.profiles (id) on delete cascade,
  celebrity_id               uuid not null references public.celebrities (id) on delete cascade,
  occasion_type              text not null,
  message                    text not null,
  card_url                   text,
  card_prompt                text,
  reference_image_url        text,
  status                     text default 'pending',
  created_at                 timestamptz default now(),
  updated_at                 timestamptz default now(),
  generated_card_text        text,
  completed_at               timestamptz,
  recipient_name             text,
  payment_status             text default 'pending',
  amount_paid                integer,
  payment_method             text,
  razorpay_order_id          text,
  razorpay_payment_id        text,
  user_uploaded_card_url     text,
  user_uploaded_video_url    text,
  card_generation_type       text default 'ai',
  generation_attempts        integer default 0,
  generated_card_image_url   text,
  card_approved              boolean default false,
  greeting_text              text,
  discount_percentage        integer default 0,
  discount_amount            integer default 0,
  wishme_payment_id          text,
  style_reference_image_url  text,
  constraint check_generation_attempts check (generation_attempts <= 3),
  constraint wish_celebrity_orders_status_check check (status = any (array['pending', 'generated', 'sent', 'failed']))
);

create table if not exists public.wish_friend_orders (
  id                   uuid primary key default gen_random_uuid(),
  user_id              uuid not null references public.profiles (id) on delete cascade,
  order_type           text not null,
  celebrity_id         uuid not null references public.celebrities (id),
  recipient_name       text not null,
  occasion             text not null,
  relationship         text,
  tone                 text,
  prompt               text not null,
  original_price       integer not null default 0,
  discount_amount      integer not null default 0,
  price_paid           integer not null default 0,
  status               text not null default 'pending',
  video_url            text,
  video_file_key       text,
  admin_notes          text,
  completed_at         timestamptz,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  aspect_ratio         text,
  hook_style           text,
  call_to_action       text,
  reference_image_url  text,
  order_details        jsonb not null default '{}'::jsonb,
  constraint wish_friend_orders_details_size check (pg_column_size(order_details) < 20000),
  constraint wish_friend_orders_order_type_check check (order_type = any (array['video_wish', 'ugc_video'])),
  constraint wish_friend_orders_status_check check (status = any (array['pending', 'processing', 'completed', 'rejected']))
);

-- user_id is the auth user id here (FK to auth.users in production; auth.users is created by migration 0002, after
-- this file, so the FK is omitted in the fixture).
create table if not exists public.ugc_ads (
  id                   uuid primary key default gen_random_uuid(),
  user_id              uuid not null,
  product_name         text not null,
  product_description  text,
  product_image_url    text not null,
  script               text,
  video_url            text,
  thumbnail_url        text,
  status               text not null default 'pending',
  avatar_id            text,
  avatar_name          text,
  voice_id             text,
  heygen_video_id      text,
  generation_error     text,
  price_paid           numeric(10, 2) default 0,
  aspect_ratio         text default '9:16',
  video_style          text default 'ugc',
  prompt               text,
  hook_style           text,
  call_to_action       text,
  background_type      text default 'product',
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  completed_at         timestamptz,
  celebrity_id         uuid references public.celebrities (id) on delete set null,
  admin_notes          text,
  video_file_key       text,
  order_details        jsonb not null default '{}'::jsonb,
  constraint ugc_ads_status_check check (status = any (array['pending', 'pending_approval', 'script_generating', 'video_generating',
    'video_processing', 'processing', 'completed', 'failed']))
);

create table if not exists public.image_promotions (
  id                   uuid primary key default gen_random_uuid(),
  user_id              uuid not null references public.profiles (id) on delete cascade,
  celebrity_id         uuid not null references public.celebrities (id) on delete cascade,
  concept              text not null,
  branding_details     text,
  generated_image_url  text,
  status               text not null default 'pending',
  price_paid           integer not null,
  error_message        text,
  created_at           timestamptz not null default now(),
  completed_at         timestamptz,
  constraint image_promotions_status_check check (status = any (array['pending', 'processing', 'completed', 'failed']))
);

create table if not exists public.photo_wishes (
  id                  uuid primary key default gen_random_uuid(),
  user_id             uuid not null references public.profiles (id) on delete cascade,
  original_image_url  text not null,
  edited_image_url    text,
  occasion            text not null,
  recipient_name      text not null,
  wish_message        text not null,
  sender_name         text,
  text_style          text default 'elegant',
  amount_charged      numeric default 0,
  status              text default 'pending',
  error_message       text,
  created_at          timestamptz not null default now(),
  completed_at        timestamptz
);

create table if not exists public.greeting_card_generations (
  id                      uuid primary key default gen_random_uuid(),
  user_id                 uuid not null references public.profiles (id) on delete cascade,
  original_prompt         text not null,
  refined_prompt          text,
  prompt_refinement_used  boolean default false,
  reference_image_url     text,
  reference_image_source  text,
  generated_image_url     text,
  occasion_name           text not null,
  recipient_name          text not null,
  greeting_text           text,
  status                  text default 'pending',
  error_message           text,
  saved_to_library        boolean default false,
  created_at              timestamptz default now(),
  completed_at            timestamptz,
  amount_charged          integer not null default 2,
  wishme_payment_id       text,
  constraint greeting_card_generations_reference_image_source_check
    check (reference_image_source = any (array['upload', 'library', 'camera', 'none'])),
  constraint greeting_card_generations_status_check check (status = any (array['pending', 'processing', 'completed', 'failed']))
);

create table if not exists public.library_items (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null references public.profiles (id) on delete cascade,
  kind           text not null,
  source_type    text not null,
  source_id      uuid not null,
  title          text not null,
  subtitle       text,
  media_url      text,
  file_key       text,
  thumbnail_url  text,
  created_at     timestamptz not null default now(),
  constraint library_items_unique_source unique (user_id, source_type, source_id),
  constraint library_items_has_media check (media_url is not null or file_key is not null),
  constraint library_items_kind_check check (kind = any (array['image', 'video']))
);

do $$ begin
  create type public.music_generation_type as enum ('with_lyrics', 'instrumental');
exception when duplicate_object then null; end $$;
do $$ begin
  create type public.music_generation_status as enum ('pending', 'processing', 'completed', 'failed');
exception when duplicate_object then null; end $$;

create table if not exists public.music_generations (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid not null references public.profiles (id) on delete cascade,
  song_title       text not null,
  genre            text,
  mood             text,
  prompt           text,
  lyrics           text,
  song_url         text,
  download_url     text,
  generation_type  public.music_generation_type not null default 'with_lyrics',
  status           public.music_generation_status not null default 'pending',
  credits_used     integer not null default 1,
  api_task_id      text,
  error_message    text,
  duration         integer,
  created_at       timestamptz not null default now(),
  completed_at     timestamptz,
  price_paid       integer,
  wishme_payment_id text
);

create table if not exists public.tts_generations (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references public.profiles (id) on delete cascade,
  text          text not null,
  voice_id      text not null,
  voice_name    text,
  audio_url     text,
  status        text not null default 'completed',
  credits_used  integer default 15,
  created_at    timestamptz not null default now()
);

create table if not exists public.sound_effect_generations (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid not null references public.profiles (id) on delete cascade,
  description       text not null,
  duration_seconds  integer default 5,
  audio_url         text,
  status            text not null default 'completed',
  credits_used      integer default 10,
  created_at        timestamptz not null default now()
);

create table if not exists public.voice_conversion_generations (
  id                  uuid primary key default gen_random_uuid(),
  user_id             uuid not null references public.profiles (id) on delete cascade,
  original_file_name  text,
  target_voice_id     text not null,
  target_voice_name   text,
  audio_url           text,
  status              text not null default 'completed',
  credits_used        integer default 25,
  created_at          timestamptz not null default now()
);

create table if not exists public.audio_isolation_generations (
  id                  uuid primary key default gen_random_uuid(),
  user_id             uuid not null references public.profiles (id) on delete cascade,
  original_file_name  text,
  audio_url           text,
  status              text not null default 'completed',
  credits_used        integer default 20,
  created_at          timestamptz not null default now()
);

create table if not exists public.image_music_generations (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid not null references public.profiles (id) on delete cascade,
  image_url         text,
  audio_url         text,
  vocal_url         text,
  video_url         text,
  description       text,
  lyrics            text,
  genre             text,
  mood              text,
  duration_seconds  integer,
  has_vocals        boolean default false,
  amount_charged    numeric default 120,
  status            text default 'completed',
  created_at        timestamptz not null default now(),
  completed_at      timestamptz
);

create table if not exists public.voice_call_wishes (
  id                     uuid primary key default gen_random_uuid(),
  user_id                uuid not null references public.profiles (id) on delete cascade,
  recipient_name         text not null,
  recipient_phone        text not null,
  occasion               text not null,
  vapi_voice_id          text not null,
  vapi_voice_name        text,
  vapi_call_id           text,
  call_status            text default 'pending',
  call_duration_seconds  integer,
  price_paid             integer not null default 100,
  error_message          text,
  created_at             timestamptz not null default now(),
  completed_at           timestamptz,
  celebrity_id           uuid references public.celebrities (id),
  sender_name            text,
  scheduled_at           timestamptz,
  disconnect_reason      text,
  call_transcript        text,
  webhook_payload        jsonb,
  call_config            jsonb
);

-- Owned by the celebrities domain (celebrities.sql creates them first); repeated here only so this file also works
-- alone. generate-greeting-card / generate-occasion-video write ai_generated_content, greeting_card_url and status.
create table if not exists public.occasion_bookings (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid not null references public.profiles (id),
  occasion_id      uuid not null,
  celebrity_id     uuid not null references public.celebrities (id) on delete cascade,
  booking_type     text not null,
  recipient_name   text not null,
  recipient_email  text,
  recipient_phone  text,
  message          text not null,
  status           text default 'pending',
  price            integer not null default 0,
  created_at       timestamptz default now(),
  updated_at       timestamptz default now()
);
alter table public.occasion_bookings add column if not exists ai_generated_content text;
alter table public.occasion_bookings add column if not exists ai_video_url text;
alter table public.occasion_bookings add column if not exists greeting_card_url text;

create table if not exists public.celebrity_favorites (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null,
  celebrity_id  uuid not null,
  price_paid    integer not null default 0,
  status        text not null default 'active',
  created_at    timestamptz not null default now()
);
