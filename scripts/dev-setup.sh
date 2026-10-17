#!/usr/bin/env bash
# One-time local database setup for standalone development (docker-compose.dev.yml must be up).
# Loads the Supabase-like app schema from test/fixtures (the same tables the integration tests use), applies
# migrations, then attaches the sign-up trigger that creates a profile for each new auth user, and loads a small
# fictional demo catalogue (scripts/dev-seed.sql).
# Refuses to run twice; pass --reset to drop everything and start over.
set -euo pipefail
cd "$(dirname "$0")/.."

psql() { docker compose -f docker-compose.dev.yml exec -T postgres psql -U postgres -d wishme -v ON_ERROR_STOP=1 -q "$@"; }

if [[ "${1:-}" == "--reset" ]]; then
  psql -c 'drop schema if exists wishme cascade; drop schema if exists auth cascade; drop schema if exists public cascade; create schema public;'
elif [[ "$(psql -tAc "select to_regclass('public.profiles') is not null")" == "t" ]]; then
  echo "Database already set up (use --reset to start over)."
  exit 0
fi

for f in base accounts celebrities content hub; do
  echo "loading test/fixtures/$f.sql"
  psql < "test/fixtures/$f.sql"
done

pnpm -s migrate:dev

psql <<'SQL'
do $$ begin
  if exists (select 1 from pg_proc where proname = 'handle_new_user') then
    drop trigger if exists on_auth_user_created on auth.users;
    create trigger on_auth_user_created after insert on auth.users for each row execute function public.handle_new_user();
  end if;
end $$;
SQL

echo "loading scripts/dev-seed.sql (demo plans, celebrities, occasions)"
psql < scripts/dev-seed.sql
echo "Local database ready."
