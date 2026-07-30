import { randomBytes } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";

import {
  AUTHOR_ONLY_KINDS,
  eventMatchesFilter,
  KIND_AGENT_ENGRAM,
  KIND_AUTH,
  KIND_AGENT_TURN_METRIC,
  KIND_DELETION,
  KIND_DM_VISIBILITY,
  KIND_GIT_REPO_STATE,
  KIND_IA_ARCHIVE_REQUEST,
  KIND_IA_UNARCHIVE_REQUEST,
  KIND_NIP43_MEMBERSHIP_LIST,
  KIND_NIP43_MEMBER_ADDED,
  KIND_NIP43_LEAVE_REQUEST,
  KIND_NIP29_DELETE_EVENT,
  KIND_PRESENCE_SNAPSHOT,
  KIND_PRESENCE_UPDATE,
  KIND_PRODUCT_FEEDBACK,
  KIND_PUSH_LEASE,
  KIND_REACTION,
  KIND_REMOTE_AGENT_ACK,
  KIND_REMOTE_AGENT_COMMAND,
  KIND_REMOTE_AGENT_ENROLLMENT,
  KIND_REMOTE_AGENT_STATUS,
  KIND_STREAM_MESSAGE_EDIT,
  KIND_THREAD_SUMMARY,
  KIND_WINDOW_BOUNDS,
  P_GATED_KINDS,
  publicKeyFromSecret,
  REMOTE_AGENT_KINDS,
  RELAY_ADMIN_ADD_MEMBER,
  RELAY_ADMIN_CHANGE_ROLE,
  RELAY_ADMIN_REMOVE_MEMBER,
  RELAY_ADMIN_SET_WORKSPACE_PROFILE,
  unixNow,
  signNostrEvent,
  verifyNostrEvent,
  type NostrEvent,
  type NostrFilter,
} from "@buzz/core";
import { TokenBucketRateLimiter } from "@buzz/auth";
import {
  eventChannelId,
  MemoryEventStore,
  OpenRelayAccessPolicy,
  PostgresEventStore,
  type EventStore,
  type RelayAccessPolicy,
} from "@buzz/db";
import {
  InMemoryEventBus,
  type ConnectionControl,
  type EventBus,
  type RateLimitClaim,
} from "@buzz/pubsub";
import type { SearchService } from "@buzz/search";
import type { AuditService } from "@buzz/audit";
import {
  WorkflowEngine,
  WorkflowRuntime,
  type PostgresWorkflowStore,
} from "@buzz/workflow";
import type { Pool } from "pg";
import {
  RemoteProtocolError,
  remoteCapabilitySchema,
} from "@buzz/remote-agent-protocol";
import type { MeshStatus } from "@buzz/relay-mesh";
import { WebSocketServer, WebSocket } from "ws";
import { z } from "zod";
import {
  authenticateNip98,
  authenticateNip98Identity,
  Nip98ReplayGuard,
  verifyOwnerAttestation,
} from "./nip98.js";
import {
  RemoteRegistry,
  type RemoteRegistryContract,
  type RemoteWorkerBinding,
} from "./remote-registry.js";
import { RelayMetrics } from "./metrics.js";
import { RelayAuditQueue } from "./audit-queue.js";
import {
  RelayWorkflowActionSink,
  type WorkflowCommunityIdentity,
} from "./workflow-action-sink.js";
import {
  handleMediaHttp,
  MediaUploadGate,
  type RelayMediaOptions,
} from "./media-http.js";
import {
  HuddleAudioRooms,
  type HuddleAudioMeshOptions,
} from "./huddle-audio.js";
import { RelayHuddleLifecycle } from "./huddle-lifecycle.js";
import { RelayInviteHttp, type JoinPolicy } from "./invites-http.js";
import { handleNip05Http } from "./nip05-http.js";
import { handleModerationHttp } from "./moderation-http.js";
import { RelayModerationCommands } from "./moderation-commands.js";
import { RelayModerationNotices } from "./moderation-notices.js";
import { handleWorkflowWebhookHttp } from "./workflow-webhook-http.js";
import {
  RelayOperatorHttp,
  type RelayOperatorOptions,
} from "./operator-http.js";
import { RelayAdminHttp, type RelayAdminHttpOptions } from "./admin-http.js";
import { RelayStaticHttp, type RelayStaticOptions } from "./static-http.js";

const RELAY_VERSION = "0.2.0";
import { MeshDemoHttp, type MeshDemoHttpOptions } from "./mesh-demo-http.js";
import { RelayGitHttp, type RelayGitHttpOptions } from "./git-http.js";
import { isGitObjectId, isSafeGitRefname } from "./git-manifest.js";
import { ProductFeedbackService } from "./product-feedback.js";
import { RelayPushRuntime, type RelayPushOptions } from "./push-runtime.js";
import { IdentityArchiveService } from "./identity-archive.js";
import { validateClientEventIngest } from "./ingest-validation.js";
import { resolveTargetCoordinate } from "./target-coordinate.js";
import { validateEventKind } from "./event-kind-validation.js";
import { RelayMembershipCommands } from "./relay-membership.js";
import { resolveThreadMetadata } from "./thread-metadata.js";
import { validateEventMedia } from "./imeta.js";
import { ReminderScheduler } from "./reminder-scheduler.js";
import { ChannelReaper } from "./channel-reaper.js";

const DEFAULT_MAX_FRAME_BYTES = 512 * 1024;
const MAX_FILTERS_PER_SUBSCRIPTION = 10;
const MAX_FILTER_LIMIT = 10_000;
const MAX_HISTORICAL_LIMIT = 2_000;
const MAX_SUBSCRIPTIONS = 1_024;
const MAX_SUBSCRIPTION_ID_BYTES = 256;
const MAX_PENDING_MESSAGES_PER_CONNECTION = 1_000;
const WS_ADMISSION_WINDOW_SECONDS = 5;

export type RelayRateLimitOptions = {
  readonly humanMessagesPerMinute: number;
  readonly humanApiCallsPerMinute: number;
  readonly humanWsEventsPerSecond: number;
  readonly agentStandardMessagesPerMinute: number;
  readonly agentStandardApiCallsPerMinute: number;
  readonly agentElevatedMessagesPerMinute: number;
  readonly agentPlatformMessagesPerMinute: number;
};

const DEFAULT_RATE_LIMITS: RelayRateLimitOptions = {
  agentElevatedMessagesPerMinute: 300,
  agentPlatformMessagesPerMinute: 600,
  agentStandardApiCallsPerMinute: 600,
  agentStandardMessagesPerMinute: 120,
  humanApiCallsPerMinute: 300,
  humanMessagesPerMinute: 60,
  humanWsEventsPerSecond: 10,
};

const inviteRequestSchema = z
  .object({
    capabilities: z.array(remoteCapabilitySchema).max(8).optional(),
    lifetimeSeconds: z.number().int().min(30).max(3_600).optional(),
  })
  .strict();

type Client = {
  readonly socket: WebSocket;
  readonly challenge: string;
  readonly subscriptions: Map<string, NostrFilter[]>;
  authenticationTimer?: NodeJS.Timeout;
  pendingMessages: number;
  processing: Promise<void>;
  authenticatedPubkey?: string;
  authenticatedOwnerPubkey?: string;
};

export type RelayServerOptions = {
  readonly host: string;
  readonly port: number;
  readonly publicUrl: URL;
  readonly community: string;
  readonly ownerPubkeys: ReadonlySet<string>;
  readonly maxConnections?: number;
  readonly maxConnectionsPerPubkey?: number;
  /** Maximum simultaneously executing EVENT, REQ, and COUNT handlers. */
  readonly maxConcurrentHandlers?: number;
  readonly maxFrameBytes?: number;
  /** Shared fixed-window admission thresholds. */
  readonly rateLimits?: Partial<RelayRateLimitOptions>;
  /**
   * Exact browser origins allowed by CORS. An empty list preserves the source
   * relay's permissive development mode.
   */
  readonly corsOrigins?: readonly string[];
  /** Relay-authoritative signing identity advertised by NIP-11. */
  readonly relaySelfPubkey?: string;
  /** True only when this process has durable NIP-43 membership support. */
  readonly nip43?: boolean;
  /** Advertise NIP-43 only when durable relay membership is enforced. */
  readonly advertiseNip43?: boolean;
  /** Public WebSocket URL of the dedicated device-pairing relay. */
  readonly pairingRelayUrl?: string;
  readonly registry?: RemoteRegistryContract;
  readonly eventStore?: EventStore;
  readonly accessPolicy?: RelayAccessPolicy;
  readonly eventBus?: EventBus;
  readonly readinessCheck?: () => Promise<void>;
  /** Deployment-wide leader-elected usage snapshot appended to /metrics. */
  readonly usageMetrics?: { render(): string };
  readonly search?: {
    readonly communityId: string;
    readonly service: Pick<SearchService, "search">;
  };
  readonly audit?: {
    readonly communityId: string;
    readonly service: Pick<AuditService, "log">;
  };
  readonly workflow?: {
    readonly pool: Pool;
    readonly relaySecretKey: Uint8Array;
    readonly resolveCommunityIdentity?: (
      communityId: string,
    ) => Promise<WorkflowCommunityIdentity>;
    readonly store: PostgresWorkflowStore;
  };
  /** Shared deployment runtime used by dynamically resolved tenant backends. */
  readonly workflowRuntime?: WorkflowRuntime;
  readonly media?: RelayMediaOptions;
  readonly pool?: Pool;
  readonly channelReaper?: {
    readonly batchLimit?: number;
    readonly enabled?: boolean;
    readonly intervalMs?: number;
  };
  readonly reminderScheduler?: {
    readonly batchLimit?: number;
    readonly enabled?: boolean;
    readonly intervalMs?: number;
  };
  readonly relaySecretKey?: Uint8Array;
  readonly joinPolicy?: JoinPolicy;
  readonly admin?: Omit<RelayAdminHttpOptions, "mediaStorage" | "pool">;
  readonly static?: RelayStaticOptions;
  readonly operator?: Omit<
    RelayOperatorOptions,
    | "deploymentHost"
    | "onCommunityArchived"
    | "onMembershipChanged"
    | "pool"
    | "replay"
  >;
  /** Live inter-relay mesh status. Omitted when BUZZ_MESH is off. */
  readonly meshStatus?: () => MeshStatus;
  /** Cross-pod owner-authoritative huddle routing for this tenant. */
  readonly huddleMesh?: HuddleAudioMeshOptions;
  /** Durable encrypted push lease, matcher, and delivery configuration. */
  readonly push?: Omit<RelayPushOptions, "communityHost" | "publicUrl">;
  /** Testbed-only, explicitly enabled cross-pod reliable-stream probe. */
  readonly meshDemo?: MeshDemoHttpOptions;
  /** Immutable object-store Git Smart HTTP service for this tenant. */
  readonly git?: Omit<
    RelayGitHttpOptions,
    "accessPolicy" | "community" | "onRefState" | "publicUrl"
  >;
};

type EventPublisher = (event: NostrEvent, community?: string) => Promise<void>;
type DisconnectPubkeyClusterwide = (
  pubkey: string,
  eventId: string,
  reason: string,
) => Promise<void>;

