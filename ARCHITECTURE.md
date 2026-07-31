# Buzz architecture

Buzz is a self-hosted collaboration system in which people, agents, workflows,
and developer tools use the same signed event model. The production code is a
strict TypeScript pnpm workspace.

## Design principles

1. **The relay is the source of truth.** Durable collaboration state is a
   signed Nostr event in the relay store.
2. **The URL selects the community.** The request host is resolved before auth
   or data access. Shared infrastructure never creates a cross-community view.
3. **People and agents are identities, not privilege classes.** Both sign
   events; authorization comes from membership, role, owner delegation, and
   scoped capabilities.
4. **Protocol before side effects.** Verify, authorize, persist, then fan out
   and execute derived behavior.
5. **Remote management is not remote shell.** A remote agent worker has one
   outbound encrypted control connection with an explicit command allowlist.
6. **Bound everything exposed to a network.** Frames, bodies, filters,
   subscriptions, result windows, queues, logs, replay sets, and concurrency all
   have caps.

## Component map

```text
 React desktop ─┐
 Web client ────┼──── signed Nostr over WebSocket/HTTP ────┐
 Expo mobile ───┤                                           │
 buzz CLI ──────┘                                           ▼
                                                  apps/relay
 Remote worker ───── one outbound WSS + NIP-42 ──────┤
                                                     │
                        ┌────────────────────────────┼────────────────────┐
                        ▼                            ▼                    ▼
                    Postgres                       Redis              S3/MinIO
              events, policy, search,       fan-out, presence,     media, Git
              workflows, audit, leases      typing, invalidation    objects
```

### Applications

| Path | Responsibility |
| --- | --- |
| `apps/relay` | NIP-01/NIP-42 relay, HTTP bridges, tenant routing, Git, media, huddles, workflows, moderation, push dispatch, metrics |
| `apps/desktop-host` | Desktop process, secure identity storage, native bridge, local managed agents, workspace/Git integration |
| `apps/mobile` | Expo/React Native client for Android, iOS, and web |
| `apps/remote-agent` | Outbound-only remote agent worker and ACP process lifecycle |
| `apps/push-gateway` | Push delivery authority and provider integration |
| `apps/pair-relay`, `apps/pairing-cli` | NIP-AB device pairing |
| `apps/admin` | Relay migrations, seeding, and operator commands |
| `apps/sprig` | Deployable bundled agent distribution |

The React desktop UI, browser client, and operator UI live in `desktop`, `web`,
and `admin-web`.

### Shared packages

| Path | Responsibility |
| --- | --- |
| `packages/core` | Canonical event types, kinds, filters, signing, verification, observer/engram models |
| `packages/sdk` | Typed event builders |
| `packages/db` | Community-scoped Postgres event store, replacement/deletion/thread semantics |
| `packages/auth` | Bounded rate limiting; relay NIP-42/NIP-98 policy is integrated at the server boundary |
| `packages/pubsub` | Verified community-scoped event bus, Redis fan-out, presence |
| `packages/search` | Community-scoped Postgres full-text search candidates |
| `packages/audit` | Per-community tamper-evident hash chain |
| `packages/media` | Upload validation and S3-compatible storage |
| `packages/workflow` | Strict YAML workflow schemas, conditions, templates, execution, durable store |
| `packages/ws-client` | Shared authenticated relay connection |
| `packages/acp`, `packages/agent` | ACP harness and built-in agent |
| `packages/dev-mcp` | Explicit developer tool surface for an agent |
| `packages/cli` | JSON-first human/agent CLI |
| `packages/remote-agent-protocol` | BRAP envelope, enrollment, schemas, replay, transport validation, redaction |
| `packages/remote-agent-client` | Owner-side worker enrollment and command client |
| `packages/relay-mesh` | Relay-to-relay topology and event forwarding |

## Community boundary

A client-facing Buzz URL represents one community. Hosted deployments can
route many hosts to shared Postgres, Redis, and object storage, but every
tenant-observable operation includes the resolved community.

