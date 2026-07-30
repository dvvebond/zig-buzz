import {
  KIND_MEMBER_ADDED_NOTIFICATION,
  KIND_MEMBER_REMOVED_NOTIFICATION,
  KIND_NIP29_GROUP_MEMBERS,
  KIND_PRESENCE_UPDATE,
  KIND_STREAM_MESSAGE,
  KIND_STREAM_MESSAGE_V2,
  KIND_TYPING_INDICATOR,
  publicKeyFromSecret,
  signNostrEvent,
  unixNow,
  type NostrEvent,
} from "@buzz/core";
import {
  AuthenticatedRelayClient,
  type RelayClientEvent,
  type RelaySocket,
  type RelaySubscription,
} from "@buzz/ws-client";
import { isAbsolute, parse as parsePath } from "node:path";

import {
  AcpProcessClient,
  type AcpProcessClientOptions,
} from "./process-client.js";
import { DEFAULT_BASE_PROMPT } from "./base-prompt.js";

const HEX_PUBKEY = /^[0-9a-f]{64}$/;
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_SEEN_EVENTS = 12_000;
const MAX_CHANNEL_SESSIONS = 256;
// The relay permits 100 concurrent subscriptions. Keep room for membership
// discovery/control subscriptions and future protocol extensions.
const MAX_CHANNEL_SUBSCRIPTIONS = 256;
const MAX_QUEUED_EVENTS = 2_000;
const MAX_AGENT_REPLY_BYTES = 1024 * 1024;
const MEMBERSHIP_SUBSCRIPTION_ID = "buzz-acp-membership";
const DISCOVERY_SUBSCRIPTION_ID = "buzz-acp-channel-discovery";

export type RespondTo = "owner-only" | "allowlist" | "anyone" | "nobody";

export type AcpHarnessOptions = {
  readonly relayUrl: string;
  readonly secretKey: Uint8Array;
  readonly ownerPubkey?: string;
  readonly authTag?: readonly [string, string, string, string];
  readonly respondTo?: RespondTo;
  readonly respondToAllowlist?: readonly string[];
  readonly agent: AcpProcessClientOptions;
  /** Undefined uses Buzz's standard collaboration prompt; null disables it. */
  readonly basePrompt?: string | null;
  readonly systemPrompt?: string;
  readonly sessionTitle?: string;
  /**
   * Exact channel UUIDs to subscribe to immediately on every connection.
   * Current memberships are also discovered automatically from NIP-29
   * membership snapshots and maintained by relay membership notifications.
   */
  readonly initialChannelIds?: readonly string[];
  readonly parallelism?: number;
  readonly presenceEnabled?: boolean;
  readonly typingEnabled?: boolean;
  /**
   * Publish ACP agent_message_chunk text as a signed Buzz reply after a turn.
   * Enable this for agents such as buzz-agent-ts that do not publish through
   * their own Buzz MCP tool. It is off by default to avoid duplicate replies
   * from existing third-party adapters.
   */
  readonly publishAgentText?: boolean;
  readonly allowInsecureLocalhost?: boolean;
  readonly socketFactory?: (url: string) => RelaySocket;
};

export type AcpHarnessEvent =
  | { readonly type: "ready" | "stopped" }
  | { readonly type: "relay"; readonly event: RelayClientEvent }
  | {
      readonly type: "turn-started" | "turn-completed";
      readonly channelId: string;
      readonly eventId: string;
    }
  | { readonly type: "error"; readonly error: Error };

