# ADR 0001: Serve the Supabase protocol, proxy what is not migrated yet

Date: 2026-10-16. Status: accepted.

## Context

The migration plan in the app repository (`docs/BACKEND_MIGRATION_PLAN.md`) proposes a new `/api/v1` and moving the
app to it screen by screen. The owner asked for a backend that connects to the **current** app seamlessly. The app
has about 150 hand-built Supabase calls across 47 tables, 6 RPCs, 46 edge functions, 6 buckets and Realtime, and old
builds stay installed for months.

## Decision

This server implements the Supabase wire protocol for exactly the calls the app makes (GoTrue, a PostgREST subset,
the named edge functions, Storage object routes, Realtime `postgres_changes`), and forwards every route group it has
not taken over yet to the real Supabase project. Each group is switched from `proxy` to `local` by configuration.
A clean `/api/v1` is built alongside for new app code.

## Consequences

- The app switches backends by changing one URL, with no code change, and can do so before anything is migrated.
- Old builds keep working through the whole migration.
- Migration risk is per route group and reversible without a release.
- We maintain a PostgREST-compatible query compiler. It is deliberately a subset: only operators the app uses, only
  tables and columns with a policy, no arbitrary SQL. Anything else is rejected with PostgREST's error shape.
- Security holes in today's protocol (client-written money rows, decorative OTP, anonymous profile lookups) are closed
  inside the compat handlers, so the app does not need to change for them to close.
