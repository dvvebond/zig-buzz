#!/usr/bin/env bash
# Assemble the canonical TypeScript agent toolchain. The target is a package
# label only: JavaScript artifacts are architecture-independent and require
# Node.js 22+ on the destination.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TARGET="${1:-$(node -p '`${process.platform}-${process.arch}`')}"
case "${TARGET}" in
  *[!A-Za-z0-9._-]*|'')
    echo "invalid target label: ${TARGET}" >&2
    exit 1
    ;;
esac
OUTPUT="${ROOT}/dist/sidecars/${TARGET}"

cd "${ROOT}"
pnpm --filter @buzz/sprig build
rm -rf "${OUTPUT}"
mkdir -p "${OUTPUT}"
pnpm --config.allow-unused-patches=true \
  --filter @buzz/sprig deploy --legacy --prod "${OUTPUT}"
printf 'TypeScript sidecars bundled at %s\n' "${OUTPUT}"
