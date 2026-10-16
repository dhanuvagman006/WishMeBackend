# WishMe backend architecture

This service replaces the hosted Supabase project behind the WishMe mobile app (`Sdata0605/wishme-mobile-app`)
with a backend the owner runs on their own VPS. It is designed around three requirements:

1. **Seamless for the app.** The installed app keeps working unchanged. Pointing `EXPO_PUBLIC_SUPABASE_URL` at this
   server is the only switch, and even that can happen before any domain is migrated.
2. **Secure by default.** Every table, column, function and bucket is denied unless a written policy allows it, and
   money never moves because a phone said so.
3. **Scalable and highly available.** Stateless HTTP replicas behind a load balancer, background work on queues,
   zero-downtime deploys, tested backups.

Companion documents: [SECURITY.md](SECURITY.md), [RUNBOOK.md](RUNBOOK.md), [CUTOVER.md](CUTOVER.md),
[CONTRIBUTING.md](../CONTRIBUTING.md) and the decision records in [adr/](adr/). The contract this server honours is
`docs/BACKEND_CONTRACT_INVENTORY.md` in the app repository (every endpoint the app calls, with the fields it reads).

---

## 1. The big idea: a Supabase-compatible strangler gateway

The app speaks Supabase: PostgREST under `/rest/v1`, GoTrue under `/auth/v1`, edge functions under `/functions/v1`,
Storage under `/storage/v1` and Realtime (Phoenix) under `/realtime/v1`. About 150 call sites build those requests
by hand. Rewriting them all before switching would take months and break old builds.

So this server **speaks the same protocol**, route by route, and **forwards anything it does not handle yet to the
real Supabase project**:

```text
                        ┌──────────────────────────── WishMe backend (this repo) ────────────────────────────┐
  WishMe app  ──HTTPS──►│ Caddy ─► api replicas ─► route mode?  local ─► compat engine ─► domain services ─► Postgres │
  (unchanged)           │                                │                                          ├► Redis       │
                        │                                └─ proxy ─► Supabase (until that route is migrated)        │
                        │          worker ─► BullMQ jobs (reminders, AI calls, content, reconciliation)           │
                        └──────────────────────────────────────────────────────────────────────────────────────────┘
```

- **Route modes.** Every compat route group (`auth`, `rest:<table>`, `rpc:<name>`, `functions:<name>`, `storage`,
  `realtime`) is `local` or `proxy`. The default during the transition is `proxy`; groups flip to `local` one at a
  time after they are tested. Flipping back is a config change, not a release. See `src/compat/modes.ts`.
- **One database until cutover.** In `DB_MODE=shared` the server connects to the existing Supabase Postgres, so local
  and proxied routes see the same rows. No dual writes, no sync jobs. In `DB_MODE=standalone` (after cutover) the
  same code runs against the VPS Postgres restored from a dump. See [CUTOVER.md](CUTOVER.md).
- **One token for both worlds.** In shared mode access tokens are signed with the Supabase project's JWT secret and
  carry the claims Supabase expects (`sub`, `role: authenticated`, `aud`, `session_id`), so a token issued here is
  accepted by proxied routes too. After cutover signing switches to Ed25519 keys only this server holds.
- **A clean API alongside.** `/api/v1/*` is the long-term contract (typed, resource-oriented, no client-built SQL).
  New app code should use it; the compat surface is retired screen by screen once every installed build is new
  enough (`minVersion` from `GET /api/v1/config`).

## 2. Process model

One container image, three entry points:

| Process | Entry | Replicas | What it does |
| --- | --- | --- | --- |
| `api` | `dist/server.js` | 2+ | Fastify HTTP: compat surface, `/api/v1`, webhooks, Realtime and voice WebSockets. Stateless. |
| `worker` | `dist/worker.js` | 1+ | BullMQ processors and repeatable jobs. Idempotent, so more replicas only add throughput. |
| `migrate` | `dist/migrate.js` | one-shot | Applies `migrations/*.sql` in order inside a transaction each, with an advisory lock. |

Caddy load-balances `api` replicas with active health checks on `/api/readyz`, retries idempotent requests on another
replica, and keeps WebSockets sticky by connection. A deploy replaces replicas one at a time; each one stops accepting
new connections on `SIGTERM`, drains in-flight requests (30 s), tells WebSocket clients to reconnect, then exits.

## 3. Source layout

```text
src/
  config/env.ts            all configuration, validated with zod at startup (fail fast, never default secrets)
  lib/                     logger, errors, db, redis, rate limiter, crypto, vendor HTTP client, metrics, sql builder
  auth/                    JWT, password hashing, refresh tokens, OTPs, users repository, request auth context
  compat/                  the Supabase-shaped surface the current app speaks
    modes.ts               local / proxy decision per route group
    proxy.ts               streaming pass-through to the upstream Supabase project
    gotrue/                /auth/v1/*
    postgrest/             /rest/v1/* : query parser, schema cache, SQL compiler, table policies, RPCs
    functions/             /functions/v1/* : registry + one handler module per domain
    storage/               /storage/v1/* : B2-backed object storage with per-bucket rules
    realtime/              /realtime/v1/websocket : Phoenix protocol, fed by Postgres LISTEN/NOTIFY
  api/v1/                  the clean API (health, config, auth, me, wallet, payments, webhooks)
  domains/                 business logic shared by compat and v1 (ledger, payments, orders, notifications)
  vendors/                 one client per third party (Razorpay, B2, ElevenLabs, Gemini, Sarvam, Vapi, TBO, …)
  jobs/                    queue definitions and processors
  app.ts                   builds the Fastify instance (used by server and tests)
  server.ts worker.ts migrate.ts
migrations/                forward-only SQL, numbered
deploy/                    docker-compose.yml, Caddyfile, env example, backup and deploy scripts
test/                      unit tests and integration tests against real Postgres and Redis
```

