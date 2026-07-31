# AGENTS.md — Buzz contributor instructions

Buzz is a TypeScript-only pnpm workspace. Read
[CONTRIBUTING.md](CONTRIBUTING.md), [ARCHITECTURE.md](ARCHITECTURE.md), and
[TESTING.md](TESTING.md) before changing a subsystem.

## Source map

```text
apps/
  relay/                 Relay server and HTTP/WebSocket surfaces
  desktop-host/          Desktop process, managed-agent lifecycle, native bridge
  mobile/                Expo + React Native client
  admin/                 Operator CLI
  pair-relay/            Pairing relay
  pairing-cli/           Pairing CLI
  push-gateway/          Push delivery service
  remote-agent/          Outbound-only remote managed-agent worker
  sprig/                 Bundled agent distribution
packages/
  core/                  Nostr events, filters, kinds, validation
  sdk/                   Typed event builders
  db/ auth/ pubsub/       Persistence, authorization, Redis fan-out
  search/ audit/ media/  Search, audit chain, object storage
  workflow/              Workflow parser and executor
  ws-client/             Shared NIP-42 relay client
  acp/ agent/ dev-mcp/   Agent harness and tools
  cli/                   JSON-first Buzz CLI
  pairing/ persona/      Pairing and personas
  relay-mesh/            Inter-relay mesh
  remote-agent-protocol/ Signed encrypted management frames
  remote-agent-client/   Owner-side remote worker controller
desktop/                 React desktop UI
web/                     Browser client
admin-web/               Operator UI
```

## Required workflow

Activate the repository toolchain and use the locked workspace:

```bash
. ./bin/activate-hermit
pnpm install --frozen-lockfile
```

Before handing off a change:

```bash
just ci
just test
```

Use focused gates while iterating:

```bash
pnpm --filter <workspace-name> check
pnpm --filter <workspace-name> test
just desktop-ci
just mobile-check
```

Do not bypass strict TypeScript or Biome failures. New behavior requires tests,
including rejection and boundary cases. Exported public APIs require TSDoc.

## System invariants

### Community isolation

The request host is authoritative for the community. Resolve it before
authentication, authorization, lookup, cache access, storage, metrics, or side
effects. Unknown hosts fail closed.

Every tenant-observable resource must carry the community boundary:

- Postgres rows and queries;
- Redis channels, presence, typing, rate limits, and invalidations;
- object-store paths, Git manifests, media metadata, and search documents;
- workflow runs, webhook routes, push leases, audit chains, and logs;
- module-level client caches and reconnect state.

Shared infrastructure must never create a user-visible global workspace.

### Signed events

Verify canonical event ID and Schnorr signature before decryption, persistence,
authorization-dependent side effects, or fan-out. Ephemeral kinds
(`20000..29999`) are never persisted or indexed. Channel-scoped events use
NIP-29 `h` tags.

Prefer a signed event and the existing WebSocket/`POST /events` pipeline over a
new endpoint-specific API. HTTP-only surfaces still use the same host boundary,
validation, and authorization model.

### HTTP authentication

NIP-98 authorization is bound to the exact URL, method, payload hash,
freshness window, signer, community, and replay cache. Validate body and frame
limits before parsing unbounded data. Return stable errors without leaking
tenant existence, keys, tokens, SQL, paths, or decrypted content.

### Remote agents

Remote workers follow
[docs/remote-agent-protocol.md](docs/remote-agent-protocol.md):

- exactly one outbound relay WebSocket; no inbound management listener;
- `wss://` outside explicit loopback development;
- NIP-42 relay authentication;
- signed NIP-44 v2 management frames;
- one-time hashed enrollment, explicit fingerprint approval, relay pinning;
- strict owner, worker, deployment, recipient, session, sequence, message, and
  expiry binding;
- local generation and storage of worker/agent private keys;
- named local secret references only;
- capability-scoped commands and no generic remote shell;
- replay/reordering rejection, revocation, and a local kill switch.

Never log or return private keys, enrollment secrets, provider secrets,
decrypted management frames, or unredacted process environments.

## Event and API changes

The kind registry is
[`packages/core/src/kinds.ts`](packages/core/src/kinds.ts). When adding a kind:

1. check numeric collisions and persistence semantics;
2. add strict types/schema and SDK builders;
3. add relay scope, membership, and side-effect policy;
4. add database behavior only for durable events;
5. update every interpreting client;
6. test signatures, malformed data, unauthorized access, cross-community
   access, replay where applicable, and live fan-out;
7. document the public contract.

New HTTP routes belong in `apps/relay/src`. Resolve community first, enforce
NIP-98 or explicit internal authentication, use bounded schemas, and test
cross-tenant and error-redaction behavior.

## Client rules

### Desktop

The React UI is in `desktop/src`; the TypeScript host is
`apps/desktop-host/src`. The compatibility bridge must preserve stable invoke
results and errors.

Community switching remounts React state but does not clear module singletons.
Any community-scoped cache, client, pending promise, media URL, observer state,
or draft store needs an explicit reset wired into the community reset path.

Use named, rem-based text tokens. `pnpm -C desktop check:px-text` rejects new
arbitrary text sizes. For E2E use `pnpm -C desktop build:e2e`; a normal build
does not contain the test bridge.

### Mobile

The mobile app is strict TypeScript in `apps/mobile`, using Expo, React Native,
React Navigation, TanStack Query, and secure platform storage.

- Keep Nostr parsing/projection logic in testable domain modules.
- Store private keys only through secure storage; AsyncStorage is for bounded
  non-secret state and signed outbox events.
- Verify signatures before NIP-44 decryption.
- Keep paginated queries cursor-bounded and deterministic.
- Reset community queries, subscriptions, local projections, and connection
  state on relay changes.
- Use `just mobile-check`, `just mobile-test`, and
  `pnpm --filter @buzz/mobile build`.
- Native `android/` and `ios/` directories are Expo CNG output and are not
  committed.

### CLI and agents

The agent-first CLI is `packages/cli`. Build it with:

```bash
pnpm --filter @buzz/cli build
node packages/cli/dist/main.js --help
```

Keep stdout machine-readable JSON and diagnostics on stderr. Preserve documented
exit classes. Managed-agent ACP subprocesses receive only explicitly allowed
environment variables and secret references.

## Git and destructive actions

The working tree may contain a user's changes. Inspect `git status`, avoid
overwriting unrelated work, and never use `git reset --hard` or destructive
checkout commands. Do not commit or push unless explicitly requested. Use
recoverable deletion for large legacy or generated trees.

Commits require DCO sign-off (`git commit -s`) and Conventional Commit titles.

## Screenshots

Desktop screenshot specs live under `desktop/tests/e2e`. Build the E2E bridge
and wait for animations before capture:

```bash
just desktop-screenshot --name home
pnpm -C desktop test:e2e:smoke
```

Do not upload PR screenshots through the Buzz relay. Use
`scripts/post-screenshots.sh`, and verify multiple screenshots have distinct
hashes before posting.

## Common mistakes

- querying or caching without a community key;
- omitting explicit `kinds` from broad relay queries;
- treating a React remount as a reset of module state;
- persisting ephemeral AUTH, observer, or remote-control events;
- accepting remote frames before signature, recipient, expiry, and replay
  checks;
- storing secret values where a secret reference is expected;
- running integration tests without `BUZZ_RUN_INTEGRATION=1`;
- using a normal desktop build for mock-bridge E2E;
- committing Expo-generated native directories or build output.
