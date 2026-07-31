# Testing Buzz

Buzz uses strict TypeScript checks, unit tests, protocol vectors, integration
tests, browser tests, packaging tests, and container smoke tests. No test or
production path depends on a Rust or Dart runtime.

## Standard gates

```bash
just ci                 # formatting, types, unit tests, client builds
just test-unit          # infrastructure-free suites
just test-integration   # Postgres/Redis/MinIO-backed suites
just test               # unit and integration
```

The underlying canonical runner is `scripts/run-tests.sh`. CI uses the locked
pnpm workspace:

```bash
pnpm install --frozen-lockfile
pnpm check
pnpm test
pnpm build
```

## Focused suites

```bash
pnpm --filter @buzz/core check
pnpm --filter @buzz/auth check
pnpm --filter @buzz/db check
pnpm --filter @buzz/relay check
pnpm --filter @buzz/cli check
pnpm --filter @buzz/acp check
pnpm --filter @buzz/remote-agent-protocol check
pnpm --filter @buzz/remote-agent check
pnpm --filter @buzz/desktop-host check
pnpm --filter @buzz/mobile check
```

Vitest test files live beside their TypeScript modules. Relay integration tests
use the `.integration.test.ts` suffix and execute only when
`BUZZ_RUN_INTEGRATION=1`, which the integration runner sets after provisioning
services.

## Live relay

Start infrastructure, migrations, and the relay:

```bash
. ./bin/activate-hermit
cp .env.example .env
just setup
just relay
```

The defaults expose:

- WebSocket relay: `ws://localhost:3000`
- health: `http://localhost:3000/_health`
- readiness: `http://localhost:3000/_readiness`
- Postgres: `localhost:5432`
- Redis: `localhost:6379`
- MinIO: `localhost:9000`

Build and use the agent-first CLI in another terminal:

```bash
pnpm --filter @buzz/cli build
export BUZZ_RELAY_URL=ws://localhost:3000
export BUZZ_PRIVATE_KEY=<64-lowercase-hex>
node packages/cli/dist/main.js channels list
```

The CLI writes JSON to stdout, diagnostics to stderr, and uses stable exit
classes for input, network, authentication, conflict, and internal errors.

## Relay protocol coverage

The relay suite covers:

- NIP-01 serialization, signatures, filters, replaceable events, and COUNT;
- NIP-42 WebSocket and NIP-98 HTTP authentication;
- host-derived community isolation and unknown-host denial;
- NIP-29 membership/role/channel visibility and NIP-44 private payloads;
- event ingestion, query, subscription fan-out, and Redis local-echo dedupe;
- media, Git smart HTTP, invites, moderation, workflows, huddles, push leases,
  retention, metrics, and static bundles;
- Postgres persistence, search, audit records, and migration behavior;
- limits, malformed input, replay, cross-tenant access, and graceful shutdown.

Run the relay gate directly:

```bash
pnpm --filter @buzz/relay check
BUZZ_RUN_INTEGRATION=1 pnpm --filter @buzz/relay test
```

## Remote-agent security coverage

The remote worker must use one outbound relay WebSocket and expose no inbound
control port. The protocol and worker suites verify:

- one-time enrollment token hashing, expiry, and atomic redemption;
- owner/worker fingerprint approval and relay pinning;
- NIP-42 transport auth plus signed NIP-44 v2 control frames;
- exact recipient, deployment, session, message, sequence, and expiry binding;
- replay, reordering, stale frame, wrong-signer, and cross-deployment rejection;
- capability-scoped commands and the absence of a generic shell command;
- local secret references, private-key non-export, and status/log redaction;
- reconnect backoff, single active connection/session, revocation, and local
  kill-switch behavior.

Run:

```bash
pnpm --filter @buzz/remote-agent-protocol check
pnpm --filter @buzz/remote-agent-client check
pnpm --filter @buzz/remote-agent check
pnpm --filter @buzz/relay test
```

The normative protocol and operations runbook are
[docs/remote-agent-protocol.md](docs/remote-agent-protocol.md) and
[docs/remote-agent-operations.md](docs/remote-agent-operations.md).

## Desktop and web

```bash
just desktop-ci
just desktop-e2e-smoke
just web-check
just web-e2e-smoke
just admin-web-check
```

The desktop UI uses an explicit mock bridge for browser E2E. Packaged-runtime
checks build `apps/desktop-host`, assemble the distribution, start it with a
temporary profile, and verify its health/bridge lifecycle.

## Mobile

```bash
just mobile-check
just mobile-test
pnpm --filter @buzz/mobile build
pnpm --filter @buzz/mobile exec expo-doctor
```

The Expo app exports Android, iOS, and web bundles. Unit tests cover event
projection, threads, forums, inbox, Markdown, media parsing, observer frames,
private section sync, reminders, offline outbox, cursors, and local state.
Before release, also run a clean Expo export and smoke the web bundle at a
mobile viewport.

Worktree identity and mobile release contracts have standalone tests:

```bash
scripts/test-mobile-worktree-overrides.sh
scripts/test-mobile-release-contract.sh
scripts/test-mobile-release-candidate-publisher.sh
```

## Packaging and containers

```bash
pnpm package:desktop:archive
scripts/smoke-desktop-package.sh
docker build -t buzz-relay:test .
docker compose config
```

Also build the push gateway and Sprig images when their packages or shared
dependencies change. A container passes only after its health/readiness endpoint
is reachable and its startup logs contain no secret or unhandled error.

## Failure diagnosis

| Symptom | Likely cause | Action |
| --- | --- | --- |
| `ECONNREFUSED` for Postgres/Redis/MinIO | services are stopped | `just setup` or `docker compose up -d` |
| `auth-required` | missing/invalid NIP-42 credentials | set a valid `BUZZ_PRIVATE_KEY`; check membership policy |
| NIP-98 replay/freshness error | reused auth event or clock skew | generate a new request-bound auth event; sync clocks |
| empty channel results | identity is not a member or wrong host | verify the relay URL and NIP-29 membership |
| remote worker refuses URL | non-TLS non-loopback relay | use `wss://`; insecure transport is loopback-only |
| integration tests skip | missing integration flag | use `just test-integration` |
| clean tree passes but package fails | stale or missing build output | run locked install and rebuild the package |

Do not “fix” a flaky or security-sensitive test with retries alone. First
identify the race, shared state, missing tenant key, or non-deterministic clock
and make that boundary explicit.