## 4. Request lifecycle (compat REST call)

1. Caddy terminates TLS, adds `X-Request-Id`, forwards to a replica.
2. Fastify hooks: request id, body size limit, rate limit (per IP and per user, Redis-backed), CORS.
3. `auth/context.ts` resolves the caller: `apikey` must be a known key; the bearer token is verified (signature,
   expiry, audience, issuer). The profile id and celebrity ids for the user are loaded and cached for 60 s.
4. `compat/modes.ts` decides `local` or `proxy` for `rest:<table>`.
5. Local: `postgrest/parser.ts` turns the query string into an AST. Unknown operators, columns or tables are rejected,
   never passed through.
6. `postgrest/compiler.ts` builds one parameterised SQL statement from the AST **and the table's policy**: the
   policy's row predicate is AND-ed into every read, update, delete and upsert; insert and update payloads are reduced
   to the policy's writable columns; server-owned columns (owner ids, timestamps) are set by the policy, not the client;
   embedded resources are compiled as correlated subqueries that apply the embedded table's own read policy.
7. The statement runs in a transaction with `statement_timeout`, and, in shared mode, with
   `SET LOCAL ROLE authenticated` and `request.jwt.claims` so the database's existing row-level security also applies
   (defence in depth).
8. Postgres serialises the result with `json_agg`, exactly as PostgREST does, so numbers, timestamps and nested
   objects come back in the shapes the app already parses.
9. Errors use PostgREST's body `{ code, message, details, hint }` and status codes.

## 5. Data model ownership

- **`public` schema** — the app's tables (47 used today). Owned by Supabase until cutover; this server never alters
  their structure in shared mode. Policies in `src/compat/postgrest/policies/` describe who may touch what.
- **`auth.users`** — credentials. Read and written directly (bcrypt hashes are verified as-is and upgraded to Argon2id
  on login). In standalone mode a compatible `auth.users` table is created by migration `0002` if the restore did not
  bring one.
- **`wishme` schema** — tables this server owns: refresh tokens, OTP challenges, idempotency keys, the payment ledger
  and Razorpay event log, audit log, outbox, push receipts. Created by `migrations/`.

## 6. Money

All money is integer **paise** inside this server. The client never decides an amount that moves money:

- Deposits: `create-razorpay-order` creates the order server-side and records it; `verify-razorpay-payment` and the
  Razorpay webhook both fulfil it through one idempotent function keyed on the Razorpay payment id. The wallet credit
  is written by the server. The app's follow-up client inserts (`wallet_transactions`, `payment_transactions`) are
  recognised and answered with the server's row instead of creating a second credit.
- Debits requested through compat inserts are accepted only as debits, validated against the locked balance
  (`SELECT … FOR UPDATE`) and recorded in the ledger. A client cannot insert a credit.
- A nightly job reconciles Razorpay's captured payments with the ledger and checks `sum(ledger) = balance` per wallet.

Details per flow are in `src/domains/wallet` and `src/domains/payments`.

## 7. Scalability

- The `api` process holds no state except open WebSockets. Sessions are JWTs; rate-limit counters, idempotency keys,
  caches and queues live in Redis.
- Postgres connections are pooled per replica (`DB_POOL_MAX`) and can go through a pooler (`DB_PREPARE=false` for
  transaction-mode poolers). Realtime uses one dedicated direct connection per replica for `LISTEN`.
- Slow or bursty work (AI generation, calls, notifications, reconciliation) runs in the `worker` with per-vendor
  concurrency limits, retries with backoff and dead-letter visibility.
- `@fastify/under-pressure` sheds load with `503` + `Retry-After` when the event loop or heap is saturated, instead
  of falling over.
- Responses that are public and cacheable (celebrity catalogue, plans, platform settings) carry `Cache-Control` and
  are cached in Redis for short periods.

## 8. Availability

- Two `api` replicas minimum; rolling deploys with readiness checks; automatic rollback on failed readiness.
- `/api/healthz` (process alive) and `/api/readyz` (database and Redis reachable, schema cache loaded).
- Postgres: continuous WAL archiving to a private B2 bucket plus nightly base backups; documented restore under two
  hours; monthly restore drill. Redis with AOF; queues are re-derivable from the database.
- Uptime monitoring on `readyz`, error tracking via Sentry-compatible DSN, structured JSON logs with request ids,
  Prometheus metrics at `/metrics` (internal network only).

## 9. Configuration and modes

| Variable | Meaning |
| --- | --- |
| `DB_MODE` | `shared` (Supabase Postgres, transition) or `standalone` (VPS Postgres, after cutover). |
| `COMPAT_DEFAULT_MODE` | `proxy` or `local`; per-group overrides in `ROUTE_MODES`. |
| `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_JWT_SECRET` | Upstream for proxying and the transition signing secret. |
| `JWT_SIGNING` | `supabase-hs256` (transition) or `eddsa` (after cutover, keys in `JWT_PRIVATE_KEY`). |

The full list with descriptions is `src/config/env.ts` and `deploy/.env.example`.
