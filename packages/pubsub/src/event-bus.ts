import { randomUUID } from "node:crypto";

import { createClient, type RedisClientType } from "redis";
import { verifyNostrEvent, type NostrEvent } from "@buzz/core";

export type EventBusListener = (event: NostrEvent) => Promise<void> | void;
export type EventBusUnsubscribe = () => Promise<void> | void;
export type ConnectionControl =
  | { readonly op: "DisconnectCommunity" }
  | {
      readonly event_id: string;
      readonly op: "DisconnectPubkey";
      readonly pubkey: readonly number[];
      readonly reason: string;
    }
  | {
      readonly channel_id: string;
      readonly event_id: string;
      readonly op: "RevokeChannelAccess";
      readonly pubkey: readonly number[];
    }
  | {
      readonly channel_id: string;
      readonly event_id: string;
      readonly mode: "all" | "non_members";
      readonly op: "RevalidateChannelAccess";
    };
export type ConnectionControlListener = (
  command: ConnectionControl,
) => Promise<void> | void;

/** Result of one atomic, fixed-window distributed admission claim. */
export type RateLimitClaim = {
  readonly allowed: boolean;
  readonly current: number;
  readonly limit: number;
  readonly resetInSeconds: number;
};

/** Independent admission counter categories used by the relay. */
export type RateLimitKind = "api" | "msg" | "ws";

export type EventBus = {
  subscribe(
    community: string,
    listener: EventBusListener,
  ): Promise<EventBusUnsubscribe>;
  publish(community: string, event: NostrEvent): Promise<void>;
  subscribeControl(
    communityId: string,
    listener: ConnectionControlListener,
  ): Promise<EventBusUnsubscribe>;
  publishControl(
    communityId: string,
    command: ConnectionControl,
  ): Promise<void>;
  claimNip98Replay(
    scope: string,
    eventId: string,
    ttlSeconds: number,
  ): Promise<boolean>;
  /**
   * Atomically increments a community-and-principal scoped fixed-window
   * counter. Production callers deliberately fail closed when this rejects.
   */
  claimRateLimit(
    scope: string,
    principal: string,
    kind: RateLimitKind,
    windowSeconds: number,
    limit: number,
  ): Promise<RateLimitClaim>;
  setPresence(community: string, pubkey: string, status: string): Promise<void>;
  clearPresence(community: string, pubkey: string): Promise<void>;
  getPresenceBulk(
    community: string,
    pubkeys: readonly string[],
  ): Promise<ReadonlyMap<string, string>>;
  ready(): Promise<void>;
  close(): Promise<void>;
};

export class InMemoryEventBus implements EventBus {
  readonly #listeners = new Map<string, Set<EventBusListener>>();
  readonly #controlListeners = new Map<
    string,
    Set<ConnectionControlListener>
  >();
  readonly #nip98Seen = new Map<string, number>();
  readonly #rateLimits = new Map<
    string,
    { count: number; readonly expiresAt: number }
  >();
  readonly #presence = new Map<
    string,
    { readonly expiresAt: number; readonly status: string }
  >();

  public async subscribe(
    community: string,
    listener: EventBusListener,
  ): Promise<EventBusUnsubscribe> {
    const scoped = this.#listeners.get(community) ?? new Set();
    scoped.add(listener);
    this.#listeners.set(community, scoped);
    return () => {
      scoped.delete(listener);
      if (scoped.size === 0) this.#listeners.delete(community);
    };
  }

