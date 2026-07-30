# TypeScript migration completion contract

## Purpose

Buzz was migrated from a mixed-language monorepo to a TypeScript-only product.
This document records the compatibility contract used for the cutover. Source
parity alone was insufficient: public protocol, persistence, authorization,
operations, packaging, and user-visible behavior all had to pass their
acceptance gates before the legacy build inputs were removed.

## System story

A person or agent connects to a Buzz community through one relay. Clients
authenticate with a Nostr key, publish signed events, subscribe to filtered
events, and receive live updates. The relay verifies and authorizes events,
persists the durable ones, indexes searchable content, fans events out locally
and across relay instances, and triggers side effects such as workflows,
moderation, media, git, and audit entries.

An agent is a normal Buzz identity plus an ACP harness. A local managed agent is
spawned by the desktop runtime. A remote managed agent runs on another server
and connects outbound to the same relay. Local and remote agents must have the
same chat, channel, tool, observer, presence, and lifecycle behavior.

## Target workspace

The target is a Node.js 22+ pnpm workspace:

```text
apps/
  relay/                 Public relay, REST bridges, WebSocket protocol
  desktop-host/          TypeScript desktop process and native bridge
  mobile/                React Native client
  remote-agent/          Outbound-only remote agent worker
  push-gateway/          APNS and push lease service
  sprig/                 All-in-one agent distribution
packages/
  core/                  Nostr types, kinds, filters, verification
  sdk/                   Typed event builders
  db/                    Postgres persistence and migrations
  auth/                  NIP-42, NIP-98, NIP-OA, scopes, rate limits
  pubsub/                Redis fan-out, presence, typing, invalidation
  search/                Postgres FTS
  audit/                 Hash-chain audit service
  media/                 Blossom and S3-compatible storage
  workflow/              YAML workflow parser and executor
  ws-client/             Shared authenticated relay client
  acp/                   ACP harness
  agent/                 Built-in ACP agent
  dev-mcp/               Shell and file-edit MCP server
  persona/               Persona packs
  cli/                   Agent-first `buzz` CLI
  pairing/               Shared NIP-AB pairing protocol
  git-sign-nostr/        Nostr Git signature helper
  git-credential-nostr/  Nostr Git credential helper
  relay-mesh/            Inter-relay mesh
  remote-agent-protocol/ Secure remote management protocol
```

The React desktop, web, and admin clients remain top-level workspace projects.
The desktop process and mobile client are TypeScript replacements, not wrappers.

## Dependency order

1. `core`, `sdk`, and `remote-agent-protocol`
2. `db`, `auth`, `pubsub`, `search`, `audit`, and `ws-client`
3. `relay`, `media`, `workflow`, git, huddles, and mesh
4. `cli`, `acp`, `agent`, `dev-mcp`, `persona`, pairing, and admin tooling
5. desktop native runtime and push gateway
6. React Native mobile client
7. removal of legacy build inputs after compatibility gates pass

This order prevents a frontend or CLI from being migrated against a temporary
API that later diverges from the relay.

## Compatibility matrix

### Core protocol

- NIP-01 event serialization, ID calculation, and BIP-340 signature validation
- NIP-01 filters: ids, authors, kinds, time, limit, and tag filters
- Replaceable and parameterized-replaceable event semantics
- Ephemeral kinds are never persisted
- NIP-42 WebSocket authentication and challenge binding
- NIP-98 HTTP authentication, URL/method binding, freshness, and replay checks
- NIP-29 channel scoping through `h` tags
- NIP-44 encryption and NIP-17 gift-wrap handling
- All kind constants remain numerically identical

### Relay

- WebSocket messages: `AUTH`, `EVENT`, `REQ`, `COUNT`, `CLOSE`, `OK`, `EOSE`,
  `CLOSED`, and notices
- Host-derived community boundary before authentication and all reads/writes
- Unknown hosts fail closed
- Signed event verification before decryption or persistence
- Admission, membership, role, scope, moderation, and p-gated read policies
- In-process subscription fan-out and Redis multi-node fan-out with local-echo
  deduplication
- Thread counters and replaceable-event conflict behavior
- Health, readiness, status, and Prometheus surfaces

### HTTP and storage

- NIP-11/NIP-05 metadata
- `POST /events`, `/query`, and `/count`
- invites, join policy, moderation reads, operator communities, and webhooks
- Blossom upload/download/head with size and content checks
- git smart HTTP and policy hooks
- huddle audio WebSocket
- static web/admin bundles with host isolation
- Postgres migrations, partitions, search vectors, audit chain, and retention

### Product features

- channels, threads, edits, reactions, pins, bookmarks, scheduled messages
- DMs, encrypted visibility, profiles, contacts, mute lists, presence, typing
- canvases, forums, long-form notes, emoji sets, reminders, and feed
- personas, teams, managed agents, agent observer frames, and turn metrics
- workflows, triggers, approvals, schedules, and webhook execution
- NIP-34 repos, patches, issues, pull requests, and status events
- reports, bans, timeouts, archival, feedback, and administration
- media metadata, upload records, thumbnails, and S3-compatible storage
- relay mesh, pairing, push leases, and push gateway

### Agent behavior

- ACP initialize, authentication, model discovery, sessions, prompts, cancel,
  permissions, config options, tool calls, and usage
- mention filtering, owner/allowlist gates, queue/steer/interrupt behavior
- per-channel session pool, concurrency, timeouts, heartbeat, and shutdown
- observer frames, transcript recovery, engrams, and usage metrics
- local process lifecycle, restore, reconciliation, logs, retention, and config
- remote lifecycle through the protocol in
  `docs/remote-agent-protocol.md`

### Client behavior

- existing React desktop and web acceptance tests continue to pass
- desktop IPC is replaced by typed TypeScript runtime calls with the same
  result and error contracts
- community switching resets all community-scoped module singletons
- mobile feature modules and Nostr models match desktop behavior
- CLI JSON contracts and documented exit codes remain stable

## Definition of done for each subsystem

Each migrated subsystem needs all of the following:

1. Strict TypeScript source with no production `any` escape hatches.
2. Unit tests for pure logic and failure cases.
3. Contract tests against captured behavior or shared protocol vectors.
4. Integration tests for persistence/network boundaries.
5. User-visible or CLI end-to-end coverage.
6. Production configuration, health checks, logs, metrics, and graceful
   shutdown where applicable.
7. No runtime import, shell-out, sidecar, or FFI dependency on a legacy
   implementation.
8. Security checks for validation, authorization, replay, size limits, secret
   handling, and error redaction.

## Cutover rule

The legacy implementation was removed only after the TypeScript implementation
passed its compatibility gate. Production entry points now resolve to one
TypeScript implementation; silent per-request fallback is forbidden because it
makes behavior and incident diagnosis non-deterministic.
