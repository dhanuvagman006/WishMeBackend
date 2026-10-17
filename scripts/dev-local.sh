#!/usr/bin/env bash
# Runs the whole local stack for the "WishMe Local" phone app: Postgres + Redis (docker-compose.dev.yml), the API on
# :3000, and the USB tunnel so the phone's localhost:3000 reaches this machine. Ctrl+C stops the API; the
# containers keep running (stop them with: docker compose -f docker-compose.dev.yml stop).
set -euo pipefail
cd "$(dirname "$0")/.."

docker compose -f docker-compose.dev.yml up -d --wait
./scripts/dev-setup.sh

if command -v adb >/dev/null && adb get-state >/dev/null 2>&1; then
  adb reverse tcp:3000 tcp:3000 && echo "Phone tunnel ready: the app's localhost:3000 -> this machine."
else
  echo "No phone on USB: plug it in and run 'adb reverse tcp:3000 tcp:3000'."
fi

echo "OTP codes for sign-up are printed below (look for 'email (log provider, not sent)')."
exec pnpm exec tsx --env-file=.env src/server.ts
