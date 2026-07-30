import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { KIND_PAIRING, verifyNostrEvent, type NostrEvent } from "@buzz/core";
import { WebSocket, WebSocketServer, type RawData } from "ws";

const HEX_32 = /^[0-9a-f]{64}$/;
const BASE64 =
  /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const EVENT_KEYS = [
  "content",
  "created_at",
  "id",
  "kind",
  "pubkey",
  "sig",
  "tags",
] as const;

export type PairRelayOptions = {
  readonly host?: string;
  readonly port?: number;
  readonly path?: string;
  readonly maxConnections?: number;
  readonly connectionTtlMilliseconds?: number;
  readonly freshnessSeconds?: number;
  readonly now?: () => number;
};

type Connection = {
  readonly id: number;
  readonly socket: WebSocket;
  readonly openedAt: number;
  messageWindow: RateWindow;
  eventWindow: RateWindow;
  eventAttempts: number;
  subscription?: { readonly id: string; readonly recipient: string };
};

type TimedCount = { count: number; touchedAt: number };

export class PairRelay {
  readonly #options: Required<PairRelayOptions>;
  readonly #http: Server;
  readonly #ws: WebSocketServer;
  readonly #connections = new Map<WebSocket, Connection>();
  readonly #subscribers = new Map<string, Connection>();
  readonly #seen = new Map<string, number>();
  readonly #delivered = new Map<string, TimedCount>();
  #nextConnectionId = 0;
  #started = false;