The boundary is applied to:

- event storage, addresses, deletion tombstones, channel/thread metadata;
- membership, roles, moderation, invites, reports, and archives;
- search queries and result re-authorization;
- Redis fan-out, presence, typing, cache invalidation, and rate-limit keys;
- workflows, schedules, approvals, webhooks, and reminders;
- media records, object keys, Git repository pointers, and pack manifests;
- push leases/delivery authority, remote-worker bindings, and enrollment;
- audit head and chain verification;
- client-side query caches, drafts, subscriptions, and local projections.

The tenant gateway resolves an authority to one configured relay. Unknown hosts
fail closed. Global liveness surfaces can be served by the control process, but
they do not disclose tenant state.

## Event model

A normal event has the NIP-01 shape:

```ts
type NostrEvent = {
  id: string;
  pubkey: string;
  created_at: number;
  kind: number;
  tags: string[][];
  content: string;
  sig: string;
};
```

`packages/core/src/event.ts` canonicalizes and verifies the event ID and
BIP-340 Schnorr signature. `packages/core/src/filter.ts` implements NIP-01
filter matching. `packages/core/src/kinds.ts` is the numeric registry and also
declares ingest, channel-scoped, recipient-gated, author-only, relay-only, and
remote-control sets.

Important classes:

- regular durable events are deduplicated by ID;
- replaceable events choose the newest valid coordinate;
- parameterized replaceable events include the `d` tag;
- ephemeral kinds `20000..29999` are routed live and never persisted;
- channel events contain exactly one valid NIP-29 `h` tag;
- recipient-gated private events require an explicit `p` filter at read time;
- relay-only derived kinds cannot be submitted by ordinary clients.

The remote kinds are:

| Kind | Use |
| ---: | --- |
| 24210 | enrollment proof |
| 24211 | owner command |
| 24212 | worker status |
| 24213 | acknowledgement |

All four are ephemeral and recipient gated.

## Relay connection and ingest

`apps/relay/src/server.ts` owns HTTP and WebSocket admission. A WebSocket client
receives a random NIP-42 challenge immediately and must authenticate within a
bounded time.

Supported relay messages include:

- client: `AUTH`, `EVENT`, `REQ`, `COUNT`, `CLOSE`;
- server: `AUTH`, `OK`, `EVENT`, `COUNT`, `EOSE`, `CLOSED`, `NOTICE`.

Per-connection state includes the authenticated signer/owner, subscriptions,
pending-send count, and a serialized processing chain. Global semaphores cap
connections and concurrent handlers. The server caps frame size, subscription
ID length, filters per subscription, subscriptions per connection, historical
results, and pending messages.

Durable event ingest follows this order:

```text
frame/body limit
  → JSON/protocol shape
  → canonical ID and signature
  → authenticated signer/delegation
  → known/allowed event kind
  → timestamp, tag, content, media, and coordinate validation
  → host/community membership and role policy
  → author/recipient/channel-specific authorization
  → transactional store and replacement/deletion/thread effects
  → audit/workflow/moderation/push/derived-event side effects
  → local + Redis fan-out
  → OK response
```

An ephemeral event skips storage and durable indexing but still passes
signature, auth, routing, kind-specific, recipient, and rate-limit policy.

`REQ` and `COUNT` apply explicit filter validation, community scoping,
membership/recipient visibility, and bounded results. Search returns candidates
from `packages/search`; the relay re-authorizes each candidate before delivery.

## Persistence

`packages/db` exposes one `EventStore` contract with production Postgres and
test-memory implementations. The community is a required argument for every
operation.

The store implements:

- ID deduplication and replaceable-event winner selection;
- atomic event plus policy effects where required;
- deletion tombstones and author/admin deletion policy;
- normalized channel and thread metadata;
- composite `(created_at, id)` cursors for stable pagination;
- channel-window summaries and relay-derived bounds;
- event-by-ID and parameterized address lookup;
- query/count filters with result caps.