export class AcpHarness {
  readonly #options: ValidatedHarnessOptions;
  readonly #agent: AcpProcessClient;
  readonly #relay: AuthenticatedRelayClient;
  readonly #listeners = new Set<(event: AcpHarnessEvent) => void>();
  readonly #sessions = new Map<string, string>();
  readonly #queues = new Map<string, NostrEvent[]>();
  readonly #processingChannels = new Set<string>();
  readonly #seen = new Map<string, undefined>();
  readonly #activeSessions = new Set<string>();
  readonly #channelSubscriptions = new Map<string, RelaySubscription>();
  readonly #turnText = new Map<string, { text: string; truncated: boolean }>();
  readonly #parallelism: Semaphore;
  #membershipSubscription: RelaySubscription | undefined;
  #discoverySubscription: RelaySubscription | undefined;
  #reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  #relayConnectPromise: Promise<void> | undefined;
  #reconnectAttempt = 0;
  #started = false;
  #stopping = false;

  public constructor(options: AcpHarnessOptions) {
    this.#options = validateHarnessOptions(options);
    this.#agent = new AcpProcessClient(this.#options.agent);
    this.#relay = new AuthenticatedRelayClient({
      allowInsecureLocalhost: this.#options.allowInsecureLocalhost,
      ...(this.#options.authTag ? { authTag: this.#options.authTag } : {}),
      relayUrl: this.#options.relayUrl,
      secretKey: this.#options.secretKey,
      ...(this.#options.socketFactory
        ? { socketFactory: this.#options.socketFactory }
        : {}),
    });
    this.#parallelism = new Semaphore(this.#options.parallelism);
    this.#relay.on((event) => this.#handleRelayEvent(event));
    this.#agent.on((event) => {
      if (event.type !== "update" || !this.#options.publishAgentText) return;
      const { sessionId, update } = event.notification;
      if (
        !this.#activeSessions.has(sessionId) ||
        update.sessionUpdate !== "agent_message_chunk" ||
        update.content.type !== "text"
      ) {
        return;
      }
      this.#appendTurnText(sessionId, update.content.text);
    });
  }

  public on(listener: (event: AcpHarnessEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  public async start(): Promise<void> {
    if (this.#started) throw new Error("ACP harness is already started");
    this.#started = true;
    try {
      await this.#agent.start();
      await this.#connectRelay();
      this.#emit({ type: "ready" });
    } catch (error) {
      this.#started = false;
      await this.#agent.shutdown();
      this.#relay.close();
      throw error;
    }
  }

  public async stop(): Promise<void> {
    if (this.#stopping) return;
    this.#stopping = true;
    try {
      if (this.#reconnectTimer) clearTimeout(this.#reconnectTimer);
      this.#reconnectTimer = undefined;
      for (const sessionId of this.#activeSessions) {
        await this.#agent.cancel(sessionId).catch(() => undefined);
      }
      if (this.#relay.connected && this.#options.presenceEnabled) {
        await this.#publishPresence("offline").catch(() => undefined);
      }
      this.#closeRelaySubscriptions();
      this.#relay.close();
      await this.#agent.shutdown();
      this.#started = false;
      this.#emit({ type: "stopped" });
    } finally {
      this.#stopping = false;
    }
  }

  #handleRelayEvent(event: RelayClientEvent): void {
    this.#emit({ event, type: "relay" });
    if (event.type === "event") {
      if (event.subscriptionId === MEMBERSHIP_SUBSCRIPTION_ID) {
        this.#acceptMembershipNotification(event.event);
      } else if (event.subscriptionId === DISCOVERY_SUBSCRIPTION_ID) {
        this.#acceptMembershipSnapshot(event.event);
      } else if (
        this.#channelSubscriptions.get(exactTag(event.event, "h") ?? "")?.id ===
        event.subscriptionId
      ) {
        this.#acceptEvent(event.event);
      }
    }
    if (
      event.type === "eose" &&
      event.subscriptionId === DISCOVERY_SUBSCRIPTION_ID
    ) {
      this.#discoverySubscription?.close();
      this.#discoverySubscription = undefined;
    }
    if (event.type === "disconnected" && this.#started && !this.#stopping) {
      this.#forgetRelaySubscriptions();
      this.#scheduleReconnect();
    }
    if (event.type === "error")
      this.#emit({ error: event.error, type: "error" });
  }

  #acceptMembershipSnapshot(event: NostrEvent): void {
    if (
      event.kind !== KIND_NIP29_GROUP_MEMBERS ||
      !hasTag(event, "p", this.#options.agentPubkey)
    ) {
      return;
    }
    const channelId = exactTag(event, "d");
    if (channelId && UUID.test(channelId)) this.#watchChannel(channelId);
  }

  #acceptMembershipNotification(event: NostrEvent): void {
    if (
      !hasExactTag(event, "p", this.#options.agentPubkey) ||
      (event.kind !== KIND_MEMBER_ADDED_NOTIFICATION &&
        event.kind !== KIND_MEMBER_REMOVED_NOTIFICATION)
    ) {
      return;
    }
    const channelId = exactTag(event, "h");
    if (!channelId || !UUID.test(channelId)) return;
    if (event.kind === KIND_MEMBER_ADDED_NOTIFICATION) {
      this.#watchChannel(channelId);
    } else {
      this.#unwatchChannel(channelId);
    }
  }

  #acceptEvent(event: NostrEvent): void {
    if (
      this.#stopping ||
      event.pubkey === this.#options.agentPubkey ||
      !this.#isAllowedAuthor(event.pubkey) ||
      !hasExactTag(event, "p", this.#options.agentPubkey) ||
      !this.#remember(event.id)
    ) {
      return;
    }
    const channelId = exactTag(event, "h");
    if (!channelId || !UUID.test(channelId)) return;
    if (
      event.kind === KIND_STREAM_MESSAGE &&
      event.pubkey === this.#options.ownerPubkey &&
      event.content.trim() === "!shutdown"
    ) {
      void this.stop();
      return;
    }
    if (
      event.kind === KIND_STREAM_MESSAGE &&
      event.pubkey === this.#options.ownerPubkey &&
      event.content.trim() === "!cancel"
    ) {
      const sessionId = this.#sessions.get(channelId);
      if (sessionId && this.#activeSessions.has(sessionId)) {
        void this.#agent.cancel(sessionId).catch((error: unknown) => {
          this.#emit({
            error:
              error instanceof Error ? error : new Error("ACP cancel failed"),
            type: "error",
          });
        });
      }
      return;
    }
    const queue = this.#queues.get(channelId) ?? [];
    if (queue.length >= MAX_QUEUED_EVENTS) {
      this.#emit({
        error: new Error("ACP harness event queue is full"),
        type: "error",
      });
      return;
    }
    queue.push(event);
    this.#queues.set(channelId, queue);
    if (!this.#processingChannels.has(channelId)) {
      void this.#drainChannel(channelId);
    }
  }

  async #drainChannel(channelId: string): Promise<void> {
    this.#processingChannels.add(channelId);
    try {
      for (;;) {
        const event = this.#queues.get(channelId)?.shift();
        if (!event || this.#stopping) return;
        const release = await this.#parallelism.acquire();
        try {
          await this.#runTurn(channelId, event);
        } catch (error) {
          this.#emit({
            error:
              error instanceof Error ? error : new Error("ACP turn failed"),
            type: "error",
          });
        } finally {
          release();
        }
      }
    } finally {
      this.#processingChannels.delete(channelId);
      if (this.#queues.get(channelId)?.length === 0) {
        this.#queues.delete(channelId);
      }
    }
  }

  async #runTurn(channelId: string, event: NostrEvent): Promise<void> {
    const sessionId = await this.#sessionFor(channelId);
    this.#activeSessions.add(sessionId);
    this.#emit({ channelId, eventId: event.id, type: "turn-started" });
    if (this.#options.typingEnabled) {
      await this.#publishTyping(channelId, event).catch(() => undefined);
    }
    try {
      if (this.#options.publishAgentText) {
        this.#turnText.set(sessionId, { text: "", truncated: false });
      }
      await this.#agent.prompt(sessionId, renderPrompt(event, channelId));
      if (this.#options.publishAgentText) {
        await this.#publishAgentReply(channelId, event, sessionId);
      }
    } finally {
      this.#turnText.delete(sessionId);
      this.#activeSessions.delete(sessionId);
      this.#emit({ channelId, eventId: event.id, type: "turn-completed" });
    }
  }

  async #sessionFor(channelId: string): Promise<string> {
    const existing = this.#sessions.get(channelId);
    if (existing) return existing;
    if (this.#sessions.size >= MAX_CHANNEL_SESSIONS) {
      throw new Error("ACP harness channel session limit reached");
    }
    const response = await this.#agent.newSession({
      sessionTitle: composeSessionTitle(this.#options.sessionTitle, channelId),
      ...(this.#options.systemPrompt
        ? { systemPrompt: this.#options.systemPrompt }
        : {}),
    });
    this.#sessions.set(channelId, response.sessionId);
    return response.sessionId;
  }

  #isAllowedAuthor(pubkey: string): boolean {
    switch (this.#options.respondTo) {
      case "anyone":
        return true;
      case "nobody":
        return false;
      case "owner-only":
        return pubkey === this.#options.ownerPubkey;
      case "allowlist":
        return (
          pubkey === this.#options.ownerPubkey ||
          this.#options.respondToAllowlist.has(pubkey)
        );
    }
  }

  #remember(eventId: string): boolean {
    if (this.#seen.has(eventId)) return false;
    this.#seen.set(eventId, undefined);
    if (this.#seen.size > MAX_SEEN_EVENTS) {
      const oldest = this.#seen.keys().next().value as string | undefined;
      if (oldest) this.#seen.delete(oldest);
    }
    return true;
  }

  async #publishPresence(status: "online" | "offline"): Promise<void> {
    const event = signNostrEvent(
      {
        content: status,
        created_at: unixNow(),
        kind: KIND_PRESENCE_UPDATE,
        tags: [],
      },
      this.#options.secretKey,
    );
    await this.#relay.publish(event);
  }

  #connectRelay(): Promise<void> {
    if (this.#relayConnectPromise) return this.#relayConnectPromise;
    this.#relayConnectPromise = (async () => {
      await this.#relay.connect();
      if (this.#stopping || !this.#started) {
        this.#relay.close();
        return;
      }
      this.#closeRelaySubscriptions();
      this.#membershipSubscription = this.#relay.subscribe(
        [
          {
            "#p": [this.#options.agentPubkey],
            kinds: [
              KIND_MEMBER_ADDED_NOTIFICATION,
              KIND_MEMBER_REMOVED_NOTIFICATION,
            ],
          },
        ],
        MEMBERSHIP_SUBSCRIPTION_ID,
      );
      this.#discoverySubscription = this.#relay.subscribe(
        [
          {
            "#p": [this.#options.agentPubkey],
            kinds: [KIND_NIP29_GROUP_MEMBERS],
          },
        ],
        DISCOVERY_SUBSCRIPTION_ID,
      );
      for (const channelId of this.#options.initialChannelIds) {
        this.#watchChannel(channelId);
      }
      this.#reconnectAttempt = 0;
      if (this.#options.presenceEnabled) await this.#publishPresence("online");
    })().finally(() => {
      this.#relayConnectPromise = undefined;
    });
    return this.#relayConnectPromise;
  }

  #watchChannel(channelId: string): void {
    const normalized = channelId.toLowerCase();
    if (
      this.#stopping ||
      !this.#relay.connected ||
      this.#channelSubscriptions.has(normalized)
    ) {
      return;
    }
    if (this.#channelSubscriptions.size >= MAX_CHANNEL_SUBSCRIPTIONS) {
      this.#emit({
        error: new Error(
          `ACP harness channel subscription limit (${MAX_CHANNEL_SUBSCRIPTIONS}) reached`,
        ),
        type: "error",
      });
      return;
    }
    const subscription = this.#relay.subscribe(
      [
        {
          "#h": [normalized],
          kinds: [KIND_STREAM_MESSAGE, KIND_STREAM_MESSAGE_V2],
        },
      ],
      `buzz-acp-channel-${normalized}`,
    );
    this.#channelSubscriptions.set(normalized, subscription);
  }

  #unwatchChannel(channelId: string): void {
    const normalized = channelId.toLowerCase();
    this.#channelSubscriptions.get(normalized)?.close();
    this.#channelSubscriptions.delete(normalized);
    this.#queues.delete(normalized);
    const sessionId = this.#sessions.get(normalized);
    if (sessionId && this.#activeSessions.has(sessionId)) {
      void this.#agent.cancel(sessionId).catch((error: unknown) => {
        this.#emit({
          error:
            error instanceof Error
              ? error
              : new Error("ACP membership-revocation cancel failed"),
          type: "error",
        });
      });
    }
  }

  #closeRelaySubscriptions(): void {
    this.#membershipSubscription?.close();
    this.#discoverySubscription?.close();
    for (const subscription of this.#channelSubscriptions.values()) {
      subscription.close();
    }
    this.#forgetRelaySubscriptions();
  }

  #forgetRelaySubscriptions(): void {
    this.#membershipSubscription = undefined;
    this.#discoverySubscription = undefined;
    this.#channelSubscriptions.clear();
  }

  #scheduleReconnect(): void {
    if (this.#reconnectTimer || this.#stopping || !this.#started) return;
    const delay = Math.min(30_000, 500 * 2 ** this.#reconnectAttempt);
    this.#reconnectAttempt = Math.min(this.#reconnectAttempt + 1, 16);
    this.#reconnectTimer = setTimeout(() => {
      this.#reconnectTimer = undefined;
      void this.#connectRelay().catch((error: unknown) => {
        this.#emit({
          error:
            error instanceof Error
              ? error
              : new Error("ACP relay reconnect failed"),
          type: "error",
        });
        this.#scheduleReconnect();
      });
    }, delay);
    this.#reconnectTimer.unref?.();
  }

  async #publishTyping(channelId: string, source: NostrEvent): Promise<void> {
    const root = threadRoot(source);
    const event = signNostrEvent(
      {
        content: "",
        created_at: unixNow(),
        kind: KIND_TYPING_INDICATOR,
        tags: [
          ["h", channelId],
          ...(root ? [["e", root, "", "root"]] : []),
          ["expiration", String(unixNow() + 15)],
        ],
      },
      this.#options.secretKey,
    );
    await this.#relay.publish(event);
  }

  #appendTurnText(sessionId: string, delta: string): void {
    const current = this.#turnText.get(sessionId);
    if (!current || current.truncated || !delta) return;
    const remaining =
      MAX_AGENT_REPLY_BYTES - Buffer.byteLength(current.text, "utf8");
    if (remaining <= 0) {
      current.truncated = true;
      return;
    }
    const bounded = truncateUtf8(delta, remaining);
    current.text += bounded;
    if (bounded !== delta) current.truncated = true;
  }

  async #publishAgentReply(
    channelId: string,
    source: NostrEvent,
    sessionId: string,
  ): Promise<void> {
    const collected = this.#turnText.get(sessionId);
    if (!collected) return;
    const content = collected.truncated
      ? `${collected.text}\n\n[Response truncated at 1 MiB]`
      : collected.text;
    if (!content.trim()) return;
    const root = threadRoot(source) ?? source.id;
    const tags: string[][] = [
      ["h", channelId],
      ["p", source.pubkey],
      ["e", root, "", "root"],
    ];
    if (source.id !== root) tags.push(["e", source.id, "", "reply"]);
    await this.#relay.publish(
      signNostrEvent(
        {
          content,
          created_at: unixNow(),
          kind: KIND_STREAM_MESSAGE,
          tags,
        },
        this.#options.secretKey,
      ),
    );
  }

  #emit(event: AcpHarnessEvent): void {
    for (const listener of this.#listeners) listener(event);
  }
}

