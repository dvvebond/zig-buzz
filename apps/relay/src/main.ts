#!/usr/bin/env node

import { createHash, randomBytes } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { createRelayServer, type RelayRateLimitOptions } from "./server.js";
import { Pool } from "pg";
import { PostgresEventStore, PostgresRelayAccessPolicy } from "@buzz/db";
import { InMemoryEventBus, RedisEventBus } from "@buzz/pubsub";
import { SearchService } from "@buzz/search";
import { AuditService } from "@buzz/audit";
import { validateRemoteRelayUrl } from "@buzz/remote-agent-protocol";
import { PostgresWorkflowStore } from "@buzz/workflow";
import { generateSecretKey } from "nostr-tools/pure";
import { schnorr } from "@noble/curves/secp256k1.js";
import {
  MeshNode,
  RedisReadyRegistry,
  RedisSessionDirectory,
  RuntimeIdentity,
  createReadyRecord,
  type RuntimeId,
} from "@buzz/relay-mesh";
import {
  DEFAULT_MEDIA_LIMITS,
  FileMediaStorage,
  S3MediaStorage,
  validateMediaConfig,
  type MediaConfig,
} from "@buzz/media";

import { PostgresRemoteRegistry } from "./postgres-remote-registry.js";
import { normalizeCandidateHost } from "./operator-http.js";
import { TenantGateway, type ResolvedRelayTenant } from "./tenant-gateway.js";
import type { WorkflowCommunityIdentity } from "./workflow-action-sink.js";
import { GitOperationGate } from "./git-http.js";
import {
  FileGitObjectStore,
  S3GitObjectStore,
  type GitObjectStore,
} from "./git-store.js";
import { RelayMeshDispatcher } from "./mesh-dispatcher.js";
import { resolveRelayBinding, resolveRelayRedisUrl } from "./runtime-config.js";
import {
  UsageMetricsCollector,
  type UsageMetricsOptions,
} from "./usage-metrics.js";