  public async publish(community: string, event: NostrEvent): Promise<void> {
    if (!verifyNostrEvent(event)) throw new Error("event bus event is invalid");
    await Promise.all(
      [...(this.#listeners.get(community) ?? [])].map((listener) =>
        listener(event),
      ),
    );
  }

  public async subscribeControl(
    communityId: string,
    listener: ConnectionControlListener,
  ): Promise<EventBusUnsubscribe> {
    const channel = controlChannel(communityId);
    const scoped = this.#controlListeners.get(channel) ?? new Set();
    scoped.add(listener);
    this.#controlListeners.set(channel, scoped);
    return () => {
      scoped.delete(listener);
      if (scoped.size === 0) this.#controlListeners.delete(channel);
    };
  }

  public async publishControl(
    communityId: string,
    command: ConnectionControl,
  ): Promise<void> {
    const validated = validateConnectionControl(command);
    await Promise.all(
      [...(this.#controlListeners.get(controlChannel(communityId)) ?? [])].map(
        (listener) => listener(validated),
      ),
    );
  }

  public async claimNip98Replay(
    scope: string,
    eventId: string,
    ttlSeconds: number,
  ): Promise<boolean> {
    const { key, ttl } = replayClaim(scope, eventId, ttlSeconds);
    const now = Date.now();
    for (const [candidate, expiresAt] of this.#nip98Seen) {
      if (expiresAt <= now) this.#nip98Seen.delete(candidate);
    }
    if (this.#nip98Seen.has(key)) return false;
    if (this.#nip98Seen.size >= 100_000) {
      throw new Error("NIP-98 replay window is full");
    }
    this.#nip98Seen.set(key, now + ttl * 1_000);
    return true;
  }

  public async claimRateLimit(
    scope: string,
    principal: string,
    kind: RateLimitKind,
    windowSeconds: number,
    limit: number,
  ): Promise<RateLimitClaim> {
    const claim = rateLimitClaim(scope, principal, kind, windowSeconds, limit);
    const now = Date.now();
    let counter = this.#rateLimits.get(claim.key);
    if (counter && counter.expiresAt <= now) {
      this.#rateLimits.delete(claim.key);
      counter = undefined;
    }
    if (!counter) {
      if (this.#rateLimits.size >= 100_000) {
        for (const [key, candidate] of this.#rateLimits) {
          if (candidate.expiresAt <= now) this.#rateLimits.delete(key);
        }
      }
      if (this.#rateLimits.size >= 100_000) {
        throw new Error("in-memory admission window is full");
      }
      counter = {
        count: 0,
        expiresAt: now + claim.windowSeconds * 1_000,
      };
      this.#rateLimits.set(claim.key, counter);
    }
    counter.count += 1;
    return {
      allowed: counter.count <= claim.limit,
      current: counter.count,
      limit: claim.limit,
      resetInSeconds: Math.max(1, Math.ceil((counter.expiresAt - now) / 1_000)),
    };
  }

  public async setPresence(
    community: string,
    pubkey: string,
    status: string,
  ): Promise<void> {
    this.#presence.set(presenceKey(community, pubkey), {
      expiresAt: Date.now() + 90_000,
      status: validatePresenceStatus(status),
    });
  }

  public async clearPresence(community: string, pubkey: string): Promise<void> {
    this.#presence.delete(presenceKey(community, pubkey));
  }

  public async getPresenceBulk(
    community: string,
    pubkeys: readonly string[],
  ): Promise<ReadonlyMap<string, string>> {
    const output = new Map<string, string>();
    const now = Date.now();
    for (const pubkey of validatePresencePubkeys(pubkeys)) {
      const key = presenceKey(community, pubkey);
      const value = this.#presence.get(key);
      if (value && value.expiresAt > now) output.set(pubkey, value.status);
      else if (value) this.#presence.delete(key);
    }
    return output;
  }

  public async close(): Promise<void> {
    this.#listeners.clear();
    this.#controlListeners.clear();
    this.#nip98Seen.clear();
    this.#rateLimits.clear();
    this.#presence.clear();
  }

  public async ready(): Promise<void> {}
}

export class RedisEventBus implements EventBus {
  readonly #sourceId = randomUUID();
  readonly #publisher: RedisClientType;
  readonly #subscriber: RedisClientType;
  readonly #listeners = new Map<string, Set<EventBusListener>>();
  readonly #controlListeners = new Map<
    string,
    Set<ConnectionControlListener>
  >();
  #connected = false;
  #connectPromise: Promise<void> | undefined;

  public constructor(redisUrl: string) {
    const url = new URL(redisUrl);
    if (url.protocol !== "redis:" && url.protocol !== "rediss:") {
      throw new TypeError("Redis URL must use redis:// or rediss://");
    }
    this.#publisher = createClient({ url: url.toString() });
    this.#subscriber = this.#publisher.duplicate();
  }

