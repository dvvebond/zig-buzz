#!/usr/bin/env bash
# Build the deploy-anywhere TypeScript Sprig multicall distribution.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VERSION="${1:-${VERSION:-$(node -p "require('${ROOT}/apps/sprig/package.json').version")}}"
TARGET="${2:-${TARGET:-$(node -p '`${process.platform}-${process.arch}`')}}"
DIST_DIR="${DIST_DIR:-${ROOT}/dist}"
ARCHIVE_BASENAME="${ARCHIVE_BASENAME:-sprig-${VERSION}-${TARGET}}"

for value in "${VERSION}" "${TARGET}" "${ARCHIVE_BASENAME}"; do
  case "${value}" in
    *[!A-Za-z0-9._-]*|'')
      echo "unsafe version, target, or archive label: ${value}" >&2
      exit 1
      ;;
  esac
done

cd "${ROOT}"
if [[ "${SKIP_BUILD:-0}" != "1" ]]; then
  pnpm --filter @buzz/sprig build
fi

STAGING="$(mktemp -d)"
trap 'rm -rf "${STAGING}"' EXIT
pnpm --config.allow-unused-patches=true \
  --filter @buzz/sprig deploy --legacy --prod "${STAGING}/sprig"

GIT_SHA="$(git rev-parse HEAD 2>/dev/null || printf unknown)"
node - "${STAGING}/sprig" "${VERSION}" "${TARGET}" "${GIT_SHA}" <<'NODE'
const fs = require("node:fs");
const path = require("node:path");
const [root, version, target, gitSha] = process.argv.slice(2);
fs.writeFileSync(
  path.join(root, "sprig.json"),
  `${JSON.stringify({
    format: "sprig-typescript",
    git_sha: gitSha,
    node: ">=22",
    target,
    version,
  }, null, 2)}\n`,
);
NODE

mkdir -p "${DIST_DIR}"
ARCHIVE_PATH="${DIST_DIR}/${ARCHIVE_BASENAME}.tar.gz"
rm -f "${ARCHIVE_PATH}" "${ARCHIVE_PATH}.sha256"
tar -C "${STAGING}" -czf "${ARCHIVE_PATH}" sprig
if command -v sha256sum >/dev/null 2>&1; then
  sha256sum "${ARCHIVE_PATH}" > "${ARCHIVE_PATH}.sha256"
else
  shasum -a 256 "${ARCHIVE_PATH}" > "${ARCHIVE_PATH}.sha256"
fi
printf '%s\n' "${ARCHIVE_PATH}"
