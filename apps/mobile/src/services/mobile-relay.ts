import AsyncStorage from "@react-native-async-storage/async-storage";
import {
  signNostrEvent,
  verifyNostrEvent,
  type NostrEvent,
  type NostrFilter,
} from "@buzz/core";
import type { EventTemplate } from "@buzz/sdk";
import {
  AuthenticatedRelayClient,
  type RelayClientEvent,
  type RelaySubscription,
} from "@buzz/ws-client";
import { getPublicKey } from "nostr-tools/pure";

import { encodeOutbox, parseOutbox } from "../domain/outbox";

export type RelayConnectionState =
  | "idle"
  | "connecting"
  | "connected"
  | "reconnecting"
  | "offline";

type LiveSubscription = {
  readonly filters: readonly NostrFilter[];
  readonly onEvent: (event: NostrEvent) => void;
  relay: RelaySubscription | undefined;
};

const MAX_QUERY_EVENTS = 10_000;

export class MobileRelay {
  readonly #relayUrl: string;
  readonly #secretKey: Uint8Array;
  readonly #outboxKey: string;
  readonly #live = new Map<string, LiveSubscription>();
  readonly #stateListeners = new Set<(state: RelayConnectionState) => void>();
  readonly #outboxListeners = new Set<
    (events: readonly NostrEvent[]) => void
  >();
  readonly #outbox = new Map<string, NostrEvent>();
  #client: AuthenticatedRelayClient | undefined;
  #clientUnsubscribe: (() => void) | undefined;
  #state: RelayConnectionState = "idle";
  #closed = false;
  #connectPromise: Promise<void> | undefined;
  #reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  #attempt = 0;
  #outboxLoaded: Promise<void> | undefined;
  #outboxWrite = Promise.resolve();
  #flushingOutbox = false;

  public constructor(input: {
    readonly relayUrl: string;
    readonly secretKey: Uint8Array;
  }) {
    this.#relayUrl = input.relayUrl;
    this.#secretKey = Uint8Array.from(input.secretKey);
    this.#outboxKey = `buzz.mobile.outbox.v1:${getPublicKey(input.secretKey)}:${encodeURIComponent(input.relayUrl)}`;
  }

  public get state(): RelayConnectionState {
    return this.#state;
  }