export function createRelayServer(options: RelayServerOptions) {
  const registry = options.registry ?? new RemoteRegistry();
  const eventStore = options.eventStore ?? new MemoryEventStore();
  const accessPolicy = options.accessPolicy ?? new OpenRelayAccessPolicy();
  const pushRuntime = options.push
    ? new RelayPushRuntime({
        ...options.push,
        communityHost: options.community,
        publicUrl: options.publicUrl,
      })
    : undefined;
  const eventBus = options.eventBus ?? new InMemoryEventBus();
  const clients = new Set<Client>();
  const disconnectPubkeyClusterwide: DisconnectPubkeyClusterwide = async (
    pubkey,
    eventId,
    reason,
  ) => {
    disconnectPubkeyClients(clients, pubkey, eventId, reason);
    if (!options.search) return;
    try {
      await eventBus.publishControl(options.search.communityId, {
        event_id: eventId,
        op: "DisconnectPubkey",
        pubkey: [...Buffer.from(pubkey, "hex")],
        reason,
      });
    } catch {
      // The durable ban remains the admission backstop if Redis is unavailable.
    }
  };
  const metrics = new RelayMetrics();
  const rateLimits = resolveRateLimits(options.rateLimits);
  const handlerSemaphore = new TrySemaphore(
    options.maxConcurrentHandlers ?? 1_024,
  );
  const auditQueue = options.audit
    ? new RelayAuditQueue(options.audit.service)
    : undefined;
  const locallyPublished = new Map<string, number>();
  let unsubscribeEventBus: (() => Promise<void> | void) | undefined;
  let unsubscribeControlBus: (() => Promise<void> | void) | undefined;
  let lifecycleRevalidation: NodeJS.Timeout | undefined;
  const publishEvent: EventPublisher = async (
    event,
    community = options.community,
  ) => {
    metrics.eventsPublishedTotal += 1;
    rememberLocalEvent(locallyPublished, event.id);
    await eventBus.publish(community, event);
    if (community.toLowerCase() !== options.community.toLowerCase()) return;
    if (REMOTE_AGENT_KINDS.has(event.kind)) {
      routeEvent(event, clients);
    } else {
      await routeGeneralEvent(event, clients, accessPolicy, options.community);
    }
  };
  const reminderScheduler =
    options.pool && options.reminderScheduler?.enabled !== false
      ? new ReminderScheduler(options.pool, publishEvent, {
          batchLimit:
            options.reminderScheduler?.batchLimit ??
            environmentInteger("SPROUT_REMINDER_SCHEDULER_BATCH_LIMIT", 100),
          intervalMs:
            options.reminderScheduler?.intervalMs ??
            environmentInteger("SPROUT_REMINDER_SCHEDULER_INTERVAL_SECS", 10) *
              1_000,
        })
      : undefined;
  const channelReaper =
    eventStore instanceof PostgresEventStore &&
    options.relaySecretKey &&
    options.channelReaper?.enabled !== false
      ? new ChannelReaper(
          (limit) => eventStore.reapExpiredChannels(limit),
          async (outcome) => {
            for (const event of outcome.derivedEvents) {
              await publishEvent(event, outcome.community);
            }
            await applyChannelAccessChangesClusterwide(
              outcome.community.toLowerCase() ===
                options.community.toLowerCase()
                ? clients
                : new Set<Client>(),
              [{ channelId: outcome.channelId, mode: "all" }],
              accessPolicy,
              outcome.community,
              eventBus,
              outcome.communityId,
              outcome.derivedEvents[0]?.id ?? "0".repeat(64),
            );
          },
          {
            batchLimit:
              options.channelReaper?.batchLimit ??
              environmentInteger("BUZZ_REAPER_BATCH_LIMIT", 100),
            intervalMs:
              options.channelReaper?.intervalMs ??
              environmentInteger("BUZZ_REAPER_INTERVAL_SECS", 60) * 1_000,
          },
        )
      : undefined;
  const membershipCommands =
    options.nip43 && options.pool && options.relaySecretKey
      ? new RelayMembershipCommands({
          community: options.community,
          eventStore,
          pool: options.pool,
          publishEvent,
          relaySecretKey: options.relaySecretKey,
        })
      : undefined;
  const gitHttp =
    options.git && options.relaySecretKey
      ? new RelayGitHttp({
          ...options.git,
          accessPolicy,
          community: options.community,
          onRefState: async (state) => {
            const tags: string[][] = [["d", state.repoId]];
            for (const [refName, oid] of Object.entries(state.refs).sort(
              ([left], [right]) => left.localeCompare(right),
            )) {
              if (
                (refName.startsWith("refs/heads/") ||
                  refName.startsWith("refs/tags/")) &&
                isSafeGitRefname(refName) &&
                isGitObjectId(oid)
              ) {
                tags.push([refName, oid]);
              }
            }
            if (isSafeGitRefname(state.head)) {
              tags.push(["HEAD", `ref: ${state.head}`]);
            }
            tags.push(["p", state.actorPubkey]);
            const event = signNostrEvent(
              {
                content: "",
                created_at: unixNow(),
                kind: KIND_GIT_REPO_STATE,
                tags,
              },
              options.relaySecretKey as Uint8Array,
            );
            const result = await eventStore.store(options.community, event);
            if (result.status === "inserted" || result.status === "ephemeral") {
              await publishEvent(event);
            }
          },
          publicUrl: options.publicUrl,
        })
      : undefined;
  if (options.git && !gitHttp) {
    throw new Error("Git HTTP requires a relay signing key");
  }
  let workflowRuntime = options.workflowRuntime;
  const ownsWorkflowRuntime =
    workflowRuntime === undefined && options.workflow !== undefined;
  const workflowAbort = new AbortController();
  if (options.workflow && workflowRuntime === undefined) {
    const workflowEventStores = new Map<string, PostgresEventStore>();
    const actionSink = new RelayWorkflowActionSink(
      options.workflow.pool,
      options.community,
      options.workflow.relaySecretKey,
      async (event, channelId, identity) => {
        let targetStore: EventStore = eventStore;
        if (
          identity.communityHost.toLowerCase() !==
            options.community.toLowerCase() ||
          identity.relaySecretKey.toString() !==
            options.workflow?.relaySecretKey.toString()
        ) {
          const key = `${identity.communityId}:${Buffer.from(
            identity.relaySecretKey,
          ).toString("hex")}`;
          targetStore =
            workflowEventStores.get(key) ??
            new PostgresEventStore(options.workflow?.pool as Pool, {
              relaySecretKey: identity.relaySecretKey,
            });
          workflowEventStores.set(key, targetStore as PostgresEventStore);
        }
        const stored = await targetStore.store(
          identity.communityHost,
          event,
          channelId,
        );
        if (stored.status === "inserted" || stored.status === "ephemeral") {
          await publishEvent(event, identity.communityHost);
        }
        if (stored.status === "inserted") {
          await enqueueEventCreatedAudit(
            auditQueue,
            identity.communityId,
            event,
            channelId,
          );
        }
      },
      options.workflow.resolveCommunityIdentity,
    );
    workflowRuntime = new WorkflowRuntime(
      options.workflow.store,
      new WorkflowEngine(actionSink),
    );
    void workflowRuntime.runScheduler(workflowAbort.signal).catch(() => {
      // Readiness and the next scheduler tick surface durable infrastructure
      // failures; never turn a rejected background promise into a process crash.
    });
  }
  const replayScope = options.search?.communityId ?? options.community;
  const nip98Replay = new Nip98ReplayGuard(
    10_000,
    (scope, eventId, ttlSeconds) =>
      eventBus.claimNip98Replay(scope, eventId, ttlSeconds),
  );
  const admin =
    options.admin && options.pool
      ? new RelayAdminHttp({
          ...options.admin,
          ...(options.media ? { mediaStorage: options.media.storage } : {}),
          pool: options.pool,
        })
      : undefined;
  const staticHttp = options.static
    ? new RelayStaticHttp(options.static)
    : undefined;
  const meshDemo = options.meshDemo
    ? new MeshDemoHttp(options.meshDemo)
    : undefined;
  const operator =
    options.operator && options.pool
      ? new RelayOperatorHttp({
          ...options.operator,
          deploymentHost: options.community,
          onCommunityArchived: async (communityId, archivedHost) => {
            if (
              archivedHost.toLowerCase() === options.community.toLowerCase()
            ) {
              disconnectCommunityClients(clients);
            }
            await eventBus.publishControl(communityId, {
              op: "DisconnectCommunity",
            });
          },
          onMembershipChanged: async (communityId, membershipHost) => {
            if (!options.relaySecretKey || !options.pool) return;
            const members = await options.pool.query<{
              readonly pubkey: string;
              readonly role: string;
            }>(
              `SELECT pubkey, role
               FROM relay_members
               WHERE community_id = $1::uuid
               ORDER BY created_at, pubkey`,
              [communityId],
            );
            const databaseNow = await options.pool.query<{
              readonly now: Date;
            }>("SELECT clock_timestamp() AS now");
            const event = signNostrEvent(
              {
                content: "",
                created_at: Math.floor(
                  (databaseNow.rows[0]?.now.getTime() ?? Date.now()) / 1_000,
                ),
                kind: KIND_NIP43_MEMBERSHIP_LIST,
                tags: [
                  ["-"],
                  ...members.rows.map(({ pubkey, role }) => [
                    "member",
                    pubkey,
                    role,
                  ]),
                ],
              },
              options.relaySecretKey,
            );
            const stored = await eventStore.store(membershipHost, event);
            if (stored.status === "inserted" || stored.status === "ephemeral") {
              await publishEvent(event, membershipHost);
            }
          },
          pool: options.pool,
          replay: nip98Replay,
        })
      : undefined;
  const moderationNotices =
    options.pool && options.relaySecretKey
      ? new RelayModerationNotices({
          community: options.community,
          eventStore,
          pool: options.pool,
          publishEvent,
          relaySecretKey: options.relaySecretKey,
        })
      : undefined;
  const moderationCommands = options.pool
    ? new RelayModerationCommands(
        options.pool,
        options.community,
        options.media
          ? {
              communityId: options.media.communityId,
              storage: options.media.storage,
            }
          : undefined,
        moderationNotices,
      )
    : undefined;
  const productFeedback =
    options.pool && options.search
      ? new ProductFeedbackService({
          communityHost: options.community,
          communityId: options.search.communityId,
          ...(options.media ? { mediaStorage: options.media.storage } : {}),
          pool: options.pool,
          publicUrl: options.publicUrl,
        })
      : undefined;
  const identityArchive =
    options.pool && options.relaySecretKey
      ? new IdentityArchiveService({
          community: options.community,
          eventStore,
          pool: options.pool,
          publishEvent,
          relaySecretKey: options.relaySecretKey,
        })
      : undefined;
  const invites = new RelayInviteHttp({
    community: options.community,
    ownerPubkeys: options.ownerPubkeys,
    publicUrl: options.publicUrl,
    replay: nip98Replay,
    replayScope,
    ...(options.joinPolicy ? { joinPolicy: options.joinPolicy } : {}),
    ...(options.pool ? { pool: options.pool } : {}),
    ...(options.relaySecretKey
      ? { relaySecretKey: options.relaySecretKey }
      : {}),
    onMemberAdded: async (pubkey) => {
      if (!options.relaySecretKey) return;
      const event = signNostrEvent(
        {
          content: "",
          created_at: unixNow(),
          kind: KIND_NIP43_MEMBER_ADDED,
          tags: [["-"], ["p", pubkey]],
        },
        options.relaySecretKey,
      );
      const stored = await eventStore.store(options.community, event);
      if (stored.status === "inserted" || stored.status === "ephemeral") {
        await publishEvent(event);
      }
    },
  });
  const connectionRateLimit = new TokenBucketRateLimiter({
    capacity: 200,
    refillPerSecond: 20,
    maximumKeys: 50_000,
  });
  const identityRateLimit = new TokenBucketRateLimiter({
    capacity: 600,
    refillPerSecond: 30,
    maximumKeys: 100_000,
  });
  const controlRateLimit = new TokenBucketRateLimiter({
    capacity: 20,
    refillPerSecond: 0.2,
    maximumKeys: 100_000,
  });
  const httpRateLimit = new TokenBucketRateLimiter({
    capacity: 60,
    refillPerSecond: 1,
    maximumKeys: 100_000,
  });
  const mediaUploadGate = options.media
    ? new MediaUploadGate(
        options.media.maxConcurrentUploads ?? 8,
        options.media.maxConcurrentUploadsPerPubkey ?? 2,
        options.media.uploadsPerMinute ?? 20,
      )
    : undefined;
  const huddleLifecycle =
    options.pool && options.relaySecretKey
      ? new RelayHuddleLifecycle({
          community: options.community,
          eventStore,
          pool: options.pool,
          publishEvent,
          relaySecretKey: options.relaySecretKey,
        })
      : undefined;
  const huddleAudioRooms = new HuddleAudioRooms({
    accessPolicy,
    community: options.community,
    ...(huddleLifecycle ? { lifecycle: huddleLifecycle } : {}),
    publicUrl: options.publicUrl,
    ...(options.huddleMesh ? { mesh: options.huddleMesh } : {}),
  });
  const httpServer = createServer((request, response) => {
    void handleHttp(request, response, {
      accessPolicy,
      ...(admin ? { admin } : {}),
      ...(auditQueue ? { auditQueue } : {}),
      clients,
      controlRateLimit,
      disconnectPubkeyClusterwide,
      eventBus,
      eventStore,
      rateLimits,
      httpRateLimit,
      ...(identityArchive ? { identityArchive } : {}),
      ...(membershipCommands ? { membershipCommands } : {}),
      invites,
      nip98Replay,
      ...(operator ? { operator } : {}),
      ...(productFeedback ? { productFeedback } : {}),
      ...(pushRuntime ? { pushRuntime } : {}),
      ...(staticHttp ? { staticHttp } : {}),
      metrics,
      ...(moderationCommands ? { moderationCommands } : {}),
      ...(mediaUploadGate ? { mediaUploadGate } : {}),
      ...(meshDemo ? { meshDemo } : {}),
      ...(gitHttp ? { gitHttp } : {}),
      options,
      publishEvent,
      registry,
      ...(workflowRuntime ? { workflowRuntime } : {}),
    });
  });
  const websocketServer = new WebSocketServer({
    maxPayload: options.maxFrameBytes ?? DEFAULT_MAX_FRAME_BYTES,
    noServer: true,
    perMessageDeflate: false,
  });
  const audioWebsocketServer = new WebSocketServer({
    maxPayload: 64 * 1024,
    noServer: true,
    perMessageDeflate: false,
  });

  httpServer.on("upgrade", (request, socket, head) => {
    const host = requestHostname(request.headers.host);
    if (
      host !== new URL(`http://${options.community}`).hostname.toLowerCase()
    ) {
      socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    const audioMatch =
      request.url &&
      /^\/huddle\/([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\/audio$/i.exec(
        request.url,
      );
    if (audioMatch?.[1]) {
      const channelId = audioMatch[1];
      audioWebsocketServer.handleUpgrade(request, socket, head, (websocket) =>
        huddleAudioRooms.accept(websocket, channelId),
      );
      return;
    }
    if (request.url !== "/") {
      socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    websocketServer.handleUpgrade(request, socket, head, (websocket) => {
      websocketServer.emit("connection", websocket, request);
    });
  });

  websocketServer.on("connection", (socket) => {
    if (clients.size >= (options.maxConnections ?? 10_000)) {
      socket.close(1013, "connection capacity exceeded");
      return;
    }
    metrics.websocketConnectionsTotal += 1;
    const client: Client = {
      challenge: randomBytes(32).toString("hex"),
      pendingMessages: 0,
      processing: Promise.resolve(),
      socket,
      subscriptions: new Map(),
    };
    client.authenticationTimer = setTimeout(() => {
      if (client.authenticatedPubkey !== undefined) return;
      metrics.authenticationTimeoutsTotal += 1;
      client.socket.close(1008, "authentication timeout");
    }, 5_000);
    client.authenticationTimer.unref();
    clients.add(client);
    socket.send(JSON.stringify(["AUTH", client.challenge]));
    socket.on("message", (data, isBinary) => {
      metrics.websocketMessagesTotal += 1;
      const bytes = Array.isArray(data)
        ? Buffer.concat(data)
        : Buffer.isBuffer(data)
          ? data
          : Buffer.from(data);
      if (
        isBinary ||
        bytes.length > (options.maxFrameBytes ?? DEFAULT_MAX_FRAME_BYTES)
      ) {
        socket.close(1009, "payload too large");
        return;
      }
      if (client.pendingMessages >= MAX_PENDING_MESSAGES_PER_CONNECTION) {
        socket.close(1013, "inbound request capacity exceeded");
        return;
      }
      client.pendingMessages += 1;
      client.processing = client.processing
        .then(() =>
          handleWebSocketMessage(client, bytes.toString("utf8"), {
            connectionRateLimit,
            controlRateLimit,
            clients,
            disconnectPubkeyClusterwide,
            accessPolicy,
            ...(auditQueue ? { auditQueue } : {}),
            eventBus,
            eventStore,
            handlerSemaphore,
            identityRateLimit,
            ...(identityArchive ? { identityArchive } : {}),
            ...(membershipCommands ? { membershipCommands } : {}),
            options,
            publishEvent,
            rateLimits,
            registry,
            metrics,
            ...(moderationCommands ? { moderationCommands } : {}),
            ...(productFeedback ? { productFeedback } : {}),
            ...(pushRuntime ? { pushRuntime } : {}),
            ...(gitHttp ? { gitHttp } : {}),
            ...(workflowRuntime ? { workflowRuntime } : {}),
          }),
        )
        .catch(() => {
          socket.close(1011, "request processing failed");
        })
        .finally(() => {
          client.pendingMessages = Math.max(0, client.pendingMessages - 1);
        });
    });
    let clientRemoved = false;
    const removeClient = (): void => {
      if (clientRemoved) return;
      clientRemoved = true;
      if (client.authenticationTimer) {
        clearTimeout(client.authenticationTimer);
        delete client.authenticationTimer;
      }
      clients.delete(client);
      const pubkey = client.authenticatedPubkey;
      if (
        pubkey &&
        ![...clients].some(
          (candidate) => candidate.authenticatedPubkey === pubkey,
        )
      ) {
        void eventBus
          .clearPresence(options.community, pubkey)
          .catch(() => undefined);
      }
    };
    socket.on("close", removeClient);
    socket.on("error", removeClient);
  });

  return {
    address: () => httpServer.address(),
    close: async () => {
      if (ownsWorkflowRuntime) workflowAbort.abort();
      channelReaper?.stop();
      reminderScheduler?.stop();
      for (const client of clients)
        client.socket.close(1001, "server shutdown");
      huddleAudioRooms.close();
      audioWebsocketServer.close();
      websocketServer.close();
      await unsubscribeEventBus?.();
      await unsubscribeControlBus?.();
      if (lifecycleRevalidation) clearInterval(lifecycleRevalidation);
      await auditQueue?.close();
      await pushRuntime?.close();
      await new Promise<void>((resolve, reject) => {
        httpServer.close((error) => (error ? reject(error) : resolve()));
      });
    },
    listen: async () => {
      unsubscribeEventBus = await eventBus.subscribe(
        options.community,
        async (event) => {
          if (consumeLocalEvent(locallyPublished, event.id)) return;
          if (REMOTE_AGENT_KINDS.has(event.kind)) {
            routeEvent(event, clients);
          } else {
            await routeGeneralEvent(
              event,
              clients,
              accessPolicy,
              options.community,
            );
          }
        },
      );
      if (options.search) {
        unsubscribeControlBus = await eventBus.subscribeControl(
          options.search.communityId,
          (command) =>
            applyConnectionControl(
              command,
              clients,
              accessPolicy,
              options.community,
            ),
        );
      }
      if (options.pool && options.search) {
        const pool = options.pool;
        const communityId = options.search.communityId;
        lifecycleRevalidation = setInterval(() => {
          void pool
            .query<{ readonly active: boolean }>(
              `SELECT EXISTS(
                 SELECT 1
                 FROM communities
                 WHERE id = $1::uuid AND archived_at IS NULL
               ) AS active`,
              [communityId],
            )
            .then((result) => {
              if (result.rows[0]?.active === false) {
                disconnectCommunityClients(clients);
              }
            })
            .catch(() => undefined);
        }, 30_000);
        lifecycleRevalidation.unref();
      }
      await gitHttp?.ready();
      await new Promise<void>((resolve, reject) => {
        httpServer.once("error", reject);
        httpServer.listen(options.port, options.host, () => {
          httpServer.off("error", reject);
          resolve();
        });
      });
      pushRuntime?.start();
      channelReaper?.start();
      reminderScheduler?.start();
    },
    eventStore,
    huddleAudioRooms,
    channelReaper,
    metrics,
    registry,
    reminderScheduler,
    workflowRuntime,
    pushRuntime,
  };
}

async function handleWebSocketMessage(
  client: Client,
  encoded: string,
  context: {
    readonly clients: ReadonlySet<Client>;
    readonly accessPolicy: RelayAccessPolicy;
    readonly auditQueue?: RelayAuditQueue;
    readonly connectionRateLimit: TokenBucketRateLimiter;
    readonly controlRateLimit: TokenBucketRateLimiter;
    readonly disconnectPubkeyClusterwide: DisconnectPubkeyClusterwide;
    readonly eventBus: EventBus;
    readonly eventStore: EventStore;
    readonly gitHttp?: RelayGitHttp;
    readonly handlerSemaphore: TrySemaphore;
    readonly identityArchive?: IdentityArchiveService;
    readonly membershipCommands?: RelayMembershipCommands;
    readonly identityRateLimit: TokenBucketRateLimiter;
    readonly options: RelayServerOptions;
    readonly publishEvent: EventPublisher;
    readonly rateLimits: RelayRateLimitOptions;
    readonly registry: RemoteRegistryContract;
    readonly metrics: RelayMetrics;
    readonly moderationCommands?: RelayModerationCommands;
    readonly productFeedback?: ProductFeedbackService;
    readonly pushRuntime?: RelayPushRuntime;
    readonly workflowRuntime?: WorkflowRuntime;
  },
): Promise<void> {
  let message: unknown;
  let releaseHandler: (() => void) | undefined;
  try {
    message = JSON.parse(encoded) as unknown;
  } catch {
    send(client.socket, ["NOTICE", "invalid JSON"]);
    return;
  }
  if (!Array.isArray(message) || typeof message[0] !== "string") return;
  try {
    const cost = messageCost(message[0]);
    if (
      !context.connectionRateLimit.consume(client.challenge, cost) ||
      (client.authenticatedPubkey !== undefined &&
        !context.identityRateLimit.consume(client.authenticatedPubkey, cost)) ||
      (message[0] === "BRAP" &&
        client.authenticatedPubkey !== undefined &&
        !context.controlRateLimit.consume(client.authenticatedPubkey, 5))
    ) {
      throw new RemoteProtocolError(
        "RATE_LIMITED",
        "relay request rate exceeded",
      );
    }
    if (
      message[0] === "EVENT" ||
      message[0] === "REQ" ||
      message[0] === "COUNT"
    ) {
      requireAuthentication(client);
      if (
        !(await enforceSharedWebSocketAdmission(
          client,
          message,
          context.eventBus,
          context.options.search?.communityId ?? context.options.community,
          context.rateLimits,
          context.metrics,
        ))
      ) {
        return;
      }
      releaseHandler = context.handlerSemaphore.tryAcquire();
      if (!releaseHandler) {
        context.metrics.rejectedRequestsTotal += 1;
        sendWebSocketAdmissionRejection(
          client,
          message,
          "rate-limited: too many concurrent requests",
        );
        return;
      }
    }
    switch (message[0]) {
      case "AUTH":
        await authenticateWebSocket(
          client,
          message[1],
          context.options.publicUrl,
          context.accessPolicy,
          context.options.community,
          context.clients,
          context.options.maxConnectionsPerPubkey ?? 20,
        );
        break;
      case "REQ":
        requireAuthentication(client);
        await setSubscription(
          client,
          message,
          context.eventStore,
          context.accessPolicy,
          context.options.community,
          context.options.search,
        );
        break;
      case "COUNT":
        requireAuthentication(client);
        await countSubscription(
          client,
          message,
          context.eventStore,
          context.accessPolicy,
          context.options.community,
          context.options.search,
        );
        break;
      case "CLOSE":
        if (typeof message[1] === "string") {
          client.subscriptions.delete(message[1]);
          send(client.socket, ["CLOSED", message[1], ""]);
        }
        break;
      case "EVENT":
        requireAuthentication(client);
        if (
          verifyNostrEvent(message[1]) &&
          REMOTE_AGENT_KINDS.has(message[1].kind)
        ) {
          await publishRemoteEvent(
            client,
            message[1],
            context.registry,
            context.options.community,
            context.publishEvent,
          );
        } else {
          await publishGeneralEvent(
            client,
            message[1],
            context.eventStore,
            context.accessPolicy,
            context.options.community,
            context.publishEvent,
            context.auditQueue,
            context.options.audit?.communityId,
            context.workflowRuntime,
            context.gitHttp,
            context.moderationCommands,
            context.identityArchive,
            context.membershipCommands,
            context.productFeedback,
            context.pushRuntime,
            context.options.media,
            context.eventBus,
            context.disconnectPubkeyClusterwide,
            context.clients,
            context.options.search?.communityId,
            context.options.relaySelfPubkey ??
              (context.options.relaySecretKey
                ? publicKeyFromSecret(context.options.relaySecretKey)
                : undefined),
          );
        }
        break;
      case "BRAP":
        requireAuthentication(client);
        await handleBrap(client, message, context);
        break;
    }
  } catch (error) {
    context.metrics.rejectedRequestsTotal += 1;
    const protocolError =
      error instanceof RemoteProtocolError
        ? error
        : new RemoteProtocolError("CONFIG_INVALID", "request was rejected");
    if (message[0] === "EVENT" || message[0] === "AUTH") {
      send(client.socket, [
        "OK",
        submittedEventId(message[1]),
        false,
        nostrRejectionReason(protocolError, message[0]),
      ]);
      return;
    }
    send(client.socket, [
      "NOTICE",
      `${protocolError.code}: ${protocolError.message}`,
    ]);
  } finally {
    releaseHandler?.();
  }
}

async function enforceSharedWebSocketAdmission(
  client: Client,
  message: unknown[],
  eventBus: EventBus,
  scope: string,
  rateLimits: RelayRateLimitOptions,
  metrics: RelayMetrics,
): Promise<boolean> {
  const pubkey = client.authenticatedPubkey as string;
  let wsClaim: RateLimitClaim;
  try {
    wsClaim = await eventBus.claimRateLimit(
      scope,
      pubkey,
      "ws",
      WS_ADMISSION_WINDOW_SECONDS,
      rateLimits.humanWsEventsPerSecond * WS_ADMISSION_WINDOW_SECONDS,
    );
  } catch {
    metrics.rejectedRequestsTotal += 1;
    metrics.recordAdmissionRejection("websocket", "unavailable");
    sendWebSocketAdmissionRejection(
      client,
      message,
      "rate-limited: shared admission unavailable",
    );
    return false;
  }
  if (!wsClaim.allowed) {
    metrics.rejectedRequestsTotal += 1;
    metrics.recordAdmissionRejection("websocket", "quota");
    sendWebSocketAdmissionRejection(
      client,
      message,
      `rate-limited: quota exceeded; retry in ${wsClaim.resetInSeconds}s`,
    );
    return false;
  }
  if (message[0] !== "EVENT") return true;

  let messageClaim: RateLimitClaim;
  try {
    messageClaim = await eventBus.claimRateLimit(
      scope,
      pubkey,
      "msg",
      60,
      client.authenticatedOwnerPubkey === undefined
        ? rateLimits.humanMessagesPerMinute
        : rateLimits.agentStandardMessagesPerMinute,
    );
  } catch {
    metrics.rejectedRequestsTotal += 1;
    metrics.recordAdmissionRejection("websocket", "unavailable");
    sendWebSocketAdmissionRejection(
      client,
      message,
      "rate-limited: shared admission unavailable",
    );
    return false;
  }
  if (messageClaim.allowed) return true;
  metrics.rejectedRequestsTotal += 1;
  metrics.recordAdmissionRejection("websocket", "quota");
  sendWebSocketAdmissionRejection(
    client,
    message,
    `rate-limited: quota exceeded; retry in ${messageClaim.resetInSeconds}s`,
  );
  return false;
}

function sendWebSocketAdmissionRejection(
  client: Client,
  message: unknown[],
  reason: string,
): void {
  if (message[0] === "EVENT") {
    send(client.socket, ["OK", submittedEventId(message[1]), false, reason]);
    return;
  }
  const subscriptionId =
    message[0] === "REQ" || message[0] === "COUNT" ? message[1] : undefined;
  if (
    typeof subscriptionId === "string" &&
    Buffer.byteLength(subscriptionId, "utf8") <= MAX_SUBSCRIPTION_ID_BYTES
  ) {
    send(client.socket, ["CLOSED", subscriptionId, reason]);
    return;
  }
  send(client.socket, ["NOTICE", reason]);
}

async function authenticateWebSocket(
  client: Client,
  value: unknown,
  publicUrl: URL,
  accessPolicy: RelayAccessPolicy,
  community: string,
  clients: ReadonlySet<Client>,
  maxConnectionsPerPubkey: number,
): Promise<void> {
  if (!verifyNostrEvent(value) || value.kind !== KIND_AUTH) {
    throw new RemoteProtocolError(
      "SIGNATURE_INVALID",
      "NIP-42 event is invalid",
    );
  }
  const now = unixNow();
  if (value.created_at < now - 600 || value.created_at > now + 600) {
    throw new RemoteProtocolError("MESSAGE_EXPIRED", "NIP-42 event is stale");
  }
  if (
    singleTag(value, "challenge") !== client.challenge ||
    normalizeRelayUrl(singleTag(value, "relay")) !==
      normalizeRelayUrl(publicUrl.toString())
  ) {
    throw new RemoteProtocolError(
      "AUTH_REQUIRED",
      "NIP-42 challenge or relay binding does not match",
    );
  }
  if (
    client.authenticatedPubkey !== undefined &&
    client.authenticatedPubkey !== value.pubkey
  ) {
    throw new RemoteProtocolError(
      "AUTH_REQUIRED",
      "connection is already bound to another public key",
    );
  }
  const ownerPubkey = verifyOwnerAttestation(value);
  if (
    value.tags.some((tag) => tag[0] === "auth") &&
    ownerPubkey === undefined
  ) {
    throw new RemoteProtocolError(
      "SIGNATURE_INVALID",
      "NIP-OA owner credential is invalid",
    );
  }
  if (!(await accessPolicy.canConnect(community, value.pubkey, ownerPubkey))) {
    throw new RemoteProtocolError(
      "CAPABILITY_DENIED",
      "identity is not admitted to this community",
    );
  }
  if (
    [...clients].filter(
      (candidate) =>
        candidate !== client && candidate.authenticatedPubkey === value.pubkey,
    ).length >= maxConnectionsPerPubkey
  ) {
    throw new RemoteProtocolError(
      "RATE_LIMITED",
      "identity connection quota exceeded",
    );
  }
  client.authenticatedPubkey = value.pubkey;
  if (client.authenticationTimer) {
    clearTimeout(client.authenticationTimer);
    delete client.authenticationTimer;
  }
  if (ownerPubkey) client.authenticatedOwnerPubkey = ownerPubkey;
  else delete client.authenticatedOwnerPubkey;
  send(client.socket, ["OK", value.id, true, ""]);
}

async function setSubscription(
  client: Client,
  message: unknown[],
  eventStore: EventStore,
  accessPolicy: RelayAccessPolicy,
  community: string,
  search: RelayServerOptions["search"],
): Promise<void> {
  const subscriptionId = message[1];
  if (
    typeof subscriptionId !== "string" ||
    subscriptionId.length < 1 ||
    Buffer.byteLength(subscriptionId, "utf8") > MAX_SUBSCRIPTION_ID_BYTES
  ) {
    throw new RemoteProtocolError("CONFIG_INVALID", "invalid subscription ID");
  }
  const filters = message.slice(2).map(parseFilter);
  if (filters.length > MAX_FILTERS_PER_SUBSCRIPTION) {
    throw new RemoteProtocolError("CONFIG_INVALID", "invalid filter count");
  }
  if (
    !client.subscriptions.has(subscriptionId) &&
    client.subscriptions.size >= MAX_SUBSCRIPTIONS
  ) {
    send(client.socket, [
      "CLOSED",
      subscriptionId,
      "error: too many subscriptions",
    ]);
    return;
  }
  const channelScope = subscriptionChannelId(filters);
  if (
    channelScope === undefined &&
    !pGatedFiltersAuthorized(filters, client.authenticatedPubkey as string)
  ) {
    send(client.socket, [
      "CLOSED",
      subscriptionId,
      "restricted: p-gated events require #p matching your pubkey",
    ]);
    return;
  }
  if (
    channelScope === undefined &&
    !engramFiltersAuthorized(filters, client.authenticatedPubkey as string)
  ) {
    send(client.socket, [
      "CLOSED",
      subscriptionId,
      "restricted: agent-engram reads require authors=[self] or #p=[self]",
    ]);
    return;
  }
  if (
    channelScope === undefined &&
    !authorOnlyFiltersAuthorized(filters, client.authenticatedPubkey as string)
  ) {
    send(client.socket, [
      "CLOSED",
      subscriptionId,
      "restricted: author-only kinds require authors=[self]",
    ]);
    return;
  }
  client.subscriptions.set(subscriptionId, filters);
  const delivered = new Set<string>();
  for (const filter of filters) {
    if (filter.kinds?.some((kind) => REMOTE_AGENT_KINDS.has(kind))) continue;
    const events = await queryFilterEvents(
      eventStore,
      community,
      filter,
      search,
      Math.min(filter.limit ?? MAX_HISTORICAL_LIMIT, MAX_HISTORICAL_LIMIT),
    );
    for (const event of events) {
      if (
        delivered.has(event.id) ||
        (channelScope !== undefined &&
          eventChannelId(event) !== channelScope) ||
        !(await accessPolicy.canRead(
          community,
          client.authenticatedPubkey as string,
          event,
          client.authenticatedOwnerPubkey,
        ))
      ) {
        continue;
      }
      delivered.add(event.id);
      send(client.socket, ["EVENT", subscriptionId, event]);
    }
  }
  send(client.socket, ["EOSE", subscriptionId]);
}

async function countSubscription(
  client: Client,
  message: unknown[],
  eventStore: EventStore,
  accessPolicy: RelayAccessPolicy,
  community: string,
  search: RelayServerOptions["search"],
): Promise<void> {
  const subscriptionId = message[1];
  if (
    typeof subscriptionId !== "string" ||
    Buffer.byteLength(subscriptionId, "utf8") < 1 ||
    Buffer.byteLength(subscriptionId, "utf8") > MAX_SUBSCRIPTION_ID_BYTES
  ) {
    throw new RemoteProtocolError("CONFIG_INVALID", "invalid COUNT request");
  }
  const filters = message.slice(2).map(parseFilter);
  if (filters.length > MAX_FILTERS_PER_SUBSCRIPTION) {
    throw new RemoteProtocolError(
      "CONFIG_INVALID",
      "invalid COUNT filter count",
    );
  }
  const pubkey = client.authenticatedPubkey as string;
  if (!pGatedFiltersAuthorized(filters, pubkey)) {
    send(client.socket, [
      "CLOSED",
      subscriptionId,
      "restricted: p-gated kinds require #p tag matching your pubkey",
    ]);
    return;
  }
  if (!engramFiltersAuthorized(filters, pubkey)) {
    send(client.socket, [
      "CLOSED",
      subscriptionId,
      "restricted: agent-engram reads require authors=[self] or #p=[self]",
    ]);
    return;
  }
  if (!authorOnlyFiltersAuthorized(filters, pubkey)) {
    send(client.socket, [
      "CLOSED",
      subscriptionId,
      "restricted: author-only kinds require authors=[self]",
    ]);
    return;
  }
  let count = 0;
  for (const filter of filters) {
    count += filter.search
      ? await countReadableSearchEvents(
          eventStore,
          accessPolicy,
          community,
          pubkey,
          filter,
          search,
          client.authenticatedOwnerPubkey,
        )
      : await countReadableEvents(
          eventStore,
          accessPolicy,
          community,
          pubkey,
          filter,
          client.authenticatedOwnerPubkey,
        );
    if (!Number.isSafeInteger(count)) {
      throw new RemoteProtocolError(
        "CONFIG_INVALID",
        "COUNT result exceeds the supported range",
      );
    }
  }
  send(client.socket, ["COUNT", subscriptionId, { count }]);
}

async function publishGeneralEvent(
  client: Client,
  value: unknown,
  eventStore: EventStore,
  accessPolicy: RelayAccessPolicy,
  community: string,
  publishEvent: EventPublisher,
  auditQueue: RelayAuditQueue | undefined,
  auditCommunityId: string | undefined,
  workflowRuntime: WorkflowRuntime | undefined,
  gitHttp: RelayGitHttp | undefined,
  moderationCommands: RelayModerationCommands | undefined,
  identityArchive: IdentityArchiveService | undefined,
  membershipCommands: RelayMembershipCommands | undefined,
  productFeedback: ProductFeedbackService | undefined,
  pushRuntime: RelayPushRuntime | undefined,
  media: RelayMediaOptions | undefined,
  eventBus: EventBus,
  disconnectPubkeyClusterwide: DisconnectPubkeyClusterwide,
  clients: ReadonlySet<Client>,
  controlCommunityId: string | undefined,
  relaySelfPubkey: string | undefined,
): Promise<void> {
  validateClientEventIngest(value, {
    now: unixNow(),
    principalPubkey: client.authenticatedPubkey as string,
    transport: "websocket",
  });
  const coordinateOverride = await resolveTargetCoordinate(
    eventStore,
    community,
    value,
    relaySelfPubkey,
  );
  const requestedChannelId =
    coordinateOverride === undefined
      ? eventChannelId(value)
      : (coordinateOverride ?? undefined);
  gitHttp?.validateAnnouncement(value);
  if (
    !(await accessPolicy.canPublish(
      community,
      client.authenticatedPubkey as string,
      value,
      client.authenticatedOwnerPubkey,
      coordinateOverride,
    ))
  ) {
    throw new RemoteProtocolError(
      "CAPABILITY_DENIED",
      "event is not authorized in this community or channel",
    );
  }
  await validateEventKind(
    eventStore,
    community,
    value,
    unixNow(),
    undefined,
    relaySelfPubkey,
  );
  await validateEventMedia(value, imetaMedia(media));
  if (membershipCommands?.handles(value.kind)) {
    const message = await membershipCommands.execute(value);
    send(client.socket, ["OK", value.id, true, message]);
    return;
  }
  if (
    value.kind === RELAY_ADMIN_ADD_MEMBER ||
    value.kind === RELAY_ADMIN_REMOVE_MEMBER ||
    value.kind === RELAY_ADMIN_CHANGE_ROLE ||
    value.kind === RELAY_ADMIN_SET_WORKSPACE_PROFILE ||
    value.kind === KIND_NIP43_LEAVE_REQUEST
  ) {
    throw new RemoteProtocolError(
      "CONFIG_INVALID",
      "relay membership commands are unavailable",
    );
  }
  if (
    await executeModerationDirectEvent(
      moderationCommands,
      value,
      disconnectPubkeyClusterwide,
    )
  ) {
    send(client.socket, ["OK", value.id, true, ""]);
    return;
  }
  if (identityArchive?.handles(value.kind)) {
    await identityArchive.execute(value);
  } else if (
    value.kind === KIND_IA_ARCHIVE_REQUEST ||
    value.kind === KIND_IA_UNARCHIVE_REQUEST
  ) {
    throw new RemoteProtocolError(
      "CONFIG_INVALID",
      "identity archival is unavailable",
    );
  }
  if (value.kind === KIND_PRODUCT_FEEDBACK) {
    if (!productFeedback) {
      throw new RemoteProtocolError(
        "CONFIG_INVALID",
        "product feedback persistence is unavailable",
      );
    }
    await productFeedback.accept(value);
    send(client.socket, ["OK", value.id, true, ""]);
    return;
  }
  if (value.kind === KIND_PUSH_LEASE) {
    await acceptPushLeaseEvent(pushRuntime, value, publishEvent);
    send(client.socket, ["OK", value.id, true, ""]);
    return;
  }
  if (value.kind === KIND_PRESENCE_UPDATE) {
    await applyPresenceUpdate(eventBus, community, value);
  }
  const preparedControl = await workflowRuntime?.prepareControlEvent(
    community,
    value,
    requestedChannelId,
  );
  const effectiveChannelId = preparedControl?.channelId ?? requestedChannelId;
  const threadMetadata = await resolveThreadMetadata(
    eventStore,
    community,
    value,
    effectiveChannelId,
  );
  const result = await eventStore.store(
    community,
    value,
    effectiveChannelId,
    preparedControl?.apply,
    threadMetadata,
  );
  await evictRevokedChannelSubscriptionsClusterwide(
    clients,
    result.revokedChannelMembers ?? [],
    eventBus,
    controlCommunityId,
    value.id,
  );
  await applyChannelAccessChangesClusterwide(
    clients,
    result.channelAccessChanges ?? [],
    accessPolicy,
    community,
    eventBus,
    controlCommunityId,
    value.id,
  );
  let responseMessage = result.message;
  if (result.status === "inserted") {
    await gitHttp?.onEventStored(value);
  }
  if (result.status === "inserted" || result.status === "ephemeral") {
    await publishEvent(value);
    for (const derived of result.derivedEvents ?? []) {
      await publishEvent(derived);
    }
  }
  if (result.status === "inserted") {
    await enqueueEventCreatedAudit(
      auditQueue,
      auditCommunityId,
      value,
      effectiveChannelId,
    );
    if (preparedControl) {
      const response = await preparedControl.afterCommit();
      if (response !== undefined) {
        responseMessage = `response:${JSON.stringify(response)}`;
      }
    } else {
      await workflowRuntime?.onEvent(community, value, effectiveChannelId);
    }
  }
  send(client.socket, [
    "OK",
    value.id,
    !isActiveReactionDuplicate(result),
    result.status === "duplicate" || result.status === "superseded"
      ? (result.message ?? result.status)
      : (responseMessage ?? ""),
  ]);
}

async function applyPresenceUpdate(
  eventBus: EventBus,
  community: string,
  event: NostrEvent,
): Promise<void> {
  let status = event.content;
  if (status.startsWith("{")) {
    try {
      const parsed = JSON.parse(status) as unknown;
      if (
        typeof parsed === "object" &&
        parsed !== null &&
        !Array.isArray(parsed) &&
        typeof (parsed as { status?: unknown }).status === "string"
      ) {
        status = (parsed as { status: string }).status;
      }
    } catch {
      // A malformed legacy object remains a literal status and is bounded by
      // the presence store below.
    }
  }
  status = truncateUtf8(status, 128);
  if (status === "offline") {
    await eventBus.clearPresence(community, event.pubkey);
  } else {
    await eventBus.setPresence(community, event.pubkey, status);
  }
}

function truncateUtf8(value: string, maximumBytes: number): string {
  if (Buffer.byteLength(value, "utf8") <= maximumBytes) return value;
  let output = "";
  let bytes = 0;
  for (const character of value) {
    const width = Buffer.byteLength(character, "utf8");
    if (bytes + width > maximumBytes) break;
    output += character;
    bytes += width;
  }
  return output;
}

function environmentInteger(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw || !/^[1-9][0-9]*$/.test(raw)) return fallback;
  const value = Number(raw);
  return Number.isSafeInteger(value) ? value : fallback;
}

function imetaMedia(media: RelayMediaOptions | undefined) {
  return media
    ? {
        communityId: media.communityId,
        publicBaseUrl: media.config.publicBaseUrl,
        storage: media.storage,
      }
    : undefined;
}

async function routeGeneralEvent(
  event: NostrEvent,
  clients: ReadonlySet<Client>,
  accessPolicy: RelayAccessPolicy,
  community: string,
): Promise<void> {
  for (const client of clients) {
    if (
      !client.authenticatedPubkey ||
      !(await accessPolicy.canRead(
        community,
        client.authenticatedPubkey,
        event,
        client.authenticatedOwnerPubkey,
      ))
    ) {
      continue;
    }
    for (const [subscriptionId, filters] of client.subscriptions) {
      const channelScope = subscriptionChannelId(filters);
      if (eventChannelId(event) !== channelScope) {
        continue;
      }
      if (filters.some((filter) => eventMatchesFilter(event, filter))) {
        send(client.socket, ["EVENT", subscriptionId, event]);
      }
    }
  }
}

async function acceptPushLeaseEvent(
  runtime: RelayPushRuntime | undefined,
  event: NostrEvent,
  publishEvent: EventPublisher,
): Promise<void> {
  if (!runtime) {
    throw new RemoteProtocolError(
      "CONFIG_INVALID",
      "push is not supported by this relay",
    );
  }
  const outcome = await runtime.acceptLease(event);
  if (outcome !== "accepted") {
    throw new RemoteProtocolError(
      "CONFIG_INVALID",
      `push lease rejected: ${outcome}`,
    );
  }
  await publishEvent(event);
}

async function executeModerationDirectEvent(
  moderationCommands: RelayModerationCommands | undefined,
  event: NostrEvent,
  disconnectPubkeyClusterwide: DisconnectPubkeyClusterwide,
): Promise<boolean> {
  if (!moderationCommands?.handles(event.kind)) return false;
  const result = await moderationCommands.execute(event);
  if (result.disconnectPubkey) {
    await disconnectPubkeyClusterwide(
      result.disconnectPubkey,
      event.id,
      "blocked: you are banned from this community",
    );
  }
  return result.handled;
}

async function publishRemoteEvent(
  client: Client,
  value: unknown,
  registry: RemoteRegistryContract,
  community: string,
  publishEvent: EventPublisher,
): Promise<void> {
  const { event } = await validateRemoteEvent(
    client,
    value,
    registry,
    community,
  );
  await publishEvent(event);
  send(client.socket, ["OK", event.id, true, ""]);
}

async function validateRemoteEvent(
  client: Client,
  value: unknown,
  registry: RemoteRegistryContract,
  community: string,
): Promise<{
  readonly event: NostrEvent;
  readonly binding: RemoteWorkerBinding;
}> {
  if (!verifyNostrEvent(value) || !REMOTE_AGENT_KINDS.has(value.kind)) {
    throw new RemoteProtocolError(
      "SIGNATURE_INVALID",
      "remote control event is invalid",
    );
  }
  if (value.pubkey !== client.authenticatedPubkey) {
    throw new RemoteProtocolError(
      "SENDER_MISMATCH",
      "authenticated connection does not own this event",
    );
  }
  const now = unixNow();
  const expiresAt = parseUnsignedTag(value, "expires");
  if (
    value.created_at < now - 60 ||
    value.created_at > now + 60 ||
    expiresAt < now ||
    expiresAt - value.created_at > 300
  ) {
    throw new RemoteProtocolError(
      "MESSAGE_EXPIRED",
      "remote event is outside the accepted lifetime",
    );
  }
  const recipient = singleTag(value, "p");
  const workerPubkey = singleTag(value, "worker");
  const activeBinding = await registry.authorizedWorker(
    workerPubkey,
    community,
  );
  const recentlyRevokedBinding =
    value.kind === KIND_REMOTE_AGENT_ACK
      ? await registry.workerBinding(workerPubkey, community)
      : undefined;
  const binding =
    activeBinding ??
    (recentlyRevokedBinding?.revokedAt !== undefined &&
    value.pubkey === recentlyRevokedBinding.workerPubkey &&
    now - recentlyRevokedBinding.revokedAt <= 60
      ? recentlyRevokedBinding
      : undefined);
  const ownerToWorker =
    binding !== undefined &&
    value.pubkey === binding.ownerPubkey &&
    recipient === binding.workerPubkey;
  const workerToOwner =
    binding !== undefined &&
    value.pubkey === binding.workerPubkey &&
    recipient === binding.ownerPubkey;
  const directionAllowed =
    (value.kind === KIND_REMOTE_AGENT_COMMAND && ownerToWorker) ||
    (value.kind === KIND_REMOTE_AGENT_STATUS && workerToOwner) ||
    (value.kind === KIND_REMOTE_AGENT_ACK &&
      (activeBinding ? ownerToWorker || workerToOwner : workerToOwner));
  if (
    value.kind === KIND_REMOTE_AGENT_ENROLLMENT ||
    !binding ||
    !directionAllowed
  ) {
    throw new RemoteProtocolError(
      "CAPABILITY_DENIED",
      "remote event is not bound to an approved owner and worker",
    );
  }
  return { binding, event: value };
}

async function handleBrap(
  client: Client,
  message: unknown[],
  context: {
    readonly clients: ReadonlySet<Client>;
    readonly options: RelayServerOptions;
    readonly publishEvent: EventPublisher;
    readonly registry: RemoteRegistryContract;
    readonly metrics: RelayMetrics;
  },
): Promise<void> {
  if (message[1] === "ENROLL") {
    if (typeof message[2] !== "string") {
      throw new RemoteProtocolError(
        "ENROLLMENT_INVALID",
        "enrollment token is required",
      );
    }
    const result = await context.registry.redeem({
      authenticatedPubkey: client.authenticatedPubkey as string,
      community: context.options.community,
      event: message[3],
      now: unixNow(),
      token: message[2],
    });
    await context.publishEvent(result.event);
    send(client.socket, [
      "BRAP",
      "PENDING_APPROVAL",
      result.binding.enrollmentId,
    ]);
    return;
  }
  if (message[1] === "APPROVE") {
    if (typeof message[2] !== "string" || typeof message[3] !== "string") {
      throw new RemoteProtocolError(
        "OWNER_APPROVAL_REQUIRED",
        "approval binding is invalid",
      );
    }
    const result = await context.registry.approve({
      authenticatedOwnerPubkey: client.authenticatedPubkey as string,
      community: context.options.community,
      enrollmentId: message[2],
      event: message[4],
      now: unixNow(),
      workerPubkey: message[3],
    });
    await context.publishEvent(result.event);
    for (const candidate of context.clients) {
      if (candidate.authenticatedPubkey === result.binding.workerPubkey) {
        send(candidate.socket, [
          "BRAP",
          "APPROVED",
          result.binding.enrollmentId,
        ]);
      }
    }
    return;
  }
  if (message[1] === "REVOKE") {
    if (typeof message[2] !== "string") {
      throw new RemoteProtocolError(
        "CONFIG_INVALID",
        "revocation worker binding is invalid",
      );
    }
    const validated = await validateRemoteEvent(
      client,
      message[3],
      context.registry,
      context.options.community,
    );
    if (
      validated.event.kind !== KIND_REMOTE_AGENT_COMMAND ||
      validated.binding.workerPubkey !== message[2] ||
      !validated.binding.capabilities.includes("revoke")
    ) {
      throw new RemoteProtocolError(
        "CAPABILITY_DENIED",
        "remote worker cannot be revoked by this connection",
      );
    }
    await context.registry.revoke({
      authenticatedOwnerPubkey: client.authenticatedPubkey as string,
      community: context.options.community,
      now: unixNow(),
      workerPubkey: message[2],
    });
    await context.publishEvent(validated.event);
    send(client.socket, ["OK", validated.event.id, true, ""]);
    send(client.socket, [
      "BRAP",
      "REVOKED",
      validated.binding.enrollmentId,
      message[2],
    ]);
    return;
  }
  throw new RemoteProtocolError("CONFIG_INVALID", "unsupported BRAP operation");
}

function routeEvent(event: NostrEvent, clients: ReadonlySet<Client>): void {
  const recipient = singleTag(event, "p");
  for (const client of clients) {
    if (client.authenticatedPubkey !== recipient) continue;
    for (const [subscriptionId, filters] of client.subscriptions) {
      if (subscriptionChannelId(filters) !== undefined) continue;
      if (filters.some((filter) => eventMatchesFilter(event, filter))) {
        send(client.socket, ["EVENT", subscriptionId, event]);
      }
    }
  }
}

async function applyConnectionControl(
  command: ConnectionControl,
  clients: ReadonlySet<Client>,
  accessPolicy: RelayAccessPolicy,
  community: string,
): Promise<void> {
  if (command.op === "DisconnectCommunity") {
    disconnectCommunityClients(clients);
    return;
  }
  if (command.op === "RevokeChannelAccess") {
    evictRevokedChannelSubscriptions(clients, [
      {
        channelId: command.channel_id,
        pubkey: Buffer.from(command.pubkey).toString("hex"),
      },
    ]);
    return;
  }
  if (command.op === "RevalidateChannelAccess") {
    await applyChannelAccessChanges(
      clients,
      [
        {
          channelId: command.channel_id,
          mode: command.mode,
        },
      ],
      accessPolicy,
      community,
      command.event_id,
    );
    return;
  }
  disconnectPubkeyClients(
    clients,
    Buffer.from(command.pubkey).toString("hex"),
    command.event_id,
    command.reason,
  );
}

function disconnectCommunityClients(clients: ReadonlySet<Client>): void {
  for (const client of clients) {
    client.socket.close(1008, "community archived");
  }
}

function evictRevokedChannelSubscriptions(
  clients: ReadonlySet<Client>,
  revocations: readonly {
    readonly channelId: string;
    readonly pubkey: string;
  }[],
): void {
  for (const revocation of revocations) {
    for (const client of clients) {
      if (client.authenticatedPubkey !== revocation.pubkey) continue;
      for (const [subscriptionId, filters] of client.subscriptions) {
        if (
          subscriptionChannelId(filters) !== revocation.channelId.toLowerCase()
        ) {
          continue;
        }
        client.subscriptions.delete(subscriptionId);
        send(client.socket, [
          "CLOSED",
          subscriptionId,
          "restricted: channel access revoked",
        ]);
      }
    }
  }
}

async function evictRevokedChannelSubscriptionsClusterwide(
  clients: ReadonlySet<Client>,
  revocations: readonly {
    readonly channelId: string;
    readonly pubkey: string;
  }[],
  eventBus: EventBus,
  communityId: string | undefined,
  eventId: string,
): Promise<void> {
  evictRevokedChannelSubscriptions(clients, revocations);
  if (!communityId) return;
  for (const revocation of revocations) {
    try {
      await eventBus.publishControl(communityId, {
        channel_id: revocation.channelId,
        event_id: eventId,
        op: "RevokeChannelAccess",
        pubkey: [...Buffer.from(revocation.pubkey, "hex")],
      });
    } catch {
      // Durable membership checks still prevent reads and live fan-out if the
      // low-latency cross-pod control path is temporarily unavailable.
    }
  }
}

async function applyChannelAccessChangesClusterwide(
  clients: ReadonlySet<Client>,
  changes: readonly {
    readonly channelId: string;
    readonly mode: "all" | "non_members";
  }[],
  accessPolicy: RelayAccessPolicy,
  community: string,
  eventBus: EventBus,
  communityId: string | undefined,
  eventId: string,
): Promise<void> {
  await applyChannelAccessChanges(
    clients,
    changes,
    accessPolicy,
    community,
    eventId,
  );
  if (!communityId) return;
  for (const change of changes) {
    try {
      await eventBus.publishControl(communityId, {
        channel_id: change.channelId,
        event_id: eventId,
        mode: change.mode,
        op: "RevalidateChannelAccess",
      });
    } catch {
      // The delivery-time access check remains the confidentiality backstop.
    }
  }
}

async function applyChannelAccessChanges(
  clients: ReadonlySet<Client>,
  changes: readonly {
    readonly channelId: string;
    readonly mode: "all" | "non_members";
  }[],
  accessPolicy: RelayAccessPolicy,
  community: string,
  eventId: string,
): Promise<void> {
  for (const change of changes) {
    const channelId = change.channelId.toLowerCase();
    for (const client of clients) {
      const scopedSubscriptionIds = [...client.subscriptions]
        .filter(([, filters]) => subscriptionChannelId(filters) === channelId)
        .map(([subscriptionId]) => subscriptionId);
      if (scopedSubscriptionIds.length === 0) continue;
      if (
        change.mode === "non_members" &&
        client.authenticatedPubkey &&
        (await accessPolicy.canRead(
          community,
          client.authenticatedPubkey,
          accessProbeEvent(channelId, eventId),
          client.authenticatedOwnerPubkey,
        ))
      ) {
        continue;
      }
      for (const subscriptionId of scopedSubscriptionIds) {
        client.subscriptions.delete(subscriptionId);
        send(client.socket, [
          "CLOSED",
          subscriptionId,
          "restricted: channel access revoked",
        ]);
      }
    }
  }
}

function accessProbeEvent(channelId: string, eventId: string): NostrEvent {
  return {
    content: "",
    created_at: 0,
    id: eventId,
    kind: 9,
    pubkey: "0".repeat(64),
    sig: "0".repeat(128),
    tags: [["h", channelId]],
  };
}

function disconnectPubkeyClients(
  clients: ReadonlySet<Client>,
  pubkey: string,
  eventId: string,
  reason: string,
): void {
  for (const client of clients) {
    if (
      client.authenticatedPubkey !== pubkey &&
      client.authenticatedOwnerPubkey !== pubkey
    ) {
      continue;
    }
    send(client.socket, ["OK", eventId, false, reason]);
    client.socket.close(4003, boundedCloseReason(reason));
  }
}

function boundedCloseReason(reason: string): string {
  const bytes = Buffer.from(reason, "utf8");
  if (bytes.length <= 120) return reason;
  return new TextDecoder("utf-8", { fatal: false }).decode(
    bytes.subarray(0, 120),
  );
}

async function handleHttp(
  request: IncomingMessage,
  response: ServerResponse,
  context: {
    readonly accessPolicy: RelayAccessPolicy;
    readonly admin?: RelayAdminHttp;
    readonly auditQueue?: RelayAuditQueue;
    readonly clients: ReadonlySet<Client>;
    readonly controlRateLimit: TokenBucketRateLimiter;
    readonly disconnectPubkeyClusterwide: DisconnectPubkeyClusterwide;
    readonly eventBus: EventBus;
    readonly eventStore: EventStore;
    readonly gitHttp?: RelayGitHttp;
    readonly httpRateLimit: TokenBucketRateLimiter;
    readonly invites: RelayInviteHttp;
    readonly nip98Replay: Nip98ReplayGuard;
    readonly operator?: RelayOperatorHttp;
    readonly staticHttp?: RelayStaticHttp;
    readonly options: RelayServerOptions;
    readonly publishEvent: EventPublisher;
    readonly rateLimits: RelayRateLimitOptions;
    readonly workflowRuntime?: WorkflowRuntime;
    readonly registry: RemoteRegistryContract;
    readonly metrics: RelayMetrics;
    readonly mediaUploadGate?: MediaUploadGate;
    readonly meshDemo?: MeshDemoHttp;
    readonly moderationCommands?: RelayModerationCommands;
    readonly identityArchive?: IdentityArchiveService;
    readonly membershipCommands?: RelayMembershipCommands;
    readonly productFeedback?: ProductFeedbackService;
    readonly pushRuntime?: RelayPushRuntime;
  },
): Promise<void> {
  applySecurityHeaders(response);
  if (handleCors(request, response, context.options.corsOrigins ?? [])) {
    return;
  }
  context.metrics.httpRequestsTotal += 1;
  if (
    context.gitHttp &&
    (await context.gitHttp.handleInternal(request, response))
  ) {
    return;
  }
  if (context.admin && (await context.admin.handle(request, response))) {
    return;
  }
  if (
    context.staticHttp &&
    (await context.staticHttp.handleAdmin(request, response))
  ) {
    return;
  }
  if (context.operator && (await context.operator.handle(request, response))) {
    return;
  }
  if (
    request.method === "GET" &&
    (request.url === "/health" || request.url === "/_liveness")
  ) {
    json(response, 200, { status: "ok" });
    return;
  }
  if (
    request.method === "GET" &&
    (request.url === "/_readiness" ||
      request.url === "/health/ready" ||
      request.url === "/ready")
  ) {
    try {
      await context.options.readinessCheck?.();
      json(response, 200, { status: "ready" });
    } catch {
      json(response, 503, { status: "unavailable" });
    }
    return;
  }
  if (
    request.method === "GET" &&
    (request.url === "/_status" || request.url === "/status")
  ) {
    json(response, 200, {
      activeConnections: context.clients.size,
      community: context.options.community,
      status: "ok",
      uptimeSeconds: Math.floor(
        (Date.now() - context.metrics.startedAt) / 1_000,
      ),
      version: RELAY_VERSION,
    });
    return;
  }
  if (request.method === "GET" && request.url === "/metrics") {
    response.statusCode = 200;
    response.setHeader(
      "Content-Type",
      "text/plain; version=0.0.4; charset=utf-8",
    );
    response.setHeader("Cache-Control", "no-store");
    response.end(
      context.metrics.render({
        activeConnections: context.clients.size,
        activeSubscriptions: [...context.clients].reduce(
          (total, client) => total + client.subscriptions.size,
          0,
        ),
      }) + (context.options.usageMetrics?.render() ?? ""),
    );
    return;
  }
  if (request.method === "GET" && request.url === "/_mesh") {
    if (!context.options.meshStatus) {
      json(response, 200, {
        enabled: false,
        localRuntimeId: "",
        draining: false,
        peerCount: 0,
        peers: [],
        counters: {},
      });
      return;
    }
    json(response, 200, context.options.meshStatus());
    return;
  }
  if (
    request.method === "GET" &&
    request.url === "/" &&
    request.headers.accept?.includes("text/html") &&
    context.staticHttp &&
    (await context.staticHttp.handlePublic(request, response))
  ) {
    return;
  }
  if (
    request.method === "GET" &&
    (request.url === "/" || request.url === "/info")
  ) {
    const icon = await workspaceIcon(context.options);
    response.statusCode = 200;
    response.setHeader("Content-Type", "application/nostr+json; charset=utf-8");
    response.setHeader("Cache-Control", "public, max-age=300");
    response.end(
      JSON.stringify(
        relayInformationDocument({
          ...(icon ? { icon } : {}),
          maxNotBeforeDelta: environmentInteger(
            "SPROUT_MAX_NOT_BEFORE_DELTA",
            31_536_000,
          ),
          maxFrameBytes:
            context.options.maxFrameBytes ?? DEFAULT_MAX_FRAME_BYTES,
          nip43: context.options.advertiseNip43 === true,
          ...(context.options.pairingRelayUrl
            ? { pairingRelayUrl: context.options.pairingRelayUrl }
            : {}),
          ...(context.options.relaySelfPubkey
            ? { relaySelfPubkey: context.options.relaySelfPubkey }
            : {}),
          search: context.options.search !== undefined,
          ...(context.pushRuntime
            ? { push: context.pushRuntime.descriptor }
            : {}),
        }),
      ),
    );
    return;
  }
  if (
    requestHostname(request.headers.host) !==
    new URL(`http://${context.options.community}`).hostname.toLowerCase()
  ) {
    json(response, 404, { error: "not found" });
    return;
  }
  if (context.meshDemo && (await context.meshDemo.handle(request, response))) {
    return;
  }
  if (
    await handleNip05Http(request, response, {
      community: context.options.community,
      ...(context.options.pool ? { pool: context.options.pool } : {}),
      publicUrl: context.options.publicUrl,
    })
  ) {
    return;
  }
  if (
    !context.httpRateLimit.consume(request.socket.remoteAddress ?? "unknown", 1)
  ) {
    writeHttpError(
      response,
      new RemoteProtocolError("RATE_LIMITED", "HTTP request rate exceeded"),
    );
    return;
  }
  if (context.gitHttp && (await context.gitHttp.handle(request, response))) {
    return;
  }
  if (await context.invites.handle(request, response)) return;
  if (
    await handleModerationHttp(request, response, {
      community: context.options.community,
      ...(context.options.pool ? { pool: context.options.pool } : {}),
      publicUrl: context.options.publicUrl,
      replay: context.nip98Replay,
      replayScope:
        context.options.search?.communityId ?? context.options.community,
    })
  ) {
    return;
  }
  if (
    await handleWorkflowWebhookHttp(request, response, {
      community: context.options.community,
      publicUrl: context.options.publicUrl,
      ...(context.workflowRuntime ? { runtime: context.workflowRuntime } : {}),
    })
  ) {
    return;
  }
  if (
    context.options.media &&
    context.mediaUploadGate &&
    (await handleMediaHttp(request, response, {
      accessPolicy: context.accessPolicy,
      community: context.options.community,
      gate: context.mediaUploadGate,
      media: context.options.media,
    }))
  ) {
    return;
  }
  if (
    request.method === "POST" &&
    (request.url === "/events" ||
      request.url === "/query" ||
      request.url === "/count")
  ) {
    await handleHttpBridge(request, response, context);
    return;
  }
  const revokeMatch = /^\/api\/remote-agents\/([0-9a-f]{64})$/.exec(
    request.url ?? "",
  );
  if (request.method === "DELETE" && revokeMatch?.[1]) {
    try {
      const body = await readBoundedBody(request, 1);
      if (body.length !== 0) {
        throw new RemoteProtocolError(
          "CONFIG_INVALID",
          "revocation request body must be empty",
        );
      }
      const publicUrl = new URL(
        request.url ?? "",
        httpBaseUrl(context.options.publicUrl),
      ).toString();
      const ownerPubkey = await authenticateNip98({
        authorizationHeader: request.headers.authorization,
        body,
        method: request.method,
        now: unixNow(),
        publicUrl,
        replayGuard: context.nip98Replay,
        replayScope:
          context.options.search?.communityId ?? context.options.community,
      });
      requireControlBudget(context.controlRateLimit, ownerPubkey);
      if (!context.options.ownerPubkeys.has(ownerPubkey)) {
        throw new RemoteProtocolError(
          "CAPABILITY_DENIED",
          "only a community owner may revoke a remote worker",
        );
      }
      await context.registry.revoke({
        authenticatedOwnerPubkey: ownerPubkey,
        community: context.options.community,
        now: unixNow(),
        workerPubkey: revokeMatch[1],
      });
      response.statusCode = 204;
      response.setHeader("Cache-Control", "no-store");
      response.end();
    } catch (error) {
      writeHttpError(response, error);
    }
    return;
  }
  if (
    context.staticHttp &&
    (await context.staticHttp.handlePublic(request, response))
  ) {
    return;
  }
  if (
    request.method !== "POST" ||
    request.url !== "/api/remote-agents/enrollments"
  ) {
    json(response, 404, { error: "not found" });
    return;
  }

  try {
    requireJsonContentType(request);
    const body = await readBoundedBody(request, 16 * 1024);
    const publicUrl = new URL(
      request.url,
      httpBaseUrl(context.options.publicUrl),
    ).toString();
    const ownerPubkey = await authenticateNip98({
      authorizationHeader: request.headers.authorization,
      body,
      method: request.method,
      now: unixNow(),
      publicUrl,
      replayGuard: context.nip98Replay,
      replayScope:
        context.options.search?.communityId ?? context.options.community,
    });
    requireControlBudget(context.controlRateLimit, ownerPubkey);
    if (!context.options.ownerPubkeys.has(ownerPubkey)) {
      throw new RemoteProtocolError(
        "CAPABILITY_DENIED",
        "only a community owner may create remote enrollment tokens",
      );
    }
    const parsed = inviteRequestSchema.parse(JSON.parse(body.toString("utf8")));
    const minted = await context.registry.mint({
      capabilities: parsed.capabilities ?? [
        "deploy",
        "start",
        "stop",
        "restart",
        "update",
        "status",
        "revoke",
      ],
      community: context.options.community,
      now: unixNow(),
      ownerPubkey,
      ...(parsed.lifetimeSeconds !== undefined
        ? { lifetimeSeconds: parsed.lifetimeSeconds }
        : {}),
    });
    response.setHeader("Cache-Control", "no-store");
    json(response, 201, {
      enrollmentId: minted.record.id,
      expiresAt: minted.record.expiresAt,
      token: minted.token,
    });
  } catch (error) {
    writeHttpError(response, error);
  }
}

async function handleHttpBridge(
  request: IncomingMessage,
  response: ServerResponse,
  context: {
    readonly accessPolicy: RelayAccessPolicy;
    readonly auditQueue?: RelayAuditQueue;
    readonly disconnectPubkeyClusterwide: DisconnectPubkeyClusterwide;
    readonly eventBus: EventBus;
    readonly eventStore: EventStore;
    readonly gitHttp?: RelayGitHttp;
    readonly clients: ReadonlySet<Client>;
    readonly identityArchive?: IdentityArchiveService;
    readonly membershipCommands?: RelayMembershipCommands;
    readonly moderationCommands?: RelayModerationCommands;
    readonly productFeedback?: ProductFeedbackService;
    readonly pushRuntime?: RelayPushRuntime;
    readonly nip98Replay: Nip98ReplayGuard;
    readonly options: RelayServerOptions;
    readonly publishEvent: EventPublisher;
    readonly rateLimits: RelayRateLimitOptions;
    readonly metrics: RelayMetrics;
    readonly workflowRuntime?: WorkflowRuntime;
  },
): Promise<void> {
  try {
    requireJsonContentType(request);
    const path = request.url as "/events" | "/query" | "/count";
    const body = await readBoundedBody(
      request,
      path === "/events" ? 1024 * 1024 : 256 * 1024,
    );
    const publicUrl = new URL(
      path,
      httpBaseUrl(context.options.publicUrl),
    ).toString();
    const identity = await authenticateNip98Identity({
      authorizationHeader: request.headers.authorization,
      body,
      method: "POST",
      now: unixNow(),
      publicUrl,
      replayGuard: context.nip98Replay,
      replayScope:
        context.options.search?.communityId ?? context.options.community,
    });
    const { ownerPubkey, pubkey } = identity;
    if (
      !(await context.accessPolicy.canConnect(
        context.options.community,
        pubkey,
        ownerPubkey,
      ))
    ) {
      throw new RemoteProtocolError(
        "CAPABILITY_DENIED",
        "identity is not admitted to this community",
      );
    }
    await enforceSharedHttpAdmission(
      context.eventBus,
      context.options.search?.communityId ?? context.options.community,
      pubkey,
      context.rateLimits.humanApiCallsPerMinute,
      context.metrics,
    );

    if (path === "/events") {
      await submitHttpEvent(body, pubkey, ownerPubkey, response, context);
      return;
    }

    const filters = parseHttpFilters(body);
    if (subscriptionChannelId(filters) === undefined) {
      requirePWhileReadingGatedKinds(filters, pubkey);
      requirePrivateFilterAuthorization(filters, pubkey);
    }
    if (path === "/query") {
      const presenceEvents = await synthesizePresenceEvents(
        filters,
        context.eventBus,
        context.options.community,
        context.options.relaySecretKey,
      );
      if (presenceEvents) {
        const readable: NostrEvent[] = [];
        for (const event of presenceEvents) {
          if (
            await context.accessPolicy.canRead(
              context.options.community,
              pubkey,
              event,
              ownerPubkey,
            )
          ) {
            readable.push(event);
          }
        }
        json(response, 200, readable);
        return;
      }
      const events: NostrEvent[] = [];
      const delivered = new Set<string>();
      for (const filter of filters) {
        const filteredEvents = filter.top_level
          ? await queryChannelWindowEvents(
              context.eventStore,
              context.options.community,
              filter,
              context.options.relaySecretKey,
            )
          : await queryFilterEvents(
              context.eventStore,
              context.options.community,
              filter,
              context.options.search,
              Math.min(
                filter.limit ?? MAX_HISTORICAL_LIMIT,
                MAX_HISTORICAL_LIMIT,
              ),
            );
        for (const event of filteredEvents) {
          if (
            delivered.has(event.id) ||
            !(await context.accessPolicy.canRead(
              context.options.community,
              pubkey,
              event,
              ownerPubkey,
            ))
          ) {
            continue;
          }
          delivered.add(event.id);
          events.push(event);
        }
      }
      json(response, 200, events);
      return;
    }

    let count = 0;
    for (const filter of filters) {
      count += filter.search
        ? await countReadableSearchEvents(
            context.eventStore,
            context.accessPolicy,
            context.options.community,
            pubkey,
            filter,
            context.options.search,
            ownerPubkey,
          )
        : await countReadableEvents(
            context.eventStore,
            context.accessPolicy,
            context.options.community,
            pubkey,
            filter,
            ownerPubkey,
          );
      if (!Number.isSafeInteger(count)) {
        throw new Error("event count exceeds JavaScript safe integer range");
      }
    }
    json(response, 200, { count });
  } catch (error) {
    writeHttpError(response, error);
  }
}

class HttpAdmissionError extends Error {
  public constructor(
    readonly status: 429 | 503,
    message: string,
  ) {
    super(message);
    this.name = "HttpAdmissionError";
  }
}

async function enforceSharedHttpAdmission(
  eventBus: EventBus,
  scope: string,
  pubkey: string,
  limit: number,
  metrics: RelayMetrics,
): Promise<void> {
  let claim: RateLimitClaim;
  try {
    claim = await eventBus.claimRateLimit(scope, pubkey, "api", 60, limit);
  } catch {
    metrics.rejectedRequestsTotal += 1;
    metrics.recordAdmissionRejection("http", "unavailable");
    throw new HttpAdmissionError(
      503,
      "rate-limited: shared admission unavailable",
    );
  }
  if (claim.allowed) return;
  metrics.rejectedRequestsTotal += 1;
  metrics.recordAdmissionRejection("http", "quota");
  throw new HttpAdmissionError(
    429,
    `rate-limited: quota exceeded; retry in ${claim.resetInSeconds}s`,
  );
}

async function submitHttpEvent(
  body: Buffer,
  pubkey: string,
  delegatedBy: string | undefined,
  response: ServerResponse,
  context: {
    readonly accessPolicy: RelayAccessPolicy;
    readonly auditQueue?: RelayAuditQueue;
    readonly disconnectPubkeyClusterwide: DisconnectPubkeyClusterwide;
    readonly eventBus: EventBus;
    readonly eventStore: EventStore;
    readonly gitHttp?: RelayGitHttp;
    readonly clients: ReadonlySet<Client>;
    readonly identityArchive?: IdentityArchiveService;
    readonly membershipCommands?: RelayMembershipCommands;
    readonly moderationCommands?: RelayModerationCommands;
    readonly productFeedback?: ProductFeedbackService;
    readonly pushRuntime?: RelayPushRuntime;
    readonly options: RelayServerOptions;
    readonly publishEvent: EventPublisher;
    readonly workflowRuntime?: WorkflowRuntime;
  },
): Promise<void> {
  let value: unknown;
  try {
    value = JSON.parse(body.toString("utf8")) as unknown;
  } catch {
    throw new RemoteProtocolError(
      "CONFIG_INVALID",
      "event body is invalid JSON",
    );
  }
  validateClientEventIngest(value, {
    now: unixNow(),
    principalPubkey: pubkey,
    transport: "http",
  });
  const coordinateOverride = await resolveTargetCoordinate(
    context.eventStore,
    context.options.community,
    value,
    context.options.relaySelfPubkey ??
      (context.options.relaySecretKey
        ? publicKeyFromSecret(context.options.relaySecretKey)
        : undefined),
  );
  const requestedChannelId =
    coordinateOverride === undefined
      ? eventChannelId(value)
      : (coordinateOverride ?? undefined);
  context.gitHttp?.validateAnnouncement(value);
  if (
    !(await context.accessPolicy.canPublish(
      context.options.community,
      pubkey,
      value,
      delegatedBy,
      coordinateOverride,
    ))
  ) {
    throw new RemoteProtocolError(
      "CAPABILITY_DENIED",
      "event is not authorized in this community or channel",
    );
  }
  await validateEventKind(
    context.eventStore,
    context.options.community,
    value,
    unixNow(),
    undefined,
    context.options.relaySelfPubkey ??
      (context.options.relaySecretKey
        ? publicKeyFromSecret(context.options.relaySecretKey)
        : undefined),
  );
  await validateEventMedia(value, imetaMedia(context.options.media));
  if (context.membershipCommands?.handles(value.kind)) {
    const message = await context.membershipCommands.execute(value);
    json(response, 200, {
      accepted: true,
      event_id: value.id,
      message,
    });
    return;
  }
  if (
    value.kind === RELAY_ADMIN_ADD_MEMBER ||
    value.kind === RELAY_ADMIN_REMOVE_MEMBER ||
    value.kind === RELAY_ADMIN_CHANGE_ROLE ||
    value.kind === RELAY_ADMIN_SET_WORKSPACE_PROFILE ||
    value.kind === KIND_NIP43_LEAVE_REQUEST
  ) {
    throw new RemoteProtocolError(
      "CONFIG_INVALID",
      "relay membership commands are unavailable",
    );
  }
  if (
    await executeModerationDirectEvent(
      context.moderationCommands,
      value,
      context.disconnectPubkeyClusterwide,
    )
  ) {
    json(response, 200, {
      accepted: true,
      event_id: value.id,
      message: "",
    });
    return;
  }
  if (context.identityArchive?.handles(value.kind)) {
    await context.identityArchive.execute(value);
  } else if (
    value.kind === KIND_IA_ARCHIVE_REQUEST ||
    value.kind === KIND_IA_UNARCHIVE_REQUEST
  ) {
    throw new RemoteProtocolError(
      "CONFIG_INVALID",
      "identity archival is unavailable",
    );
  }
  if (value.kind === KIND_PRODUCT_FEEDBACK) {
    if (!context.productFeedback) {
      throw new RemoteProtocolError(
        "CONFIG_INVALID",
        "product feedback persistence is unavailable",
      );
    }
    await context.productFeedback.accept(value);
    json(response, 200, {
      accepted: true,
      event_id: value.id,
      message: "",
    });
    return;
  }
  if (value.kind === KIND_PUSH_LEASE) {
    await acceptPushLeaseEvent(
      context.pushRuntime,
      value,
      context.publishEvent,
    );
    json(response, 200, {
      accepted: true,
      event_id: value.id,
      message: "",
    });
    return;
  }
  const preparedControl = await context.workflowRuntime?.prepareControlEvent(
    context.options.community,
    value,
    requestedChannelId,
  );
  const effectiveChannelId = preparedControl?.channelId ?? requestedChannelId;
  const threadMetadata = await resolveThreadMetadata(
    context.eventStore,
    context.options.community,
    value,
    effectiveChannelId,
  );
  const result = await context.eventStore.store(
    context.options.community,
    value,
    effectiveChannelId,
    preparedControl?.apply,
    threadMetadata,
  );
  await evictRevokedChannelSubscriptionsClusterwide(
    context.clients,
    result.revokedChannelMembers ?? [],
    context.eventBus,
    context.options.search?.communityId,
    value.id,
  );
  await applyChannelAccessChangesClusterwide(
    context.clients,
    result.channelAccessChanges ?? [],
    context.accessPolicy,
    context.options.community,
    context.eventBus,
    context.options.search?.communityId,
    value.id,
  );
  let responseMessage = result.message;
  if (result.status === "inserted") {
    await context.gitHttp?.onEventStored(value);
  }
  if (result.status === "inserted" || result.status === "ephemeral") {
    await context.publishEvent(value);
    for (const derived of result.derivedEvents ?? []) {
      await context.publishEvent(derived);
    }
  }
  if (result.status === "inserted") {
    await enqueueEventCreatedAudit(
      context.auditQueue,
      context.options.audit?.communityId,
      value,
      effectiveChannelId,
    );
    if (preparedControl) {
      const commandResponse = await preparedControl.afterCommit();
      if (commandResponse !== undefined) {
        responseMessage = `response:${JSON.stringify(commandResponse)}`;
      }
    } else {
      await context.workflowRuntime?.onEvent(
        context.options.community,
        value,
        effectiveChannelId,
      );
    }
  }
  json(response, 200, {
    accepted: !isActiveReactionDuplicate(result),
    event_id: value.id,
    message:
      result.status === "duplicate" || result.status === "superseded"
        ? (result.message ?? result.status)
        : (responseMessage ?? ""),
  });
}

function isActiveReactionDuplicate(result: {
  readonly message?: string;
  readonly status: string;
}): boolean {
  return (
    result.status === "duplicate" &&
    result.message === "duplicate: reaction already exists"
  );
}

async function enqueueEventCreatedAudit(
  queue: RelayAuditQueue | undefined,
  communityId: string | undefined,
  event: NostrEvent,
  channelId: string | undefined,
): Promise<void> {
  if (!queue || !communityId) return;
  await queue.enqueue({
    action: "event_created",
    actorPubkey: Uint8Array.from(Buffer.from(event.pubkey, "hex")),
    communityId,
    detail: {
      channel_id: channelId ?? null,
      event_kind: event.kind,
    },
    objectId: event.id,
  });
}

function parseHttpFilters(body: Buffer): NostrFilter[] {
  let value: unknown;
  try {
    value = JSON.parse(body.toString("utf8")) as unknown;
  } catch {
    throw new RemoteProtocolError(
      "CONFIG_INVALID",
      "filters body is invalid JSON",
    );
  }
  if (!Array.isArray(value) || value.length < 1 || value.length > 10) {
    throw new RemoteProtocolError(
      "CONFIG_INVALID",
      "request must contain between one and ten filters",
    );
  }
  const filters = value.map(parseFilter);
  if (filters.some((filter) => filter.kinds?.some(isRemoteAgentKind))) {
    throw new RemoteProtocolError(
      "CAPABILITY_DENIED",
      "remote-control events are available only on authenticated WebSockets",
    );
  }
  return filters;
}

function requirePWhileReadingGatedKinds(
  filters: readonly NostrFilter[],
  pubkey: string,
): void {
  if (pGatedFiltersAuthorized(filters, pubkey)) return;
  throw new RemoteProtocolError(
    "CAPABILITY_DENIED",
    "p-gated events require #p matching your pubkey",
  );
}

function requirePrivateFilterAuthorization(
  filters: readonly NostrFilter[],
  pubkey: string,
): void {
  if (!engramFiltersAuthorized(filters, pubkey)) {
    throw new RemoteProtocolError(
      "CAPABILITY_DENIED",
      "agent-engram reads require authors=[self] or #p=[self]",
    );
  }
  if (!authorOnlyFiltersAuthorized(filters, pubkey)) {
    throw new RemoteProtocolError(
      "CAPABILITY_DENIED",
      "author-only kinds require authors=[self]",
    );
  }
}

function pGatedFiltersAuthorized(
  filters: readonly NostrFilter[],
  pubkey: string,
): boolean {
  return filters.every((filter) => {
    const canMatch = filter.kinds
      ? filter.kinds.some((kind) => P_GATED_KINDS.has(kind))
      : true;
    if (!canMatch) return true;
    const noIdExemption =
      filter.kinds?.some(
        (kind) =>
          kind === KIND_DM_VISIBILITY || kind === KIND_AGENT_TURN_METRIC,
      ) ?? false;
    if (!noIdExemption && (filter.ids?.length ?? 0) > 0) return true;
    const recipients = filter["#p"];
    return (
      recipients !== undefined &&
      recipients.length > 0 &&
      recipients.every((recipient) => recipient === pubkey)
    );
  });
}

function engramFiltersAuthorized(
  filters: readonly NostrFilter[],
  pubkey: string,
): boolean {
  return filters.every((filter) => {
    if ((filter.ids?.length ?? 0) > 0) return true;
    const canMatch =
      filter.kinds === undefined || filter.kinds.includes(KIND_AGENT_ENGRAM);
    if (!canMatch) return true;
    const authors = filter.authors;
    if (
      authors !== undefined &&
      authors.length > 0 &&
      authors.every((author) => author === pubkey)
    ) {
      return true;
    }
    const owners = filter["#p"];
    return (
      owners !== undefined &&
      owners.length > 0 &&
      owners.every((owner) => owner === pubkey)
    );
  });
}

function authorOnlyFiltersAuthorized(
  filters: readonly NostrFilter[],
  pubkey: string,
): boolean {
  return filters.every((filter) => {
    const onlyAuthorKinds =
      filter.kinds !== undefined &&
      filter.kinds.length > 0 &&
      filter.kinds.every((kind) => AUTHOR_ONLY_KINDS.has(kind));
    if (!onlyAuthorKinds) return true;
    return (
      filter.authors !== undefined &&
      filter.authors.length > 0 &&
      filter.authors.every((author) => author === pubkey)
    );
  });
}

function subscriptionChannelId(
  filters: readonly NostrFilter[],
): string | undefined {
  let channelId: string | undefined;
  for (const filter of filters) {
    const values = filter["#h"];
    if (
      values?.length !== 1 ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        values[0] as string,
      )
    ) {
      return undefined;
    }
    const current = (values[0] as string).toLowerCase();
    if (channelId !== undefined && channelId !== current) return undefined;
    channelId = current;
  }
  return channelId;
}

async function countReadableEvents(
  eventStore: EventStore,
  accessPolicy: RelayAccessPolicy,
  community: string,
  pubkey: string,
  filter: NostrFilter,
  delegatedBy?: string,
): Promise<number> {
  let count = 0;
  let cursor: { readonly createdAt: number; readonly id: string } | undefined;
  for (;;) {
    const events = await eventStore.queryPage(community, filter, cursor, 1_000);
    for (const event of events) {
      if (await accessPolicy.canRead(community, pubkey, event, delegatedBy)) {
        count += 1;
      }
    }
    if (events.length < 1_000) return count;
    const last = events.at(-1);
    if (!last) return count;
    cursor = { createdAt: last.created_at, id: last.id };
  }
}

async function queryFilterEvents(
  eventStore: EventStore,
  community: string,
  filter: NostrFilter,
  search: RelayServerOptions["search"],
  maximumEvents: number,
): Promise<NostrEvent[]> {
  if (!filter.search) {
    return eventStore.query(community, {
      ...filter,
      limit: maximumEvents,
    });
  }
  if (!search) {
    throw new RemoteProtocolError(
      "CONFIG_INVALID",
      "NIP-50 search is not enabled on this relay",
    );
  }
  const events: NostrEvent[] = [];
  for await (const page of searchEventPages(
    eventStore,
    community,
    filter,
    search,
  )) {
    for (const event of page) {
      if (events.length >= maximumEvents) return events;
      events.push(event);
    }
  }
  return events;
}

async function countReadableSearchEvents(
  eventStore: EventStore,
  accessPolicy: RelayAccessPolicy,
  community: string,
  pubkey: string,
  filter: NostrFilter,
  search: RelayServerOptions["search"],
  delegatedBy?: string,
): Promise<number> {
  if (!search) {
    throw new RemoteProtocolError(
      "CONFIG_INVALID",
      "NIP-50 search is not enabled on this relay",
    );
  }
  let count = 0;
  for await (const page of searchEventPages(
    eventStore,
    community,
    filter,
    search,
  )) {
    for (const event of page) {
      if (await accessPolicy.canRead(community, pubkey, event, delegatedBy)) {
        count += 1;
      }
    }
  }
  return count;
}

async function* searchEventPages(
  eventStore: EventStore,
  community: string,
  filter: NostrFilter,
  search: NonNullable<RelayServerOptions["search"]>,
): AsyncGenerator<NostrEvent[]> {
  const perPage = 500;
  const exactAuthors = filter.authors?.every((author) => author.length === 64)
    ? filter.authors
    : undefined;
  for (let page = 1; page <= 1_000; page += 1) {
    const result = await search.service.search({
      ...(exactAuthors ? { authors: exactAuthors } : {}),
      channelScope: searchChannelScope(filter),
      communityId: search.communityId,
      ...(filter.kinds ? { kinds: filter.kinds } : {}),
      mode: "full-text",
      page,
      perPage,
      ...(filter.since !== undefined ? { since: filter.since } : {}),
      text: filter.search as string,
      ...(filter.until !== undefined ? { until: filter.until } : {}),
    });
    if (result.hits.length === 0) return;
    const orderedIds = result.hits.map((hit) => hit.eventId);
    const fetched = await eventStore.query(community, {
      ids: orderedIds,
      limit: orderedIds.length,
    });
    const byId = new Map(fetched.map((event) => [event.id, event]));
    const accepted = orderedIds
      .map((id) => byId.get(id))
      .filter(
        (event): event is NostrEvent =>
          event !== undefined && eventMatchesFilter(event, filter),
      );
    yield accepted;
    if (result.hits.length < perPage) return;
  }
}

function searchChannelScope(
  filter: NostrFilter,
):
  | { readonly type: "any" }
  | { readonly type: "channels"; readonly channelIds: readonly string[] } {
  const requested = filter["#h"];
  if (!requested) return { type: "any" };
  return {
    channelIds: requested.filter((value) =>
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        value,
      ),
    ),
    type: "channels",
  };
}

function requireJsonContentType(request: IncomingMessage): void {
  if (
    !request.headers["content-type"]
      ?.toLowerCase()
      .startsWith("application/json")
  ) {
    throw new RemoteProtocolError(
      "CONFIG_INVALID",
      "content type must be application/json",
    );
  }
}

function writeHttpError(response: ServerResponse, error: unknown): void {
  if (error instanceof HttpAdmissionError) {
    json(response, error.status, { error: error.message });
    return;
  }
  const status = !(error instanceof RemoteProtocolError)
    ? 500
    : error instanceof RemoteProtocolError &&
        (error.code === "AUTH_REQUIRED" ||
          error.code === "SIGNATURE_INVALID" ||
          error.code === "MESSAGE_EXPIRED")
      ? 401
      : error instanceof RemoteProtocolError &&
          error.code === "CAPABILITY_DENIED"
        ? 403
        : error instanceof RemoteProtocolError && error.code === "RATE_LIMITED"
          ? 429
          : 400;
  json(response, status, {
    error:
      error instanceof RemoteProtocolError ? error.code : "REQUEST_INVALID",
  });
}

function parseFilter(value: unknown): NostrFilter {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new RemoteProtocolError("CONFIG_INVALID", "filter must be an object");
  }
  const candidate = value as Record<string, unknown>;
  const output: {
    ids?: string[];
    authors?: string[];
    kinds?: number[];
    since?: number;
    until?: number;
    before_id?: string;
    limit?: number;
    search?: string;
    top_level?: boolean;
    include_aux?: boolean;
    include_summaries?: boolean;
    [tagName: `#${string}`]: string[] | undefined;
  } = {};
  for (const [key, raw] of Object.entries(candidate)) {
    if (key === "ids" || key === "authors") {
      output[key] = parseStringArray(raw, key, /^[0-9a-f]{1,64}$/, 1_000);
      continue;
    }
    if (key === "kinds") {
      if (
        !Array.isArray(raw) ||
        raw.length > 1_000 ||
        !raw.every(
          (kind) =>
            Number.isSafeInteger(kind) &&
            (kind as number) >= 0 &&
            (kind as number) <= 65_535,
        )
      ) {
        throw new RemoteProtocolError("CONFIG_INVALID", "invalid kinds filter");
      }
      output.kinds = raw as number[];
      continue;
    }
    if (key === "since" || key === "until") {
      if (!Number.isSafeInteger(raw) || (raw as number) < 0) {
        throw new RemoteProtocolError(
          "CONFIG_INVALID",
          `invalid ${key} filter`,
        );
      }
      output[key] = raw as number;
      continue;
    }
    if (key === "before_id") {
      if (typeof raw !== "string" || !/^[0-9a-f]{64}$/.test(raw)) {
        throw new RemoteProtocolError(
          "CONFIG_INVALID",
          "invalid before_id filter",
        );
      }
      output.before_id = raw;
      continue;
    }
    if (key === "limit") {
      if (
        !Number.isSafeInteger(raw) ||
        (raw as number) < 0 ||
        (raw as number) > MAX_FILTER_LIMIT
      ) {
        throw new RemoteProtocolError("CONFIG_INVALID", "invalid limit filter");
      }
      output.limit = raw as number;
      continue;
    }
    if (key === "search") {
      if (
        typeof raw !== "string" ||
        raw.trim().length < 1 ||
        Buffer.byteLength(raw, "utf8") > 16 * 1024
      ) {
        throw new RemoteProtocolError(
          "CONFIG_INVALID",
          "invalid search filter",
        );
      }
      output.search = raw;
      continue;
    }
    if (
      key === "top_level" ||
      key === "include_aux" ||
      key === "include_summaries"
    ) {
      if (typeof raw !== "boolean") {
        throw new RemoteProtocolError(
          "CONFIG_INVALID",
          `${key} must be a boolean`,
        );
      }
      output[key] = raw;
      continue;
    }
    if (/^#[A-Za-z0-9_-]{1,32}$/.test(key)) {
      output[key as `#${string}`] = parseStringArray(
        raw,
        key,
        /^.{1,1024}$/u,
        1_000,
      );
      continue;
    }
    throw new RemoteProtocolError(
      "CONFIG_INVALID",
      `unsupported filter field ${key}`,
    );
  }
  if (output.before_id !== undefined && output.until === undefined) {
    throw new RemoteProtocolError(
      "CONFIG_INVALID",
      "before_id requires an until cursor",
    );
  }
  if (
    output.kinds?.some((kind) => REMOTE_AGENT_KINDS.has(kind)) &&
    (!output.kinds.every((kind) => REMOTE_AGENT_KINDS.has(kind)) ||
      !output["#p"]?.length)
  ) {
    throw new RemoteProtocolError(
      "CONFIG_INVALID",
      "remote subscriptions require explicit kinds and #p",
    );
  }
  return output;
}

