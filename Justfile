set dotenv-load := true
set shell := ["bash", "-euo", "pipefail", "-c"]

desktop_dir := "desktop"
web_dir := "web"
admin_web_dir := "admin-web"
mobile_dir := "apps/mobile"
mesh := ""
fresh := ""

default:
    @./bin/just --list

# Install the complete TypeScript workspace.
bootstrap:
    corepack enable
    pnpm install --frozen-lockfile

# Install dependencies, provision backing services, apply schema, and hooks.
setup: bootstrap _ensure-migrations hooks

hooks:
    ./scripts/setup-hooks.sh

reset:
    docker compose down -v
    docker compose up -d postgres redis minio minio-init
    ./bin/just migrate

down:
    docker compose down

ps:
    docker compose ps

logs *ARGS:
    docker compose logs -f {{ARGS}}

build:
    pnpm build

build-release:
    pnpm build
    pnpm package:desktop

check: fmt-check typescript-check desktop-check web-check admin-web-check mobile-check

fmt:
    pnpm format
    pnpm -C {{desktop_dir}} format
    pnpm -C {{web_dir}} format
    pnpm -C {{admin_web_dir}} format

fmt-check:
    pnpm format:check
    pnpm -C {{desktop_dir}} exec biome format .
    pnpm -C {{web_dir}} exec biome format .
    pnpm -C {{admin_web_dir}} exec biome format .

# Historical name retained for callers; this is now the strict TypeScript gate.
clippy: typescript-check

typescript-check:
    pnpm check

desktop-install:
    pnpm install

desktop-install-ci:
    pnpm install --frozen-lockfile

desktop-check:
    pnpm -C {{desktop_dir}} check
    pnpm --filter @buzz/desktop-host check

desktop-fix:
    pnpm -C {{desktop_dir}} exec biome check --write .

desktop-test:
    pnpm -C {{desktop_dir}} test
    pnpm --filter @buzz/desktop-host test

desktop-typecheck:
    pnpm -C {{desktop_dir}} typecheck
    pnpm --filter @buzz/desktop-host build

desktop-build:
    pnpm -C {{desktop_dir}} build

fmt-all: fmt mobile-fmt

fix-all: fmt desktop-fix web-fix mobile-fix

_ensure-services:
    #!/usr/bin/env bash
    docker compose up -d postgres redis minio minio-init
    for container in buzz-postgres buzz-redis buzz-minio; do
    for _ in $(seq 1 60); do
    status="$(docker inspect --format='{{"{{"}}.State.Health.Status{{"}}"}}' "$container" 2>/dev/null || true)"
    [[ "$status" == healthy ]] && break
    sleep 2
    done
    status="$(docker inspect --format='{{"{{"}}.State.Health.Status{{"}}"}}' "$container" 2>/dev/null || true)"
    [[ "$status" == healthy ]] || { docker logs "$container" || true; exit 1; }
    done

_ensure-migrations: _ensure-services
    ./bin/just migrate

desktop-release-build target="host":
    node --experimental-strip-types scripts/package-desktop.mts --archive --platform {{target}}

desktop-ci: desktop-check desktop-test desktop-build

desktop-e2e-seed: _ensure-migrations
    ./scripts/setup-desktop-test-data.sh

desktop-e2e-smoke:
    pnpm -C {{desktop_dir}} test:e2e:smoke

desktop-e2e-integration: _ensure-migrations
    pnpm -C {{desktop_dir}} test:e2e:integration

desktop-e2e-pre-push: desktop-e2e-integration

ci: check test-unit desktop-build web-build admin-web-build mobile-build-android

test:
    ./scripts/run-tests.sh all

test-unit:
    ./scripts/run-tests.sh unit

test-integration:
    ./scripts/run-tests.sh integration

mesh-e2e:
    pnpm --filter @buzz/relay-mesh check
    pnpm --filter @buzz/relay test

mesh-dev-fresh: mesh-e2e

