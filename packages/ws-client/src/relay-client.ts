import {
  KIND_AUTH,
  signNostrEvent,
  unixNow,
  verifyNostrEvent,
  type NostrEvent,
  type NostrFilter,
} from "@buzz/core";

const MAX_MESSAGE_BYTES = 512 * 1024;
const MAX_SUBSCRIPTIONS = 1_024;

export type RelaySocket = {
  readonly readyState: number;
  addEventListener(type: "open", listener: () => void): void;
  addEventListener(
    type: "message",
    listener: (event: { readonly data: unknown }) => void,
  ): void;
  addEventListener(
    type: "close",
    listener: (event?: {
      readonly code?: number;
      readonly reason?: string;
    }) => void,
  ): void;
  addEventListener(type: "error", listener: () => void): void;
  send(data: string): void;
  close(code?: number, reason?: string): void;
};

export type RelayClientEvent =
  | { readonly type: "connected" | "disconnected" }
  | {
      readonly type: "event";
      readonly subscriptionId: string;
      readonly event: NostrEvent;
    }
  | { readonly type: "eose"; readonly subscriptionId: string }
  | {
      readonly type: "closed";
      readonly subscriptionId: string;
      readonly message: string;
    }
  | { readonly type: "notice"; readonly message: string }
  | {
      readonly type: "error";
      readonly error: Error;
    };

export type RelaySubscription = {
  readonly id: string;
  close(): void;
};

type PendingPublish = {
  readonly resolve: (message: string) => void;
  readonly reject: (error: Error) => void;
  readonly timeout: ReturnType<typeof setTimeout>;
};

type PendingCount = {
  readonly resolve: (count: number) => void;
  readonly reject: (error: Error) => void;
  readonly timeout: ReturnType<typeof setTimeout>;
};

export class AuthenticatedRelayClient {
  readonly #relayUrl: URL;
  readonly #secretKey: Uint8Array;
  readonly #authTag: readonly [string, string, string, string] | undefined;
  readonly #socketFactory: (url: string) => RelaySocket;
  readonly #listeners = new Set<(event: RelayClientEvent) => void>();
  readonly #subscriptions = new Map<string, readonly NostrFilter[]>();
  readonly #pendingPublishes = new Map<string, PendingPublish>();
  readonly #pendingCounts = new Map<string, PendingCount>();
  #socket: RelaySocket | undefined;
  #authEventId: string | undefined;
  #authenticated = false;
  #connectPromise: Promise<void> | undefined;

