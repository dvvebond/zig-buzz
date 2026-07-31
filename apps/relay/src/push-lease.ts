import { createHash } from "node:crypto";

import { KIND_PUSH_LEASE, type NostrEvent, type NostrFilter } from "@buzz/core";
import { nip44 } from "nostr-tools";
import type { Pool, PoolClient } from "pg";

export const PUSH_KINDS = [7, 9, 1059, 40007, 46010] as const;
export const URGENT_PUSH_KINDS = [] as const;
export const PUSH_CLASSES = ["silent", "default", "time_sensitive"] as const;

const MAX_SAFE_JSON_INTEGER = 2 ** 53 - 1;
const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const PUSH_GATE_LOCK_NAMESPACE = "buzz_push_gate:";

/** Supported push delivery priority. */
export type PushClass = (typeof PUSH_CLASSES)[number];

/** Strictly validated NIP-PL subscription. */
export type PushSubscription = {
  /** Positive event filter, narrowed to an author, self p-tag, or channel. */
  readonly filter: NostrFilter;
  /** Highest delivery priority owed by this match. */
  readonly class: PushClass;
  /** Optional subtractive filters. */
  readonly ignore: readonly NostrFilter[];
  /** Optional p-tag fan-out suppression. */
  readonly suppress?: {
    /** Suppress events carrying more than this many p-tags. */
    readonly p_tags_max: number;
  };
};

/** Validated effective fields of one encrypted NIP-PL replacement. */
export type PushLeaseReplacement = {
  /** Whether this replacement activates or revokes the lease. */
  readonly active: boolean;
  /** Monotonic installation generation. */
  readonly generation: number;
  /** Public NIP-40 expiry in Unix seconds. */
  readonly expiresAt: number;
  /** Addressable installation identifier from the d tag. */
  readonly installationId: string;
  /** Active application profile. */
  readonly appProfile?: "buzz-ios-production" | "buzz-ios-sandbox";
  /** Opaque push-gateway endpoint grant. */
  readonly endpointGrant?: string;
  /** Validated subscriptions for an active lease. */
  readonly subscriptions?: readonly PushSubscription[];
};

/** Atomic lease acceptance outcome. */
export type PushLeaseAcceptOutcome =
  | "accepted"
  | "endpoint_already_leased"
  | "lease_quota_exceeded"
  | "source_event_collision"
  | "stale_event"
  | "stale_generation";

/** NIP-PL validation, decryption, and atomic Postgres acceptance. */
export class PushLeaseService {
  public constructor(
    private readonly options: {
      /** Server-resolved tenant id. */
      readonly communityId: string;
      /** Exact tenant host bound before event processing. */
      readonly communityHost: string;
      /** Public relay URL used to pin the plaintext origin scheme. */
      readonly publicUrl: URL;
      /** Current executor key id advertised in NIP-11. */
      readonly executorKeyId: string;
      /** Current tenant relay secret used only for NIP-44 decryption. */
      readonly relaySecretKey: Uint8Array;
      /** Durable database containing events and effective lease state. */
      readonly pool: Pool;
      /** True only when a delivery worker is configured. */
      readonly pushConfigured: boolean;
    },
  ) {
    if (
      options.executorKeyId.length < 1 ||
      Buffer.byteLength(options.executorKeyId, "utf8") > 64
    ) {
      throw new Error("push executor key id must contain 1..64 bytes");
    }
  }

  /** Validate, decrypt, and commit one kind:30350 replacement transaction. */
  public async accept(
    event: NostrEvent,
    now = Math.floor(Date.now() / 1_000),
  ): Promise<PushLeaseAcceptOutcome> {
    if (!this.options.pushConfigured) {
      throw new Error("push is not supported");
    }
    const replacement = parsePushLeaseEvent(
      event,
      now,
      this.options.executorKeyId,
      this.options.relaySecretKey,
      canonicalOrigin(this.options.publicUrl, this.options.communityHost),
    );
    return await persistReplacement(
      this.options.pool,
      this.options.communityId,
      event,
      replacement,
    );
  }
}