type ValidatedHarnessOptions = {
  readonly relayUrl: string;
  readonly secretKey: Uint8Array;
  readonly agentPubkey: string;
  readonly ownerPubkey?: string;
  readonly authTag?: readonly [string, string, string, string];
  readonly respondTo: RespondTo;
  readonly respondToAllowlist: ReadonlySet<string>;
  readonly agent: AcpProcessClientOptions;
  readonly systemPrompt?: string;
  readonly sessionTitle?: string;
  readonly initialChannelIds: ReadonlySet<string>;
  readonly parallelism: number;
  readonly presenceEnabled: boolean;
  readonly typingEnabled: boolean;
  readonly publishAgentText: boolean;
  readonly allowInsecureLocalhost: boolean;
  readonly socketFactory?: (url: string) => RelaySocket;
};

function validateHarnessOptions(
  options: AcpHarnessOptions,
): ValidatedHarnessOptions {
  const ownerPubkey = options.ownerPubkey?.toLowerCase();
  if (ownerPubkey && !HEX_PUBKEY.test(ownerPubkey)) {
    throw new TypeError("agent owner pubkey must be 32-byte lowercase hex");
  }
  const respondTo = options.respondTo ?? "owner-only";
  if (
    (respondTo === "owner-only" || respondTo === "allowlist") &&
    !ownerPubkey
  ) {
    throw new TypeError(`${respondTo} requires an agent owner pubkey`);
  }
  const authTag = options.authTag;
  if (
    authTag &&
    (authTag.length !== 4 ||
      authTag[0] !== "auth" ||
      !HEX_PUBKEY.test(authTag[1]) ||
      !/^[0-9a-f]{128}$/.test(authTag[3]))
  ) {
    throw new TypeError("authTag must be a structurally valid NIP-OA auth tag");
  }
  const allowlist = new Set<string>();
  for (const value of options.respondToAllowlist ?? []) {
    const normalized = value.toLowerCase();
    if (!HEX_PUBKEY.test(normalized)) {
      throw new TypeError("respond-to allowlist contains an invalid pubkey");
    }
    allowlist.add(normalized);
  }
  const parallelism = options.parallelism ?? 1;
  if (
    !Number.isSafeInteger(parallelism) ||
    parallelism < 1 ||
    parallelism > 32
  ) {
    throw new RangeError("ACP harness parallelism must be between 1 and 32");
  }
  const systemPrompt = frameSystemPrompt(
    options.agent.cwd,
    options.basePrompt === undefined ? DEFAULT_BASE_PROMPT : options.basePrompt,
    options.systemPrompt,
  );
  if (systemPrompt && Buffer.byteLength(systemPrompt, "utf8") > 1024 * 1024) {
    throw new RangeError("ACP harness system prompt exceeds 1 MiB");
  }
  const initialChannelIds = new Set<string>();
  for (const value of options.initialChannelIds ?? []) {
    const normalized = value.toLowerCase();
    if (!UUID.test(normalized)) {
      throw new TypeError("initial ACP channel ID must be a UUID");
    }
    initialChannelIds.add(normalized);
  }
  if (initialChannelIds.size > MAX_CHANNEL_SUBSCRIPTIONS) {
    throw new RangeError(
      `ACP harness supports at most ${MAX_CHANNEL_SUBSCRIPTIONS} initial channels`,
    );
  }
  return {
    agent: options.agent,
    agentPubkey: publicKeyFromSecret(options.secretKey),
    allowInsecureLocalhost: options.allowInsecureLocalhost ?? false,
    ...(authTag
      ? {
          authTag: [...authTag] as [string, string, string, string],
        }
      : {}),
    ...(ownerPubkey ? { ownerPubkey } : {}),
    initialChannelIds,
    parallelism,
    presenceEnabled: options.presenceEnabled ?? true,
    publishAgentText: options.publishAgentText ?? false,
    relayUrl: options.relayUrl,
    respondTo,
    respondToAllowlist: allowlist,
    secretKey: Uint8Array.from(options.secretKey),
    ...(options.sessionTitle ? { sessionTitle: options.sessionTitle } : {}),
    ...(options.socketFactory ? { socketFactory: options.socketFactory } : {}),
    ...(systemPrompt ? { systemPrompt } : {}),
    typingEnabled: options.typingEnabled ?? true,
  };
}