mesh-e2e-hardware: mesh-e2e

mesh-e2e-admission: mesh-e2e

mesh-e2e-confidence: mesh-e2e

desktop-screenshot *ARGS:
    pnpm -C {{desktop_dir}} build:e2e
    pnpm -C {{desktop_dir}} exec playwright test tests/e2e/config-bridge-screenshots.spec.ts {{ARGS}}

relay: bootstrap _ensure-migrations
    BUZZ_PUBLIC_URL="${BUZZ_PUBLIC_URL:-ws://localhost:3000/}" \
      BUZZ_HOST="${BUZZ_HOST:-127.0.0.1}" \
      pnpm --filter @buzz/relay build
    BUZZ_PUBLIC_URL="${BUZZ_PUBLIC_URL:-ws://localhost:3000/}" \
      BUZZ_HOST="${BUZZ_HOST:-127.0.0.1}" \
      pnpm --filter @buzz/relay start

relay-web: bootstrap _ensure-migrations
    pnpm -C {{web_dir}} build
    BUZZ_WEB_DIR="{{justfile_directory()}}/{{web_dir}}/dist" \
      BUZZ_PUBLIC_URL="${BUZZ_PUBLIC_URL:-ws://localhost:3000/}" \
      pnpm --filter @buzz/relay build
    BUZZ_WEB_DIR="{{justfile_directory()}}/{{web_dir}}/dist" \
      BUZZ_PUBLIC_URL="${BUZZ_PUBLIC_URL:-ws://localhost:3000/}" \
      pnpm --filter @buzz/relay start

admin: bootstrap _ensure-migrations
    pnpm -C {{admin_web_dir}} build
    BUZZ_ADMIN_HOST="${BUZZ_ADMIN_HOST:-admin.localhost:3000}" \
      BUZZ_ADMIN_WEB_DIR="{{justfile_directory()}}/{{admin_web_dir}}/dist" \
      pnpm --filter @buzz/relay build
    BUZZ_ADMIN_HOST="${BUZZ_ADMIN_HOST:-admin.localhost:3000}" \
      BUZZ_ADMIN_WEB_DIR="{{justfile_directory()}}/{{admin_web_dir}}/dist" \
      pnpm --filter @buzz/relay start

admin-seed: _ensure-migrations
    pnpm --filter @buzz/admin build
    node apps/admin/dist/main.js seed

admin-check:
    pnpm --filter @buzz/admin check
    pnpm -C {{admin_web_dir}} check

relay-release: _ensure-migrations
    NODE_ENV=production pnpm --filter @buzz/relay build
    NODE_ENV=production pnpm --filter @buzz/relay start

dev *ARGS: bootstrap _ensure-migrations
    #!/usr/bin/env bash
    pnpm --filter @buzz/relay build
    BUZZ_PUBLIC_URL="${BUZZ_PUBLIC_URL:-ws://localhost:3000/}" \
    node apps/relay/dist/main.js >/tmp/buzz-dev-relay.log 2>&1 &
    relay_pid=$!
    cleanup() { kill "$relay_pid" 2>/dev/null || true; }
    trap cleanup EXIT
    for _ in $(seq 1 60); do
    curl -fsS http://127.0.0.1:3000/_readiness >/dev/null && break
    kill -0 "$relay_pid" 2>/dev/null || { tail -200 /tmp/buzz-dev-relay.log; exit 1; }
    sleep 1
    done
    pnpm -C {{desktop_dir}} desktop {{ARGS}}

desktop-standalone *ARGS:
    BUZZ_DESKTOP_NO_OPEN="${BUZZ_DESKTOP_NO_OPEN:-0}" pnpm -C {{desktop_dir}} desktop {{ARGS}}

staging *ARGS:
    BUZZ_RELAY_URL=wss://sprout-oss.stage.blox.sqprod.co pnpm -C {{desktop_dir}} desktop {{ARGS}}

