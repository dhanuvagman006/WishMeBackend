-- Test fixture tables for the hub and voice domains, matching the production DDL from the Supabase audit
-- (schema.sql, 2026-10-16): columns, types, defaults, keys and CHECK constraints. Owner columns hold the AUTH user id
-- (auth.users.id) except user_vapi_voices, which keys on profiles.id like the old vapi-* functions.
-- Loaded after base.sql and before migrations. Use 'create table if not exists' / 'alter table ... add column if not exists'.

create table if not exists public.assistant_settings (
  user_id        uuid primary key,
  assistant_name text not null default 'WishMe Assistant',
  voice          text not null default 'Kore',
  personality    text not null default 'friendly',
  custom_note    text,
  language       text not null default 'auto',
  is_default     boolean not null default false,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  constraint assistant_settings_assistant_name_check check (char_length(assistant_name) >= 1 and char_length(assistant_name) <= 30),
  constraint assistant_settings_custom_note_check check (custom_note is null or char_length(custom_note) <= 300),
  constraint assistant_settings_language_check check (char_length(language) >= 2 and char_length(language) <= 20),
  constraint assistant_settings_personality_check check (char_length(personality) >= 2 and char_length(personality) <= 30),
  constraint assistant_settings_voice_check check (char_length(voice) >= 2 and char_length(voice) <= 40)
);

create table if not exists public.calendar_events (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid not null,
  title            text not null,
  notes            text,
  location         text,
  starts_at        timestamptz not null,
  ends_at          timestamptz,
  all_day          boolean not null default false,
  timezone         text not null default 'Asia/Kolkata',
  recurrence       text not null default 'none',
  recurrence_until date,
  colour           text,
  source           text not null default 'user',
  source_id        uuid,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  constraint calendar_events_end_after_start check (ends_at is null or ends_at >= starts_at),
  constraint calendar_events_location_check check (location is null or char_length(location) <= 300),
  constraint calendar_events_notes_check check (notes is null or char_length(notes) <= 2000),
  constraint calendar_events_recurrence_check check (recurrence = any (array['none', 'daily', 'weekly', 'monthly', 'yearly'])),
  constraint calendar_events_source_check check (source = any (array['user', 'occasion', 'booking'])),
  constraint calendar_events_title_check check (char_length(title) >= 1 and char_length(title) <= 200)
);

create table if not exists public.ai_calls (
  id                   uuid primary key default gen_random_uuid(),
  user_id              uuid not null,
  to_name              text,
  to_phone             text not null,
  purpose              text not null,
  details              text,
  language             text not null default 'english',
  status               text not null default 'queued',
  scheduled_for        timestamptz,
  vapi_call_id         text unique,
  started_at           timestamptz,
  ended_at             timestamptz,
  duration_seconds     integer,
  ended_reason         text,
  transcript           text,
  summary              text,
  outcome              text,
  next_step            text,
  recording_url        text,
  opted_out            boolean not null default false,
  price_paid           numeric not null default 0,
  error_message        text,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  recording_seconds    integer,
  recording_expires_at timestamptz,
  constraint ai_calls_details_check check (details is null or char_length(details) <= 800),
  constraint ai_calls_purpose_check check (char_length(purpose) >= 5 and char_length(purpose) <= 600)
);

create table if not exists public.ai_call_lines (
  id         bigserial primary key,
  call_id    uuid not null references public.ai_calls (id) on delete cascade,
  role       text not null,
  message    text not null,
  seq        integer not null,
  created_at timestamptz not null default now(),
  constraint ai_call_lines_call_id_seq_key unique (call_id, seq),
  constraint ai_call_lines_role_check check (role = any (array['assistant', 'user']))
);

create table if not exists public.reminders (
  id                     uuid primary key default gen_random_uuid(),
  user_id                uuid not null,
  title                  text not null,
  notes                  text,
  due_at                 timestamptz,
  timezone               text not null default 'Asia/Kolkata',
  pin_to_timezone        boolean not null default false,
  lead_minutes           integer not null default 0,
  delivery               text not null default 'notification',
  style                  text not null default 'reminder',
  recurrence             text not null default 'none',
  recurrence_until       date,
  escalate               boolean not null default false,
  escalate_after_minutes integer not null default 3,
  escalate_phone         text,
  status                 text not null default 'pending',
  completed_at           timestamptz,
  event_id               uuid references public.calendar_events (id) on delete cascade,
  call_id                uuid references public.ai_calls (id) on delete set null,
  fired_at               timestamptz,
  acknowledged_at        timestamptz,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  constraint reminders_delivery_check check (delivery = any (array['notification', 'call'])),
  constraint reminders_escalate_after_minutes_check check (escalate_after_minutes >= 2 and escalate_after_minutes <= 60),
  constraint reminders_lead_minutes_check check (lead_minutes >= 0 and lead_minutes <= 20160),
  constraint reminders_notes_check check (notes is null or char_length(notes) <= 2000),
  constraint reminders_recurrence_check check (recurrence = any (array['none', 'daily', 'weekly', 'monthly', 'yearly'])),
  constraint reminders_status_check check (status = any (array['pending', 'done', 'missed', 'cancelled'])),
  constraint reminders_style_check check (style = any (array['alarm', 'reminder', 'quiet'])),
  constraint reminders_title_check check (char_length(title) >= 1 and char_length(title) <= 200)
);

create table if not exists public.user_vapi_voices (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null,
  vapi_voice_id text not null,
  voice_name    text not null,
  created_at    timestamptz not null default now(),
  audio_url     text
);
