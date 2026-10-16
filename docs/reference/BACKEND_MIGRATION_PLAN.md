# WishMe backend migration plan: hosted Supabase to the owner's VPS

Status: proposal, 16 Oct 2026. Nothing here has been built yet. Effort figures assume one experienced
full-stack TypeScript developer and are ranges, not commitments; they get firmer after phase A, because the
edge-function source and the database schema are not in this repository yet.

Companion documents:

- [BACKEND_CONTRACT_INVENTORY.md](BACKEND_CONTRACT_INVENTORY.md) lists every endpoint the app calls today
  (47 tables, 6 RPCs, 46 edge functions, 6 storage buckets, 8 realtime channels, the Sarvam relay), with the
  calling files and the fields the app relies on.
- [scripts/supabase-audit](../scripts/supabase-audit/README.md) exports the Supabase project (schema, RLS policies,
  SQL functions, data, buckets, edge-function source) once the owner logs in.
- [PROJECT_REPORT.md](../PROJECT_REPORT.md) section 5 describes the app side.

---

## 1. Goals, non-goals and the shape of the plan

**Goals**

1. Run the whole backend on infrastructure the owner controls, with no dependency on Supabase.
2. Move money logic to the server. Today the phone inserts `wallet_transactions` and `payment_transactions`,
   computes prices and fees, and PATCHes balances and order payment states. After the migration the phone
   only asks; the server prices, charges, credits and records.
3. Keep the app working at every step. Screens move one domain at a time and can be flipped back.
4. Keep Backblaze B2 for media and Razorpay for payments, with Razorpay webhooks verified on the server.

**Non-goals**

- Rewriting screens. The new API returns the row shapes the screens already parse; cleanup comes later.
- Changing third-party vendors (ElevenLabs, Gemini, Sarvam, Vapi, TBO, HeyGen stay).
- Making the mock services real (hotels, buses and bills use static data and simulated payments today).

**The shape: move compute first, data last.** The cheapest safe strangler keeps **one database** during the
transition. The new API on the VPS connects to the existing Supabase Postgres, so the old edge functions, the
old PostgREST endpoints and the new API all see the same rows. Each phase moves one domain's *endpoints* to the
VPS. Only phase I moves the *data*, in one rehearsed maintenance window, after which Supabase is switched off.
This avoids dual writes, two-way sync and split-brain balances, which are the usual ways a migration like this
loses money.

The VPS gets its own Postgres in phase B anyway: it is the staging database, the restore-rehearsal target, and the
production database from phase I on.

```text
           today                         phases C to H                           after phase I
  ┌───────┐                      ┌───────┐                                 ┌───────┐
  │  app  │──► Supabase          │  app  │──► VPS API ──┐                  │  app  │──► VPS API ──► VPS Postgres
  └───────┘   (PostgREST,        └───┬───┘              ├─► Supabase       └───────┘     │
               Auth, Edge fns,       └──► Supabase ─────┘   Postgres                       └─► Redis, B2, vendors
               Realtime, Storage)        (domains not yet moved)  (one database)
```

---

## 2. Target architecture on the VPS

### 2.1 Components

| Component | Choice | Why |
| --- | --- | --- |
| Reverse proxy and TLS | **Caddy 2** | Automatic Let's Encrypt certificates and renewal, HTTP/2 and WebSocket proxying with a ten-line config. nginx + certbot works too but needs more moving parts. |
| HTTP API | **Node 24 + TypeScript, Express 5**, Zod, OpenAPI via `lib/api-spec` + orval | The scaffold in `artifacts/api-server` and `lib/*` already wires Express 5, Drizzle, Zod schemas generated from OpenAPI, and a typed client. See 2.2 for why not Fastify or Hono. |
| WebSocket service | Same codebase, separate process, `ws` library | Chat and live updates (replacing Supabase Realtime) and the Sarvam voice relay. A separate process means a deploy of the HTTP API does not drop every open voice session. |
| Background jobs | **BullMQ** on Redis, separate `worker` process | Retries with backoff, delayed jobs (scheduled calls and reminders), repeatable jobs (cron), concurrency limits per vendor, a dashboard (Bull Board) behind admin auth. |
| Database | **PostgreSQL 16** | Matches Supabase's major version family closely enough for a clean `pg_dump` restore; the Replit config already pinned 16. |
| ORM and migrations | **Drizzle** (`lib/db`) | Already in the scaffold. Phase B runs `drizzle-kit pull` against the restored schema so the existing tables become typed Drizzle tables without hand-writing 47 schemas. Migrations are generated SQL files committed to git. |
| Cache, queues, rate limits, pub/sub | **Redis 7** with AOF persistence | BullMQ needs it; also used for OTP rate limits, idempotency keys and fan-out between API and WebSocket processes. |
| Media | **Backblaze B2** (unchanged), S3-compatible API | The `wishmetoday` bucket stays. Supabase Storage buckets move into B2 in phase I. Uploads go direct from the phone with presigned PUT URLs; private reads with short-lived presigned GET URLs. |
| Payments | **Razorpay** (unchanged) | Orders created and priced by the server; payment verified by signature on the callback and again by webhook; one idempotent ledger write. |
| Email | The provider behind `send-email-otp` today (found in phase A), or Amazon SES / Resend / Postmark | OTP and password-reset mail. SMTP credentials live only on the VPS. |
| Push | Expo Push Service | `push_tokens` table and `registerPushToken` exist in the app but are never called; phase H wires them up. |
| Logs | **pino** JSON to stdout, Docker `local` log driver with rotation; optional Loki + Grafana | Request id on every line, user id where known, never bodies of auth or payment calls. |
| Errors | Sentry (hosted) or GlitchTip (self-hosted, Sentry-compatible) | Same SDK on the API, the worker and the app. |
| Uptime and metrics | Uptime Kuma (self-hosted) on `/api/healthz` and `/api/readyz`; optional Prometheus `prom-client` metrics | Alerts to email or Telegram. |

