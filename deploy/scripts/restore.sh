#!/usr/bin/env bash
# Restores an encrypted dump into the local Postgres container (standalone mode, or a restore drill into a scratch
# database). Needs the age PRIVATE key, which lives offline: copy it in only for the restore and delete it after.
#   ./restore.sh <backup name> <age identity file> [target database]
set -euo pipefail

cd /opt/wishme
set -a; source .env; set +a
NAME="${1:?backup name, e.g. wishme-shared-20261016T020000Z.dump.age}"
IDENTITY="${2:?path to the age identity (private key) file}"
TARGET_DB="${3:-wishme_restore_drill}"
USER_="${POSTGRES_USER:-wishme}"

docker compose exec -T postgres psql -U "$USER_" -d postgres -c "drop database if exists ${TARGET_DB}" -c "create database ${TARGET_DB}"
START=$(date +%s)
rclone cat "${BACKUP_RCLONE_REMOTE}/${NAME}" | age -d -i "$IDENTITY" \
  | docker compose exec -T postgres pg_restore -U "$USER_" -d "$TARGET_DB" --no-owner --exit-on-error
echo "restored ${NAME} into ${TARGET_DB} in $(( $(date +%s) - START ))s"
docker compose exec -T postgres psql -U "$USER_" -d "$TARGET_DB" -c \
  "select (select count(*) from public.profiles) as profiles, (select count(*) from wishme.ledger_entries) as ledger_entries"