const WINDOW_AUX_KINDS = [
  KIND_DELETION,
  KIND_REACTION,
  KIND_NIP29_DELETE_EVENT,
  KIND_STREAM_MESSAGE_EDIT,
] as const;
const WINDOW_AUX_DELETE_KINDS = [
  KIND_DELETION,
  KIND_NIP29_DELETE_EVENT,
] as const;

async function queryChannelWindowEvents(
  eventStore: EventStore,
  community: string,
  filter: NostrFilter,
  relaySecretKey: Uint8Array | undefined,
): Promise<NostrEvent[]> {
  if (!relaySecretKey) {
    throw new RemoteProtocolError(
      "CONFIG_INVALID",
      "channel windows require a configured relay signing key",
    );
  }
  if (filter.search !== undefined) {
    throw new RemoteProtocolError(
      "CONFIG_INVALID",
      "top_level cannot be combined with search",
    );
  }
  const channels = filter["#h"];
  if (channels?.length !== 1 || !isUuid(channels[0] as string)) {
    throw new RemoteProtocolError(
      "CONFIG_INVALID",
      "top_level requires exactly one #h channel",
    );
  }
  if ((filter.until === undefined) !== (filter.before_id === undefined)) {
    throw new RemoteProtocolError(
      "CONFIG_INVALID",
      "top_level cursor requires both until and before_id, or neither",
    );
  }
  const cursor =
    filter.until !== undefined && filter.before_id !== undefined
      ? { createdAt: filter.until, id: filter.before_id }
      : undefined;
  const channelId = channels[0] as string;
  const window = await eventStore.queryChannelWindow(community, channelId, {
    ...(cursor ? { cursor } : {}),
    ...(filter.kinds ? { kinds: filter.kinds } : {}),
    limit: Math.max(1, Math.min(filter.limit ?? 50, 200)),
  });
  const output = window.rows.map((row) => row.storedEvent.event);

  if (filter.include_aux && window.rows.length > 0) {
    const seen = new Set<string>();
    let targets = window.rows.map((row) => row.storedEvent.event.id);
    for (const kinds of [WINDOW_AUX_KINDS, WINDOW_AUX_DELETE_KINDS]) {
      if (targets.length === 0) break;
      const aux = await eventStore.query(community, {
        "#e": targets,
        kinds,
        limit: 1_000,
      });
      targets = [];
      for (const event of aux) {
        if (seen.has(event.id)) continue;
        seen.add(event.id);
        output.push(event);
        targets.push(event.id);
      }
    }
  }

  if (filter.include_summaries) {
    for (const row of window.rows) {
      if (!row.threadSummary) continue;
      output.push(
        signNostrEvent(
          {
            content: JSON.stringify({
              reply_count: row.threadSummary.replyCount,
              descendant_count: row.threadSummary.descendantCount,
              last_reply_at: row.threadSummary.lastReplyAt ?? null,
              participants: row.threadSummary.participants,
            }),
            created_at: unixNow(),
            kind: KIND_THREAD_SUMMARY,
            tags: [
              ["e", row.storedEvent.event.id],
              ["d", row.storedEvent.event.id],
              ["h", channelId],
            ],
          },
          relaySecretKey,
        ),
      );
    }
  }

  const requestedCursor = cursor ? `${cursor.createdAt}:${cursor.id}` : "head";
  output.push(
    signNostrEvent(
      {
        content: JSON.stringify({
          has_more: window.hasMore,
          next_cursor: window.nextCursor
            ? {
                created_at: window.nextCursor.createdAt,
                id: window.nextCursor.id,
              }
            : null,
        }),
        created_at: unixNow(),
        kind: KIND_WINDOW_BOUNDS,
        tags: [
          ["d", `${channelId}:${requestedCursor}`],
          ["h", channelId],
        ],
      },
      relaySecretKey,
    ),
  );
  return output;
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value,
  );
}