  public constructor(input: {
    readonly relayUrl: string;
    readonly secretKey: Uint8Array;
    /** Optional NIP-OA owner credential copied into every NIP-42 AUTH event. */
    readonly authTag?: readonly [string, string, string, string];
    readonly allowInsecureLocalhost?: boolean;
    readonly socketFactory?: (url: string) => RelaySocket;
  }) {
    this.#relayUrl = validateRelayUrl(
      input.relayUrl,
      input.allowInsecureLocalhost ?? false,
    );
    this.#secretKey = Uint8Array.from(input.secretKey);
    this.#authTag = input.authTag
      ? validateOwnerAuthTag(input.authTag)
      : undefined;
    this.#socketFactory =
      input.socketFactory ??
      ((url) => new WebSocket(url) as unknown as RelaySocket);
  }

  public get connected(): boolean {
    return this.#authenticated;
  }

  public on(listener: (event: RelayClientEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  public connect(): Promise<void> {
    if (this.#authenticated) return Promise.resolve();
    if (this.#connectPromise) return this.#connectPromise;
    this.#connectPromise = this.#open().catch((error: unknown) => {
      const socket = this.#socket;
      this.#socket = undefined;
      this.#authenticated = false;
      this.#authEventId = undefined;
      socket?.close(1001, "connection failed");
      throw asError(error, "relay connection failed");
    });
    return this.#connectPromise.finally(() => {
      this.#connectPromise = undefined;
    });
  }

  public subscribe(
    filters: readonly NostrFilter[],
    id: string = crypto.randomUUID(),
  ): RelaySubscription {
    this.#requireConnected();
    validateSubscription(id, filters, this.#subscriptions.size);
    const copied = filters.map(copyFilter);
    this.#subscriptions.set(id, copied);
    this.#send(["REQ", id, ...copied]);
    return {
      id,
      close: () => {
        if (!this.#subscriptions.delete(id)) return;
        if (this.#authenticated) this.#send(["CLOSE", id]);
      },
    };
  }

  public publish(
    event: NostrEvent,
    timeoutMilliseconds = 15_000,
  ): Promise<string> {
    this.#requireConnected();
    if (!verifyNostrEvent(event)) {
      throw new TypeError("cannot publish an invalid Nostr event");
    }
    validateTimeout(timeoutMilliseconds);
    if (this.#pendingPublishes.has(event.id)) {
      throw new Error("event publication is already pending");
    }
    return new Promise<string>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.#pendingPublishes.delete(event.id);
        reject(new Error("relay event acknowledgement timed out"));
      }, timeoutMilliseconds);
      this.#pendingPublishes.set(event.id, { reject, resolve, timeout });
      try {
        this.#send(["EVENT", event]);
      } catch (error) {
        clearTimeout(timeout);
        this.#pendingPublishes.delete(event.id);
        reject(asError(error, "event publication failed"));
      }
    });
  }

  public count(
    filter: NostrFilter,
    timeoutMilliseconds = 15_000,
  ): Promise<number> {
    this.#requireConnected();
    validateTimeout(timeoutMilliseconds);
    const id = crypto.randomUUID();
    return new Promise<number>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.#pendingCounts.delete(id);
        reject(new Error("relay count request timed out"));
      }, timeoutMilliseconds);
      this.#pendingCounts.set(id, { reject, resolve, timeout });
      try {
        this.#send(["COUNT", id, copyFilter(filter)]);
      } catch (error) {
        clearTimeout(timeout);
        this.#pendingCounts.delete(id);
        reject(asError(error, "count request failed"));
      }
    });
  }

  public close(): void {
    const socket = this.#socket;
    this.#socket = undefined;
    this.#authenticated = false;
    this.#authEventId = undefined;
    this.#rejectPending(new Error("relay connection closed"));
    socket?.close(1000, "client shutdown");
  }

  async #open(): Promise<void> {
    if (this.#socket) throw new Error("relay connection is already opening");
    const socket = this.#socketFactory(this.#relayUrl.toString());
    this.#socket = socket;
    socket.addEventListener("message", (event) =>
      this.#handleMessage(event.data),
    );
    socket.addEventListener("close", () => this.#handleClose(socket));
    socket.addEventListener("error", () => {
      this.#emit({
        error: new Error("relay WebSocket failed"),
        type: "error",
      });
    });
    await waitForOpen(socket);
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error("relay authentication timed out"));
      }, 15_000);
      const unsubscribe = this.on((event) => {
        if (event.type === "connected") {
          clearTimeout(timeout);
          unsubscribe();
          resolve();
        } else if (event.type === "disconnected") {
          clearTimeout(timeout);
          unsubscribe();
          reject(new Error("relay disconnected during authentication"));
        }
      });
    });
  }

  #handleMessage(raw: unknown): void {
    let message: unknown;
    try {
      const encoded = decodeSocketMessage(raw);
      if (new TextEncoder().encode(encoded).length > MAX_MESSAGE_BYTES) {
        this.#socket?.close(1009, "payload too large");
        return;
      }
      message = JSON.parse(encoded) as unknown;
    } catch {
      this.#emit({
        error: new Error("relay sent an invalid JSON message"),
        type: "error",
      });
      return;
    }
    if (!Array.isArray(message) || typeof message[0] !== "string") return;
    if (message[0] === "AUTH" && typeof message[1] === "string") {
      this.#authenticate(message[1]);
      return;
    }
    if (
      message[0] === "OK" &&
      message[1] === this.#authEventId &&
      message[2] === true
    ) {
      this.#authenticated = true;
      this.#emit({ type: "connected" });
      return;
    }
    if (
      message[0] === "OK" &&
      message[1] === this.#authEventId &&
      message[2] === false
    ) {
      this.#socket?.close(1008, "relay authentication rejected");
      return;
    }
    if (
      message[0] === "OK" &&
      typeof message[1] === "string" &&
      typeof message[2] === "boolean"
    ) {
      const pending = this.#pendingPublishes.get(message[1]);
      if (!pending) return;
      clearTimeout(pending.timeout);
      this.#pendingPublishes.delete(message[1]);
      if (message[2])
        pending.resolve(typeof message[3] === "string" ? message[3] : "");
      else
        pending.reject(
          new Error(safeRelayMessage(message[3], "relay rejected event")),
        );
      return;
    }
    if (
      message[0] === "EVENT" &&
      typeof message[1] === "string" &&
      verifyNostrEvent(message[2])
    ) {
      if (!this.#subscriptions.has(message[1])) return;
      this.#emit({
        event: message[2],
        subscriptionId: message[1],
        type: "event",
      });
      return;
    }
    if (message[0] === "EOSE" && typeof message[1] === "string") {
      if (this.#subscriptions.has(message[1])) {
        this.#emit({ subscriptionId: message[1], type: "eose" });
      }
      return;
    }
    if (
      message[0] === "COUNT" &&
      typeof message[1] === "string" &&
      isCountPayload(message[2])
    ) {
      const pending = this.#pendingCounts.get(message[1]);
      if (!pending) return;
      clearTimeout(pending.timeout);
      this.#pendingCounts.delete(message[1]);
      pending.resolve(message[2].count);
      return;
    }
    if (message[0] === "CLOSED" && typeof message[1] === "string") {
      const subscriptionId = message[1];
      const reason = safeRelayMessage(message[2], "relay closed request");
      this.#subscriptions.delete(subscriptionId);
      const pendingCount = this.#pendingCounts.get(subscriptionId);
      if (pendingCount) {
        clearTimeout(pendingCount.timeout);
        this.#pendingCounts.delete(subscriptionId);
        pendingCount.reject(new Error(reason));
      }
      this.#emit({
        message: reason,
        subscriptionId,
        type: "closed",
      });
      return;
    }
    if (message[0] === "NOTICE") {
      this.#emit({
        message: safeRelayMessage(message[1], "relay notice"),
        type: "notice",
      });
    }
  }

  #authenticate(challenge: string): void {
    if (
      challenge.length < 16 ||
      challenge.length > 256 ||
      this.#authenticated
    ) {
      this.#socket?.close(1008, "invalid authentication challenge");
      return;
    }
    const event = signNostrEvent(
      {
        content: "",
        created_at: unixNow(),
        kind: KIND_AUTH,
        tags: [
          ["relay", this.#relayUrl.toString()],
          ["challenge", challenge],
          ...(this.#authTag ? [[...this.#authTag]] : []),
        ],
      },
      this.#secretKey,
    );
    this.#authEventId = event.id;
    this.#send(["AUTH", event]);
  }

  #handleClose(socket: RelaySocket): void {
    if (this.#socket !== socket) return;
    const wasActive = this.#authenticated || this.#socket !== undefined;
    this.#socket = undefined;
    this.#authenticated = false;
    this.#authEventId = undefined;
    this.#subscriptions.clear();
    this.#rejectPending(
      new Error("relay disconnected before completing request"),
    );
    if (wasActive) this.#emit({ type: "disconnected" });
  }

  #rejectPending(error: Error): void {
    for (const pending of this.#pendingPublishes.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    for (const pending of this.#pendingCounts.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.#pendingPublishes.clear();
    this.#pendingCounts.clear();
  }

  #requireConnected(): void {
    if (!this.#authenticated || !this.#socket) {
      throw new Error("relay client is not authenticated");
    }
  }

  #send(message: unknown[]): void {
    const encoded = JSON.stringify(message);
    if (new TextEncoder().encode(encoded).length > MAX_MESSAGE_BYTES) {
      throw new RangeError("relay message exceeds 512 KiB");
    }
    this.#socket?.send(encoded);
  }

  #emit(event: RelayClientEvent): void {
    for (const listener of this.#listeners) listener(event);
  }
}

