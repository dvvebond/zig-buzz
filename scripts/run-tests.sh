#!/usr/bin/env bash
# Canonical TypeScript test runner. Integration mode provisions the same
# Postgres/Redis/MinIO boundary used by production before executing the suites.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
MODE="${1:-all}"
cd "${REPO_ROOT}"

test_relay_started=false

cleanup_test_relay() {
  if [[ "${test_relay_started}" != "true" ]] ||
    [[ ! -f /tmp/buzz-relay.pid ]]; then
    return
  fi
  local relay_pid
  relay_pid="$(cat /tmp/buzz-relay.pid 2>/dev/null || true)"
  if [[ "${relay_pid}" =~ ^[0-9]+$ ]] && kill -0 "${relay_pid}" 2>/dev/null; then
    kill "${relay_pid}" 2>/dev/null || true
    wait "${relay_pid}" 2>/dev/null || true
  fi
}

start_test_relay() {
  ./scripts/start-relay-for-tests.sh
  test_relay_started=true
  trap cleanup_test_relay EXIT
}

run_typescript_integration_tests() {
  BUZZ_RUN_INTEGRATION=1 \
    BUZZ_TEST_DATABASE_URL="${BUZZ_TEST_DATABASE_URL:-postgres://buzz:buzz_dev@localhost:5432/buzz}" \
    BUZZ_TEST_REDIS_URL="${BUZZ_TEST_REDIS_URL:-redis://localhost:6379}" \
    pnpm test:typescript
}

case "${MODE}" in
  unit)
    pnpm test:typescript
    pnpm -C desktop test
    pnpm -C web typecheck
    pnpm -C admin-web test
    ;;
  integration)
    start_test_relay
    run_typescript_integration_tests
    ;;
  all)
    pnpm test:typescript
    pnpm -C desktop test
    pnpm -C web typecheck
    pnpm -C admin-web test
    start_test_relay
    run_typescript_integration_tests
    ;;
  *)
    echo "Usage: $0 [unit|integration|all]" >&2
    exit 1
    ;;
esac