  public constructor(options: PairRelayOptions = {}) {
    this.#options = {
      connectionTtlMilliseconds: options.connectionTtlMilliseconds ?? 120_000,
      freshnessSeconds: options.freshnessSeconds ?? 120,
      host: options.host ?? "127.0.0.1",
      maxConnections: options.maxConnections ?? 128,
      now: options.now ?? Date.now,
      path: options.path ?? "/pair",
      port: options.port ?? 5_000,
    };
    this.#ws = new WebSocketServer({
      clientTracking: false,
      maxPayload: 4_096,
      noServer: true,
      perMessageDeflate: false,
    });
    this.#http = createServer((_request, response) => {
      response.writeHead(400, securityHeaders());
      response.end();
    });
    this.#http.headersTimeout = 5_000;
    this.#http.requestTimeout = 5_000;
    this.#http.keepAliveTimeout = 5_000;
    this.#http.on("upgrade", (request, socket, head) => {
      let pathname: string;
      try {
        pathname = new URL(request.url ?? "", "http://pair.invalid").pathname;
      } catch {
        socket.destroy();
        return;
      }
      if (
        pathname !== this.#options.path ||
        this.#connections.size >= this.#options.maxConnections
      ) {
        socket.write(
          `HTTP/1.1 ${pathname === this.#options.path ? "503 Service Unavailable" : "404 Not Found"}\r\nConnection: close\r\n\r\n`,
        );
        socket.destroy();
        return;
      }
      this.#ws.handleUpgrade(request, socket, head, (websocket) => {
        this.#accept(websocket);
      });
    });
  }

  public async listen(): Promise<{
    readonly host: string;
    readonly port: number;
    readonly url: string;
  }> {
    if (this.#started) {
      throw new Error("pair relay is already listening");
    }
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => {
        this.#http.off("listening", onListening);
        reject(error);
      };
      const onListening = (): void => {
        this.#http.off("error", onError);
        resolve();
      };
      this.#http.once("error", onError);
      this.#http.once("listening", onListening);
      this.#http.listen(this.#options.port, this.#options.host);
    });
    this.#started = true;
    const address = this.#http.address() as AddressInfo;
    return {
      host: address.address,
      port: address.port,
      url: `ws://${formatHost(address.address)}:${address.port}${this.#options.path}`,
    };
  }

  public async close(): Promise<void> {
    for (const connection of this.#connections.values()) {
      connection.socket.close(1001, "relay shutting down");
      connection.socket.terminate();
    }
    this.#connections.clear();
    this.#subscribers.clear();
    if (!this.#started) return;
    await new Promise<void>((resolve, reject) => {
      this.#http.close((error) => {
        if (error) reject(error);
        else resolve();
      });
    });
    this.#started = false;
  }

  #accept(socket: WebSocket): void {
    const connection: Connection = {
      eventAttempts: 0,
      eventWindow: new RateWindow(this.#options.now),
      id: this.#nextConnectionId++,
      messageWindow: new RateWindow(this.#options.now),
      openedAt: this.#options.now(),
      socket,
    };
    this.#connections.set(socket, connection);
    const lifetime = setTimeout(() => {
      socket.close(1000, "pairing session expired");
    }, this.#options.connectionTtlMilliseconds);
    lifetime.unref();

    socket.on("message", (data, isBinary) => {
      if (isBinary) {
        socket.close(1003, "text frames only");
        return;
      }
      this.#message(connection, data);
    });
    socket.on("error", () => {
      socket.terminate();
    });
    socket.once("close", () => {
      clearTimeout(lifetime);
      this.#remove(connection);
    });
  }

  #message(connection: Connection, data: RawData): void {
    if (
      this.#options.now() - connection.openedAt >
        this.#options.connectionTtlMilliseconds ||
      connection.messageWindow.tick() > 20
    ) {
      connection.socket.close(1008, "rate or lifetime limit");
      return;
    }
    let message: unknown;
    try {
      message = JSON.parse(data.toString());
    } catch {
      this.#send(connection, ["NOTICE", "error: invalid message"]);
      return;
    }
    if (!Array.isArray(message) || typeof message[0] !== "string") {
      this.#send(connection, ["NOTICE", "error: invalid message"]);
      return;
    }
    switch (message[0]) {
      case "REQ":
        this.#subscribe(connection, message);
        return;
      case "EVENT":
        this.#event(connection, message);
        return;
      case "CLOSE":
        this.#unsubscribe(connection, message);
        return;
      default:
        this.#send(connection, ["NOTICE", "error: unsupported message"]);
    }
  }

  #subscribe(connection: Connection, message: unknown[]): void {
    const subscriptionId =
      typeof message[1] === "string" && message[1].length <= 64
        ? message[1]
        : "";
    if (message.length !== 3 || !subscriptionId) {
      this.#send(connection, ["NOTICE", "error: invalid REQ"]);
      return;
    }
    if (connection.subscription) {
      this.#send(connection, [
        "CLOSED",
        subscriptionId,
        "error: already subscribed, send CLOSE first",
      ]);
      return;
    }
    let recipient: string;
    try {
      recipient = validateFilter(message[2]);
    } catch (error) {
      this.#send(connection, [
        "CLOSED",
        subscriptionId,
        `error: ${errorMessage(error)}`,
      ]);
      return;
    }
    if (this.#subscribers.has(recipient)) {
      this.#send(connection, [
        "CLOSED",
        subscriptionId,
        "error: #p already has a live subscriber",
      ]);
      return;
    }
    this.#send(connection, ["EOSE", subscriptionId]);
    connection.subscription = { id: subscriptionId, recipient };
    this.#subscribers.set(recipient, connection);
  }

  #unsubscribe(connection: Connection, message: unknown[]): void {
    if (message.length !== 2 || typeof message[1] !== "string") {
      this.#send(connection, ["NOTICE", "error: invalid CLOSE"]);
      return;
    }
    if (connection.subscription?.id === message[1]) {
      this.#subscribers.delete(connection.subscription.recipient);
      delete connection.subscription;
    }
  }

  #event(connection: Connection, message: unknown[]): void {
    const safeId = safeEventId(message[1]);
    if (message.length !== 2) {
      this.#send(connection, ["NOTICE", "error: invalid EVENT"]);
      return;
    }
    if (connection.eventWindow.tick() > 10) {
      this.#send(connection, ["OK", safeId, false, "rate-limited"]);
      return;
    }
    if (connection.eventAttempts >= 6) {
      this.#send(connection, [
        "OK",
        safeId,
        false,
        "error: session event limit reached",
      ]);
      return;
    }
    let event: NostrEvent;
    let recipient: string;
    try {
      ({ event, recipient } = validatePairingEvent(
        message[1],
        Math.floor(this.#options.now() / 1_000),
        this.#options.freshnessSeconds,
      ));
    } catch (error) {
      this.#send(connection, [
        "OK",
        safeId,
        false,
        `invalid: ${errorMessage(error)}`,
      ]);
      return;
    }
    connection.eventAttempts += 1;
    this.#evict();
    if (this.#seen.has(event.id)) {
      this.#send(connection, [
        "OK",
        event.id,
        false,
        "duplicate: already seen",
      ]);
      return;
    }
    if (this.#seen.size >= 1_024) {
      this.#send(connection, ["OK", event.id, false, "relay at capacity"]);
      return;
    }
    const target = this.#subscribers.get(recipient);
    if (!target || target.socket.readyState !== WebSocket.OPEN) {
      this.#send(connection, ["OK", event.id, false, "no live subscriber"]);
      return;
    }
    const delivery = this.#delivered.get(recipient);
    if ((delivery?.count ?? 0) >= 12) {
      this.#send(connection, [
        "OK",
        event.id,
        false,
        "recipient session budget exhausted",
      ]);
      return;
    }
    if (this.#delivered.size >= 4_096 && !delivery) {
      this.#send(connection, ["OK", event.id, false, "relay at capacity"]);
      return;
    }
    if (!this.#send(target, ["EVENT", target.subscription?.id ?? "", event])) {
      this.#send(connection, ["OK", event.id, false, "delivery failed"]);
      return;
    }
    const now = this.#options.now();
    this.#seen.set(event.id, now);
    this.#delivered.set(recipient, {
      count: (delivery?.count ?? 0) + 1,
      touchedAt: now,
    });
    this.#send(connection, ["OK", event.id, true, ""]);
  }

  #send(connection: Connection, message: readonly unknown[]): boolean {
    if (
      connection.socket.readyState !== WebSocket.OPEN ||
      connection.socket.bufferedAmount > 16_384
    ) {
      connection.socket.close(1008, "outbound queue limit");
      return false;
    }
    try {
      connection.socket.send(JSON.stringify(message));
      return true;
    } catch {
      connection.socket.terminate();
      return false;
    }
  }

  #remove(connection: Connection): void {
    if (
      connection.subscription &&
      this.#subscribers.get(connection.subscription.recipient) === connection
    ) {
      this.#subscribers.delete(connection.subscription.recipient);
    }
    this.#connections.delete(connection.socket);
  }

  #evict(): void {
    const cutoff = this.#options.now() - 300_000;
    for (const [id, touchedAt] of this.#seen) {
      if (touchedAt < cutoff) this.#seen.delete(id);
    }
    for (const [recipient, value] of this.#delivered) {
      if (value.touchedAt < cutoff) this.#delivered.delete(recipient);
    }
  }
}