### 2.2 Express 5, not Fastify or Hono

Fastify is faster per request and Hono is smaller, but neither matters here. Almost every WishMe request spends
its time waiting on Postgres or a vendor (Razorpay, TBO, ElevenLabs, Gemini), so framework overhead is noise.
What does matter is that `artifacts/api-server`, `lib/api-spec`, `lib/api-zod` and `lib/api-client-react` already
form a working Express 5 + Zod + OpenAPI pipeline, and Express has the largest pool of developers the owner can
hire. Express 5 also fixed the old pain points: async errors reach the error handler, and path matching is stricter.
Revisit only if profiling shows the framework on a hot path.

### 2.3 Code layout in the monorepo

```text
artifacts/api-server/            the backend (one package, three entry points)
  src/http.ts                    Express app: /api/v1/** routes
  src/ws.ts                      WebSocket server: /ws (live updates, chat), /ws/voice/sarvam (relay)
  src/worker.ts                  BullMQ workers and repeatable jobs
  src/modules/<domain>/          routes.ts, service.ts, repo.ts, jobs.ts per domain:
                                 auth, profiles, wallet, payments, plans, referrals, celebrities, bookings,
                                 chat, occasions, wishes, content, voice, calls, travel, hub, media, admin
  src/lib/                       auth middleware, errors, logger, razorpay, b2, vendor clients, money
  test/                          vitest + supertest against a throwaway Postgres (testcontainers)
lib/db/                          Drizzle schema (pulled from the restored DB, then owned here) + migrations
lib/api-spec/openapi.yaml        the contract; orval generates lib/api-zod (server validation) and a fetch client
artifacts/mobile/services/api/   the app's new client (section 4)
deploy/                          docker-compose.yml, Caddyfile, .env.example (names only), backup scripts
```

