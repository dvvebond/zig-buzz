#!/usr/bin/env bash
# Compute a stable, isolated TypeScript desktop environment for this worktree.
# Source this file before running `pnpm desktop` when several worktrees are
# active at once.
set -euo pipefail

WORKTREE_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
BASE_PORT="$(python3 -c 'import hashlib,sys; print(10000 + int(hashlib.sha256(sys.argv[1].encode()).hexdigest(), 16) % 50000)' "${WORKTREE_ROOT}")"

export BUZZ_VITE_PORT="${BASE_PORT}"
export BUZZ_HMR_PORT="$((BASE_PORT + 1))"
export VITE_PORT="${BUZZ_VITE_PORT}"
export VITE_HMR_PORT="${BUZZ_HMR_PORT}"
export BUZZ_RELAY_URL="${BUZZ_RELAY_URL:-ws://localhost:3000}"

BRANCH_NAME="$(git -C "${WORKTREE_ROOT}" rev-parse --abbrev-ref HEAD 2>/dev/null || printf main)"
INSTANCE_SLUG="$(printf '%s' "${BRANCH_NAME}" | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9]/-/g; s/--*/-/g; s/^-//; s/-$//')"
if [[ -z "${INSTANCE_SLUG}" ]]; then INSTANCE_SLUG="main"; fi

export BUZZ_INSTANCE_SLUG="${INSTANCE_SLUG}"
export BUZZ_WORKTREE_LABEL="${BRANCH_NAME##*/}"
export VITE_DEV_BRANCH="${BUZZ_WORKTREE_LABEL}"
export BUZZ_DESKTOP_DATA_DIR="${BUZZ_DESKTOP_DATA_DIR:-${WORKTREE_ROOT}/.buzz-desktop/${INSTANCE_SLUG}}"

printf 'Buzz desktop instance: %s (UI port %s, data %s)\n' \
  "${BUZZ_WORKTREE_LABEL}" "${BUZZ_VITE_PORT}" "${BUZZ_DESKTOP_DATA_DIR}" >&2