function validateOwnerAuthTag(
  value: readonly [string, string, string, string],
): readonly [string, string, string, string] {
  if (
    !Array.isArray(value) ||
    value.length !== 4 ||
    value[0] !== "auth" ||
    !/^[0-9a-f]{64}$/.test(value[1]) ||
    new TextEncoder().encode(value[2]).byteLength > 1_024 ||
    !/^[0-9a-f]{128}$/.test(value[3])
  ) {
    throw new TypeError("authTag must be a structurally valid NIP-OA auth tag");
  }
  return [...value] as [string, string, string, string];
}

export function validateRelayUrl(
  value: string,
  allowInsecureLocalhost: boolean,
): URL {
  const url = new URL(value);
  if (url.username || url.password || url.hash || url.search) {
    throw new TypeError(
      "relay URL must not contain credentials, query, or fragment",
    );
  }
  if (url.pathname !== "/" && url.pathname !== "") {
    throw new TypeError("relay URL path must be /");
  }
  const local =
    url.hostname === "localhost" ||
    url.hostname === "127.0.0.1" ||
    url.hostname === "[::1]";
  if (
    url.protocol !== "wss:" &&
    !(allowInsecureLocalhost && local && url.protocol === "ws:")
  ) {
    throw new TypeError("relay URL must use wss");
  }
  url.pathname = "/";
  return url;
}