/** Strictly validate and decrypt a NIP-PL event without touching storage. */
export function parsePushLeaseEvent(
  event: NostrEvent,
  now: number,
  executorKeyId: string,
  relaySecretKey: Uint8Array,
  expectedOrigin: string,
): PushLeaseReplacement {
  if (event.kind !== KIND_PUSH_LEASE) throw new Error("wrong event kind");
  if (Buffer.byteLength(event.content, "utf8") > 65_536) {
    throw new Error("push lease content is too long");
  }
  const tags = exactPublicTags(event);
  const installationId = tags.get("d");
  const expirationRaw = tags.get("expiration");
  const executor = tags.get("exec");
  if (!installationId || Buffer.byteLength(installationId, "utf8") > 64) {
    throw new Error("push lease has an invalid d tag");
  }
  if (executor !== executorKeyId) {
    throw new Error("push lease names an unknown executor key");
  }
  if (!expirationRaw || !/^-?[0-9]+$/.test(expirationRaw)) {
    throw new Error("push lease expiration must be integer Unix seconds");
  }
  const expiresAt = Number(expirationRaw);
  if (
    !Number.isSafeInteger(expiresAt) ||
    expiresAt <= now - 120 ||
    expiresAt > now + 30 * 24 * 60 * 60
  ) {
    throw new Error("push lease expiration is outside the accepted lifetime");
  }
  let plaintext: string;
  try {
    const conversationKey = nip44.v2.utils.getConversationKey(
      relaySecretKey,
      event.pubkey,
    );
    plaintext = nip44.v2.decrypt(event.content, conversationKey);
  } catch {
    throw new Error("push lease encrypted content is invalid");
  }
  if (Buffer.byteLength(plaintext, "utf8") > 32_768) {
    throw new Error("push lease plaintext is too long");
  }
  const parsed = strictJson(plaintext);
  const object = exactObject(parsed, "push lease plaintext");
  const active = exactBoolean(object.active, "active");
  const expectedKeys = active
    ? [
        "active",
        "app_profile",
        "endpoint",
        "generation",
        "origin",
        "subscriptions",
        "transport",
        "v",
      ]
    : ["active", "generation", "origin", "v"];
  requireExactKeys(object, expectedKeys, "push lease plaintext");
  if (object.v !== 1) throw new Error("unsupported push lease version");
  if (object.origin !== expectedOrigin) {
    throw new Error("push lease origin does not match this tenant");
  }
  boundedString(object.origin, 512, "origin");
  const generation = positiveSafeInteger(object.generation, "generation");
  if (!active) {
    return { active, expiresAt, generation, installationId };
  }
  const appProfile = object.app_profile;
  if (
    appProfile !== "buzz-ios-production" &&
    appProfile !== "buzz-ios-sandbox"
  ) {
    throw new Error("push app profile is not supported");
  }
  if (object.transport !== "apns") {
    throw new Error("push transport does not match the app profile");
  }
  const endpointGrant = boundedString(object.endpoint, 4_096, "endpoint");
  if (!Array.isArray(object.subscriptions)) {
    throw new Error("push subscriptions must be an array");
  }
  if (object.subscriptions.length < 1 || object.subscriptions.length > 16) {
    throw new Error("push subscription quota exceeded");
  }
  const subscriptions = object.subscriptions.map((value) =>
    parseSubscription(value, event.pubkey),
  );
  return {
    active,
    appProfile,
    endpointGrant,
    expiresAt,
    generation,
    installationId,
    subscriptions,
  };
}

function exactPublicTags(event: NostrEvent): Map<string, string> {
  const allowed = new Set(["d", "expiration", "exec", "alt"]);
  const tags = new Map<string, string>();
  for (const tag of event.tags) {
    if (tag.length !== 2 || !tag[0] || tag[1] === undefined) {
      throw new Error("push lease public tags must have exactly one value");
    }
    if (!allowed.has(tag[0])) {
      throw new Error(`unexpected push lease public tag: ${tag[0]}`);
    }
    if (tags.has(tag[0])) {
      throw new Error(`duplicate push lease public tag: ${tag[0]}`);
    }
    tags.set(tag[0], tag[1]);
  }
  for (const required of ["d", "expiration", "exec"]) {
    if (!tags.has(required)) {
      throw new Error(`push lease is missing its ${required} tag`);
    }
  }
  return tags;
}

