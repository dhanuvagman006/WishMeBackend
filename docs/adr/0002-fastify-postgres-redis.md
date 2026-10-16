# ADR 0002: Fastify 5, postgres.js, Redis and BullMQ

Date: 2026-10-16. Status: accepted.

## Context

The migration plan chose Express 5 because the app monorepo already contained an Express + Drizzle scaffold. The
backend now lives in its own repository, so that reuse argument no longer applies.

## Decision

- **Fastify 5** for HTTP: schema-first validation, pino logging built in, encapsulated plugins, first-class graceful
  close, `under-pressure` load shedding, and the WebSocket plugin on the same server.
- **postgres.js** for Postgres: fast, safe tagged templates for domain code, `unsafe(text, params)` for the compat
  compiler's parameterised SQL, `LISTEN` support for Realtime, and a `prepare: false` switch for transaction poolers.
- No ORM. The `public` schema is owned by Supabase until cutover and is only known by introspection; a typed ORM
  schema would have to be guessed. Domain code uses explicit SQL with typed row interfaces.
- **Redis 7** for rate limits, caches, idempotency and pub/sub; **BullMQ** for jobs (delays, retries, repeatable
  jobs, per-queue concurrency).
- **zod** for configuration and request validation, **jose** for JWTs, **bcryptjs** to verify Supabase's bcrypt
  hashes and **@node-rs/argon2** for new ones.

## Consequences

Fewer moving parts than an ORM pipeline, and every SQL statement is visible in code review. The trade-off is hand-written
row types; they are kept next to the queries that produce them.
