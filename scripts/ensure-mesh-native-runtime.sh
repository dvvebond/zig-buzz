#!/usr/bin/env bash
# The mesh runtime is portable JavaScript with no native sidecar. Build it and
# return its package root for compatibility with cache-directory callers.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${ROOT}"
pnpm --filter @buzz/relay-mesh build >&2
printf '%s\n' "${ROOT}/packages/relay-mesh"
