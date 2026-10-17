# WishMe backend

The backend for the WishMe app, run on our own VPS instead of hosted Supabase.

It speaks the protocol the app already uses (Supabase Auth, a PostgREST subset, edge functions, Storage and Realtime),
so **the current app connects without a code change**: point its `EXPO_PUBLIC_SUPABASE_URL` at this server. Anything
not migrated yet is forwarded to Supabase, so the switch is safe from day one and each part moves over by
configuration. See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

| | |
| --- | --- |
| Runtime | Node 24, TypeScript, Fastify 5 |
| Data | PostgreSQL 16 (postgres.js), Redis 7 |
| Jobs | BullMQ worker process |
| Edge | Caddy 2 (automatic HTTPS, health-checked load balancing) |
| Media | Backblaze B2 (S3 API) |
| Payments | Razorpay, verified by signature, API cross-check and webhook |

## Quick start (development)

```bash
pnpm install
docker compose -f docker-compose.test.yml up -d   # Postgres :55432, Redis :56379
cp deploy/.env.example .env                        # fill the required values (see src/config/env.ts)
pnpm migrate:dev
pnpm dev
```

Tests: `pnpm test` (unit + integration against the test containers). Typecheck: `pnpm typecheck`.

## Running locally with the phone app (standalone, no Supabase)

`docker-compose.dev.yml` is a persistent, memory-capped Postgres (:55433) and Redis (:56380). With a `.env` in
standalone mode (`DB_MODE=standalone`, `COMPAT_DEFAULT_MODE=local`, `EMAIL_PROVIDER=log`, `DATABASE_URL` and
`REDIS_URL` pointing at those ports, generated `SUPABASE_ANON_KEY` / `SUPABASE_JWT_SECRET` / `AUTH_PEPPER`):

```bash
./scripts/dev-local.sh   # containers, schema on first run (scripts/dev-setup.sh), adb reverse, API on :3000
```

The schema is the app's tables as modelled in `test/fixtures` plus `migrations/`. Build the app with
`EXPO_PUBLIC_SUPABASE_URL=http://localhost:3000` and the same anon key; it reaches this machine through
`adb reverse tcp:3000 tcp:3000`. Sign-up OTP codes appear in the server log. Functions whose vendor is not
configured answer 503.

## Documents

- [ARCHITECTURE.md](docs/ARCHITECTURE.md): how it fits together, request lifecycle, money, scaling, availability
- [SECURITY.md](docs/SECURITY.md): threat model and the controls that answer it
- [APP_SWITCH.md](docs/APP_SWITCH.md): connecting the app, route modes, the order to migrate
- [RUNBOOK.md](docs/RUNBOOK.md): deploy, rollback, backups, restore drill, incidents
- [CUTOVER.md](docs/CUTOVER.md): moving the data off Supabase and switching it off
- [CONTRIBUTING.md](CONTRIBUTING.md): where code goes and the non-negotiable rules
- [docs/adr/](docs/adr/): decision records
- [docs/reference/](docs/reference/): the app's contract inventory and the migration plan