Migrations live under `migrations/` and are applied by `apps/admin`. Relay
startup/readiness refuses to report ready when required storage dependencies or
migrations are unavailable.

## Pub/sub, search, and audit

The event bus verifies events before publication. Redis topics carry the
community so multi-node fan-out cannot cross hosts. Local event IDs prevent a
relay from delivering its own Redis echo twice. Bounded queues and connection
controls shed work rather than growing without limit.

Search uses Postgres FTS under a mandatory community predicate. Sensitive kinds
are excluded or recipient/channel filtered, and every hit is checked again by
the relay.

The audit service maintains a separate SHA-256 chain per community. Each entry
binds its sequence, timestamp, actor, action, target event/channel, canonical
metadata, and previous hash. Append uses transactional single-writer
coordination; verification recomputes the chain from its genesis.

## Product subsystems

### Channels and conversations

NIP-29 membership/role events establish channel access. Streams, forums, DMs,
canvases, reactions, edits, deletions, bookmarks, emoji, reminders, read state,
presence, typing, and user status are projections of signed events. Threads
retain root/parent metadata and materialized summaries.

Mobile and desktop use the same IDs, kinds, tags, signature verification, and
visibility rules. Offline mobile writes are already-signed events in a bounded
non-secret outbox; reconnect flushes them through the normal relay policy.

### Media

Blossom-compatible upload verifies NIP-98/NIP-44 policy as applicable, declared
hash, actual SHA-256, type, extension, size, and media metadata. Object keys are
content addressed and community scoped. Download/HEAD surfaces preserve access
policy and safe content headers.

### Git

The relay exposes Git smart HTTP for repository advertisement, upload-pack, and
receive-pack. Repository state uses validated refs/object IDs, immutable pack
objects, manifests, and compare-and-swap pointers. Authentication and policy
remain Nostr identities/events; Git subprocesses receive a bounded environment
and repository path.

### Workflows

Workflow definitions are strict YAML schemas. Triggers include messages,
reactions, schedules, and secret-bound webhooks. Actions include messages, DMs,
reactions, channel updates, approvals, delays, and outbound webhooks.

Template resolution is bounded and condition evaluation uses an explicit
function environment. Outbound URLs reject private/link-local destinations and
redirects that would bypass validation. Runs, steps, approvals, and schedules
are durable and community scoped.

### Huddles

Huddle lifecycle is represented by signed events. The audio WebSocket
authenticates the identity, binds it to a community/channel, checks membership,
and forwards bounded opaque audio frames. Room and per-peer queues have caps;
control frames are separate from lossy audio delivery.

### Push

Push leases are author-only, replaceable, signed events. The relay matches
authorized durable events to leases and sends bounded delivery requests to the
push gateway. Gateway authority, replay admission, quotas, and provider results
are durable so replica count does not multiply delivery rights.

## Managed agents

A local managed agent runs under `apps/desktop-host`; a remote managed agent
runs under `apps/remote-agent`. Both ultimately run the same ACP harness and
join Buzz with a normal agent key.

ACP flow:

```text
Buzz relay ← authenticated WS → ACP harness ← stdio JSON-RPC → model runtime
```

The harness owns channel discovery, mention/owner policy, per-channel sessions,
prompt queuing, cancellation, permission prompts, tool calls, observer frames,
usage, timeouts, and process shutdown.

### Remote Agent Protocol (BRAP v1)

The worker opens exactly one outbound WebSocket to the normal Buzz relay. The
desktop never opens a direct socket to the worker and the worker exposes no
inbound management port.

Enrollment:

1. An owner creates a random one-time enrollment credential over NIP-98.
2. The relay stores only its hash, owner/community/capabilities, expiry, and
   unused marker.
3. The worker validates the relay URL, generates its control key locally,
   connects outbound, and completes NIP-42.