  public async subscribe(
    community: string,
    listener: EventBusListener,
  ): Promise<EventBusUnsubscribe> {
    await this.#connect();
    const channel = channelForCommunity(community);
    let scoped = this.#listeners.get(channel);
    if (!scoped) {
      scoped = new Set();
      this.#listeners.set(channel, scoped);
      await this.#subscriber.subscribe(channel, (encoded) => {
        void this.#receive(channel, encoded).catch(() => undefined);
      });
    }
    scoped.add(listener);
    return async () => {
      const current = this.#listeners.get(channel);
      current?.delete(listener);
      if (current?.size === 0) {
        this.#listeners.delete(channel);
        await this.#subscriber.unsubscribe(channel);
      }
    };
  }

  public async publish(community: string, event: NostrEvent): Promise<void> {
    if (!verifyNostrEvent(event)) throw new Error("event bus event is invalid");
    await this.#connect();
    const encoded = JSON.stringify({
      event,
      source: this.#sourceId,
      version: 1,
    });
    if (Buffer.byteLength(encoded, "utf8") > 300 * 1024) {
      throw new Error("event bus message is too large");
    }
    await this.#publisher.publish(channelForCommunity(community), encoded);
  }

  public async subscribeControl(
    communityId: string,
    listener: ConnectionControlListener,
  ): Promise<EventBusUnsubscribe> {
    await this.#connect();
    const channel = controlChannel(communityId);
    let scoped = this.#controlListeners.get(channel);
    if (!scoped) {
      scoped = new Set();
      this.#controlListeners.set(channel, scoped);
      await this.#subscriber.subscribe(channel, (encoded) => {
        void this.#receiveControl(channel, encoded).catch(() => undefined);
      });
    }
    scoped.add(listener);
    return async () => {
      const current = this.#controlListeners.get(channel);
      current?.delete(listener);
      if (current?.size === 0) {
        this.#controlListeners.delete(channel);
        await this.#subscriber.unsubscribe(channel);
      }
    };
  }

  public async publishControl(
    communityId: string,
    command: ConnectionControl,
  ): Promise<void> {
    const validated = validateConnectionControl(command);
    await this.#connect();
    const encoded = JSON.stringify(validated);
    if (Buffer.byteLength(encoded, "utf8") > 4 * 1024) {
      throw new Error("connection-control message is too large");
    }
    await this.#publisher.publish(controlChannel(communityId), encoded);
  }

  public async claimNip98Replay(
    scope: string,
    eventId: string,
    ttlSeconds: number,
  ): Promise<boolean> {
    const { key, ttl } = replayClaim(scope, eventId, ttlSeconds);
    await this.#connect();
    const response = await this.#publisher.set(key, "1", {
      EX: ttl,
      NX: true,
    });
    return response === "OK";
  }

  public async claimRateLimit(
    scope: string,
    principal: string,
    kind: RateLimitKind,
    windowSeconds: number,
    limit: number,
  ): Promise<RateLimitClaim> {
    const claim = rateLimitClaim(scope, principal, kind, windowSeconds, limit);
    await this.#connect();
    const raw = await this.#publisher.eval(RATE_LIMIT_SCRIPT, {
      arguments: [String(claim.windowSeconds)],
      keys: [claim.key],
    });
    if (!Array.isArray(raw) || raw.length !== 2) {
      throw new Error("Redis returned an invalid admission counter result");
    }
    const current = Number(raw[0]);
    const resetInSeconds = Number(raw[1]);
    if (
      !Number.isSafeInteger(current) ||
      current < 1 ||
      !Number.isSafeInteger(resetInSeconds) ||
      resetInSeconds < 1
    ) {
      throw new Error("Redis returned an invalid admission counter value");
    }
    return {
      allowed: current <= claim.limit,
      current,
      limit: claim.limit,
      resetInSeconds,
    };
  }

  public async setPresence(
    community: string,
    pubkey: string,
    status: string,
  ): Promise<void> {
    await this.#connect();
    await this.#publisher.set(
      presenceKey(community, pubkey),
      validatePresenceStatus(status),
      { EX: 90 },
    );
  }

  public async clearPresence(community: string, pubkey: string): Promise<void> {
    await this.#connect();
    await this.#publisher.del(presenceKey(community, pubkey));
  }

  public async getPresenceBulk(
    community: string,
    pubkeys: readonly string[],
  ): Promise<ReadonlyMap<string, string>> {
    const validated = validatePresencePubkeys(pubkeys);
    if (validated.length === 0) return new Map();
    await this.#connect();
    const statuses = await this.#publisher.mGet(
      validated.map((pubkey) => presenceKey(community, pubkey)),
    );
    const output = new Map<string, string>();
    for (let index = 0; index < validated.length; index += 1) {
      const status = statuses[index];
      if (status !== null && status !== undefined) {
        output.set(validated[index] as string, status);
      }
    }
    return output;
  }

  public async close(): Promise<void> {
    await this.#connectPromise?.catch(() => undefined);
    if (!this.#connected) return;
    this.#listeners.clear();
    this.#controlListeners.clear();
    await Promise.allSettled([this.#subscriber.quit(), this.#publisher.quit()]);
    this.#connected = false;
  }

  public async ready(): Promise<void> {
    await this.#connect();
    const response = await this.#publisher.ping();
    if (response !== "PONG") throw new Error("Redis readiness check failed");
  }

  async #connect(): Promise<void> {
    if (this.#connected) return;
    if (this.#connectPromise) return this.#connectPromise;
    this.#connectPromise = Promise.all([
      this.#publisher.connect(),
      this.#subscriber.connect(),
    ])
      .then(() => {
        this.#connected = true;
      })
      .finally(() => {
        this.#connectPromise = undefined;
      });
    return this.#connectPromise;
  }

  async #receive(channel: string, encoded: string): Promise<void> {
    if (Buffer.byteLength(encoded, "utf8") > 300 * 1024) return;
    let value: unknown;
    try {
      value = JSON.parse(encoded) as unknown;
    } catch {
      return;
    }
    if (
      typeof value !== "object" ||
      value === null ||
      (value as { version?: unknown }).version !== 1 ||
      (value as { source?: unknown }).source === this.#sourceId ||
      !verifyNostrEvent((value as { event?: unknown }).event)
    ) {
      return;
    }
    const event = (value as { event: NostrEvent }).event;
    for (const listener of this.#listeners.get(channel) ?? []) {
      try {
        await listener(event);
      } catch {
        // A consumer failure must not escape Redis' callback or prevent the
        // remaining local consumers from receiving the signed event.
      }
    }
  }

  async #receiveControl(channel: string, encoded: string): Promise<void> {
    if (Buffer.byteLength(encoded, "utf8") > 4 * 1024) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(encoded) as unknown;
    } catch {
      return;
    }
    let command: ConnectionControl;
    try {
      command = validateConnectionControl(parsed);
    } catch {
      return;
    }
    for (const listener of this.#controlListeners.get(channel) ?? []) {
      try {
        await listener(command);
      } catch {
        // One local socket manager cannot block the remaining consumers.
      }
    }
  }
}