export function frameSystemPrompt(
  cwd: string,
  basePrompt: string | null | undefined,
  systemPrompt: string | null | undefined,
): string | undefined {
  const base = basePrompt?.trim();
  const system = systemPrompt?.trim();
  const body =
    base && system
      ? `[Base]\n${base}\n\n[System]\n${system}`
      : base
        ? `[Base]\n${base}`
        : system
          ? `[System]\n${system}`
          : undefined;
  if (!body || !base || !isAbsolute(cwd) || parsePath(cwd).root === cwd) {
    return body;
  }
  return `[Workspace]\nYour absolute working directory is \`${cwd}\`. All workspace files — \`AGENTS.md\`, \`RESEARCH/\`, \`PLANS/\`, \`GUIDES/\`, \`WORK_LOGS/\`, \`OUTBOX/\` — and repositories under \`${cwd}/REPOS/\` live here. Do not search other directories for them.\n\n${body}`;
}

function renderPrompt(event: NostrEvent, channelId: string): string {
  const root = threadRoot(event);
  const reply = exactTag(event, "e");
  return [
    "[Buzz Message]",
    `channel: ${channelId}`,
    `event_id: ${event.id}`,
    `author_pubkey: ${event.pubkey}`,
    ...(root ? [`thread_root_event_id: ${root}`] : []),
    ...(reply ? [`reply_event_id: ${reply}`] : []),
    "",
    event.content,
  ].join("\n");
}

