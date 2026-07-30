# Contributing to Buzz

Buzz is a TypeScript pnpm workspace. The relay, desktop runtime, web clients,
mobile client, CLI, agent harness, remote-agent worker, and shared protocol
packages are all built from TypeScript.

Please search existing issues and pull requests before starting substantial
work. Focused, tested contributions are easiest to review. AI-assisted changes
are welcome, but the submitter is responsible for understanding and reviewing
the result.

## Prerequisites

| Tool | Minimum | Purpose |
| --- | ---: | --- |
| Node.js | 22 | TypeScript runtimes and tooling |
| pnpm | 11 | Workspace package manager |
| Docker | 24 | Postgres, Redis, and MinIO |
| `just` | current | Repository task runner |

The repository includes a pinned [Hermit](https://cashapp.github.io/hermit/)
toolchain:

```bash
. ./bin/activate-hermit
just setup
```

`just setup` installs the locked pnpm workspace, starts local infrastructure,
applies database migrations, and installs Git hooks. Copy `.env.example` to
`.env` first when you need to customize defaults.

## Repository layout

```text
apps/
  relay/           WebSocket/HTTP relay
  desktop-host/    TypeScript desktop process and native bridge
  mobile/          Expo + React Native client
  admin/           Operator CLI
  pair-relay/      Device-pairing relay
  pairing-cli/     Pairing interoperability CLI
  push-gateway/    Push lease and delivery service
  remote-agent/    Outbound-only remote managed-agent worker
  sprig/           Bundled agent distribution
packages/
  core/            Nostr events, filters, kinds, and verification
  sdk/             Signed event builders
  db/              Postgres event store
  auth/            NIP-42/NIP-98 authorization
  pubsub/          Redis fan-out and presence
  search/          Full-text search
  audit/           Hash-chain audit records
  media/           Blossom/S3 media
  workflow/        Workflow parsing and execution
  ws-client/       Authenticated relay client
  acp/ agent/      ACP harness and built-in agent
  cli/             Agent-first JSON CLI
  remote-agent-protocol/
                   Signed, encrypted remote management protocol
desktop/           React desktop UI
web/               Browser client
admin-web/         Operator web client
```

See [ARCHITECTURE.md](ARCHITECTURE.md) for subsystem behavior and
[docs/remote-agent-protocol.md](docs/remote-agent-protocol.md) for the remote
worker security contract.

## Development

Start the relay and desktop app together:

```bash
just dev
```

Or use separate terminals:

```bash
just relay
just desktop-dev
```

The default relay is `ws://localhost:3000`. The production server, worker, and
clients require TLS (`wss://`) outside explicit loopback development.

Mobile development uses Expo:

```bash
just mobile-check
just mobile-dev
```

Linked Git worktrees receive a safe debug-only application identifier through
`apps/mobile/app.config.ts`; release builds retain the production identifiers.

## Quality gates

Run these before submitting a pull request:

```bash
just ci
just test
```

Useful narrower gates:

```bash
just test-unit
just test-integration
just desktop-ci
just mobile-check
pnpm --filter @buzz/relay check
pnpm --filter @buzz/remote-agent check
```

`just ci` checks formatting, strict TypeScript, unit tests, and the desktop,
web, admin, and mobile build surfaces. `just test` also provisions local
infrastructure and runs integration suites.

The workspace uses Biome, strict TypeScript, Vitest, Node's test runner, and
Playwright. Use `just fix-all` for safe formatting fixes. Do not weaken types or
tests to make a gate pass.

## Engineering rules

- Treat the request host as the community boundary before authentication or
  data access. Every tenant-observable database row, cache key, object key,
  metric, and audit chain must retain that boundary.
- Prefer signed Nostr events over endpoint-specific JSON APIs. HTTP is for
  NIP-11/NIP-05, the generic event bridge, media, webhooks, Git smart HTTP,
  huddle audio, operator surfaces, and health probes.
- Verify event IDs and signatures before authorization, decryption, storage, or
  side effects.
- Enforce input schemas and byte/count limits at every network boundary.
- Never log private keys, enrollment tokens, provider keys, decrypted control
  frames, or unredacted process environments.
- Public exported APIs need documentation. New behavior needs failure-path
  tests as well as success-path tests.
- Avoid `any`, non-null assertions used as validation, unhandled promises, and
  process-wide mutable state that can leak across communities.

## Adding an event kind

1. Add the number and name to
   [`packages/core/src/kinds.ts`](packages/core/src/kinds.ts), checking for
   collisions and ephemeral/replaceable semantics.
2. Add a strict payload schema and typed builder in `packages/core` or
   `packages/sdk`.
3. Add relay admission and authorization in `apps/relay/src`; scope channel
   events with their NIP-29 `h` tag.
4. Add persistence/query behavior in `packages/db` only when the event is
   durable. Ephemeral events must never be stored or indexed.
5. Add side effects only after successful verification, authorization, and
   storage.
6. Add protocol, authorization, tenant-isolation, and fan-out tests.
7. Document the public kind and update all client registries that interpret it.

## Adding an HTTP endpoint

First determine whether a signed event plus the existing WebSocket or
`POST /events` path is sufficient. If HTTP is necessary:

1. Resolve the host-derived community before auth or lookup.
2. Use NIP-98 for user-authorized requests and bind the signature to the exact
   method, URL, payload hash, freshness window, and replay cache.
3. Validate content type, body size, and schema before processing.
4. Use stable, non-sensitive errors and structured logs.
5. Test unauthenticated, unauthorized, cross-community, replay, malformed, and
   successful requests.

## Pull requests

Use a Conventional Commit title such as `feat(relay): add huddle admission`.
Every commit requires a Developer Certificate of Origin sign-off:

```bash
git commit -s
```

UI changes should include screenshots or a short recording. Security-sensitive
changes should state the trust boundary, abuse cases considered, and verification
performed.

Buzz is licensed under Apache 2.0. By submitting a contribution, you confirm
that you have the right to license it under those terms and certify the DCO
trailer on each commit.