async function synthesizePresenceEvents(
  filters: readonly NostrFilter[],
  eventBus: EventBus,
  community: string,
  relaySecretKey: Uint8Array | undefined,
): Promise<NostrEvent[] | undefined> {
  if (!relaySecretKey) return undefined;
  const pubkeys: string[] = [];
  for (const filter of filters) {
    if (
      filter.kinds?.length !== 1 ||
      (filter.kinds[0] !== KIND_PRESENCE_UPDATE &&
        filter.kinds[0] !== KIND_PRESENCE_SNAPSHOT) ||
      !filter.authors?.length ||
      !filter.authors.every((author) => /^[0-9a-f]{64}$/.test(author))
    ) {
      return undefined;
    }
    pubkeys.push(...filter.authors);
  }
  const presence = await eventBus.getPresenceBulk(
    community,
    [...new Set(pubkeys)].sort(),
  );
  const now = unixNow();
  return [...presence.entries()].map(([pubkey, status]) =>
    signNostrEvent(
      {
        content: status,
        created_at: now,
        kind: KIND_PRESENCE_UPDATE,
        tags: [["p", pubkey]],
      },
      relaySecretKey,
    ),
  );
}

function parseStringArray(
  value: unknown,
  field: string,
  pattern: RegExp,
  maximumItems: number,
): string[] {
  if (
    !Array.isArray(value) ||
    value.length > maximumItems ||
    !value.every(
      (item) =>
        typeof item === "string" &&
        Buffer.byteLength(item, "utf8") <= 4_096 &&
        pattern.test(item),
    )
  ) {
    throw new RemoteProtocolError("CONFIG_INVALID", `invalid ${field} filter`);
  }
  return value as string[];
}