production *ARGS:
    BUZZ_RELAY_URL=wss://buzz.block.builderlab.xyz pnpm -C {{desktop_dir}} desktop {{ARGS}}

desktop-dev:
    pnpm -C {{desktop_dir}} dev

web:
    pnpm -C {{web_dir}} dev

web-check:
    pnpm -C {{web_dir}} check

web-fix:
    pnpm -C {{web_dir}} exec biome check --write .

web-typecheck:
    pnpm -C {{web_dir}} typecheck

web-build:
    pnpm -C {{web_dir}} build

web-e2e-smoke:
    pnpm -C {{web_dir}} test:e2e:smoke

admin-web-check:
    pnpm -C {{admin_web_dir}} check

admin-web-build:
    pnpm -C {{admin_web_dir}} build

mobile-install:
    pnpm install --frozen-lockfile

mobile-fmt:
    pnpm exec biome format --write {{mobile_dir}}

mobile-fix:
    pnpm exec biome check --write {{mobile_dir}}
    pnpm --filter @buzz/mobile check

mobile-check:
    pnpm --filter @buzz/mobile check
    pnpm --filter @buzz/mobile doctor

mobile-test:
    pnpm --filter @buzz/mobile test

mobile-build-android:
    pnpm --filter @buzz/mobile exec expo export --platform android --output-dir dist/android

mobile-dev:
    #!/usr/bin/env bash
    ./scripts/mobile-worktree-overrides.sh
    set -a
    if [[ -f "{{mobile_dir}}/.env.worktree.local" ]]; then
        source "{{mobile_dir}}/.env.worktree.local"
    fi
    set +a
    pnpm --filter @buzz/mobile start

mobile-clean:
    ./scripts/mobile-worktree-clean.sh

migrate:
    pnpm --filter @buzz/admin build
    node apps/admin/dist/main.js migrate

clean:
    find apps packages -type d -name dist -prune -exec rm -rf {} +
    rm -rf desktop/dist web/dist admin-web/dist dist

check-compile:
    pnpm build:typescript

get-current-version:
    @node -p "require('./desktop/package.json').version"

get-current-relay-version:
    @node -p "require('./apps/relay/package.json').version"

get-next-minor-version:
    @node -e 'const [a,b]=require("./desktop/package.json").version.split(".").map(Number); console.log(`${a}.${b+1}.0`)'

get-next-patch-version:
    @node -e 'const [a,b,c]=require("./desktop/package.json").version.split(".").map(Number); console.log(`${a}.${b}.${c+1}`)'

get-next-relay-patch-version:
    @node -e 'const [a,b,c]=require("./apps/relay/package.json").version.split(".").map(Number); console.log(`${a}.${b}.${c+1}`)'

bump-desktop-version version:
    node ./scripts/bump-package-version.mjs desktop/package.json {{version}}

bump-relay-version version:
    node ./scripts/bump-package-version.mjs apps/relay/package.json {{version}}

release-desktop *ARGS:
    pnpm package:desktop {{ARGS}}

release-relay *ARGS:
    docker build {{ARGS}} -t buzz-relay:$(./bin/just get-current-relay-version) .

goose relay="ws://localhost:3000" agents="1" heartbeat="0" prompt="" key="$BUZZ_PRIVATE_KEY":
    pnpm --filter @buzz/sprig build
    BUZZ_RELAY_URL={{relay}} BUZZ_PRIVATE_KEY={{key}} node apps/sprig/dist/main.js buzz-agent --agents {{agents}} --heartbeat {{heartbeat}} --prompt {{prompt}}

goose-bg relay="ws://localhost:3000" agents="1" heartbeat="0" prompt="" key="$BUZZ_PRIVATE_KEY":
    nohup ./bin/just goose {{relay}} {{agents}} {{heartbeat}} {{prompt}} {{key}} >/tmp/buzz-agent.log 2>&1 &

benchmark *ARGS:
    ./scripts/benchmark.sh {{ARGS}}

benchmark-down:
    ./scripts/benchmark.sh down
