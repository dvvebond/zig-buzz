#!/usr/bin/env bash
# Start the canonical TypeScript relay and its backing services for integration
# tests. The historical --profile flag is accepted as a no-op so downstream CI
# callers can migrate independently.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
SKIP_BUILD=false
TEST_PORT="${BUZZ_TEST_RELAY_PORT:-3031}"
TEST_COMMUNITY="localhost:${TEST_PORT}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --profile)
      [[ $# -ge 2 ]] || { echo "--profile requires a value" >&2; exit 1; }
      shift 2
      ;;
    --no-build)
      SKIP_BUILD=true
      shift
      ;;
    *)
      echo "Unknown option: $1" >&2
      exit 1
      ;;
  esac
done

log() { printf '[relay-test] %s\n' "$*"; }
fail() { printf '[relay-test] %s\n' "$*" >&2; exit 1; }

cd "${REPO_ROOT}"
if ! [[ "${TEST_PORT}" =~ ^[0-9]+$ ]] ||
  (( TEST_PORT < 1 || TEST_PORT > 65535 )); then
  fail "BUZZ_TEST_RELAY_PORT must be an integer from 1 to 65535"
fi
log "Starting Postgres, Redis, and MinIO"
docker compose up -d postgres redis minio minio-init

wait_healthy() {
  local service="$1"
  local container="$2"
  local status
  for _ in $(seq 1 60); do
    status="$(docker inspect --format='{{.State.Health.Status}}' "${container}" 2>/dev/null || true)"
    if [[ "${status}" == "healthy" ]]; then
      log "${service} is healthy"
      return 0
    fi
    sleep 2
  done
  docker logs "${container}" >&2 || true
  fail "${service} did not become healthy within 120 seconds"
}

wait_healthy "Postgres" "buzz-postgres"
wait_healthy "Redis" "buzz-redis"
wait_healthy "MinIO" "buzz-minio"

export PGHOST=localhost
export PGPORT=5432
export PGUSER=buzz
export PGPASSWORD=buzz_dev
export PGDATABASE=buzz
export PGSCHEMA_PLAN_HOST=localhost
export PGSCHEMA_PLAN_PORT=5432
export PGSCHEMA_PLAN_DB=buzz
export PGSCHEMA_PLAN_USER=buzz
export PGSCHEMA_PLAN_PASSWORD=buzz_dev

log "Applying the database schema"
./bin/pgschema apply --file schema/schema.sql --auto-approve
docker exec -i -e PGPASSWORD="${PGPASSWORD}" buzz-postgres \
  psql -U "${PGUSER}" -d "${PGDATABASE}" -v ON_ERROR_STOP=1 \
  < scripts/attach-schema-partitions.sql

docker exec -i -e PGPASSWORD="${PGPASSWORD}" buzz-postgres \
  psql -U "${PGUSER}" -d "${PGDATABASE}" -v ON_ERROR_STOP=1 \
    -v community_host="${TEST_COMMUNITY}" <<'SQL'
INSERT INTO communities (id, host)
VALUES ('00000000-0000-4000-8000-00000000c0de', :'community_host')
ON CONFLICT (id) DO UPDATE SET host = EXCLUDED.host;
SQL

if [[ "${SKIP_BUILD}" == "true" ]]; then
  [[ -f apps/relay/dist/main.js ]] ||
    fail "--no-build requires apps/relay/dist/main.js"
  [[ -f packages/git-credential-nostr/dist/main.js ]] ||
    fail "--no-build requires packages/git-credential-nostr/dist/main.js"
  log "Using existing TypeScript build output"
else
  log "Building the TypeScript relay and git credential helper"
  pnpm --filter @buzz/relay build
  pnpm --filter @buzz/git-credential-nostr build
fi

if [[ -f /tmp/buzz-relay.pid ]]; then
  previous_pid="$(cat /tmp/buzz-relay.pid 2>/dev/null || true)"
  if [[ "${previous_pid}" =~ ^[0-9]+$ ]] && kill -0 "${previous_pid}" 2>/dev/null; then
    fail "a relay recorded in /tmp/buzz-relay.pid is still running"
  fi
fi

log "Starting the TypeScript relay"
nohup env \
  BUZZ_DATABASE_URL=postgres://buzz:buzz_dev@localhost:5432/buzz \
  BUZZ_REDIS_URL=redis://localhost:6379 \
  BUZZ_PUBLIC_URL="ws://${TEST_COMMUNITY}/" \
  BUZZ_HOST=0.0.0.0 \
  BUZZ_PORT="${TEST_PORT}" \
  BUZZ_S3_ENDPOINT=http://localhost:9000 \
  BUZZ_S3_ACCESS_KEY=buzz_dev \
  BUZZ_S3_SECRET_KEY=buzz_dev_secret \
  BUZZ_S3_BUCKET=buzz-media \
  BUZZ_S3_FORCE_PATH_STYLE=true \
  node apps/relay/dist/main.js > /tmp/buzz-relay.log 2>&1 &
relay_pid=$!
printf '%s\n' "${relay_pid}" > /tmp/buzz-relay.pid

cleanup_failed_relay() {
  if kill -0 "${relay_pid}" 2>/dev/null; then
    kill "${relay_pid}" 2>/dev/null || true
    wait "${relay_pid}" 2>/dev/null || true
  fi
}

for _ in $(seq 1 60); do
  kill -0 "${relay_pid}" 2>/dev/null || {
    cat /tmp/buzz-relay.log >&2
    fail "relay process exited during startup"
  }
  readiness="$(curl -fsS \
    -H "Host: ${TEST_COMMUNITY}" \
    "http://127.0.0.1:${TEST_PORT}/_readiness" 2>/dev/null || true)"
  if [[ "${readiness}" == '{"status":"ready"}' ]]; then
    log "Relay is ready at ws://${TEST_COMMUNITY}"
    exit 0
  fi
  sleep 1
done

cat /tmp/buzz-relay.log >&2
cleanup_failed_relay
fail "relay did not become ready within 60 seconds"