function parseSubscription(value: unknown, author: string): PushSubscription {
  const object = exactObject(value, "push subscription");
  requireAllowedKeys(
    object,
    ["class", "filter", "ignore", "suppress"],
    "push subscription",
  );
  if (!("filter" in object) || !("class" in object)) {
    throw new Error("push subscription is missing filter or class");
  }
  if (
    object.class !== "silent" &&
    object.class !== "default" &&
    object.class !== "time_sensitive"
  ) {
    throw new Error("push class is not supported");
  }
  const filter = parseLeaseFilter(object.filter, author, true);
  const rawIgnore = object.ignore ?? [];
  if (!Array.isArray(rawIgnore) || rawIgnore.length > 8) {
    throw new Error("push ignore quota exceeded");
  }
  const ignore = rawIgnore.map((candidate) =>
    parseLeaseFilter(candidate, author, false),
  );
  let suppress: PushSubscription["suppress"];
  if (object.suppress !== undefined && object.suppress !== null) {
    const raw = exactObject(object.suppress, "push suppression");
    requireExactKeys(raw, ["p_tags_max"], "push suppression");
    suppress = {
      p_tags_max: positiveSafeInteger(raw.p_tags_max, "p_tags_max"),
    };
  }
  return {
    class: object.class,
    filter,
    ignore,
    ...(suppress ? { suppress } : {}),
  };
}

function parseLeaseFilter(
  value: unknown,
  leaseAuthor: string,
  requireNarrowing: boolean,
): NostrFilter {
  const object = exactObject(value, "push filter");
  requireAllowedKeys(
    object,
    ["#e", "#h", "#p", "authors", "kinds"],
    "push filter",
  );
  const kinds = integerArray(object.kinds, 16, "kinds");
  if (kinds.some((kind) => !PUSH_KINDS.includes(kind as never))) {
    throw new Error("push filter kind is not push-eligible");
  }
  const authors = optionalHexArray(object.authors, 20, "authors");
  const p = optionalHexArray(object["#p"], 20, "#p");
  const e = optionalHexArray(object["#e"], 20, "#e");
  const h = optionalStringArray(object["#h"], 50, "#h");
  if (p?.some((pubkey) => pubkey !== leaseAuthor)) {
    throw new Error("push filter p-tag must name the lease author");
  }
  if (h?.some((channelId) => !UUID_V4.test(channelId))) {
    throw new Error("push filter h-tag must be a lowercase UUID v4");
  }
  if (
    requireNarrowing &&
    authors === undefined &&
    p === undefined &&
    h === undefined
  ) {
    throw new Error("push filter must be narrowed");
  }
  return {
    kinds,
    ...(authors ? { authors } : {}),
    ...(p ? { "#p": p } : {}),
    ...(e ? { "#e": e } : {}),
    ...(h ? { "#h": h } : {}),
  };
}