The API is versioned under `/api/v1`. Every route validates its input with the generated Zod schema and returns a
consistent error body `{ error: { code, message } }`, plus a compatibility `message` / `error` string while old
screens still match error text (see the inventory's transport conventions).

### 2.4 Docker Compose layout

One VPS, one `docker-compose.yml` under `/opt/wishme`, images built in CI and pulled from GitHub Container Registry.

```yaml
services:
  caddy:     { image: caddy:2, ports: ["80:80", "443:443"], volumes: [./Caddyfile:/etc/caddy/Caddyfile, caddy_data:/data] }
  api:       { image: ghcr.io/sdata0605/wishme-api:${TAG}, command: node dist/http.cjs,   env_file: .env, depends_on: [postgres, redis] }
  ws:        { image: ghcr.io/sdata0605/wishme-api:${TAG}, command: node dist/ws.cjs,     env_file: .env, depends_on: [redis] }
  worker:    { image: ghcr.io/sdata0605/wishme-api:${TAG}, command: node dist/worker.cjs, env_file: .env, depends_on: [postgres, redis] }
  migrate:   { image: ghcr.io/sdata0605/wishme-api:${TAG}, command: node dist/migrate.cjs, env_file: .env, profiles: [tools] }
  postgres:  { image: postgres:16, volumes: [pg_data:/var/lib/postgresql/data], shm_size: 256mb }   # no public port
  redis:     { image: redis:7, command: redis-server --appendonly yes, volumes: [redis_data:/data] } # no public port
  backup:    { image: ghcr.io/sdata0605/wishme-backup:${TAG}, env_file: .env.backup }              # pgBackRest or wal-g + cron
  uptime:    { image: louislam/uptime-kuma:1 }                                                        # optional
volumes: { pg_data: {}, redis_data: {}, caddy_data: {} }
```

Caddy routes `api.<domain>` to `api:3000`, and `api.<domain>/ws*` to `ws:3001`. Postgres and Redis are on the
internal Docker network only. SSH is key-only, the firewall (ufw) opens 22, 80 and 443, and unattended security
upgrades are on.

**Secrets.** `.env` files on the VPS, owned by root, mode 600, never in git. The repo carries `deploy/.env.example`
with names only. Vendor keys (Razorpay key secret and webhook secret, ElevenLabs, Gemini, Sarvam, Vapi, TBO, HeyGen,
B2, SMTP, the JWT signing key) are entered on the VPS by the owner, or set as GitHub Actions environment secrets
that the deploy job writes to the VPS.

### 2.5 Backups and restore

- **Continuous:** pgBackRest (or wal-g) ships WAL to a separate, private B2 bucket with its own application key
  that can write but not delete (B2 object lock or lifecycle rules for retention). Point-in-time recovery to any
  second in the last 14 days.
- **Nightly full backup** plus weekly `pg_dump` logical dumps kept 30 days, encrypted with a key the owner holds.
- **Redis** is not a system of record; AOF keeps queued jobs across restarts. Lost jobs are re-derived from the
  database by the sweeper jobs (section 2.7).
- **Restore drill** monthly onto a scratch container, with the timing written down. The phase I cutover is itself a
  rehearsed restore.
- **B2 media** already has B2's own durability; enable bucket versioning or object lock for user uploads.

### 2.6 Deploy pipeline (GitHub Actions)

1. On every PR: install, typecheck (libs, api, mobile), unit and integration tests with a Postgres service
   container, OpenAPI codegen drift check (`orval` output must be committed), lint.
2. On merge to `master`: build the API image once (multi-stage, `node:24-slim`, esbuild bundle from the existing
   `build.ts`), tag it with the commit SHA, push to GHCR.
3. Deploy job, `environment: production` with required reviewer: SSH to the VPS with a deploy-only key,
   `docker compose pull`, `docker compose run --rm migrate` (forward-only, backward-compatible migrations),
   `docker compose up -d api ws worker`, then poll `/api/readyz` and roll back to the previous `TAG` on failure.
4. A `staging` environment on the same VPS (separate compose project, separate database and Redis db index, its own
   subdomain) gets every merge automatically; production is promoted by hand.

Migrations follow expand / contract: add columns and tables first, deploy code that uses them, drop old ones in a
later release. This keeps the old Supabase edge functions working while they still share the database.

### 2.7 Background jobs

| Queue | Producer | Job | Replaces |
| --- | --- | --- | --- |
| `reminders` | repeatable, every minute | Find reminders due within the next minute with `delivery = 'call'` or escalation due and unacknowledged; place the call; mark `missed` when appropriate; send Expo push as a backstop. | Whatever dispatcher runs today (cron function or `pg_cron`, found in phase A). |
| `ai-calls` | `POST /calls`, delayed for scheduled calls | Start the Vapi call at the right time; a sweeper marks calls stuck in `queued` or `ringing` as failed after a timeout. Vapi webhooks update status, lines and summary. | `ai-call-start` and the Vapi webhook function. |
| `celebrity-calls` | `POST /voice-calls` | Same as above for celebrity-voice calls (`voice_call_wishes`). | `vapi-celebrity-call`, `vapi-make-call`. |
| `content` | content endpoints | Music (submit, poll vendor until done, upload result to B2, update row), greeting cards, photo wishes, image promotions, occasion videos (HeyGen), wish-celebrity cards. Charge on success or refund on failure. | `generate-*`, `check-music-status`, `elevenlabs-*`. |
| `notifications` | domain events | Welcome WhatsApp, subscription email, wish delivered, celebrity auto-replies. | `send-*`, `trigger-message-event`, `*-auto-reply`. |
| `payments` | Razorpay webhook, repeatable reconciliation | Credit the ledger idempotently; nightly reconciliation against Razorpay's payments list; payout processing. | `verify-razorpay-payment` plus the client-side inserts. |
| `maintenance` | repeatable | Expire OTPs and refresh tokens, delete expired call recordings, clean abandoned uploads. | Unknown today. |

Every job is idempotent (keyed by the row id plus the vendor's id), has a bounded retry policy, and writes its
final state to the database so the app's existing status polling keeps working.

### 2.8 Live updates and chat (replacing Supabase Realtime)

The app opens Supabase Realtime sockets in five places (wallet balance on the dashboard, My Bookings, and the
celebrity dashboard's bookings, followers and messages tabs) and simply refetches over REST when anything changes.
The replacement keeps that model:

- `wss://api.<domain>/ws` with the access token in the first message (`{ type: 'auth', token }`), then
  `{ type: 'subscribe', topic }` for topics the server authorises: `user:<profileId>:wallet`,
  `user:<profileId>:orders`, `celebrity:<celebrityId>:bookings`, `celebrity:<celebrityId>:followers`,
  `celebrity:<celebrityId>:conversations`, `conversation:<id>`.
- The server pushes `{ type: 'changed', topic, table, id }`; the app refetches exactly as it does now.
- Producers publish to Redis pub/sub after a commit. While legacy edge functions still write the shared Supabase
  database, a small Postgres trigger calls `pg_notify` and the WebSocket process `LISTEN`s, so changes made by old
  code also reach new subscribers.
- The app gets one hook, `useLiveTopic(topic, onChange)`, replacing the five hand-written Phoenix clients.

Chat sending moves to `POST /conversations/:id/messages`; the server updates `last_message_at` and unread counters
in the same transaction (the phone does read-modify-write PATCHes today) and publishes the change.

### 2.9 Sizing (to be confirmed with the audit numbers)

A 4 vCPU / 8 GB RAM / 160 GB NVMe VPS in an Indian region comfortably runs all of the above for tens of thousands of
users, since the heavy work (speech, video, music) happens at vendors. Postgres gets 2 GB of shared buffers. Plan a
second, smaller VPS later for staging and backups if the budget allows.

---

## 3. Auth design

### 3.1 What the app does today

`context/AuthContext.tsx` talks to Supabase Auth REST directly: password grant, refresh grant (with a
single-flight guard because Supabase rotates refresh tokens), sign-up after an OTP check by two edge functions,
`/recover` for password reset, `PUT /user` for password and metadata changes, and `/logout`. The session is
`{ access_token, refresh_token }` in AsyncStorage; the app decodes `exp` itself and refreshes five minutes early.
Gaps the inventory found: `verify-email-otp` and `/auth/v1/signup` are not linked (nothing proves the OTP was
passed), changing a password signs in again just to test the old one, and "forgot password by phone" reads an email
address by phone number with the anon key.

### 3.2 Tokens

- **Access token:** a JWT valid for 15 minutes. Claims: `sub` (the user id, unchanged from Supabase),
  `pid` (profile id), `role` (`user` | `celebrity` | `admin`), `cid` (celebrity id when there is one), `iat`, `exp`,
  `aud: 'authenticated'`, `iss`.
- **Refresh token:** 256 random bits, base64url, valid 60 days, stored only as a SHA-256 hash in
  `auth_refresh_tokens (id, user_id, family_id, token_hash, created_at, expires_at, revoked_at, replaced_by,
  user_agent, ip)`. Every refresh rotates: the old token is revoked and points at its replacement. Presenting a
  revoked token revokes the whole family (theft detection). The app's single-flight refresh already fits this.
- **Signing during the transition (phases C to H):** access tokens are signed **HS256 with the Supabase project's
  JWT secret** and carry `role: 'authenticated'` alongside the WishMe claims. That makes one token valid for the new
  API *and* for the not-yet-migrated PostgREST endpoints and edge functions, which check `auth.uid()` against the
  `sub` claim. The anon key in the app is HS256, so the project uses the legacy shared secret; the owner confirms in
  phase A whether newer asymmetric signing keys are enabled.
- **After cutover (phase I):** switch to **EdDSA (Ed25519)** with a key only the VPS holds, publish the public key at
  `/.well-known/jwks.json`, and rotate keys yearly. Access tokens expire within 15 minutes, refresh tokens live in
  our own table, so nobody is signed out by the switch.

### 3.3 Endpoints

Response bodies mirror Supabase's so `AuthContext.tsx` changes by URL, not by parsing logic.

| Endpoint | Body | Returns |
| --- | --- | --- |
| `POST /api/v1/auth/otp` | `{ email, purpose: 'signup' \| 'celebrity' \| 'reset' }` | `204`. `409` if signing up an existing email, `429 { retryAfter }`, `400` invalid email. Code: 6 digits, stored as a hash, 10-minute expiry, 5 attempts, 1 send per 60 s and 5 per hour per email and per IP. |
| `POST /api/v1/auth/signup` | `{ email, password, otp, first_name, last_name, phone, referral_code?, gender? }` | `{ access_token, refresh_token, expires_in, token_type, user }`. Verifies the OTP, creates the user and the profile in **one transaction**, applies the referral. |
| `POST /api/v1/auth/celebrity-apply` | celebrity form + `password`, `otp` | Same session shape; also creates the `celebrity_applications` row (one column shape, not the two the app sends today). |
| `POST /api/v1/auth/token?grant_type=password` | `{ email, password }` | Session + `user` with `user_metadata`, plus the profile fields `login()` fetches today (saves a round trip). Error text keeps the word "invalid" during the transition. |
| `POST /api/v1/auth/token?grant_type=refresh_token` | `{ refresh_token }` | New session. Also accepts a **Supabase refresh token** once (section 3.5). |
| `POST /api/v1/auth/password/reset` | `{ email \| phone, otp, new_password }` | Resets with an emailed OTP. The phone variant resolves the email server-side, so no profile data is exposed. |
| `POST /api/v1/auth/password/change` | `{ current_password, new_password }` | Checks the current password server-side, revokes other refresh families. |
| `POST /api/v1/auth/logout` | `{ refresh_token }` | Revokes that family. |
| `GET/PATCH /api/v1/me` | profile fields (gender, names, phone…) | Replaces `PUT /auth/v1/user { data }` and the `profiles` PATCHes in `edit-profile.tsx`. |

Passwords: bcrypt-verified as they come from Supabase; on successful login the hash is upgraded to Argon2id
(`@node-rs/argon2`). Minimum length and a breached-password check (k-anonymity HIBP range API) at sign-up and change.

### 3.4 Where users live

During phases C to H the database is still Supabase's, and `profiles.user_id` (and other tables) reference
`auth.users(id)`. The API therefore reads and writes **`auth.users` directly** for credentials: same `id`, same
`email`, bcrypt `encrypted_password`, `email_confirmed_at`, `raw_user_meta_data`. The existing sign-up trigger that
creates the `profiles` row keeps firing. Our own `auth_refresh_tokens` and `auth_otps` tables live in a new `wishme`
schema in the same database.

In phase I the restore creates `wishme.users` from `auth.users` with the **same ids** (so every foreign key keeps
working), the foreign keys are repointed, and the `auth` schema is dropped.

### 3.5 Migrating existing users without a forced logout

- **Passwords:** `auth.users.encrypted_password` holds standard bcrypt (`$2a$10$…`), which `bcrypt` / `bcryptjs`
  verify directly. Nobody resets a password.
- **Sessions:** the app holds a Supabase refresh token. When the first build with the new client starts, it calls
  `POST /api/v1/auth/token?grant_type=refresh_token` with that token. The API looks it up in `auth.refresh_tokens`
  (same database), checks it is not revoked, revokes it, and issues a WishMe session. Users never see a login screen.
  After phase I this path is removed; anyone who skipped every release until then signs in once.
- **Accounts without a password** (magic link or OAuth, if any show up in `auth.identities`): mark them, and send
  them through the OTP reset flow on next login.
- **Unconfirmed emails:** keep `email_confirmed_at`; unconfirmed accounts must pass an OTP at first login.

### 3.6 Authorisation

Supabase enforces access with RLS on every table. The new API enforces it in code: every repository function takes
the caller's context (`userId`, `profileId`, `celebrityId`, `role`) and scopes its query, and ids sent by the client
are never trusted for ownership. The RLS policies exported in phase A are the checklist: each one becomes a test
case. Admin routes require `role = 'admin'` and are on a separate path prefix with their own rate limits.

---

## 4. How the mobile app switches

### 4.1 One client, same shapes

Add `artifacts/mobile/services/api/`:

- `client.ts`: `apiFetch(path, init, token?)` with the same 20-second timeout, bearer header and error parsing as
  `supabaseFetch`, base URL from `EXPO_PUBLIC_API_URL`, an `x-app-version` header, and automatic retry of
  idempotent GETs on network errors.
- One module per domain (`wallet.ts`, `celebrities.ts`, `chat.ts`, …) exposing typed functions whose return types
  are the **row shapes the screens already use** (`{ id, wallet_balance }`, `Reminder`, `AiCall`, …), so a screen
  changes one call, not its parsing. Types come from the orval-generated client where possible.
- `routing.ts`: a per-domain switch, `backendFor('wallet') → 'api' | 'supabase'`, seeded with build-time defaults and
  overridden by `GET /api/v1/config` (cached in AsyncStorage). A domain can be flipped back to Supabase without
  shipping a build.

`constants/supabase.ts` and `services/supabaseRest.ts` stay until phase I, then are deleted. New code never imports
them; a lint rule (or a grep in CI) counts remaining imports so progress is visible.

### 4.2 Order of work inside the app

1. Ship the client and the config endpoint with every domain still on Supabase (no behaviour change).
2. Per phase: implement the domain module, switch the screens of that domain to it, test against staging, flip the
   domain to `api` in production config for internal testers, then for everyone.
3. After a domain has been on the API for two weeks without incident, delete its Supabase code paths in the app.

### 4.3 Old builds in the wild

Installed APKs keep calling Supabase until they update. Because the database is shared until phase I, old builds keep
working through phases C to H **except** where a phase deliberately closes a hole: once money logic is server-side,
RLS on `wallet_transactions`, `payment_transactions`, `payout_requests` and balance columns must deny client writes,
which breaks old builds' payment flows. So:

- `GET /api/v1/config` returns `minVersion` and `recommendedVersion`; the app shows a blocking update screen below
  `minVersion` (ship this in the very first API build, before it is needed).
- Phase C raises `minVersion` when the money RLS is tightened. Phase I raises it again before Supabase is switched off.

---

## 5. Phases

Effort is calendar-free developer time for one person. Phases D, E and F can run in parallel with a second developer
once C is done.

### Phase A — Audit and capture (3 to 5 days)

- **Do:** owner runs `scripts/supabase-audit` (needs their login), screenshots the dashboard settings listed in its
  README, and gathers vendor account ownership. Read every edge function, especially the ones the app never calls
  (webhooks, cron) and the ones using the service-role key. Fill the gaps the inventory flags: does `tbo-flights`
  charge the wallet; is `profiles.wallet_balance` maintained by a trigger; who dispatches reminder calls; where Vapi
  webhooks land.
- **App changes:** none.
- **API:** none. Output is a short `docs/BACKEND_AUDIT_FINDINGS.md` and an updated inventory.
- **Risks:** nobody has the database password or vendor logins (reset paths exist for the first, not always for the
  second); functions deployed from code nobody kept. Mitigation: `functions download` recovers deployed source.

### Phase B — VPS stand-up and data restore (4 to 6 days)

- **Do:** harden the VPS, install Docker, deploy the Compose stack with Caddy and a health route, set up backups
  first, then restore the phase A dump into the VPS Postgres (stripping Supabase-only objects: `auth`/`storage`
  grants to `anon`/`authenticated`, `pg_graphql`, `supabase_realtime` publication, `supabase_functions` webhooks,
  replaced by stubs where needed). Run `drizzle-kit pull` to generate `lib/db` schema. Time the restore. Stand up
  staging with an anonymised copy. Build the CI/CD pipeline. Add `EXPO_PUBLIC_API_URL` and the empty client.
- **App changes:** `services/api/client.ts`, `routing.ts`, the config fetch and the force-update screen, all with
  every domain still on Supabase.
- **API:** `GET /api/healthz`, `GET /api/readyz`, `GET /api/v1/config`.
- **Risks:** extensions or functions in the dump that do not exist on vanilla Postgres; disk sizing; the VPS region
  far from Supabase's (adds latency while the API talks to the Supabase database, so pick a region next to it).

### Phase C — Auth, profiles, wallet, payments (3 to 4 weeks)

- **Do:** section 3 auth. Connect the API to the Supabase Postgres through the session pooler with a dedicated
  database role. Move profile reads and edits, plans, referrals, wallet, Razorpay, Scan & Pay, celebrity payouts and
  bank details. Introduce a proper ledger: amounts as integer paise, every movement a row with a unique
  `idempotency_key`, the balance updated in the same transaction under `SELECT … FOR UPDATE`, and a nightly check that
  `sum(ledger) = balance` for every wallet. Replace each client-side money write in the inventory's list.
- **App changes:** `AuthContext.tsx` points at `/api/v1/auth/*`; `edit-profile.tsx`, `settings/security.tsx`,
  `useWallet`, `usePlan`, `select-plan.tsx`, `referrals.tsx`, `commission.tsx`, `components/wallet/*`,
  `components/scan-pay/ScanPayScreen.tsx` call the new modules. The dashboard's balance listener moves to the
  WebSocket topic once phase D ships it (until then it polls every 30 s while visible). Raise `minVersion` when money
  RLS is tightened.
- **API:**
  - `GET /me`, `PATCH /me`, `POST /me/photo-upload-url`, `POST /me/kyc-upload-url` (private bucket, no public URL).
  - `GET /wallet` → `{ id, wallet_balance }`; `GET /wallet/transactions?cursor=`; `GET /wallet/referral-earnings`.
  - `POST /payments/orders { purpose: 'wallet_deposit' | 'plan' | 'subscription' | …, ref_id?, amount? }` → the server
    computes the amount (only deposits accept a user amount, within limits) and returns `{ order_id, amount, currency,
    key_id }`.
  - `POST /payments/verify { razorpay_order_id, razorpay_payment_id, razorpay_signature }` → verifies
    `HMAC_SHA256(order_id + "|" + payment_id, key_secret)`, then credits and fulfils the purpose idempotently; returns
    the new balance or the fulfilled entity.
  - `POST /webhooks/razorpay`: raw body, `X-Razorpay-Signature` checked against the webhook secret, handles
    `payment.captured`, `order.paid`, `payment.failed`, `refund.processed`; same idempotent fulfilment, so a user who
    closes the app after paying still gets credited.
  - `POST /wallet/pay-upi { payee_vpa, payee_name, amount, note }` (Scan & Pay ledger debit, with a daily limit).
  - `GET /plans`, `POST /plans/:id/purchase { method: 'wallet' | 'razorpay' }`.
  - `GET /referrals`, `GET /referrals/history`, `GET /referrals/validate/:code` (the three RPCs).
  - `GET /payouts`, `POST /payouts { amount, bank_detail_id }` (balance checked and held server-side),
    `GET/POST /bank-details`.
- **Risks:** money correctness (mitigate with the ledger invariant check, idempotency keys and integration tests for
  double-submit, webhook-before-callback and callback-without-webhook); hidden database triggers that also move money
  (found in phase A, kept or replaced deliberately); old builds still writing money rows until RLS is tightened.

### Phase D — Celebrities, bookings, chat (2 to 3 weeks)

- **Do:** celebrity catalogue and detail, favourites and subscriptions, reviews, media, events, occasions and occasion
  bookings, loved ones and occasion alerts, video-wish bookings, wish-celebrity and wish-a-friend orders, chat for
  both sides, the whole celebrity dashboard, and the WebSocket service (section 2.8).
- **App changes:** the hooks `useCelebrities`, `useCelebrity`, `useCelebrityFavorites`, `useVoiceCallCelebrities`,
  and the screens `celebrity/[id]`, `booking/[id]`, `bookings`, `booking-summary`, `chat/[id]`, `messages`,
  `favorites`, `occasions`, `occasion-book/[id]`, `occasion-wishes`, `loved-ones`, `wish-*`, `celebrity-signup`,
  `celebrity-dashboard` and `components/celebrity-dashboard/*`. The five Phoenix clients become `useLiveTopic`.
- **API:**
  - `GET /celebrities?category=&q=&voice_call=1&cursor=` (same fields as today's `select=` lists),
    `GET /celebrities/:id` (with review count, favourite status and favourite price for the caller).
  - `POST /celebrities/:id/subscribe { method }` (replaces `purchase_celebrity_subscription`, priced server-side).
  - `POST /bookings { celebrity_id, service_type, details… }` → server prices (fee included), debits, creates the
    booking in one transaction. `PATCH /celebrity/bookings/:id { status: 'accepted' | 'rejected' }` (celebrity only).
  - `POST /wish-orders`, `GET /wish-orders`, `GET /wish-orders/:id`, `POST /wish-orders/:id/send`,
    `POST /wish-friend-orders` (replaces the two RPCs).
  - `GET /conversations`, `GET /conversations/:id/messages?before=&after=`, `POST /conversations/:id/messages`,
    `POST /conversations/:id/read`; voice notes via `POST /uploads { kind: 'voice-note' }` (presigned B2 URL).
  - Celebrity dashboard: `GET/PATCH /celebrity/me`, `/celebrity/media`, `/celebrity/events`, `/celebrity/settings`,
    `/celebrity/followers`, `/celebrity/reviews`, `/celebrity/earnings` (computed server-side, replacing the
    dashboard's client-side 70 % estimate), `/celebrity/tds?from=&to=`.
  - `GET/POST/PATCH/DELETE /loved-ones`, `/occasion-alerts` (the server keeps `loved_ones.occasions` and
    `occasion_alerts` consistent instead of the phone dual-writing them).
- **Risks:** the largest surface by endpoint count; identity-key inconsistencies (profile id vs celebrity id vs auth
  id) surface here; chat ordering and unread counts under concurrency.

### Phase E — AI content as queued jobs (2 to 3 weeks)

- **Do:** music (lyrics, generation, status), ElevenLabs tools (TTS, SFX, voice conversion, cloning, isolation,
  image-to-music video), greeting cards, photo wishes, image promotions, occasion videos and wish-celebrity cards,
  document generation, message and prompt suggestions, library and signed media URLs. Each paid generation becomes:
  quote → hold funds → enqueue → vendor work → upload result to B2 → mark complete and capture, or fail and release.
- **App changes:** `components/music/*`, `greeting-cards`, `photo-wish`, `image-promotions`, `ugc-*`,
  `components/ugc/*`, `wish-friend`, `services/library.ts`, `services/documents/generate.ts`, `hooks/useVoices.ts`.
  Screens keep polling their row's `status` (or listen on `user:<pid>:orders`); the phone stops inserting
  `*_generations` rows and `payment_transactions`.
- **API:** `POST /content/:kind` with the same input fields as today's function payloads → `202 { id, status:
  'queued' }`; `GET /content/:kind/:id` → the row as today; `GET /content/:kind?cursor=` for history;
  `POST /media/signed-url { key }` (replaces `b2-get-signed-url`, ownership checked); `POST /uploads` for
  reference images; `POST /documents` (synchronous, 150 s timeout kept); `POST /suggestions/messages`,
  `POST /suggestions/card-prompts`.
- **Risks:** vendor rate limits and long runtimes (BullMQ concurrency per vendor, generous timeouts); the base64
  images currently stored in `image_music_generations.image_url` (move to B2 during phase I); prices that today come
  from the client (`platform_settings` becomes the single source, read on the server).

### Phase F — Voice tokens, Sarvam relay, AI calls via Vapi (2 to 3 weeks)

- **Do:** mint Gemini Live ephemeral tokens on the API; port the Sarvam relay into the WebSocket process with the
  exact frame protocol in the inventory; move AI calls, celebrity voice calls and voice-call wishes to Vapi with
  server-verified webhooks; recordings behind short-lived signed URLs.
- **App changes:** `services/voice/engine.ts` and `services/geminiLive/client.ts` call `/api/v1/voice/token`;
  `services/sarvamLive/client.ts` already accepts `relay_url` from the token response, so it moves with no code
  change once the token endpoint returns `wss://api.<domain>/ws/voice/sarvam`. `services/assistant/aiCalls.ts`,
  `services/hub/callLogs.ts`, `app/(tabs)/voice-call.tsx`, `app/voice-call-wish.tsx`, `services/assistant/webSearch.ts`.
- **API:** `POST /voice/token { probe?, want?, supports }` → `{ engine, fallback_engine, relay_url, token?, model? }`;
  `WSS /ws/voice/sarvam` (auth frame, then `start`, `audio`, `text`, `tool_result`, …);
  `POST /calls` → `{ callId, status, scheduledFor }`, `GET /calls`, `GET /calls/:id`, `GET /calls/:id/lines`,
  `POST /calls/:id/recording-link` (404 / 410 semantics kept); `POST /voice-calls` (celebrity voice, priced and charged
  server-side); `GET /vapi/voices`, `POST /vapi/voices`; `POST /webhooks/vapi` (shared secret or signature, idempotent
  status transitions); `POST /search/web`.
- **Risks:** WebSocket relays are latency-sensitive (keep the VPS close to Sarvam and Google endpoints, measure
  round-trip before switching); long-lived sockets during deploys (the `ws` process drains on SIGTERM and is deployed
  separately); Vapi webhook replays and out-of-order events; the server must re-validate phone numbers (no emergency
  or premium numbers, India only), not trust the phone's check.

### Phase G — Travel and bills via TBO (1 to 2 weeks)

- **Do:** port `tbo-flights` and `tbo-hotels` as a TBO client module with token caching and request logging (TBO
  support asks for request and response logs). Make flight booking a proper money flow: re-quote, hold funds, book and
  ticket, capture on success, release and alert on failure, store a `travel_bookings` row with PNR and ticket numbers.
  Hotels, buses and bills stay mock until the business decides to make them real; their pay screens must not imply a
  real charge.
- **App changes:** `services/tboService.ts` points at the new routes and passes the user's token (flight calls run with
  the anon key today); `FlightReviewAndPayScreen.tsx` calls one `POST /travel/flights/book` instead of chaining
  quote, book and ticket itself.
- **API:** `POST /travel/flights/search`, `/farerule`, `/farequote`, `/ssr` (same payloads and `success` envelope as
  today), `POST /travel/flights/book { traceId, resultIndex, isLCC, passengers, payment: 'wallet' | 'razorpay' }`
  → `TBOBookingConfirmation`, `GET /travel/bookings/:id`; hotel routes kept behind a flag.
- **Risks:** fares change between quote and ticket; partial failures (booked but not ticketed) need a manual queue and
  an alert; TBO test versus production credentials.

### Phase H — The Hub: reminders, calendar, call logs (1 to 2 weeks)

- **Do:** reminders, calendar events, assistant settings, push tokens, and the dispatcher (reminder calls,
  escalation, missed status, push backstop). Wire `registerPushToken` into app start.
- **App changes:** `services/hub/reminders.ts`, `calendar.ts`, `notifications.ts`, `context/AssistantPersonaContext.tsx`.
  These already return typed rows, so each function body swaps its URL; local-notification scheduling on the phone
  is unchanged.
- **API:** `GET /reminders?status=&from=&to=`, `POST /reminders`, `PATCH /reminders/:id`,
  `POST /reminders/:id/done`, `POST /reminders/:id/ack`, `DELETE /reminders/:id`; the same CRUD for `/events` with
  the recurrence-aware window query; `GET/PUT /assistant-settings`; `PUT /push-tokens`.
- **Risks:** time zones and recurrence (keep the stored `timezone` and `pin_to_timezone` semantics exactly); the
  dispatcher must not double-call after a deploy (BullMQ job ids derived from reminder id plus due time).

### Phase I — Cutover and decommission (about 1 week, plus 2 to 4 weeks of watching)

- **Do:**
  1. Rehearse twice on staging with fresh dumps; record the timings.
  2. Copy Supabase Storage buckets into B2 (`rclone` with the S3 endpoints of both) and prepare a URL rewrite: an
     SQL script replacing `…supabase.co/storage/v1/object/public/<bucket>/` prefixes in every URL column, plus a
     Caddy redirect for any URL that escaped into chat messages. Identity documents in `verification-docs` go to a
     **private** bucket and are served only through signed URLs.
  3. Raise `minVersion`; announce a 30-minute maintenance window.
  4. Freeze: put the API and Supabase into read-only (revoke write grants on the Supabase database role), drain
     the queues.
  5. Dump, restore into the VPS Postgres, move `auth.users` into `wishme.users` with the same ids, repoint foreign
     keys, run the URL rewrite, verify row counts and the ledger invariant.
  6. Switch `DATABASE_URL`, switch JWT signing to EdDSA, point Razorpay, Vapi and other webhooks at the VPS, open
     writes.
  7. Watch error rates, payment reconciliation and queue depth for two weeks with Supabase kept read-only as a
     fallback; then take a final dump, archive it encrypted, and delete the Supabase project.
- **App changes:** remove `constants/supabase.ts`, `services/supabaseRest.ts`, the Supabase keys in `.env.example`,
  and the token-exchange path.
- **Risks:** the maintenance window running long (rehearsals give a real number); missed URL columns (the rehearsal
  diff finds them); a webhook still pointed at Supabase (checklist per vendor).

### Effort summary

| Phase | One developer | Can run in parallel with |
| --- | --- | --- |
| A Audit and capture | 3–5 days | B (VPS hardening part) |
| B VPS and restore | 4–6 days | A |
| C Auth, profiles, wallet, payments | 3–4 weeks | — (everything depends on it) |
| D Celebrities, bookings, chat | 2–3 weeks | E, F |
| E AI content jobs | 2–3 weeks | D, F |
| F Voice and calls | 2–3 weeks | D, E |
| G Travel | 1–2 weeks | H |
| H Hub | 1–2 weeks | G |
| I Cutover | ~1 week + 2–4 weeks watching | — |
| **Total** | **about 15–22 weeks** | about 10–13 weeks with two developers |

---

## 6. Risk register (whole project)

| Risk | Likelihood | Impact | Mitigation |
| --- | --- | --- | --- |
| Money moved or recorded twice, or not at all, while logic moves server-side | Medium | High | Ledger with idempotency keys, Razorpay webhook as the source of truth, nightly reconciliation, invariant check, force-update before tightening RLS. |
| Business rules hidden in triggers or service-role functions are missed | High | Medium | Phase A reads every function and trigger; summarize.mjs lists triggers, webhooks and service-role functions first. |
| Owner lacks access to a vendor account or key | Medium | High | Inventory owners in phase A; start key rotation early where an ex-developer may hold a key. |
| Old app builds break | High | Medium | Force-update gate shipped in phase B; shared database keeps old builds working until deliberate breaks. |
| Voice latency worse from the VPS | Medium | Medium | Measure before switching; choose the region accordingly; keep the Supabase relay as a fallback through `relay_url`. |
| Single VPS is a single point of failure | Medium | High | Tested backups and PITR, documented rebuild (Compose plus restore) under two hours, a second VPS later. |
| Personal data exposure during migration | Low | High | Dumps stay on the owner's machine and the VPS, encrypted at rest; staging uses anonymised data; KYC documents move to a private bucket. |

---

## 7. Open questions for the owner

1. **VPS:** provider, region, OS and version (Ubuntu 24.04 LTS recommended), CPU, RAM, disk, and whether it is already
   running anything else. Do we get root SSH access, and who else has it?
2. **Domain:** which domain or subdomain should the API use (for example `api.wishme.<tld>`), and who controls DNS?
3. **Supabase access:** can you log in to the project as an owner, and do you know (or can you reset) the database
   password? Is the project on the legacy JWT secret or the new signing keys? Which region is it in?
4. **Keys and accounts:** who holds the logins and keys for Razorpay (key id, key secret, webhook secret, live or test),
   ElevenLabs, Google AI Studio (Gemini), Sarvam, Vapi (and its phone numbers), TBO (test or production agency
   credentials), HeyGen, Backblaze B2, the email provider, and the WhatsApp provider? Please do not paste any of them
   into a chat; we only need to know who has them and whether they can be rotated.
5. **Traffic:** how many registered users, daily active users, and peak concurrent voice sessions today, and what do you
   expect in six months? Monthly Razorpay volume and number of payouts?
6. **Data residency and compliance:** must data stay in India (DPDP Act 2023, RBI guidance for payment data)? Are
   Aadhaar and PAN numbers or images collected on purpose, and for which flows? How long must call recordings be kept?
7. **Budget and people:** monthly budget for the VPS, backups, monitoring and email; one developer or two; target date.
8. **Scope decisions:** should hotels, buses and bill payments stay mock, be hidden, or become real? Is Scan & Pay meant
   to stay a wallet transfer, or to become a real UPI payment through a licensed partner?
9. **Admin tooling:** who approves celebrity applications, payouts and refunds today, and with what tool (Supabase
   dashboard, a separate admin app)? It has to keep working after Supabase is gone.
10. **Downtime:** is a 30-minute maintenance window at night acceptable for the final cutover?