function requireAuthentication(client: Client): asserts client is Client & {
  authenticatedPubkey: string;
} {
  if (!client.authenticatedPubkey) {
    throw new RemoteProtocolError("AUTH_REQUIRED", "NIP-42 auth is required");
  }
}

function singleTag(event: NostrEvent, name: string): string {
  const values = event.tags.filter((tag) => tag[0] === name);
  if (values.length !== 1 || values[0]?.length !== 2 || !values[0][1]) {
    throw new RemoteProtocolError(
      "TAG_INVALID",
      `event must contain exactly one ${name} tag`,
    );
  }
  return values[0][1];
}

function normalizeRelayUrl(value: string): string {
  const url = new URL(value);
  url.hash = "";
  if (url.pathname === "") url.pathname = "/";
  return url.toString();
}

function parseUnsignedTag(event: NostrEvent, name: string): number {
  const raw = singleTag(event, name);
  if (!/^(?:0|[1-9][0-9]*)$/.test(raw)) {
    throw new RemoteProtocolError("TAG_INVALID", `${name} tag is invalid`);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) {
    throw new RemoteProtocolError("TAG_INVALID", `${name} tag is too large`);
  }
  return value;
}

function requestHostname(hostHeader: string | undefined): string {
  if (!hostHeader || hostHeader.length > 512) return "";
  try {
    return new URL(`http://${hostHeader}`).hostname.toLowerCase();
  } catch {
    return "";
  }
}