async function persistReplacement(
  pool: Pool,
  communityId: string,
  event: NostrEvent,
  replacement: PushLeaseReplacement,
): Promise<PushLeaseAcceptOutcome> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await advisoryLock(
      client,
      Buffer.concat([
        Buffer.from(communityId),
        Buffer.from(event.pubkey, "hex"),
        Buffer.from(replacement.installationId),
      ]),
    );
    await advisoryLock(
      client,
      Buffer.concat([
        Buffer.from(communityId),
        Buffer.from(event.pubkey, "hex"),
      ]),
    );
    if (replacement.active) {
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
        [`${PUSH_GATE_LOCK_NAMESPACE}${communityId}`],
      );
    }
    const collision = await client.query<{
      readonly author: Buffer;
      readonly installation_id: string;
    }>(
      `SELECT author, installation_id
       FROM push_leases
       WHERE community_id = $1::uuid AND source_event_id = decode($2, 'hex')
       FOR UPDATE`,
      [communityId, event.id],
    );
    const bound = collision.rows[0];
    if (bound) {
      await client.query("ROLLBACK");
      return bound.author.toString("hex") === event.pubkey &&
        bound.installation_id === replacement.installationId
        ? "stale_event"
        : "source_event_collision";
    }
    const currentResult = await client.query<{
      readonly generation: string | number;
      readonly source_created_at: string | number;
      readonly source_event_id: string;
    }>(
      `SELECT generation, source_created_at,
              encode(source_event_id, 'hex') AS source_event_id
       FROM push_leases
       WHERE community_id = $1::uuid
         AND author = decode($2, 'hex')
         AND installation_id = $3
       FOR UPDATE`,
      [communityId, event.pubkey, replacement.installationId],
    );
    const current = currentResult.rows[0];
    if (current) {
      const currentCreatedAt = Number(current.source_created_at);
      const eventWins =
        event.created_at > currentCreatedAt ||
        (event.created_at === currentCreatedAt &&
          event.id < current.source_event_id);
      if (!eventWins) {
        await client.query("ROLLBACK");
        return "stale_event";
      }
      if (replacement.generation <= Number(current.generation)) {
        await client.query("ROLLBACK");
        return "stale_generation";
      }
    }
    await client.query(
      `UPDATE push_leases
       SET active = false, endpoint_enabled = false, updated_at = now()
       WHERE community_id = $1::uuid
         AND author = decode($2, 'hex')
         AND active
         AND expires_at <= EXTRACT(EPOCH FROM now())::bigint`,
      [communityId, event.pubkey],
    );
    let endpointHash: string | null = null;
    let maxClass: PushClass | null = null;
    if (replacement.active) {
      const quota = await client.query<{ readonly count: string }>(
        `SELECT count(*)::text AS count
         FROM push_leases
         WHERE community_id = $1::uuid
           AND author = decode($2, 'hex')
           AND active
           AND installation_id <> $3`,
        [communityId, event.pubkey, replacement.installationId],
      );
      if (Number(quota.rows[0]?.count ?? "0") >= 16) {
        await client.query("ROLLBACK");
        return "lease_quota_exceeded";
      }
      endpointHash = createHash("sha256")
        .update(replacement.endpointGrant as string)
        .digest("hex");
      const duplicate = await client.query<{ readonly duplicate: boolean }>(
        `SELECT EXISTS(
           SELECT 1
           FROM push_leases
           WHERE community_id = $1::uuid
             AND author = decode($2, 'hex')
             AND installation_id <> $3
             AND active
             AND app_profile = $4
             AND endpoint_hash = decode($5, 'hex')
         ) AS duplicate`,
        [
          communityId,
          event.pubkey,
          replacement.installationId,
          replacement.appProfile,
          endpointHash,
        ],
      );
      if (duplicate.rows[0]?.duplicate) {
        await client.query("ROLLBACK");
        return "endpoint_already_leased";
      }
      maxClass = [...(replacement.subscriptions ?? [])]
        .map((subscription) => subscription.class)
        .sort(
          (left, right) => classRank(right) - classRank(left),
        )[0] as PushClass;
    }
    await client.query(
      `UPDATE events
       SET deleted_at = now()
       WHERE community_id = $1::uuid
         AND kind = $2
         AND pubkey = decode($3, 'hex')
         AND d_tag = $4
         AND deleted_at IS NULL`,
      [communityId, KIND_PUSH_LEASE, event.pubkey, replacement.installationId],
    );
    await client.query(
      `INSERT INTO events (
         community_id, id, pubkey, created_at, kind, tags, content, sig,
         received_at, channel_id, d_tag
       )
       VALUES (
         $1::uuid, decode($2, 'hex'), decode($3, 'hex'), to_timestamp($4),
         $5, $6::jsonb, $7, decode($8, 'hex'), now(), NULL, $9
       )`,
      [
        communityId,
        event.id,
        event.pubkey,
        event.created_at,
        event.kind,
        JSON.stringify(event.tags),
        event.content,
        event.sig,
        replacement.installationId,
      ],
    );
    await client.query(
      `INSERT INTO push_leases (
         community_id, author, installation_id, source_event_id,
         source_created_at, generation, active, endpoint_enabled, app_profile,
         endpoint_hash, endpoint_grant, max_class, subscriptions, expires_at
       )
       VALUES (
         $1::uuid, decode($2, 'hex'), $3, decode($4, 'hex'), $5, $6, $7,
         true, $8,
         CASE WHEN $9::text IS NULL THEN NULL ELSE decode($9, 'hex') END,
         $10, $11, $12::jsonb, $13
       )
       ON CONFLICT (community_id, author, installation_id) DO UPDATE SET
         source_event_id = EXCLUDED.source_event_id,
         source_created_at = EXCLUDED.source_created_at,
         generation = EXCLUDED.generation,
         active = EXCLUDED.active,
         endpoint_enabled = true,
         app_profile = EXCLUDED.app_profile,
         endpoint_hash = EXCLUDED.endpoint_hash,
         endpoint_grant = EXCLUDED.endpoint_grant,
         max_class = EXCLUDED.max_class,
         subscriptions = EXCLUDED.subscriptions,
         expires_at = EXCLUDED.expires_at,
         updated_at = now()`,
      [
        communityId,
        event.pubkey,
        replacement.installationId,
        event.id,
        event.created_at,
        replacement.generation,
        replacement.active,
        replacement.appProfile ?? null,
        endpointHash,
        replacement.endpointGrant ?? null,
        maxClass,
        replacement.subscriptions
          ? JSON.stringify(replacement.subscriptions)
          : null,
        replacement.expiresAt,
      ],
    );
    if (replacement.active) {
      await client.query(
        `INSERT INTO push_match_queue (community_id, event_id)
         SELECT community_id, id
         FROM events
         WHERE community_id = $1::uuid
           AND kind = ANY($2::integer[])
           AND deleted_at IS NULL
           AND received_at > now() - interval '120 seconds'
         ON CONFLICT DO NOTHING`,
        [communityId, [...PUSH_KINDS]],
      );
    }
    await client.query("COMMIT");
    return "accepted";
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    const constraint =
      error && typeof error === "object" && "constraint" in error
        ? String(error.constraint)
        : "";
    if (constraint === "push_leases_endpoint_unique") {
      return "endpoint_already_leased";
    }
    if (constraint.includes("source_event_id")) {
      return "source_event_collision";
    }
    throw error;
  } finally {
    client.release();
  }
}