function validateSubscription(
  id: string,
  filters: readonly NostrFilter[],
  currentCount: number,
): void {
  if (
    new TextEncoder().encode(id).length < 1 ||
    new TextEncoder().encode(id).length > 256
  ) {
    throw new RangeError("subscription ID must be between 1 and 256 bytes");
  }
  if (filters.length < 1 || filters.length > 10) {
    throw new RangeError(
      "subscription must contain between one and ten filters",
    );
  }
  if (currentCount >= MAX_SUBSCRIPTIONS) {
    throw new RangeError("relay client subscription limit reached");
  }
}

function copyFilter(filter: NostrFilter): NostrFilter {
  return structuredClone(filter);
}

function validateTimeout(value: number): void {
  if (!Number.isSafeInteger(value) || value < 100 || value > 10 * 60_000) {
    throw new RangeError(
      "request timeout must be between 100 ms and 10 minutes",
    );
  }
}

function waitForOpen(socket: RelaySocket): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("relay connection timed out")),
      15_000,
    );
    socket.addEventListener("open", () => {
      clearTimeout(timeout);
      resolve();
    });
    socket.addEventListener("error", () => {
      clearTimeout(timeout);
      reject(new Error("relay connection failed"));
    });
  });
}

function decodeSocketMessage(raw: unknown): string {
  if (typeof raw === "string") return raw;
  if (raw instanceof ArrayBuffer) return new TextDecoder().decode(raw);
  if (ArrayBuffer.isView(raw)) {
    return new TextDecoder().decode(
      new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength),
    );
  }
  throw new TypeError("unsupported relay WebSocket frame");
}

function safeRelayMessage(value: unknown, fallback: string): string {
  return typeof value === "string"
    ? value.slice(0, 512).replaceAll(/[\r\n\t]/g, " ")
    : fallback;
}

function isCountPayload(value: unknown): value is { readonly count: number } {
  return (
    typeof value === "object" &&
    value !== null &&
    Number.isSafeInteger((value as { readonly count?: unknown }).count) &&
    ((value as { readonly count: number }).count ?? -1) >= 0
  );
}

function asError(value: unknown, fallback: string): Error {
  return value instanceof Error ? value : new Error(fallback);
}
