#!/usr/bin/env bash
# Nightly encrypted logical backup to Backblaze B2 (run by the systemd timer installed by harden-vps.sh).
#   - shared mode: dumps the Supabase database through DATABASE_URL_DIRECT (a safety copy you control)
#   - standalone mode: dumps the local Postgres container
# Dumps are encrypted with `age` to a public key whose private half is kept offline by the owner, then streamed to a
# private B2 bucket via rclone. Retention is enforced by a B2 lifecycle rule (keep 30 days), not by this script, so a
# compromised server cannot delete history if its key lacks deleteFiles.
set -euo pipefail

cd /opt/wishme
set -a; source .env; set +a
: "${BACKUP_AGE_RECIPIENT:?set BACKUP_AGE_RECIPIENT (age public key) in .env}"
: "${BACKUP_RCLONE_REMOTE:?set BACKUP_RCLONE_REMOTE, e.g. b2backup:wishme-db-backups}"

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
NAME="wishme-${DB_MODE}-${STAMP}.dump.age"

if [ "${DB_MODE}" = "standalone" ]; then
  docker compose exec -T postgres pg_dump -U "${POSTGRES_USER:-wishme}" -d "${POSTGRES_DB:-wishme}" -Fc --no-owner
else
  docker run --rm -e PGSSLMODE=require postgres:16-alpine pg_dump "${DATABASE_URL_DIRECT:-$DATABASE_URL}" -Fc --no-owner \
    --schema=public --schema=auth --schema=wishme
fi | age -r "${BACKUP_AGE_RECIPIENT}" | rclone rcat "${BACKUP_RCLONE_REMOTE}/${NAME}"

echo "$(date -u +%FT%TZ) backup uploaded: ${NAME}"