export function validatePairingEvent(
  value: unknown,
  nowSeconds = Math.floor(Date.now() / 1_000),
  freshnessSeconds = 120,
): { readonly event: NostrEvent; readonly recipient: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("event must be an object");
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (
    keys.length !== EVENT_KEYS.length ||
    keys.some((key, index) => key !== EVENT_KEYS[index])
  ) {
    throw new Error("unknown or missing top-level field");
  }
  if (!verifyNostrEvent(value)) {
    throw new Error("signature or event id verification failed");
  }
  if (value.kind !== KIND_PAIRING) {
    throw new Error("kind must be 24134");
  }
  if (Math.abs(value.created_at - nowSeconds) > freshnessSeconds) {
    throw new Error("created_at outside freshness window");
  }
  if (
    value.tags.length !== 1 ||
    value.tags[0]?.length !== 2 ||
    value.tags[0]?.[0] !== "p" ||
    !HEX_32.test(value.tags[0]?.[1] ?? "")
  ) {
    throw new Error("event must have exactly one p tag");
  }
  validateNip44(value.content);
  return { event: value, recipient: value.tags[0][1] as string };
}

function validateNip44(content: string): void {
  if (
    content.length > 4_096 ||
    !BASE64.test(content) ||
    content.length % 4 !== 0
  ) {
    throw new Error("content is not valid base64");
  }
  const decoded = Buffer.from(content, "base64");
  if (decoded.length < 99) {
    throw new Error("content too short for NIP-44 v2");
  }
  if (decoded[0] !== 2) {
    throw new Error("content is not NIP-44 v2");
  }
}

function validateFilter(value: unknown): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("filter must be an object");
  }
  const filter = value as Record<string, unknown>;
  if (Object.keys(filter).some((key) => key !== "kinds" && key !== "#p")) {
    throw new Error("unsupported filter field");
  }
  if (
    filter.kinds !== undefined &&
    (!Array.isArray(filter.kinds) ||
      filter.kinds.length !== 1 ||
      filter.kinds[0] !== KIND_PAIRING)
  ) {
    throw new Error("kinds must be [24134]");
  }
  if (
    !Array.isArray(filter["#p"]) ||
    filter["#p"].length !== 1 ||
    typeof filter["#p"][0] !== "string" ||
    !HEX_32.test(filter["#p"][0])
  ) {
    throw new Error(
      "#p must have exactly one 64-character lowercase hex value",
    );
  }
  return filter["#p"][0];
}

function safeEventId(value: unknown): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "";
  const id = (value as Record<string, unknown>).id;
  return typeof id === "string" && HEX_32.test(id) ? id : "";
}

function securityHeaders(): Record<string, string> {
  return {
    "Cache-Control": "no-store",
    "Content-Security-Policy": "default-src 'none'",
    "Cross-Origin-Resource-Policy": "same-site",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "invalid input";
}

function formatHost(host: string): string {
  return host.includes(":") ? `[${host}]` : host;
}

class RateWindow {
  #count = 0;
  #startedAt: number;

  public constructor(private readonly now: () => number) {
    this.#startedAt = now();
  }

  public tick(): number {
    const current = this.now();
    if (current - this.#startedAt >= 10_000) {
      this.#startedAt = current;
      this.#count = 0;
    }
    this.#count += 1;
    return this.#count;
  }
}
