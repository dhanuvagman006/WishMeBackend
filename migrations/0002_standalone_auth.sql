-- mode: standalone
-- Only applied when DB_MODE=standalone. After cutover the database is restored from the Supabase dump, which normally
-- brings `auth.users`, the `anon` / `authenticated` roles and `auth.uid()` with it. This migration creates whatever is
-- missing so that a fresh database (development, tests, or a restore without the auth schema) behaves the same.

create schema if not exists auth;

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    create role service_role nologin noinherit bypassrls;
  end if;
end $$;

-- The subset of GoTrue's auth.users that this server reads and writes.
create table if not exists auth.users (
  instance_id         uuid,
  id                  uuid primary key,
  aud                 varchar(255) default 'authenticated',
  role                varchar(255) default 'authenticated',
  email               varchar(255),
  encrypted_password  varchar(255),
  email_confirmed_at  timestamptz,
  last_sign_in_at     timestamptz,
  raw_app_meta_data   jsonb default '{}'::jsonb,
  raw_user_meta_data  jsonb default '{}'::jsonb,
  created_at          timestamptz default now(),
  updated_at          timestamptz default now(),
  phone               text,
  banned_until        timestamptz,
  deleted_at          timestamptz,
  is_anonymous        boolean not null default false
);
create unique index if not exists users_email_partial_key on auth.users (lower(email)) where deleted_at is null;

-- Supabase's helper functions, reading the claims this server sets per transaction (lib/db.ts runAs).
create or replace function auth.uid() returns uuid language sql stable as $$
  select nullif(coalesce(current_setting('request.jwt.claim.sub', true),
                         current_setting('request.jwt.claims', true)::jsonb ->> 'sub'), '')::uuid
$$;
create or replace function auth.role() returns text language sql stable as $$
  select nullif(coalesce(current_setting('request.jwt.claim.role', true),
                         current_setting('request.jwt.claims', true)::jsonb ->> 'role'), '')::text
$$;
create or replace function auth.jwt() returns jsonb language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb
$$;

grant usage on schema auth to anon, authenticated;
grant execute on function auth.uid(), auth.role(), auth.jwt() to anon, authenticated;
grant usage on schema public to anon, authenticated;
-- Allow the connection role to switch into the API roles (SET LOCAL ROLE in lib/db.ts).
do $$
begin
  execute format('grant anon, authenticated to %I', current_user);
exception when others then
  raise notice 'could not grant api roles to %: %', current_user, sqlerrm;
end $$;
