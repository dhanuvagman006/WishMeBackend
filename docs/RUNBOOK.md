# Runbook

Everything lives in `/opt/wishme` on the VPS: `docker-compose.yml`, `Caddyfile`, `.env` (mode 600), `scripts/`.

## First install

1. Fresh Ubuntu 24.04 VPS, ideally in the same region as the Supabase project until cutover (Mumbai if it is there).
2. `bash deploy/scripts/harden-vps.sh deploy "<your ssh public key>"` as root, then follow its printed steps.
3. DNS: an `A` (and `AAAA`) record for `API_DOMAIN` pointing at the VPS.
4. Copy `deploy/*` to `/opt/wishme`, create `.env` from `.env.example`.
   - Shared mode needs `DATABASE_URL` (Supabase session pooler or direct connection, dedicated role),
     `DATABASE_URL_DIRECT`, `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_JWT_SECRET`.
   - Generate `AUTH_PEPPER` with `openssl rand -base64 48`. Never change it later: it invalidates OTPs and sessions.
5. `docker compose run --rm migrate`, then `docker compose up -d`.
6. Check `https://<API_DOMAIN>/api/readyz` returns `{"status":"ready",...}`.
7. Razorpay dashboard → Webhooks: `https://<API_DOMAIN>/api/v1/webhooks/razorpay`, events `payment.captured`,
   `payment.failed`, `order.paid`, with `RAZORPAY_WEBHOOK_SECRET`.

## Deploy

CI builds `ghcr.io/<owner>/wishmebackend:<sha>` on every merge to `main`. Deploy with the **Deploy** workflow
(manual, requires approval) or on the server: `/opt/wishme/scripts/deploy.sh <sha>`. It migrates, replaces API
replicas one by one, and rolls back automatically if the new version is not ready.

Migrations must stay backward compatible with the previous release (add, then use, then remove in a later release).

## Rollback

`/opt/wishme/scripts/deploy.sh <previous sha>`. Database migrations are forward-only; a release that needs a schema
undo gets a new migration.

## Route modes

Change `ROUTE_MODES` / `COMPAT_DEFAULT_MODE` in `.env`, then `docker compose up -d api` (rolling). See
[APP_SWITCH.md](APP_SWITCH.md).

## Health and monitoring

- `GET /api/healthz` (process up) and `GET /api/readyz` (database, Redis, schema cache).
- Metrics: `GET /metrics` with `Authorization: Bearer $METRICS_TOKEN`, from inside the network (Caddy hides it).
- Logs: `docker compose logs -f api worker` (JSON, with `reqId`). Every response carries `x-request-id`.
- Alert on: readiness failures, 5xx rate, `LEDGER INVARIANT MISMATCH` log lines, failed jobs, disk above 80 %.

## Backups

- Nightly encrypted dump to B2 (`wishme-backup.timer`); check with `systemctl list-timers` and the B2 bucket.
- **Monthly restore drill**: `scripts/restore.sh <name> <identity file>` into `wishme_restore_drill`; record the time.
- After cutover, add continuous WAL archiving (pgBackRest or wal-g to a separate B2 bucket) for point-in-time recovery.

## Incidents

| Symptom | First checks |
| --- | --- |
| 503s with `Retry-After` | Load shedding: `docker stats`, slow queries (`log_min_duration_statement`), scale `API_REPLICAS`. |
| Payments not credited | `wishme.payment_orders` status, `wishme.razorpay_events.error`, worker logs for `reconcile-orders` (runs every 10 minutes and fulfils captured payments it finds). |
| Users signed out | `AUTH_PEPPER` or JWT secret changed? Refresh token reuse warnings in logs (possible theft or a client bug). |
| Realtime silent | `DATABASE_URL_DIRECT` must be a session connection; check `realtime listening` at startup and the triggers from migration 0003. |
| A route misbehaves after switching to local | Set its group back to `proxy` in `ROUTE_MODES`, redeploy, investigate. |