function channelForCommunity(community: string): string {
  try {
    return `buzz:events:${normalizedAdmissionScope(community)}`;
  } catch {
    throw new TypeError("community host is invalid");
  }
}

function controlChannel(communityId: string): string {
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      communityId,
    )
  ) {
    throw new TypeError("connection-control community ID must be a UUID");
  }
  return `buzz:${communityId.toLowerCase()}:conn-control`;
}

function presenceKey(community: string, pubkey: string): string {
  const normalizedCommunity = channelForCommunity(community).slice(
    "buzz:events:".length,
  );
  if (!/^[0-9a-f]{64}$/.test(pubkey)) {
    throw new TypeError("presence pubkey must be lowercase hex");
  }
  return `buzz:${normalizedCommunity}:presence:${pubkey}`;
}

function validatePresencePubkeys(pubkeys: readonly string[]): string[] {
  if (pubkeys.length > 1_000) {
    throw new TypeError("presence lookup exceeds 1000 pubkeys");
  }
  const output = [...new Set(pubkeys)];
  for (const pubkey of output) {
    if (!/^[0-9a-f]{64}$/.test(pubkey)) {
      throw new TypeError("presence pubkey must be lowercase hex");
    }
  }
  return output;
}

function validatePresenceStatus(status: string): string {
  if (
    Buffer.byteLength(status, "utf8") < 1 ||
    Buffer.byteLength(status, "utf8") > 128 ||
    /[\u0000-\u001f\u007f]/u.test(status)
  ) {
    throw new TypeError("presence status is invalid");
  }
  return status;
}