const { host, port } = resolveRelayBinding(process.env);
const relayRedisUrl = resolveRelayRedisUrl(process.env);
const publicUrl = new URL(
  process.env.BUZZ_PUBLIC_URL ??
    process.env.RELAY_URL ??
    `ws://localhost:${port}/`,
);
const community = normalizeCandidateHost(
  process.env.BUZZ_COMMUNITY ?? publicUrl.host,
);
validateRemoteRelayUrl(publicUrl.toString(), true);
const configuredOwnerPubkeys = new Set(
  (process.env.BUZZ_OWNER_PUBKEYS ?? process.env.RELAY_OWNER_PUBKEY ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter((value) => /^[0-9a-f]{64}$/.test(value)),
);
const requireRelayMembership = parseBoolean(
  process.env.BUZZ_REQUIRE_RELAY_MEMBERSHIP ?? "false",
  "BUZZ_REQUIRE_RELAY_MEMBERSHIP",
);
const pairingRelayUrl = resolvePairingRelayUrl();

const databaseUrl = process.env.BUZZ_DATABASE_URL ?? process.env.DATABASE_URL;
const pool = databaseUrl
  ? new Pool({
      connectionString: databaseUrl,
      max: parsePoolSize(process.env.BUZZ_DATABASE_POOL_SIZE ?? "20"),
    })
  : undefined;
if (pool) await ensureConfiguredCommunity(pool, community);
const registry = pool ? new PostgresRemoteRegistry(pool) : undefined;
const accessPolicy = pool
  ? new PostgresRelayAccessPolicy(pool, requireRelayMembership)
  : undefined;
const search = pool ? await resolveSearch(pool, community) : undefined;
const ownerPubkeys =
  pool && search
    ? await resolveOwnerPubkeys(
        pool,
        search.communityId,
        configuredOwnerPubkeys,
      )
    : configuredOwnerPubkeys;
const relaySecretKey = pool
  ? await resolveRelaySecretKey(pool, community)
  : resolveConfiguredRelaySecretKey();
const joinPolicy = resolveJoinPolicy();
const operator = resolveOperator(pool);
const admin = resolveAdmin(pool);
const staticHttp = resolveStaticHttp(admin?.host);
const eventStore = pool
  ? new PostgresEventStore(pool, {
      ...(relaySecretKey ? { relaySecretKey } : {}),
    })
  : undefined;
const audit =
  pool && search
    ? { communityId: search.communityId, service: new AuditService(pool) }
    : undefined;
const workflow =
  pool && eventStore && relaySecretKey
    ? {
        pool,
        relaySecretKey,
        resolveCommunityIdentity: (communityId: string) =>
          resolveWorkflowCommunityIdentity(pool, communityId),
        store: new PostgresWorkflowStore(pool),
      }
    : undefined;
const media =
  pool && search
    ? resolveMedia(pool, search.communityId, publicUrl)
    : undefined;
const usageMetrics = pool
  ? new UsageMetricsCollector(
      pool,
      media?.storage,
      resolveUsageMetricsOptions(),
    )
  : undefined;
const git = pool && search ? resolveGit(pool, search.communityId) : undefined;
const pushConfig = resolvePushConfig();
const corsOrigins = resolveCorsOrigins(process.env.BUZZ_CORS_ORIGINS);
const maxConnections = parsePositiveInteger(
  process.env.BUZZ_MAX_CONNECTIONS,
  10_000,
  "BUZZ_MAX_CONNECTIONS",
);
const maxConcurrentHandlers = parsePositiveInteger(
  process.env.BUZZ_MAX_CONCURRENT_HANDLERS,
  1_024,
  "BUZZ_MAX_CONCURRENT_HANDLERS",
);
const maxFrameBytes = parsePositiveInteger(
  process.env.BUZZ_MAX_FRAME_BYTES,
  512 * 1024,
  "BUZZ_MAX_FRAME_BYTES",
);
const rateLimits = resolveRateLimitOptions();
const push =
  pool && search && relaySecretKey && pushConfig
    ? {
        ...pushConfig,
        communityId: search.communityId,
        pool,
        relaySecretKey,
      }
    : undefined;
const eventBus = relayRedisUrl
  ? new RedisEventBus(relayRedisUrl)
  : new InMemoryEventBus();
const meshDemoEcho = parseBoolean(
  process.env.BUZZ_MESH_DEMO_ECHO ?? "false",
  "BUZZ_MESH_DEMO_ECHO",
);
const mesh = await bootMesh({
  communityId: search?.communityId ?? community,
  demoEcho: meshDemoEcho,
  ...(relaySecretKey ? { relaySecretKey } : {}),
});
const controlRelay = createRelayServer({
  community,
  corsOrigins,
  host: pool ? "127.0.0.1" : host,
  maxConcurrentHandlers,
  maxConnections,
  maxFrameBytes,
  ownerPubkeys,
  port: pool ? 0 : port,
  publicUrl,
  rateLimits,
  ...(relaySecretKey
    ? {
        nip43: pool !== undefined,
        advertiseNip43: requireRelayMembership,
        relaySelfPubkey: Buffer.from(
          schnorr.getPublicKey(relaySecretKey),
        ).toString("hex"),
      }
    : {}),
  ...(accessPolicy ? { accessPolicy } : {}),
  ...(audit ? { audit } : {}),
  ...(eventStore ? { eventStore } : {}),
  ...(joinPolicy ? { joinPolicy } : {}),
  ...(pool ? { pool } : {}),
  ...(registry ? { registry } : {}),
  ...(relaySecretKey ? { relaySecretKey } : {}),
  ...(search ? { search } : {}),
  ...(workflow ? { workflow } : {}),
  ...(usageMetrics ? { usageMetrics } : {}),
  ...(media ? { media } : {}),
  ...(git ? { git } : {}),
  ...(push ? { push } : {}),
  ...(admin ? { admin } : {}),
  ...(operator ? { operator } : {}),
  ...(staticHttp ? { static: staticHttp } : {}),
  eventBus,
  ...(mesh ? { meshStatus: () => mesh.node.status } : {}),
  ...(pairingRelayUrl ? { pairingRelayUrl } : {}),
  ...(mesh && search
    ? {
        huddleMesh: {
          communityId: search.communityId,
          directory: mesh.directory,
          dispatcher: mesh.dispatcher,
          node: mesh.node,
        },
      }
    : {}),
  ...(mesh && meshDemoEcho
    ? {
        meshDemo: {
          communityId: search?.communityId ?? community,
          directory: mesh.directory,
          node: mesh.node,
        },
      }
    : {}),
  readinessCheck: async () => {
    await Promise.all([
      eventBus.ready(),
      ...(pool ? [pool.query("SELECT 1").then(() => undefined)] : []),
    ]);
  },
});
const relay =
  pool && search
    ? new TenantGateway({
        ...(admin ? { controlAuthorities: new Set([admin.host]) } : {}),
        controlBackend: controlRelay,
        controlHost: community,
        controlTenantId: search.communityId,
        createTenantBackend: async (tenant) => {
          const identity = await resolveWorkflowCommunityIdentity(
            pool,
            tenant.id,
          );
          const tenantPublicUrl = publicUrlForTenant(publicUrl, tenant.host);
          const tenantEventStore = new PostgresEventStore(pool, {
            relaySecretKey: identity.relaySecretKey,
          });
          const tenantOwnerPubkeys = await resolveOwnerPubkeys(pool, tenant.id);
          const tenantMedia = mediaForTenant(media, tenant.id, tenantPublicUrl);
          const tenantGit = gitForTenant(git, tenant.id);
          const tenantPush = pushConfig
            ? {
                ...pushConfig,
                communityId: tenant.id,
                pool,
                relaySecretKey: identity.relaySecretKey,
              }
            : undefined;
          return createRelayServer({
            ...(accessPolicy ? { accessPolicy } : {}),
            audit: {
              communityId: tenant.id,
              service: new AuditService(pool),
            },
            community: tenant.host,
            corsOrigins,
            eventBus,
            eventStore: tenantEventStore,
            host: "127.0.0.1",
            ...(joinPolicy ? { joinPolicy } : {}),
            ...(tenantMedia ? { media: tenantMedia } : {}),
            ...(tenantGit ? { git: tenantGit } : {}),
            ...(tenantPush ? { push: tenantPush } : {}),
            ...(mesh && meshDemoEcho
              ? {
                  meshDemo: {
                    communityId: tenant.id,
                    directory: mesh.directory,
                    node: mesh.node,
                  },
                }
              : {}),
            ...(mesh
              ? {
                  huddleMesh: {
                    communityId: tenant.id,
                    directory: mesh.directory,
                    dispatcher: mesh.dispatcher,
                    node: mesh.node,
                  },
                }
              : {}),
            ...(mesh ? { meshStatus: () => mesh.node.status } : {}),
            nip43: true,
            advertiseNip43: requireRelayMembership,
            maxConcurrentHandlers,
            maxConnections,
            maxFrameBytes,
            ownerPubkeys: tenantOwnerPubkeys,
            pool,
            port: 0,
            publicUrl: tenantPublicUrl,
            rateLimits,
            readinessCheck: async () => {
              await Promise.all([
                eventBus.ready(),
                pool.query("SELECT 1").then(() => undefined),
              ]);
            },
            ...(registry ? { registry } : {}),
            relaySecretKey: identity.relaySecretKey,
            relaySelfPubkey: Buffer.from(
              schnorr.getPublicKey(identity.relaySecretKey),
            ).toString("hex"),
            search: {
              communityId: tenant.id,
              service: search.service,
            },
            ...(staticHttp ? { static: staticHttp } : {}),
            ...(pairingRelayUrl ? { pairingRelayUrl } : {}),
            ...(usageMetrics ? { usageMetrics } : {}),
            ...(controlRelay.workflowRuntime
              ? { workflowRuntime: controlRelay.workflowRuntime }
              : {}),
          });
        },
        host,
        maxCachedTenants: parsePositiveInteger(
          process.env.BUZZ_MAX_CACHED_TENANTS,
          1_024,
          "BUZZ_MAX_CACHED_TENANTS",
        ),
        port,
        resolveTenant: (authority) => resolveTenant(pool, authority),
      })
    : controlRelay;
await relay.listen();
usageMetrics?.start();
process.stdout.write(`Buzz TypeScript relay listening on ${host}:${port}\n`);

const stop = (): void => {
  void relay.close().then(async () => {
    await usageMetrics?.stop();
    await mesh?.node.close();
    await mesh?.directory.close();
    await mesh?.registry.close();
    await eventBus.close();
    await pool?.end();
    process.exitCode = 0;
  });
};
process.once("SIGINT", stop);
process.once("SIGTERM", stop);

function resolveCorsOrigins(raw: string | undefined): readonly string[] {
  if (raw === undefined || raw.trim().length === 0) return [];
  return [
    ...new Set(
      raw.split(",").map((candidate) => {
        const value = candidate.trim();
        let parsed: URL;
        try {
          parsed = new URL(value);
        } catch {
          throw new Error(
            `BUZZ_CORS_ORIGINS contains an invalid origin: ${value}`,
          );
        }
        if (
          (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
          parsed.username ||
          parsed.password ||
          parsed.pathname !== "/" ||
          parsed.search ||
          parsed.hash ||
          (parsed.origin !== value && `${parsed.origin}/` !== value)
        ) {
          throw new Error(
            `BUZZ_CORS_ORIGINS must contain exact http(s) origins: ${value}`,
          );
        }
        return parsed.origin;
      }),
    ),
  ];
}

function parsePoolSize(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 100) {
    throw new Error("BUZZ_DATABASE_POOL_SIZE must be between 1 and 100");
  }
  return parsed;
}

async function ensureConfiguredCommunity(
  pool: Pool,
  communityHost: string,
): Promise<void> {
  await pool.query(
    `INSERT INTO communities (host)
     VALUES ($1)
     ON CONFLICT (lower(host)) DO NOTHING`,
    [communityHost],
  );
}

async function resolveTenant(
  pool: Pool,
  authority: string,
): Promise<ResolvedRelayTenant | undefined> {
  const result = await pool.query<{
    readonly host: string;
    readonly id: string;
  }>(
    `SELECT id, host
     FROM communities
     WHERE lower(host) = lower($1)
       AND archived_at IS NULL
     LIMIT 1`,
    [authority],
  );
  const row = result.rows[0];
  return row
    ? { host: normalizeCandidateHost(row.host), id: row.id }
    : undefined;
}

async function resolveOwnerPubkeys(
  pool: Pool,
  communityId: string,
  configured: ReadonlySet<string> = new Set(),
): Promise<ReadonlySet<string>> {
  for (const pubkey of configured) {
    await pool.query(
      `INSERT INTO relay_members (
         community_id, pubkey, role, added_by
       )
       SELECT id, $2, 'owner', $2
       FROM communities
       WHERE id = $1::uuid AND archived_at IS NULL
       ON CONFLICT (community_id, pubkey)
       DO UPDATE SET role = 'owner', updated_at = now()`,
      [communityId, pubkey],
    );
  }
  const result = await pool.query<{ readonly pubkey: string }>(
    `SELECT rm.pubkey
     FROM relay_members rm
     JOIN communities c ON c.id = rm.community_id
     WHERE rm.community_id = $1::uuid
       AND rm.role = 'owner'
       AND c.archived_at IS NULL
     ORDER BY rm.pubkey`,
    [communityId],
  );
  return new Set(result.rows.map((row) => row.pubkey));
}

async function resolveWorkflowCommunityIdentity(
  pool: Pool,
  communityId: string,
): Promise<WorkflowCommunityIdentity> {
  const configured = resolveConfiguredRelaySecretKey();
  const current = await pool.query<{
    readonly host: string;
    readonly signing_key: Buffer | null;
  }>(
    `SELECT host, signing_key
     FROM communities
     WHERE id = $1::uuid AND archived_at IS NULL
     LIMIT 1`,
    [communityId],
  );
  const row = current.rows[0];
  if (!row) throw new Error("workflow community is unavailable");
  if (configured) {
    return {
      communityHost: row.host,
      communityId,
      relaySecretKey: configured,
    };
  }
  if (row.signing_key) {
    if (row.signing_key.byteLength !== 32) {
      throw new Error("community signing key has an invalid length");
    }
    return {
      communityHost: row.host,
      communityId,
      relaySecretKey: Uint8Array.from(row.signing_key),
    };
  }
  const generated = generateSecretKey();
  const installed = await pool.query<{
    readonly host: string;
    readonly signing_key: Buffer;
  }>(
    `UPDATE communities
     SET signing_key = $2
     WHERE id = $1::uuid
       AND archived_at IS NULL
       AND signing_key IS NULL
     RETURNING host, signing_key`,
    [communityId, Buffer.from(generated)],
  );
  const winner = installed.rows[0];
  if (winner) {
    return {
      communityHost: winner.host,
      communityId,
      relaySecretKey: Uint8Array.from(winner.signing_key),
    };
  }
  const raced = await pool.query<{
    readonly host: string;
    readonly signing_key: Buffer | null;
  }>(
    `SELECT host, signing_key
     FROM communities
     WHERE id = $1::uuid AND archived_at IS NULL
     LIMIT 1`,
    [communityId],
  );
  const won = raced.rows[0];
  if (!won?.signing_key || won.signing_key.byteLength !== 32) {
    throw new Error("failed to initialize the community signing key");
  }
  return {
    communityHost: won.host,
    communityId,
    relaySecretKey: Uint8Array.from(won.signing_key),
  };
}

function publicUrlForTenant(base: URL, authority: string): URL {
  const url = new URL(`${base.protocol}//${authority}/`);
  url.pathname = "/";
  url.search = "";
  url.hash = "";
  return url;
}

function mediaForTenant(
  media: ReturnType<typeof resolveMedia> | undefined,
  communityId: string,
  relayUrl: URL,
): ReturnType<typeof resolveMedia> | undefined {
  if (!media) return undefined;
  const publicBaseUrl = new URL(relayUrl);
  publicBaseUrl.protocol =
    publicBaseUrl.protocol === "wss:" ? "https:" : "http:";
  publicBaseUrl.pathname = "/media";
  publicBaseUrl.search = "";
  publicBaseUrl.hash = "";
  return {
    ...media,
    communityId,
    config: validateMediaConfig({
      ...media.config,
      publicBaseUrl: publicBaseUrl.toString().replace(/\/$/, ""),
    }),
  };
}

function parseBoolean(value: string, name: string): boolean {
  const normalized = value.trim().toLowerCase();
  if (
    normalized === "true" ||
    normalized === "1" ||
    normalized === "on" ||
    normalized === "yes"
  ) {
    return true;
  }
  if (
    normalized === "false" ||
    normalized === "0" ||
    normalized === "off" ||
    normalized === "no"
  ) {
    return false;
  }
  throw new Error(`${name} must be true/false, on/off, yes/no, or 1/0`);
}

function resolvePushConfig():
  | {
      readonly deliveryUrl: URL;
      readonly executorKeyId: string;
      readonly gatewayTimeoutMs: number;
    }
  | undefined {
  const configured =
    process.env.BUZZ_PUSH_GATEWAY_DELIVERY_URL ??
    "https://push.buzz.xyz/v1/deliveries/apns";
  if (configured.trim().length === 0) return undefined;
  const deliveryUrl = new URL(configured);
  if (
    deliveryUrl.protocol !== "https:" ||
    deliveryUrl.username ||
    deliveryUrl.password ||
    deliveryUrl.pathname !== "/v1/deliveries/apns" ||
    deliveryUrl.search ||
    deliveryUrl.hash
  ) {
    throw new Error(
      "BUZZ_PUSH_GATEWAY_DELIVERY_URL must be an exact HTTPS /v1/deliveries/apns URL",
    );
  }
  const executorKeyId = process.env.BUZZ_PUSH_EXECUTOR_KEY_ID ?? "relay-v1";
  if (
    executorKeyId.length < 1 ||
    Buffer.byteLength(executorKeyId, "utf8") > 64
  ) {
    throw new Error("BUZZ_PUSH_EXECUTOR_KEY_ID must contain 1..64 bytes");
  }
  const gatewayTimeoutMs = Number(
    process.env.BUZZ_PUSH_GATEWAY_TIMEOUT_MS ?? "2000",
  );
  if (
    !Number.isSafeInteger(gatewayTimeoutMs) ||
    gatewayTimeoutMs < 100 ||
    gatewayTimeoutMs > 10_000
  ) {
    throw new Error(
      "BUZZ_PUSH_GATEWAY_TIMEOUT_MS must be an integer in 100..10000",
    );
  }
  return { deliveryUrl, executorKeyId, gatewayTimeoutMs };
}

function resolveJoinPolicy() {
  const readMarkdown = (name: string): string | null => {
    const value = process.env[name]?.trim();
    if (!value) return null;
    if (Buffer.byteLength(value, "utf8") > 256 * 1024) {
      throw new Error(`${name} must contain at most 262144 bytes`);
    }
    return value;
  };
  const termsMarkdown = readMarkdown("BUZZ_TERMS_OF_SERVICE_MARKDOWN");
  const privacyMarkdown = readMarkdown("BUZZ_PRIVACY_POLICY_MARKDOWN");
  const ageAttestationRequired = parseBoolean(
    process.env.BUZZ_AGE_ATTESTATION_REQUIRED ?? "false",
    "BUZZ_AGE_ATTESTATION_REQUIRED",
  );
  if (
    termsMarkdown === null &&
    privacyMarkdown === null &&
    !ageAttestationRequired
  ) {
    return undefined;
  }
  const version = createHash("sha256")
    .update(termsMarkdown ?? "", "utf8")
    .update(Buffer.from([0]))
    .update(privacyMarkdown ?? "", "utf8")
    .update(Buffer.from([0, ageAttestationRequired ? 1 : 0]))
    .digest("hex");
  return {
    ageAttestationRequired,
    privacyMarkdown,
    termsMarkdown,
    version,
  };
}

function parsePositiveInteger(
  value: string | undefined,
  fallback: number,
  name: string,
): number {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive safe integer`);
  }
  return parsed;
}

function resolveRateLimitOptions(): RelayRateLimitOptions {
  return {
    humanMessagesPerMinute: parsePositiveInteger(
      process.env.BUZZ_RATE_LIMIT_HUMAN_MESSAGES_PER_MIN,
      60,
      "BUZZ_RATE_LIMIT_HUMAN_MESSAGES_PER_MIN",
    ),
    humanApiCallsPerMinute: parsePositiveInteger(
      process.env.BUZZ_RATE_LIMIT_HUMAN_API_CALLS_PER_MIN,
      300,
      "BUZZ_RATE_LIMIT_HUMAN_API_CALLS_PER_MIN",
    ),
    humanWsEventsPerSecond: parsePositiveInteger(
      process.env.BUZZ_RATE_LIMIT_HUMAN_WS_EVENTS_PER_SEC,
      10,
      "BUZZ_RATE_LIMIT_HUMAN_WS_EVENTS_PER_SEC",
    ),
    agentStandardMessagesPerMinute: parsePositiveInteger(
      process.env.BUZZ_RATE_LIMIT_AGENT_STANDARD_MESSAGES_PER_MIN,
      120,
      "BUZZ_RATE_LIMIT_AGENT_STANDARD_MESSAGES_PER_MIN",
    ),
    agentStandardApiCallsPerMinute: parsePositiveInteger(
      process.env.BUZZ_RATE_LIMIT_AGENT_STANDARD_API_CALLS_PER_MIN,
      600,
      "BUZZ_RATE_LIMIT_AGENT_STANDARD_API_CALLS_PER_MIN",
    ),
    agentElevatedMessagesPerMinute: parsePositiveInteger(
      process.env.BUZZ_RATE_LIMIT_AGENT_ELEVATED_MESSAGES_PER_MIN,
      300,
      "BUZZ_RATE_LIMIT_AGENT_ELEVATED_MESSAGES_PER_MIN",
    ),
    agentPlatformMessagesPerMinute: parsePositiveInteger(
      process.env.BUZZ_RATE_LIMIT_AGENT_PLATFORM_MESSAGES_PER_MIN,
      600,
      "BUZZ_RATE_LIMIT_AGENT_PLATFORM_MESSAGES_PER_MIN",
    ),
  };
}

function resolveUsageMetricsOptions(): UsageMetricsOptions {
  const seconds = (name: string, fallback: number, floor: number): number => {
    const raw = process.env[name];
    const parsed = raw && /^[0-9]+$/.test(raw) ? Number(raw) : fallback;
    return Math.max(floor, Number.isSafeInteger(parsed) ? parsed : fallback);
  };
  const scope = (process.env.BUZZ_USAGE_METRICS_PER_COMMUNITY ?? "all")
    .trim()
    .toLowerCase();
  return {
    intervalMs: seconds("BUZZ_USAGE_METRICS_INTERVAL_SECS", 300, 5) * 1_000,
    perCommunity: scope !== "off",
    storage: {
      enabled:
        (process.env.BUZZ_STORAGE_METRICS ?? "").trim().toLowerCase() !== "off",
      intervalMs:
        seconds("BUZZ_STORAGE_SWEEP_INTERVAL_SECS", 3_600, 60) * 1_000,
      maxObjects: seconds("BUZZ_STORAGE_SWEEP_MAX_OBJECTS", 1_000_000, 1),
      timeoutMs: seconds("BUZZ_STORAGE_SWEEP_TIMEOUT_SECS", 120, 1) * 1_000,
    },
  };
}

function resolvePairingRelayUrl(): string | undefined {
  const value = process.env.BUZZ_PAIRING_RELAY_URL?.trim();
  if (!value) return undefined;
  const url = new URL(value);
  if (
    (url.protocol !== "ws:" && url.protocol !== "wss:") ||
    !url.hostname ||
    url.username ||
    url.password
  ) {
    throw new Error(
      "BUZZ_PAIRING_RELAY_URL must be a valid ws:// or wss:// URL",
    );
  }
  return value;
}

function resolveOperator(pool: Pool | undefined) {
  const rawPubkeys = (process.env.RELAY_OPERATOR_PUBKEYS ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  if (rawPubkeys.length === 0) return undefined;
  if (!pool) {
    throw new Error("RELAY_OPERATOR_PUBKEYS requires BUZZ_DATABASE_URL");
  }
  const operatorPubkeys = new Set<string>();
  for (const value of rawPubkeys) {
    const normalized = value.toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(normalized)) {
      throw new Error(
        "RELAY_OPERATOR_PUBKEYS entries must be 64-character hex pubkeys",
      );
    }
    operatorPubkeys.add(normalized);
  }
  const origin = process.env.RELAY_OPERATOR_API_ORIGIN;
  if (!origin) {
    throw new Error(
      "RELAY_OPERATOR_PUBKEYS requires RELAY_OPERATOR_API_ORIGIN",
    );
  }
  return {
    apiOrigin: new URL(origin),
    maxCommunitiesPerOwner: parsePositiveInteger(
      process.env.BUZZ_MAX_COMMUNITIES_PER_OWNER,
      3,
      "BUZZ_MAX_COMMUNITIES_PER_OWNER",
    ),
    operatorPubkeys,
  };
}

function resolveAdmin(pool: Pool | undefined) {
  const host = process.env.BUZZ_ADMIN_HOST?.trim();
  if (!host) return undefined;
  if (!pool) {
    throw new Error("BUZZ_ADMIN_HOST requires BUZZ_DATABASE_URL");
  }
  return { host };
}

function resolveStaticHttp(adminHost: string | undefined) {
  const publicDirectory = optionalWebDirectory(
    process.env.BUZZ_WEB_DIR,
    "BUZZ_WEB_DIR",
  );
  const adminDirectory = optionalWebDirectory(
    process.env.BUZZ_ADMIN_WEB_DIR,
    "BUZZ_ADMIN_WEB_DIR",
  );
  if (!publicDirectory && !adminDirectory) return undefined;
  return {
    ...(adminDirectory && adminHost
      ? {
          admin: {
            host: adminHost,
            webDirectory: adminDirectory,
          },
        }
      : {}),
    ...(publicDirectory
      ? {
          public: {
            serveGitWebGui: parseBoolean(
              process.env.BUZZ_SERVE_GIT_WEB_GUI ?? "false",
              "BUZZ_SERVE_GIT_WEB_GUI",
            ),
            webDirectory: publicDirectory,
          },
        }
      : {}),
  };
}

function optionalWebDirectory(
  value: string | undefined,
  name: string,
): string | undefined {
  const configured = value?.trim();
  if (!configured) return undefined;
  const directory = resolve(configured);
  try {
    if (!statSync(resolve(directory, "index.html")).isFile()) {
      throw new Error();
    }
  } catch {
    throw new Error(`${name} must contain a readable index.html`);
  }
  return directory;
}

function resolveMedia(pool: Pool, communityId: string, relayUrl: URL) {
  const mediaUrl = new URL(relayUrl);
  mediaUrl.protocol = mediaUrl.protocol === "wss:" ? "https:" : "http:";
  mediaUrl.pathname = "/media";
  mediaUrl.search = "";
  mediaUrl.hash = "";
  const config: MediaConfig = validateMediaConfig({
    maxFileBytes: parsePositiveInteger(
      process.env.BUZZ_MEDIA_MAX_FILE_BYTES,
      DEFAULT_MEDIA_LIMITS.maxFileBytes,
      "BUZZ_MEDIA_MAX_FILE_BYTES",
    ),
    maxGifBytes: parsePositiveInteger(
      process.env.BUZZ_MEDIA_MAX_GIF_BYTES,
      DEFAULT_MEDIA_LIMITS.maxGifBytes,
      "BUZZ_MEDIA_MAX_GIF_BYTES",
    ),
    maxImageBytes: parsePositiveInteger(
      process.env.BUZZ_MEDIA_MAX_IMAGE_BYTES,
      DEFAULT_MEDIA_LIMITS.maxImageBytes,
      "BUZZ_MEDIA_MAX_IMAGE_BYTES",
    ),
    maxVideoBytes: parsePositiveInteger(
      process.env.BUZZ_MEDIA_MAX_VIDEO_BYTES,
      DEFAULT_MEDIA_LIMITS.maxVideoBytes,
      "BUZZ_MEDIA_MAX_VIDEO_BYTES",
    ),
    publicBaseUrl:
      process.env.BUZZ_MEDIA_PUBLIC_BASE_URL ??
      process.env.BUZZ_MEDIA_BASE_URL ??
      mediaUrl.toString().replace(/\/$/, ""),
    ...(process.env.BUZZ_MEDIA_UPLOAD_IP_HEADER
      ? {
          uploadIpHeader: process.env.BUZZ_MEDIA_UPLOAD_IP_HEADER.toLowerCase(),
        }
      : {}),
    ...(process.env.BUZZ_MEDIA_UPLOAD_PORT_HEADER
      ? {
          uploadPortHeader:
            process.env.BUZZ_MEDIA_UPLOAD_PORT_HEADER.toLowerCase(),
        }
      : {}),
    uploadRecordsEnabled: parseBoolean(
      process.env.BUZZ_MEDIA_UPLOAD_RECORDS ?? "false",
      "BUZZ_MEDIA_UPLOAD_RECORDS",
    ),
  });
  const bucket = process.env.BUZZ_S3_BUCKET;
  const storage = bucket
    ? new S3MediaStorage(bucket, {
        forcePathStyle: parseBoolean(
          process.env.BUZZ_S3_FORCE_PATH_STYLE ?? "false",
          "BUZZ_S3_FORCE_PATH_STYLE",
        ),
        region: process.env.BUZZ_S3_REGION ?? "us-east-1",
        ...(process.env.BUZZ_S3_ENDPOINT
          ? { endpoint: process.env.BUZZ_S3_ENDPOINT }
          : {}),
        ...staticS3Credentials(),
      })
    : new FileMediaStorage(process.env.BUZZ_MEDIA_ROOT ?? ".buzz/media");
  return {
    communityId,
    config,
    maxConcurrentUploads: parsePositiveInteger(
      process.env.BUZZ_MEDIA_MAX_CONCURRENT_UPLOADS,
      8,
      "BUZZ_MEDIA_MAX_CONCURRENT_UPLOADS",
    ),
    maxConcurrentUploadsPerPubkey: parsePositiveInteger(
      process.env.BUZZ_MEDIA_MAX_CONCURRENT_UPLOADS_PER_PUBKEY,
      2,
      "BUZZ_MEDIA_MAX_CONCURRENT_UPLOADS_PER_PUBKEY",
    ),
    pool,
    requireGetAuth: parseBoolean(
      process.env.BUZZ_REQUIRE_MEDIA_GET_AUTH ?? "false",
      "BUZZ_REQUIRE_MEDIA_GET_AUTH",
    ),
    storage,
    uploadsPerMinute: parsePositiveInteger(
      process.env.BUZZ_MEDIA_UPLOADS_PER_MINUTE,
      20,
      "BUZZ_MEDIA_UPLOADS_PER_MINUTE",
    ),
  };
}

function resolveGit(pool: Pool, communityId: string) {
  const maximumPackBytes = parsePositiveInteger(
    process.env.BUZZ_GIT_MAX_PACK_BYTES,
    500 * 1024 * 1024,
    "BUZZ_GIT_MAX_PACK_BYTES",
  );
  const maximumRepositoryBytes = parsePositiveInteger(
    process.env.BUZZ_GIT_MAX_REPO_BYTES,
    maximumPackBytes * 2,
    "BUZZ_GIT_MAX_REPO_BYTES",
  );
  if (maximumPackBytes > maximumRepositoryBytes) {
    throw new Error(
      "BUZZ_GIT_MAX_PACK_BYTES cannot exceed BUZZ_GIT_MAX_REPO_BYTES",
    );
  }
  const configuredHookSecret = process.env.BUZZ_GIT_HOOK_HMAC_SECRET;
  if (
    configuredHookSecret !== undefined &&
    Buffer.byteLength(configuredHookSecret, "utf8") < 32
  ) {
    throw new Error("BUZZ_GIT_HOOK_HMAC_SECRET must contain at least 32 bytes");
  }
  const bucket = process.env.BUZZ_GIT_S3_BUCKET ?? process.env.BUZZ_S3_BUCKET;
  const store: GitObjectStore = bucket
    ? new S3GitObjectStore(bucket, {
        forcePathStyle: parseBoolean(
          process.env.BUZZ_S3_FORCE_PATH_STYLE ?? "false",
          "BUZZ_S3_FORCE_PATH_STYLE",
        ),
        region:
          process.env.BUZZ_S3_REGION ?? process.env.AWS_REGION ?? "us-east-1",
        ...(process.env.BUZZ_S3_ENDPOINT
          ? { endpoint: process.env.BUZZ_S3_ENDPOINT }
          : {}),
        ...staticS3Credentials(),
      })
    : new FileGitObjectStore(
        process.env.BUZZ_GIT_OBJECT_ROOT ?? ".buzz/git-objects",
      );
  let readiness: Promise<void> | undefined;
  const maxConcurrentOperations = parsePositiveInteger(
    process.env.BUZZ_GIT_MAX_CONCURRENT_OPS,
    20,
    "BUZZ_GIT_MAX_CONCURRENT_OPS",
  );
  return {
    communityId,
    hookSecret: configuredHookSecret
      ? Buffer.from(configuredHookSecret, "utf8")
      : randomBytes(32),
    limits: {
      maxPackBytes: maximumPackBytes,
      maxRepoBytes: maximumRepositoryBytes,
      operationTimeoutMs: parsePositiveInteger(
        process.env.BUZZ_GIT_OPERATION_TIMEOUT_MS,
        300_000,
        "BUZZ_GIT_OPERATION_TIMEOUT_MS",
      ),
      scratchDirectory: process.env.BUZZ_GIT_REPO_PATH ?? ".buzz/git-scratch",
    },
    maxConcurrentOperations,
    maxRepositoriesPerOwner: parsePositiveInteger(
      process.env.BUZZ_GIT_MAX_REPOS_PER_PUBKEY,
      100,
      "BUZZ_GIT_MAX_REPOS_PER_PUBKEY",
    ),
    operationGate: new GitOperationGate(maxConcurrentOperations),
    pool,
    store,
    storeReadiness: () => {
      readiness ??= store.probe();
      return readiness;
    },
  };
}

function gitForTenant(
  git: ReturnType<typeof resolveGit> | undefined,
  communityId: string,
): ReturnType<typeof resolveGit> | undefined {
  return git ? { ...git, communityId } : undefined;
}

function staticS3Credentials():
  | {
      readonly credentials: {
        readonly accessKeyId: string;
        readonly secretAccessKey: string;
      };
    }
  | Record<string, never> {
  const accessKeyId = process.env.BUZZ_S3_ACCESS_KEY;
  const secretAccessKey = process.env.BUZZ_S3_SECRET_KEY;
  if (!accessKeyId && !secretAccessKey) return {};
  if (!accessKeyId || !secretAccessKey) {
    throw new Error(
      "BUZZ_S3_ACCESS_KEY and BUZZ_S3_SECRET_KEY must be configured together",
    );
  }
  return { credentials: { accessKeyId, secretAccessKey } };
}

async function resolveSearch(pool: Pool, community: string) {
  const result = await pool.query<{ readonly id: string }>(
    `SELECT id FROM communities
     WHERE lower(host) = lower($1) AND archived_at IS NULL
     LIMIT 1`,
    [community],
  );
  const communityId = result.rows[0]?.id;
  if (!communityId) {
    throw new Error(`BUZZ_COMMUNITY '${community}' does not exist in Postgres`);
  }
  return { communityId, service: new SearchService(pool) };
}

async function resolveRelaySecretKey(
  pool: Pool,
  community: string,
): Promise<Uint8Array> {
  const configured = process.env.BUZZ_RELAY_PRIVATE_KEY;
  if (configured !== undefined) {
    if (!/^[0-9a-f]{64}$/.test(configured)) {
      throw new Error(
        "BUZZ_RELAY_PRIVATE_KEY must be a 64-character lowercase hex key",
      );
    }
    return Uint8Array.from(Buffer.from(configured, "hex"));
  }
  const existing = await pool.query<{ readonly signing_key: Buffer | null }>(
    `SELECT signing_key FROM communities
     WHERE lower(host) = lower($1) AND archived_at IS NULL
     LIMIT 1`,
    [community],
  );
  const stored = existing.rows[0]?.signing_key;
  if (stored) {
    if (stored.length !== 32) {
      throw new Error("community signing key has an invalid length");
    }
    return Uint8Array.from(stored);
  }
  const generated = generateSecretKey();
  const updated = await pool.query<{ readonly signing_key: Buffer }>(
    `UPDATE communities
     SET signing_key = $2
     WHERE lower(host) = lower($1)
       AND archived_at IS NULL
       AND signing_key IS NULL
     RETURNING signing_key`,
    [community, Buffer.from(generated)],
  );
  const won = updated.rows[0]?.signing_key;
  if (won) return Uint8Array.from(won);
  const raced = await pool.query<{ readonly signing_key: Buffer }>(
    `SELECT signing_key FROM communities
     WHERE lower(host) = lower($1) AND archived_at IS NULL
     LIMIT 1`,
    [community],
  );
  const value = raced.rows[0]?.signing_key;
  if (!value || value.length !== 32) {
    throw new Error("failed to initialize the community signing key");
  }
  return Uint8Array.from(value);
}

function resolveConfiguredRelaySecretKey(): Uint8Array | undefined {
  const configured = process.env.BUZZ_RELAY_PRIVATE_KEY;
  if (configured === undefined) return undefined;
  if (!/^[0-9a-f]{64}$/.test(configured)) {
    throw new Error(
      "BUZZ_RELAY_PRIVATE_KEY must be a 64-character lowercase hex key",
    );
  }
  return Uint8Array.from(Buffer.from(configured, "hex"));
}

async function bootMesh(input: {
  readonly communityId: string;
  readonly demoEcho: boolean;
  readonly relaySecretKey?: Uint8Array;
}) {
  const enabled = parseBoolean(process.env.BUZZ_MESH ?? "false", "BUZZ_MESH");
  if (!enabled) return undefined;
  const redisUrl = relayRedisUrl;
  if (!redisUrl) throw new Error("BUZZ_MESH=true requires BUZZ_REDIS_URL");
  if (!input.relaySecretKey) {
    throw new Error(
      "BUZZ_MESH=true requires BUZZ_RELAY_PRIVATE_KEY or a community signing key in Postgres",
    );
  }
  if (
    input.demoEcho &&
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      input.communityId,
    )
  ) {
    throw new Error(
      "BUZZ_MESH_DEMO_ECHO=true requires a database-backed UUID community",
    );
  }
  const identity = RuntimeIdentity.generate();
  const relayPubkey = Buffer.from(
    schnorr.getPublicKey(input.relaySecretKey),
  ).toString("hex") as RuntimeId;
  const host = process.env.BUZZ_MESH_BIND_HOST ?? "127.0.0.1";
  const port = parseOptionalPort(process.env.BUZZ_MESH_PORT ?? "3478");
  const publicHost = process.env.BUZZ_MESH_PUBLIC_HOST ?? host;
  const tls = resolveMeshTls();
  const allowInsecureLoopback = parseBoolean(
    process.env.BUZZ_MESH_ALLOW_INSECURE_LOOPBACK ?? "false",
    "BUZZ_MESH_ALLOW_INSECURE_LOOPBACK",
  );
  const placeholderScheme = tls ? "wss" : "ws";
  const placeholderHost = publicHost.includes(":")
    ? `[${publicHost}]`
    : publicHost;
  const readyRecord = createReadyRecord({
    identity,
    relaySecretKey: input.relaySecretKey,
    endpointUrls: [
      `${placeholderScheme}://${placeholderHost}:${port}/_mesh/ws`,
    ],
    capabilities: ["reliable-stream", "realtime-media", "huddle-control"],
  });
  const registry = new RedisReadyRegistry(redisUrl);
  const directory = new RedisSessionDirectory(
    redisUrl,
    parsePositiveInteger(
      process.env.BUZZ_MESH_LEASE_TTL_MS,
      30_000,
      "BUZZ_MESH_LEASE_TTL_MS",
    ),
  );
  const dispatcher = new RelayMeshDispatcher(
    directory,
    identity.runtimeId,
    input.demoEcho ? { communityId: input.communityId, echo: true } : undefined,
  );
  const node = new MeshNode({
    identity,
    readyRecord,
    expectedRelayPubkey: relayPubkey,
    registry,
    host,
    port,
    publicHost,
    ...(tls ? { tls } : {}),
    allowInsecureLoopback,
    registryRefreshMs: parsePositiveInteger(
      process.env.BUZZ_MESH_REGISTRY_REFRESH_MS,
      15_000,
      "BUZZ_MESH_REGISTRY_REFRESH_MS",
    ),
    handler: dispatcher,
  });
  const endpoint = await node.start();
  process.stdout.write(
    `Buzz relay mesh ${node.runtimeId.slice(0, 12)} listening on ${endpoint.toString()}\n`,
  );
  return { directory, dispatcher, node, registry };
}

function resolveMeshTls():
  | { readonly cert: Buffer; readonly key: Buffer }
  | undefined {
  const certFile = process.env.BUZZ_MESH_TLS_CERT_FILE;
  const keyFile = process.env.BUZZ_MESH_TLS_KEY_FILE;
  if (!certFile && !keyFile) return undefined;
  if (!certFile || !keyFile) {
    throw new Error(
      "BUZZ_MESH_TLS_CERT_FILE and BUZZ_MESH_TLS_KEY_FILE must be configured together",
    );
  }
  return {
    cert: readFileSync(certFile),
    key: readFileSync(keyFile),
  };
}

function parseOptionalPort(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65_535) {
    throw new Error("BUZZ_MESH_PORT must be an integer between 0 and 65535");
  }
  return parsed;
}