async function advisoryLock(
  client: PoolClient,
  value: Uint8Array,
): Promise<void> {
  const key = createHash("sha256").update(value).digest().readBigInt64LE(0);
  await client.query("SELECT pg_advisory_xact_lock($1::bigint)", [
    key.toString(),
  ]);
}

function canonicalOrigin(publicUrl: URL, communityHost: string): string {
  if (publicUrl.protocol !== "ws:" && publicUrl.protocol !== "wss:") {
    throw new Error("push relay URL must use ws or wss");
  }
  return `${publicUrl.protocol}//${communityHost}`;
}

function classRank(value: PushClass): number {
  return PUSH_CLASSES.indexOf(value);
}

function exactObject(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requireExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  label: string,
): void {
  const actual = Object.keys(value).sort();
  const required = [...expected].sort();
  if (
    actual.length !== required.length ||
    actual.some((key, index) => key !== required[index])
  ) {
    throw new Error(`${label} has missing or unknown fields`);
  }
}

function requireAllowedKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  label: string,
): void {
  const accepted = new Set(allowed);
  const invalid = Object.keys(value).find((key) => !accepted.has(key));
  if (invalid) throw new Error(`${label} field is not permitted: ${invalid}`);
}

function boundedString(
  value: unknown,
  maximumBytes: number,
  label: string,
): string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    Buffer.byteLength(value, "utf8") > maximumBytes
  ) {
    throw new Error(`${label} has an invalid string length`);
  }
  return value;
}

function exactBoolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${label} must be boolean`);
  return value;
}

function positiveSafeInteger(value: unknown, label: string): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > MAX_SAFE_JSON_INTEGER
  ) {
    throw new Error(`${label} must be a positive safe integer`);
  }
  return value;
}

function integerArray(
  value: unknown,
  maximum: number,
  label: string,
): number[] {
  if (
    !Array.isArray(value) ||
    value.length < 1 ||
    value.length > maximum ||
    value.some((entry) => !Number.isSafeInteger(entry) || entry < 0)
  ) {
    throw new Error(`${label} must be a bounded integer array`);
  }
  return value as number[];
}

function optionalHexArray(
  value: unknown,
  maximum: number,
  label: string,
): string[] | undefined {
  const result = optionalStringArray(value, maximum, label);
  if (result?.some((entry) => !HEX64.test(entry))) {
    throw new Error(`${label} must contain exact lowercase public keys`);
  }
  return result;
}

function optionalStringArray(
  value: unknown,
  maximum: number,
  label: string,
): string[] | undefined {
  if (value === undefined) return undefined;
  if (
    !Array.isArray(value) ||
    value.length < 1 ||
    value.length > maximum ||
    value.some(
      (entry) =>
        typeof entry !== "string" ||
        entry.length < 1 ||
        Buffer.byteLength(entry, "utf8") > 512,
    )
  ) {
    throw new Error(`${label} must be a bounded string array`);
  }
  return value as string[];
}

function strictJson(value: string): unknown {
  let position = 0;
  const whitespace = (): void => {
    while (/\s/.test(value[position] ?? "")) position += 1;
  };
  const parseValue = (): unknown => {
    whitespace();
    const character = value[position];
    if (character === "{") return parseObject();
    if (character === "[") return parseArray();
    if (character === '"') return parseString();
    for (const [literal, output] of [
      ["true", true],
      ["false", false],
      ["null", null],
    ] as const) {
      if (value.startsWith(literal, position)) {
        position += literal.length;
        return output;
      }
    }
    const match = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(
      value.slice(position),
    );
    if (!match) throw new Error("invalid JSON value");
    position += match[0].length;
    const parsed = Number(match[0]);
    if (!Number.isFinite(parsed)) throw new Error("invalid JSON number");
    return parsed;
  };
  const parseObject = (): Record<string, unknown> => {
    position += 1;
    whitespace();
    const output: Record<string, unknown> = {};
    const keys = new Set<string>();
    if (value[position] === "}") {
      position += 1;
      return output;
    }
    for (;;) {
      whitespace();
      if (value[position] !== '"') throw new Error("invalid JSON object key");
      const key = parseString();
      if (keys.has(key)) throw new Error(`duplicate JSON object key: ${key}`);
      keys.add(key);
      whitespace();
      if (value[position] !== ":") throw new Error("invalid JSON object");
      position += 1;
      output[key] = parseValue();
      whitespace();
      if (value[position] === "}") {
        position += 1;
        return output;
      }
      if (value[position] !== ",") throw new Error("invalid JSON object");
      position += 1;
    }
  };
  const parseArray = (): unknown[] => {
    position += 1;
    whitespace();
    const output: unknown[] = [];
    if (value[position] === "]") {
      position += 1;
      return output;
    }
    for (;;) {
      output.push(parseValue());
      whitespace();
      if (value[position] === "]") {
        position += 1;
        return output;
      }
      if (value[position] !== ",") throw new Error("invalid JSON array");
      position += 1;
    }
  };
  const parseString = (): string => {
    const start = position;
    position += 1;
    let escaped = false;
    while (position < value.length) {
      const code = value.charCodeAt(position);
      if (!escaped && code === 0x22) {
        position += 1;
        return JSON.parse(value.slice(start, position)) as string;
      }
      if (!escaped && code === 0x5c) escaped = true;
      else escaped = false;
      position += 1;
    }
    throw new Error("unterminated JSON string");
  };
  const output = parseValue();
  whitespace();
  if (position !== value.length) throw new Error("trailing JSON data");
  return output;
}
