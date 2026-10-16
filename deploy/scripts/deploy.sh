#!/usr/bin/env bash
# Zero-downtime deploy of a new image tag on the VPS.
#   sudo /opt/wishme/scripts/deploy.sh <tag>
# 1. pull the image, 2. run migrations (forward-only, backward-compatible), 3. replace API replicas one at a time with
# docker-rollout (new container healthy before the old one is stopped), 4. restart the worker, 5. verify readiness,
# and roll back to the previous tag if the new one never becomes ready.
set -euo pipefail

cd /opt/wishme
NEW_TAG="${1:?usage: deploy.sh <image tag>}"
PREV_TAG="$(grep -E '^TAG=' .env | cut -d= -f2-)"
API_DOMAIN="$(grep -E '^API_DOMAIN=' .env | cut -d= -f2-)"

log() { printf '%s %s\n' "$(date -u +%FT%TZ)" "$*"; }

set_tag() { sed -i "s/^TAG=.*/TAG=$1/" .env; }

ready() {
  for _ in $(seq 1 30); do
    if curl -fsS --max-time 3 "https://${API_DOMAIN}/api/readyz" >/dev/null; then return 0; fi
    sleep 2
  done
  return 1
}

log "deploying ${NEW_TAG} (previous ${PREV_TAG})"
set_tag "$NEW_TAG"
docker compose pull api worker migrate

log "running migrations"
docker compose run --rm migrate

log "rolling api replicas"
if docker rollout --help >/dev/null 2>&1; then
  docker rollout api
else
  log "docker-rollout not installed: falling back to a plain recreate (brief interruption)"
  docker compose up -d --no-deps api
fi

docker compose up -d --no-deps worker caddy

if ready; then
  log "deploy ${NEW_TAG} healthy"
  docker image prune -f >/dev/null
else
  log "NOT READY after deploy: rolling back to ${PREV_TAG}"
  set_tag "$PREV_TAG"
  docker compose pull api worker
  docker compose up -d --no-deps api worker
  exit 1
fi