function validateConnectionControl(value: unknown): ConnectionControl {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    !("op" in value)
  ) {
    throw new TypeError("connection-control command is invalid");
  }
  const record = value as Record<string, unknown>;
  if (record.op === "DisconnectCommunity" && Object.keys(record).length === 1) {
    return { op: "DisconnectCommunity" };
  }
  if (
    record.op === "RevokeChannelAccess" &&
    !Object.keys(record).some(
      (key) => !["channel_id", "event_id", "op", "pubkey"].includes(key),
    ) &&
    typeof record.channel_id === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      record.channel_id,
    ) &&
    typeof record.event_id === "string" &&
    /^[0-9a-f]{64}$/.test(record.event_id) &&
    Array.isArray(record.pubkey) &&
    record.pubkey.length === 32 &&
    record.pubkey.every(
      (byte) => Number.isInteger(byte) && byte >= 0 && byte <= 255,
    )
  ) {
    return {
      channel_id: record.channel_id.toLowerCase(),
      event_id: record.event_id,
      op: "RevokeChannelAccess",
      pubkey: [...record.pubkey],
    };
  }
  if (
    record.op === "RevalidateChannelAccess" &&
    !Object.keys(record).some(
      (key) => !["channel_id", "event_id", "mode", "op"].includes(key),
    ) &&
    typeof record.channel_id === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      record.channel_id,
    ) &&
    typeof record.event_id === "string" &&
    /^[0-9a-f]{64}$/.test(record.event_id) &&
    (record.mode === "all" || record.mode === "non_members")
  ) {
    return {
      channel_id: record.channel_id.toLowerCase(),
      event_id: record.event_id,
      mode: record.mode,
      op: "RevalidateChannelAccess",
    };
  }
  if (
    record.op !== "DisconnectPubkey" ||
    Object.keys(record).some(
      (key) => !["event_id", "op", "pubkey", "reason"].includes(key),
    ) ||
    typeof record.event_id !== "string" ||
    !/^[0-9a-f]{64}$/.test(record.event_id) ||
    !Array.isArray(record.pubkey) ||
    record.pubkey.length !== 32 ||
    !record.pubkey.every(
      (byte) => Number.isInteger(byte) && byte >= 0 && byte <= 255,
    ) ||
    typeof record.reason !== "string" ||
    Buffer.byteLength(record.reason, "utf8") > 1_024
  ) {
    throw new TypeError("connection-control command is invalid");
  }
  return {
    event_id: record.event_id,
    op: "DisconnectPubkey",
    pubkey: [...record.pubkey],
    reason: record.reason,
  };
}

function replayClaim(
  scope: string,
  eventId: string,
  ttlSeconds: number,
): { readonly key: string; readonly ttl: number } {
  if (
    !/^[a-z0-9-]{1,128}$/.test(scope) ||
    !/^[0-9a-f]{64}$/.test(eventId) ||
    !Number.isSafeInteger(ttlSeconds)
  ) {
    throw new TypeError("NIP-98 replay claim is invalid");
  }
  const ttl = Math.max(120, Math.min(3_600, ttlSeconds));
  return {
    key: `buzz:${scope}:nip98:${eventId}`,
    ttl,
  };
}

const RATE_LIMIT_SCRIPT = `
local count = redis.call('INCR', KEYS[1])
if count == 1 then
  redis.call('EXPIRE', KEYS[1], ARGV[1])
end
local ttl = redis.call('TTL', KEYS[1])
if ttl < 0 then
  redis.call('EXPIRE', KEYS[1], ARGV[1])
  ttl = tonumber(ARGV[1])
end
return {count, ttl}
`;

function rateLimitClaim(
  scope: string,
  principal: string,
  kind: RateLimitKind,
  windowSeconds: number,
  limit: number,
): {
  readonly key: string;
  readonly limit: number;
  readonly windowSeconds: number;
} {
  const normalizedScope = normalizedAdmissionScope(scope);
  if (
    !/^[0-9a-f]{64}$/.test(principal) ||
    !["api", "msg", "ws"].includes(kind) ||
    !Number.isSafeInteger(windowSeconds) ||
    windowSeconds < 1 ||
    windowSeconds > 86_400 ||
    !Number.isSafeInteger(limit) ||
    limit < 1
  ) {
    throw new TypeError("rate-limit claim is invalid");
  }
  return {
    key: `buzz:${normalizedScope}:ratelimit:${principal}:${kind}`,
    limit,
    windowSeconds,
  };
}

function normalizedAdmissionScope(scope: string): string {
  const lowered = scope.toLowerCase();
  if (
    /^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/.test(lowered) &&
    !lowered.includes("..")
  ) {
    return lowered;
  }
  if (
    scope.length < 1 ||
    Buffer.byteLength(scope, "utf8") > 255 ||
    /[/@?#\s]/.test(scope)
  ) {
    throw new TypeError("rate-limit claim is invalid");
  }
  let url: URL;
  try {
    url = new URL(`http://${scope}/`);
  } catch {
    throw new TypeError("rate-limit claim is invalid");
  }
  if (
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    !url.hostname ||
    (url.port !== "" &&
      (!/^[0-9]+$/.test(url.port) ||
        Number(url.port) < 1 ||
        Number(url.port) > 65_535))
  ) {
    throw new TypeError("rate-limit claim is invalid");
  }
  return `authority-${Buffer.from(url.host.toLowerCase(), "utf8").toString(
    "base64url",
  )}`;
}
