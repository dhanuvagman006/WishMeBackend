# ADR 0003: One database until cutover, with Supabase RLS kept as a second wall

Date: 2026-10-16. Status: accepted.

## Context

During the migration some routes are served here and some are proxied to Supabase. Two databases would need two-way
sync, which is where money and orders get duplicated or lost.

## Decision

- `DB_MODE=shared`: this server connects to the existing Supabase Postgres. Proxied and local routes see the same rows.
- Compat queries run with `SET LOCAL ROLE authenticated` (or `anon`) and `request.jwt.claims` set, exactly as PostgREST
  does, so Supabase's existing row-level security still applies **in addition to** our own policies
  (`DB_RLS_PASSTHROUGH=true`). Our policy is the first wall and the database's RLS is the second.
- Server-side operations that must bypass RLS (ledger writes, fulfilment, admin jobs) run as the connection role and are
  only reachable through domain services, never through the compat query compiler.
- Schema changes in shared mode are additive and live in the `wishme` schema, plus change-notification triggers on the
  tables Realtime needs.
- Data moves once, at cutover (`docs/CUTOVER.md`), after which `DB_MODE=standalone`.

## Consequences

No sync jobs and no split-brain balances. The API's database latency depends on the distance to Supabase's region
until cutover, so the VPS should be in or near the same region (Mumbai, `ap-south-1`, if the project is there).