function httpBaseUrl(relayUrl: URL): URL {
  const url = new URL(relayUrl);
  if (url.protocol === "wss:") url.protocol = "https:";
  if (url.protocol === "ws:") url.protocol = "http:";
  return url;
}

async function readBoundedBody(
  request: IncomingMessage,
  limit: number,
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const rawChunk of request) {
    const chunk = Buffer.isBuffer(rawChunk)
      ? rawChunk
      : Buffer.from(rawChunk as Uint8Array);
    length += chunk.length;
    if (length > limit) {
      throw new RemoteProtocolError(
        "MESSAGE_TOO_LARGE",
        "request body is too large",
      );
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function applySecurityHeaders(response: ServerResponse): void {
  response.setHeader("Content-Security-Policy", "default-src 'none'");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("X-Frame-Options", "DENY");
}

function relayInformationDocument(input: {
  readonly icon?: string;
  readonly maxNotBeforeDelta: number;
  readonly maxFrameBytes: number;
  readonly nip43: boolean;
  readonly pairingRelayUrl?: string;
  readonly push?: Readonly<Record<string, unknown>>;
  readonly relaySelfPubkey?: string;
  readonly search: boolean;
}): Readonly<Record<string, unknown>> {
  const relaySelf =
    input.relaySelfPubkey && /^[0-9a-f]{64}$/.test(input.relaySelfPubkey)
      ? input.relaySelfPubkey
      : null;
  return {
    contact: null,
    description: "Buzz — private team communication relay",
    ...(input.icon ? { icon: input.icon } : {}),
    limitation: {
      auth_required: true,
      due_delivery_mode: "push",
      max_filters: 10,
      max_limit: MAX_FILTER_LIMIT,
      max_message_length: input.maxFrameBytes,
      max_not_before_delta: input.maxNotBeforeDelta,
      max_subid_length: MAX_SUBSCRIPTION_ID_BYTES,
      max_subscriptions: MAX_SUBSCRIPTIONS,
      min_pow_difficulty: null,
      payment_required: false,
      restricted_writes: true,
    },
    name: "Buzz Relay",
    ...(input.pairingRelayUrl
      ? { pairing_relay_url: input.pairingRelayUrl }
      : {}),
    pubkey: null,
    ...(input.push ? { push: input.push } : {}),
    ...(relaySelf ? { self: relaySelf } : {}),
    software: "https://github.com/block/buzz",
    supported_extensions: ["nip-er", ...(input.push ? ["nip-pl"] : [])],
    supported_nips: [
      1,
      2,
      10,
      11,
      16,
      17,
      23,
      25,
      29,
      33,
      38,
      42,
      ...(input.nip43 ? [43] : []),
      ...(input.search ? [50] : []),
      56,
    ],
    version: RELAY_VERSION,
  };
}

async function workspaceIcon(
  options: RelayServerOptions,
): Promise<string | undefined> {
  if (!options.pool || !options.search) return undefined;
  try {
    const result = await options.pool.query<{
      readonly icon: string | null;
    }>(
      `SELECT icon
       FROM communities
       WHERE id = $1::uuid
         AND lower(host) = lower($2)
         AND archived_at IS NULL
       LIMIT 1`,
      [options.search.communityId, options.community],
    );
    const icon = result.rows[0]?.icon?.trim();
    return icon || undefined;
  } catch {
    // NIP-11 is intentionally fail-open; a host-scoped optional icon lookup
    // must not turn relay discovery into a database availability dependency.
    return undefined;
  }
}

function json(response: ServerResponse, status: number, body: unknown): void {
  response.statusCode = status;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.end(JSON.stringify(body));
}

function handleCors(
  request: IncomingMessage,
  response: ServerResponse,
  allowedOrigins: readonly string[],
): boolean {
  const origin = request.headers.origin;
  const allowed =
    origin !== undefined &&
    (allowedOrigins.length === 0 || allowedOrigins.includes(origin));
  if (allowed) {
    response.setHeader(
      "Access-Control-Allow-Origin",
      allowedOrigins.length === 0 ? "*" : origin,
    );
    if (allowedOrigins.length > 0) {
      response.setHeader(
        "Vary",
        appendVary(response.getHeader("Vary"), "Origin"),
      );
    }
  }
  if (
    request.method !== "OPTIONS" ||
    request.headers["access-control-request-method"] === undefined
  ) {
    return false;
  }
  if (origin === undefined || !allowed) {
    json(response, 403, { error: "origin is not allowed" });
    return true;
  }
  response.statusCode = 204;
  response.setHeader("Access-Control-Allow-Methods", "*");
  response.setHeader("Access-Control-Allow-Headers", "*");
  response.setHeader("Access-Control-Max-Age", "600");
  response.setHeader("Cache-Control", "no-store");
  response.end();
  return true;
}

function appendVary(
  current: string | number | readonly string[] | undefined,
  value: string,
): string {
  const entries = (
    Array.isArray(current) ? current.join(",") : String(current ?? "")
  )
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (!entries.some((entry) => entry.toLowerCase() === value.toLowerCase())) {
    entries.push(value);
  }
  return entries.join(", ");
}

function isRemoteAgentKind(kind: number): boolean {
  return REMOTE_AGENT_KINDS.has(kind);
}

function send(socket: WebSocket, message: unknown[]): void {
  if (socket.readyState !== WebSocket.OPEN) return;
  if (socket.bufferedAmount > 4 * 1024 * 1024) {
    socket.close(1013, "slow client");
    return;
  }
  const encoded = JSON.stringify(message);
  if (Buffer.byteLength(encoded, "utf8") > 1024 * 1024) {
    socket.close(1009, "outbound message too large");
    return;
  }
  try {
    socket.send(encoded);
  } catch {
    socket.close(1011, "send failed");
  }
}

function submittedEventId(value: unknown): string {
  if (
    typeof value === "object" &&
    value !== null &&
    "id" in value &&
    typeof value.id === "string" &&
    /^[0-9a-f]{64}$/.test(value.id)
  ) {
    return value.id;
  }
  return "";
}

function nostrRejectionReason(
  error: RemoteProtocolError,
  messageType: "AUTH" | "EVENT",
): string {
  if (error.code === "RATE_LIMITED") {
    return `rate-limited: ${error.message}`;
  }
  if (messageType === "EVENT" && error.code === "AUTH_REQUIRED") {
    return `auth-required: ${error.message}`;
  }
  if (
    error.code === "CAPABILITY_DENIED" ||
    error.code === "DEPLOYMENT_NOT_FOUND" ||
    error.code === "OWNER_APPROVAL_REQUIRED" ||
    error.code === "SECRET_REFERENCE_MISSING"
  ) {
    return `restricted: ${error.message}`;
  }
  return `invalid: ${error.message}`;
}

function messageCost(type: string): number {
  switch (type) {
    case "EVENT":
      return 2;
    case "REQ":
    case "COUNT":
      return 5;
    case "BRAP":
      return 10;
    default:
      return 1;
  }
}

class TrySemaphore {
  #available: number;

  public constructor(readonly capacity: number) {
    if (!Number.isSafeInteger(capacity) || capacity < 1) {
      throw new TypeError(
        "maxConcurrentHandlers must be a positive safe integer",
      );
    }
    this.#available = capacity;
  }

  public tryAcquire(): (() => void) | undefined {
    if (this.#available === 0) return undefined;
    this.#available -= 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.#available += 1;
    };
  }
}

function resolveRateLimits(
  overrides: Partial<RelayRateLimitOptions> | undefined,
): RelayRateLimitOptions {
  const resolved = { ...DEFAULT_RATE_LIMITS, ...overrides };
  for (const [name, value] of Object.entries(resolved)) {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new TypeError(`${name} must be a positive safe integer`);
    }
  }
  if (
    resolved.humanWsEventsPerSecond >
    Math.floor(Number.MAX_SAFE_INTEGER / WS_ADMISSION_WINDOW_SECONDS)
  ) {
    throw new TypeError("humanWsEventsPerSecond is too large");
  }
  return resolved;
}

function requireControlBudget(
  limiter: TokenBucketRateLimiter,
  pubkey: string,
): void {
  if (!limiter.consume(pubkey, 5)) {
    throw new RemoteProtocolError(
      "RATE_LIMITED",
      "remote-agent control rate exceeded",
    );
  }
}

function rememberLocalEvent(
  events: Map<string, number>,
  eventId: string,
): void {
  const now = Date.now();
  for (const [id, expiresAt] of events) {
    if (expiresAt <= now) events.delete(id);
  }
  if (events.size >= 10_000) {
    const oldest = events.keys().next().value as string | undefined;
    if (oldest) events.delete(oldest);
  }
  events.set(eventId, now + 60_000);
}

function consumeLocalEvent(
  events: Map<string, number>,
  eventId: string,
): boolean {
  const expiresAt = events.get(eventId);
  if (expiresAt === undefined) return false;
  events.delete(eventId);
  return expiresAt > Date.now();
}