function composeSessionTitle(
  configured: string | undefined,
  channelId: string,
): string {
  const base = sanitizeTitle(configured ?? "Buzz agent");
  return `${base} · #${channelId.slice(0, 8)}`.slice(0, 80);
}

function sanitizeTitle(value: string): string {
  return (
    Array.from(value, (character) => {
      const code = character.codePointAt(0) ?? 0;
      return code < 32 || code === 127 ? " " : character;
    })
      .join("")
      .trim()
      .replaceAll(/\s+/g, " ")
      .slice(0, 64) || "Buzz agent"
  );
}

function exactTag(event: NostrEvent, name: string): string | undefined {
  const tags = event.tags.filter((tag) => tag[0] === name);
  return tags.length === 1 && tags[0]?.length === 2 ? tags[0][1] : undefined;
}

function hasExactTag(event: NostrEvent, name: string, value: string): boolean {
  return event.tags.some(
    (tag) => tag.length === 2 && tag[0] === name && tag[1] === value,
  );
}

function hasTag(event: NostrEvent, name: string, value: string): boolean {
  return event.tags.some((tag) => tag[0] === name && tag[1] === value);
}

function threadRoot(event: NostrEvent): string | undefined {
  return event.tags.find(
    (tag) =>
      tag[0] === "e" && tag[3] === "root" && HEX_PUBKEY.test(tag[1] ?? ""),
  )?.[1];
}

function truncateUtf8(value: string, maximumBytes: number): string {
  if (Buffer.byteLength(value, "utf8") <= maximumBytes) return value;
  const bytes = Buffer.from(value, "utf8").subarray(0, maximumBytes);
  return new TextDecoder("utf-8", { fatal: false })
    .decode(bytes)
    .replace(/\uFFFD$/u, "");
}

class Semaphore {
  readonly #waiters: Array<() => void> = [];
  #available: number;

  public constructor(capacity: number) {
    this.#available = capacity;
  }

  public async acquire(): Promise<() => void> {
    if (this.#available === 0) {
      await new Promise<void>((resolve) => this.#waiters.push(resolve));
    }
    this.#available -= 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.#available += 1;
      this.#waiters.shift()?.();
    };
  }
}
