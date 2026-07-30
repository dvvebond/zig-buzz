#!/usr/bin/env bash
# Fully isolated TypeScript relay harness for desktop parity and performance
# runs. The historical --profile flag is accepted but no longer changes output.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
cd "${REPO_ROOT}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --profile)
      [[ $# -ge 2 ]] || { echo "--profile requires a value" >&2; exit 1; }
      shift 2
      ;;
    *)
      echo "Unknown option: $1" >&2
      exit 1
      ;;
  esac
done

PROJECT=buzz-harness
COMPOSE_FILE=docker-compose.harness.yml
PG_PORT=5471
REDIS_PORT=6471
MINIO_PORT=9471
RELAY_MAIN=3030
COMMUNITY_HOST="localhost:${RELAY_MAIN}"
RELAY_LOG="${RELAY_LOG:-/tmp/dawn-relay-run.log}"
TMUX_SESSION="${TMUX_SESSION:-dawn-relay}"

log() { printf '[isolated-relay] %s\n' "$*"; }
fail() { printf '[isolated-relay] %s\n' "$*" >&2; exit 1; }

docker compose -p "${PROJECT}" -f "${COMPOSE_FILE}" up -d
for _ in $(seq 1 60); do
  if docker compose -p "${PROJECT}" -f "${COMPOSE_FILE}" exec -T postgres \
    pg_isready -U buzz >/dev/null 2>&1; then
    break
  fi
  sleep 2
done
docker compose -p "${PROJECT}" -f "${COMPOSE_FILE}" exec -T postgres \
  pg_isready -U buzz >/dev/null 2>&1 ||
  fail "isolated Postgres did not become ready"

psql_h() {
  docker compose -p "${PROJECT}" -f "${COMPOSE_FILE}" exec -T postgres \
    psql -U buzz -d buzz -v ON_ERROR_STOP=1 "$@"
}
psql_h -c "DROP SCHEMA public CASCADE; CREATE SCHEMA public;"
export PGPASSWORD=buzz_dev
export PGSCHEMA_PLAN_HOST=localhost
export PGSCHEMA_PLAN_PORT="${PG_PORT}"
export PGSCHEMA_PLAN_DB=buzz
export PGSCHEMA_PLAN_USER=buzz
export PGSCHEMA_PLAN_PASSWORD=buzz_dev
export PGHOST=localhost
export PGPORT="${PG_PORT}"
export PGUSER=buzz
export PGDATABASE=buzz
./bin/pgschema apply --file schema/schema.sql --auto-approve
psql_h < scripts/attach-schema-partitions.sql

BUZZ_COMMUNITY_HOST="${COMMUNITY_HOST}" \
  BUZZ_DB_HOST=localhost \
  BUZZ_DB_PORT="${PG_PORT}" \
  BUZZ_DB_USER=buzz \
  BUZZ_DB_PASS=buzz_dev \
  BUZZ_DB_NAME=buzz \
  BUZZ_DB_DOCKER_CONTAINER="${PROJECT}-postgres-1" \
  ./scripts/setup-desktop-test-data.sh

pnpm --filter @buzz/relay build
tmux kill-session -t "${TMUX_SESSION}" 2>/dev/null || true
if command -v lsof >/dev/null 2>&1 &&
  lsof -nP -iTCP:"${RELAY_MAIN}" -sTCP:LISTEN >/dev/null 2>&1; then
  fail "port ${RELAY_MAIN} is already in use"
fi

tmux new-session -d -s "${TMUX_SESSION}" "cd '${REPO_ROOT}' && env \
  BUZZ_DATABASE_URL=postgres://buzz:buzz_dev@localhost:${PG_PORT}/buzz \
  BUZZ_REDIS_URL=redis://localhost:${REDIS_PORT} \
  BUZZ_PUBLIC_URL=ws://localhost:${RELAY_MAIN}/ \
  BUZZ_HOST=0.0.0.0 \
  BUZZ_PORT=${RELAY_MAIN} \
  BUZZ_S3_ENDPOINT=http://localhost:${MINIO_PORT} \
  BUZZ_S3_ACCESS_KEY=buzz_dev \
  BUZZ_S3_SECRET_KEY=buzz_dev_secret \
  BUZZ_S3_BUCKET=buzz-media \
  BUZZ_S3_FORCE_PATH_STYLE=true \
  node apps/relay/dist/main.js > '${RELAY_LOG}' 2>&1"

for _ in $(seq 1 30); do
  if curl -fsS -H "Host: ${COMMUNITY_HOST}" \
    "http://127.0.0.1:${RELAY_MAIN}/_readiness" >/dev/null; then
    log "Relay live at http://localhost:${RELAY_MAIN}"
    log "Logs: ${RELAY_LOG}; attach: tmux attach -t ${TMUX_SESSION}"
    exit 0
  fi
  sleep 1
done

tail -200 "${RELAY_LOG}" >&2 || true
fail "relay did not start within 30 seconds"