  public get pendingEvents(): readonly NostrEvent[] {
    return [...this.#outbox.values()].sort(sortEventPair);
  }

  public onState(listener: (state: RelayConnectionState) => void): () => void {
    this.#stateListeners.add(listener);
    listener(this.#state);
    return () => this.#stateListeners.delete(listener);
  }

  public onOutbox(
    listener: (events: readonly NostrEvent[]) => void,
  ): () => void {
    this.#outboxListeners.add(listener);
    listener(this.pendingEvents);
    return () => this.#outboxListeners.delete(listener);
  }

  public async connect(): Promise<void> {
    if (this.#closed) throw new Error("relay session is closed");
    if (this.#client?.connected) return;
    if (this.#connectPromise) return this.#connectPromise;
    this.#setState(this.#attempt > 0 ? "reconnecting" : "connecting");
    const promise = this.#open();
    this.#connectPromise = promise;
    try {
      await promise;
    } finally {
      if (this.#connectPromise === promise) this.#connectPromise = undefined;
    }
  }

  public async query(
    filters: readonly NostrFilter[],
    timeoutMilliseconds = 15_000,
  ): Promise<readonly NostrEvent[]> {
    await this.connect();
    const client = this.#requiredClient();
    const id = `mobile-query-${crypto.randomUUID()}`;
    const events = new Map<string, NostrEvent>();
    return new Promise<readonly NostrEvent[]>((resolve, reject) => {
      let subscription: RelaySubscription | undefined;
      const timeout = setTimeout(() => {
        cleanup();
        reject(new Error("relay history request timed out"));
      }, timeoutMilliseconds);
      const unsubscribe = client.on((event) => {
        if (
          event.type === "event" &&
          event.subscriptionId === id &&
          verifyNostrEvent(event.event)
        ) {
          if (events.size >= MAX_QUERY_EVENTS && !events.has(event.event.id)) {
            cleanup();
            reject(new Error("relay history response exceeded event limit"));
            return;
          }
          events.set(event.event.id, event.event);
        } else if (event.type === "eose" && event.subscriptionId === id) {
          cleanup();
          resolve(sortEvents([...events.values()]));
        } else if (event.type === "closed" && event.subscriptionId === id) {
          cleanup();
          reject(new Error(event.message));
        } else if (event.type === "disconnected") {
          cleanup();
          reject(new Error("relay disconnected during history request"));
        }
      });
      const cleanup = () => {
        clearTimeout(timeout);
        unsubscribe();
        subscription?.close();
      };
      try {
        subscription = client.subscribe(filters, id);
      } catch (error) {
        cleanup();
        reject(asError(error));
      }
    });
  }

  public subscribe(
    filters: readonly NostrFilter[],
    onEvent: (event: NostrEvent) => void,
  ): () => void {
    if (this.#closed) throw new Error("relay session is closed");
    const id = `mobile-live-${crypto.randomUUID()}`;
    const entry: LiveSubscription = {
      filters: filters.map((filter) => structuredClone(filter)),
      onEvent,
      relay: undefined,
    };
    this.#live.set(id, entry);
    if (this.#client?.connected) {
      entry.relay = this.#openLive(id, entry);
    } else {
      void this.connect().catch(() => undefined);
    }
    return () => {
      this.#live.delete(id);
      entry.relay?.close();
    };
  }

  public async publish(
    template: EventTemplate,
    createdAt?: number,
  ): Promise<NostrEvent> {
    const event = signNostrEvent(
      {
        content: template.content,
        created_at: createdAt ?? Math.floor(Date.now() / 1_000),
        kind: template.kind,
        tags: template.tags.map((tag) => [...tag]),
      },
      this.#secretKey,
    );
    const client = this.#client;
    if (client?.connected) {
      try {
        await client.publish(event);
        return event;
      } catch (error) {
        if (client.connected && this.#state === "connected") throw error;
      }
    }
    await this.#enqueue(event);
    void this.connect().catch(() => undefined);
    return event;
  }

  public async publishEvent(event: NostrEvent): Promise<void> {
    if (!verifyNostrEvent(event)) throw new TypeError("invalid Nostr event");
    const client = this.#client;
    if (client?.connected) {
      try {
        await client.publish(event);
        return;
      } catch (error) {
        if (client.connected && this.#state === "connected") throw error;
      }
    }
    await this.#enqueue(event);
    void this.connect().catch(() => undefined);
  }

  public async count(filter: NostrFilter): Promise<number> {
    await this.connect();
    return this.#requiredClient().count(filter);
  }

  public setOnline(online: boolean): void {
    if (this.#closed) return;
    if (!online) {
      this.#clearReconnect();
      this.#client?.close();
      this.#setState("offline");
      return;
    }
    if (this.#state === "offline") {
      this.#attempt = 0;
      void this.connect().catch(() => undefined);
    }
  }

  public close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#clearReconnect();
    this.#clientUnsubscribe?.();
    this.#client?.close();
    this.#client = undefined;
    for (const entry of this.#live.values()) entry.relay?.close();
    this.#live.clear();
    this.#stateListeners.clear();
    this.#outboxListeners.clear();
    this.#secretKey.fill(0);
    this.#state = "idle";
  }

  async #open(): Promise<void> {
    await this.#loadOutbox();
    const client = new AuthenticatedRelayClient({
      allowInsecureLocalhost: typeof __DEV__ !== "undefined" && __DEV__,
      relayUrl: this.#relayUrl,
      secretKey: this.#secretKey,
    });
    this.#clientUnsubscribe?.();
    this.#client?.close();
    this.#client = client;
    this.#clientUnsubscribe = client.on((event) =>
      this.#handleClientEvent(client, event),
    );
    try {
      await client.connect();
      if (this.#closed || this.#client !== client) {
        client.close();
        return;
      }
      this.#attempt = 0;
      this.#setState("connected");
      for (const [id, entry] of this.#live) {
        entry.relay = this.#openLive(id, entry);
      }
      void this.#flushOutbox();
    } catch (error) {
      if (this.#client === client) {
        this.#scheduleReconnect();
      }
      throw asError(error);
    }
  }

  #openLive(id: string, entry: LiveSubscription): RelaySubscription {
    return this.#requiredClient().subscribe(entry.filters, id);
  }

  #handleClientEvent(
    client: AuthenticatedRelayClient,
    event: RelayClientEvent,
  ): void {
    if (this.#client !== client || this.#closed) return;
    if (event.type === "event") {
      this.#live.get(event.subscriptionId)?.onEvent(event.event);
    } else if (event.type === "disconnected") {
      for (const entry of this.#live.values()) entry.relay = undefined;
      this.#scheduleReconnect();
    }
  }

  #scheduleReconnect(): void {
    if (this.#closed || this.#state === "offline" || this.#reconnectTimer) {
      return;
    }
    this.#attempt += 1;
    this.#setState("reconnecting");
    const exponential = Math.min(30_000, 500 * 2 ** (this.#attempt - 1));
    const jitter = Math.floor(Math.random() * Math.max(1, exponential / 4));
    this.#reconnectTimer = setTimeout(() => {
      this.#reconnectTimer = undefined;
      void this.connect().catch(() => undefined);
    }, exponential + jitter);
  }

  #clearReconnect(): void {
    if (this.#reconnectTimer) clearTimeout(this.#reconnectTimer);
    this.#reconnectTimer = undefined;
  }

  #requiredClient(): AuthenticatedRelayClient {
    if (!this.#client?.connected) throw new Error("relay is not connected");
    return this.#client;
  }

  #setState(state: RelayConnectionState): void {
    if (this.#state === state) return;
    this.#state = state;
    for (const listener of this.#stateListeners) listener(state);
  }

  async #loadOutbox(): Promise<void> {
    if (!this.#outboxLoaded) {
      this.#outboxLoaded = AsyncStorage.getItem(this.#outboxKey)
        .then((raw) => {
          for (const event of parseOutbox(raw)) {
            this.#outbox.set(event.id, event);
          }
          this.#emitOutbox();
        })
        .catch(() => undefined);
    }
    await this.#outboxLoaded;
  }

  async #enqueue(event: NostrEvent): Promise<void> {
    await this.#loadOutbox();
    this.#outbox.set(event.id, event);
    const capped = parseOutbox(encodeOutbox([...this.#outbox.values()]));
    this.#outbox.clear();
    for (const item of capped) this.#outbox.set(item.id, item);
    await this.#persistOutbox();
    this.#emitOutbox();
  }

  async #flushOutbox(): Promise<void> {
    if (this.#flushingOutbox) return;
    this.#flushingOutbox = true;
    try {
      await this.#loadOutbox();
      while (!this.#closed && this.#client?.connected) {
        const event = this.pendingEvents[0];
        if (!event) break;
        const client = this.#client;
        try {
          await client.publish(event);
          this.#outbox.delete(event.id);
          await this.#persistOutbox();
          this.#emitOutbox();
        } catch {
          if (!client.connected || this.#state !== "connected") break;
          // A connected relay rejection is permanent for an immutable signed
          // event. Remove it so one invalid event cannot poison the queue.
          this.#outbox.delete(event.id);
          await this.#persistOutbox();
          this.#emitOutbox();
        }
      }
    } finally {
      this.#flushingOutbox = false;
    }
  }

  async #persistOutbox(): Promise<void> {
    const encoded = encodeOutbox([...this.#outbox.values()]);
    this.#outboxWrite = this.#outboxWrite
      .catch(() => undefined)
      .then(() => AsyncStorage.setItem(this.#outboxKey, encoded));
    await this.#outboxWrite;
  }

  #emitOutbox(): void {
    const events = this.pendingEvents;
    for (const listener of this.#outboxListeners) listener(events);
  }
}

export function relayHttpOrigin(relayUrl: string): string {
  const url = new URL(relayUrl);
  url.protocol = url.protocol === "wss:" ? "https:" : "http:";
  url.pathname = "/";
  return url.toString().replace(/\/$/, "");
}

function sortEvents(events: NostrEvent[]): readonly NostrEvent[] {
  return events.sort(sortEventPair);
}

function sortEventPair(left: NostrEvent, right: NostrEvent): number {
  return left.created_at === right.created_at
    ? left.id.localeCompare(right.id)
    : left.created_at - right.created_at;
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error("relay request failed");
}
