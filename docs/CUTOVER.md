# Cutover: moving the data off Supabase

Until cutover the server uses the Supabase database (`DB_MODE=shared`). Cutover moves the data once, in a rehearsed
maintenance window, and then Supabase is switched off. Do it only when every route group has been `local` for at least
two weeks without incident.

## Before

1. Run the audit in the app repository (`scripts/supabase-audit`) to export schema, RLS policies, functions and
   edge-function source; check `docs/BACKEND_AUDIT_FINDINGS.md` for triggers and cron jobs that must be replaced.
2. Raise `APP_MIN_VERSION` to a build that points at this server, so no installed app still talks to Supabase.
3. Copy Supabase Storage buckets to B2 (`rclone sync supabase:<bucket> b2:<bucket>/storage/<bucket>`), and prepare
   the URL rewrite for columns that store `…supabase.co/storage/v1/object/public/…`.
4. Replace what Supabase-only extensions do today. The audit shows `pg_net` triggers (`notify_wallet_topup`,
   `notify_referral_earning`, booking status notifications) calling `send-wishme-notification`, and `pg_cron` jobs
   (see the export's `data-cron.sql`). On vanilla Postgres those calls fail (the triggers swallow the error), so the
   same notifications must be produced by this server's `notifications` queue and the cron jobs by repeatable jobs
   before cutover. Drop or rewrite those triggers in the restored database.
   The `handle_auto_reply_on_message` trigger on `messages` also calls an edge function for the celebrity AI reply.
   Once the `functions` route group is local, this server sends that reply itself, so drop the trigger (or point it
   at this server) when switching that group, not only at cutover; with both running, fans get two replies.
5. Rehearse twice on a staging VPS with fresh dumps. Record the timings.

## During (target: 30 minutes)

1. Announce maintenance. Put Supabase in read-only (revoke write privileges from the API role; stop Supabase cron).
2. Stop the worker: `docker compose stop worker`.
3. `pg_dump` the Supabase database (schemas `public`, `auth`, `wishme`, `storage` metadata) and restore it into the
   VPS Postgres: `docker compose --profile standalone up -d postgres`, then `pg_restore`.
4. Run the URL rewrite. Verify row counts against the source and the ledger invariant
   (`select … from wishme.ledger_entries` vs balance columns).
5. In `.env`: `DB_MODE=standalone`, `DATABASE_URL`/`DATABASE_URL_DIRECT` to the local Postgres, `DB_SSL=disable`,
   `COMPAT_DEFAULT_MODE=local`, `ROUTE_MODES={}`, remove `SUPABASE_URL`.
   Keep `SUPABASE_JWT_SECRET` for one week so tokens issued before the switch stay valid until they expire.
6. `docker compose run --rm migrate` (applies the standalone-only migration if anything is missing),
   `docker compose up -d`.
7. Point the Razorpay and Vapi webhooks at this server if any still point at Supabase.
8. Smoke test: sign in, wallet balance, a ₹1 test deposit with Razorpay test mode on staging, a booking, chat.

## After

1. Switch signing to Ed25519: generate a key (`openssl genpkey -algorithm ed25519`), set `JWT_SIGNING=eddsa`,
   `JWT_PRIVATE_KEY`, deploy. Remove `SUPABASE_JWT_SECRET` a week later.
2. Enable WAL archiving for point-in-time recovery; run a restore drill.
3. Watch error rates, payment reconciliation and queue depth for two weeks with Supabase kept read-only.
4. Take a final encrypted dump of Supabase, archive it, and delete the Supabase project.
5. Production triggers still move money outside the ledger: booking and wish-order earnings for celebrities, referral
   and booking commissions, TDS. They keep working after the restore (plain PL/pgSQL), and the nightly invariant check
   skips accounts they touched. Replace them with ledger movements one at a time, each with a test, then drop them.