4. It atomically redeems the credential with a signed, encrypted proof.
5. The owner verifies and approves the worker fingerprint.
6. Relay, owner, community, worker, and capabilities become a pinned binding.

Control frames are signed Nostr events whose content is NIP-44 v2 ciphertext.
The signed tags and encrypted payload independently bind protocol version,
sender, recipient, worker, deployment, session, sequence, message ID, issued
time, and expiry. Receivers verify the event before decrypting and advance
replay state only after every check passes.

Allowed operations are `deploy`, `start`, `stop`, `restart`, `update`,
`status`, bounded/redacted `logs`, and `revoke`. There is no arbitrary shell
operation. Agent and worker private keys are generated/stored remotely and
never exported; provider credentials are local named secret references.

Reconnect uses exponential backoff with jitter, ping/pong liveness, one active
connection, and one accepted session. Revocation stops new commands and
sessions; an optional explicit destructive confirmation erases the local agent
key. A local worker kill switch takes precedence over remote control.

The complete wire contract, validation order, error taxonomy, threat model,
rotation, and deletion procedure are in
[docs/remote-agent-protocol.md](docs/remote-agent-protocol.md). Deployment and
incident procedures are in
[docs/remote-agent-operations.md](docs/remote-agent-operations.md).

## HTTP surfaces

The relay keeps HTTP narrow:

| Surface | Purpose |
| --- | --- |
| `/`, `/info`, `/.well-known/nostr.json` | NIP-11/NIP-05 metadata and configured UI |
| `/events`, `/query`, `/count` | NIP-98 authenticated Nostr bridge |
| `/health`, `/_liveness`, `/_readiness`, `/_status`, `/metrics` | operations |
| `/upload`, `/media/*` | media |
| `/git/:owner/:repo/*`, `/internal/git/policy` | Git smart HTTP and hook policy |
| `/hooks/:id` | workflow webhooks |
| `/api/invites*`, `/api/join-policy*` | invite and policy flow |
| `/moderation/*`, `/api/admin/*`, `/operator/*` | scoped administration |
| `/api/remote-agents/enrollments`, `/api/remote-agents/:worker` | owner-authorized enrollment and revocation |
| huddle audio upgrade path | authenticated audio transport |

All user-authorized HTTP operations use exact request-bound NIP-98 events.
Remote-control events are WebSocket-only and cannot be retrieved through the
generic HTTP query bridge.

## Desktop and mobile runtimes

The desktop host stores identity material in its secure store, exposes a typed
local bridge to the React UI, and owns managed-process/Git/filesystem actions.
The packaged distribution contains Node plus built TypeScript; there is no
native-language sidecar.

The mobile app uses Expo secure storage for private keys, AsyncStorage for
bounded non-secret state, a shared authenticated relay client, TanStack Query,
and React Navigation. It supports pairing, channels/forums/threads/DMs,
messages/reactions/edits/deletes, search, profiles/status, media, Markdown,
canvases, reminders, agent observer activity, section sync, deep links, offline
outbox, pagination, and unread/read state.

## Operational model

Production requires TLS at the public boundary, Postgres, Redis for multi-node
fan-out, and S3-compatible storage for media/Git objects. Health means the
process is alive; readiness includes required dependencies and migrations.
Shutdown stops admission, drains bounded work, closes WebSockets/subscriptions,
stops schedules and managed children, and closes storage clients.

Configuration comes from explicit `BUZZ_*` environment variables. Secrets are
never accepted through public config snapshots. Logs are structured and
redacted; metrics may aggregate across communities only on operator-only
surfaces.

## Verification

The release boundary is:

```bash
pnpm install --frozen-lockfile
just ci
just test
pnpm build
pnpm package:desktop:archive
pnpm --filter @buzz/mobile build
```

Container images and packaged desktop/mobile exports are smoke-tested from
their assembled output, not from source-tree development dependencies. See
[TESTING.md](TESTING.md) for focused and integration gates.
