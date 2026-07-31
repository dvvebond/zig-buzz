import { PairingSession } from "@buzz/pairing";
import { KIND_PAIRING, type NostrEvent } from "@buzz/core";
import WebSocket, { type RawData } from "ws";

import type { DesktopEventBus } from "./event-bus.js";
import type { IdentityService } from "./identity.js";
import { readBoundedText } from "./native-utilities.js";
import type { WorkspaceService } from "./workspace.js";

const PAIRING_SUBSCRIPTION = "pair";
const PAIRING_TIMEOUT_MS = 130_000;
const NIP11_LIMIT = 256 * 1024;
const MAX_FRAME_BYTES = 1024 * 1024;

type ActivePairing = {
  authEventId: string | undefined;
  cancelled: boolean;
  failureEmitted: boolean;
  generation: number;
  payload: string | undefined;
  session: PairingSession;
  socket: WebSocket;
  timer: NodeJS.Timeout;
};

export class PairingService {
  readonly #events: DesktopEventBus;
  readonly #identity: IdentityService;
  readonly #workspace: Pick<WorkspaceService, "relayHttpUrl" | "relayUrl">;
  #active: ActivePairing | undefined;
  #generation = 0;

  constructor(input: {
    events: DesktopEventBus;
    identity: IdentityService;
    workspace: Pick<WorkspaceService, "relayHttpUrl" | "relayUrl">;
  }) {
    this.#events = input.events;
    this.#identity = input.identity;
    this.#workspace = input.workspace;
  }

  async start(): Promise<string> {
    await this.cancel();
    const generation = ++this.#generation;
    const relayUrl = await resolvePairingRelay(this.#workspace.relayUrl());
    const { session } = PairingSession.source(relayUrl, PAIRING_TIMEOUT_MS);
    const qr = session.qrUri();
    if (!qr) {
      session.dispose();
      throw new Error("failed to create pairing QR payload");
    }
    const payload = JSON.stringify({
      nsec: this.#identity.nsec(),
      pubkey: this.#identity.info().pubkey,
      relayUrl: this.#workspace.relayHttpUrl(),
    });
    const socket = new WebSocket(relayUrl, {
      followRedirects: false,
      handshakeTimeout: 10_000,
      maxPayload: MAX_FRAME_BYTES,
      perMessageDeflate: false,
    });
    const timer = setTimeout(() => {
      const active = this.#active;
      if (!active || active.generation !== generation) return;
      this.#events.emit("pairing-error", { message: "Session timed out" });
      this.#finish(active, 4_000, "pairing session timed out");
    }, PAIRING_TIMEOUT_MS);
    timer.unref();
    const active: ActivePairing = {
      authEventId: undefined,
      cancelled: false,
      failureEmitted: false,
      generation,
      payload,
      session,
      socket,
      timer,
    };
    this.#active = active;
    this.#attach(active);
    try {
      await waitForOpen(socket);
    } catch (error) {
      if (this.#active === active) this.#finish(active);
      throw new Error(`pairing relay connection failed: ${safeError(error)}`);
    }
    if (this.#active !== active || active.cancelled) {
      throw new Error("pairing session was cancelled");
    }
    this.#subscribe(active);
    return qr;
  }

  async confirmSas(): Promise<void> {
    const active = this.#requireActive();
    if (active.socket.readyState !== WebSocket.OPEN) {
      throw new Error("pairing relay connection is not open");
    }
    const confirmation = active.session.confirmSas();
    const payload = active.payload;
    if (!payload) throw new Error("no pairing payload is prepared");
    active.payload = undefined;
    const credentialEvent = active.session.sendPayload("custom", payload);
    await sendJson(active.socket, ["EVENT", confirmation]);
    await sendJson(active.socket, ["EVENT", credentialEvent]);
  }

  async cancel(): Promise<void> {
    const active = this.#active;
    if (!active) return;
    active.cancelled = true;
    this.#generation += 1;
    try {
      const event = active.session.abort("user_denied");
      if (event && active.socket.readyState === WebSocket.OPEN) {
        await sendJson(active.socket, ["EVENT", event]).catch(() => undefined);
      }
    } catch {
      // A completed or already-aborted session has nothing left to publish.
    }
    this.#finish(active, 1_000, "pairing cancelled");
  }

  async shutdown(): Promise<void> {
    await this.cancel();
  }

  #attach(active: ActivePairing): void {
    active.socket.on("message", (data, isBinary) => {
      if (isBinary || this.#active !== active || active.cancelled) return;
      if (rawDataLength(data) > MAX_FRAME_BYTES) {
        this.#fail(active, "pairing relay sent an oversized frame");
        return;
      }
      this.#handleMessage(active, rawDataText(data));
    });
    active.socket.once("error", (error) => {
      if (this.#active === active && !active.cancelled) {
        this.#fail(active, `pairing relay error: ${safeError(error)}`);
      }
    });
    active.socket.once("close", (code, reason) => {
      if (this.#active !== active) return;
      if (!active.cancelled && active.session.state !== "completed") {
        this.#fail(
          active,
          `pairing relay closed (${code}${reason.length ? `: ${reason.toString("utf8")}` : ""})`,
        );
      } else {
        this.#finish(active);
      }
    });
  }

  #handleMessage(active: ActivePairing, text: string): void {
    let frame: unknown;
    try {
      frame = JSON.parse(text) as unknown;
    } catch {
      return;
    }
    if (!Array.isArray(frame) || typeof frame[0] !== "string") return;
    if (frame[0] === "AUTH" && typeof frame[1] === "string") {
      try {
        const event = active.session.createAuth(frame[1], active.socket.url);
        active.authEventId = event.id;
        void sendJson(active.socket, ["AUTH", event]).catch((error) => {
          this.#fail(
            active,
            `pairing authentication failed: ${safeError(error)}`,
          );
        });
      } catch (error) {
        this.#fail(
          active,
          `pairing authentication failed: ${safeError(error)}`,
        );
      }
      return;
    }
    if (
      frame[0] === "OK" &&
      frame[1] === active.authEventId &&
      frame[2] === true
    ) {
      this.#subscribe(active);
      return;
    }
    if (
      frame[0] !== "EVENT" ||
      frame[1] !== PAIRING_SUBSCRIPTION ||
      !isNostrEvent(frame[2])
    ) {
      return;
    }
    const event = frame[2];
    try {
      if (active.session.state === "waiting") {
        const sas = active.session.handleOffer(event);
        this.#events.emit("pairing-sas-received", { sas });
        return;
      }
      try {
        const reason = active.session.handleAbort(event);
        this.#events.emit("pairing-aborted", { reason });
        this.#finish(active, 1_000, "pairing aborted");
        return;
      } catch {
        // It may be the expected completion message instead.
      }
      if (active.session.state === "payload_exchanged") {
        active.session.handleComplete(event);
        this.#events.emit("pairing-complete", {});
        this.#finish(active, 1_000, "pairing complete");
      }
    } catch {
      // Pairing subscriptions are public inboxes. Invalid, replayed, or
      // out-of-state events are untrusted noise and must not end the session.
    }
  }

  #subscribe(active: ActivePairing): void {
    if (
      this.#active !== active ||
      active.socket.readyState !== WebSocket.OPEN
    ) {
      return;
    }
    void sendJson(active.socket, [
      "REQ",
      PAIRING_SUBSCRIPTION,
      { "#p": [active.session.pubkey], kinds: [KIND_PAIRING] },
    ]).catch((error) => {
      this.#fail(active, `pairing subscription failed: ${safeError(error)}`);
    });
  }

  #requireActive(): ActivePairing {
    const active = this.#active;
    if (!active || active.cancelled) {
      throw new Error("no active pairing session");
    }
    return active;
  }

  #fail(active: ActivePairing, message: string): void {
    if (this.#active !== active || active.failureEmitted || active.cancelled) {
      return;
    }
    active.failureEmitted = true;
    this.#events.emit("pairing-error", { message });
    this.#finish(active, 4_000, "pairing failed");
  }

  #finish(active: ActivePairing, code = 1_000, reason = "pairing ended"): void {
    if (this.#active === active) this.#active = undefined;
    clearTimeout(active.timer);
    active.payload = undefined;
    active.session.dispose();
    if (
      active.socket.readyState === WebSocket.OPEN ||
      active.socket.readyState === WebSocket.CONNECTING
    ) {
      active.socket.close(code, reason);
    }
  }
}

export async function resolvePairingRelay(mainRelay: string): Promise<string> {
  const main = validatePairingRelayUrl(mainRelay);
  let document: Record<string, unknown> | undefined;
  try {
    const http = new URL(main);
    http.protocol = http.protocol === "wss:" ? "https:" : "http:";
    const response = await fetch(http, {
      headers: { Accept: "application/nostr+json" },
      redirect: "manual",
      signal: AbortSignal.timeout(5_000),
    });
    if (response.ok) {
      const parsed: unknown = JSON.parse(
        await readBoundedText(response, NIP11_LIMIT, "relay NIP-11 document"),
      );
      if (isRecord(parsed)) document = parsed;
    }
  } catch {
    // NIP-11 discovery is an optional compatibility hint.
  }
  if (typeof document?.pairing_relay_url === "string") {
    try {
      return validatePairingRelayUrl(document.pairing_relay_url);
    } catch {
      // Invalid advertised routes are ignored rather than placed in the QR.
    }
  }
  if (
    Array.isArray(document?.supported_nips) &&
    document.supported_nips.includes(43)
  ) {
    const legacy = new URL(main);
    legacy.pathname = `${legacy.pathname.replace(/\/+$/, "")}/pair`;
    return validatePairingRelayUrl(legacy.toString());
  }
  return main;
}

function validatePairingRelayUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("pairing relay URL is invalid");
  }
  if (
    (url.protocol !== "wss:" &&
      !(url.protocol === "ws:" && isLoopback(url.hostname))) ||
    !url.hostname ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error(
      "remote pairing relays must use wss and may not contain credentials, query, or fragment",
    );
  }
  return url.toString();
}

function isLoopback(hostname: string): boolean {
  const value = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  return value === "localhost" || value === "::1" || value.startsWith("127.");
}

function waitForOpen(socket: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    const onOpen = (): void => {
      cleanup();
      resolve();
    };
    const onError = (error: Error): void => {
      cleanup();
      reject(error);
    };
    const onClose = (): void => {
      cleanup();
      reject(new Error("connection closed before opening"));
    };
    const cleanup = (): void => {
      socket.off("open", onOpen);
      socket.off("error", onError);
      socket.off("close", onClose);
    };
    socket.once("open", onOpen);
    socket.once("error", onError);
    socket.once("close", onClose);
  });
}

function sendJson(socket: WebSocket, value: unknown): Promise<void> {
  const encoded = JSON.stringify(value);
  if (Buffer.byteLength(encoded, "utf8") > MAX_FRAME_BYTES) {
    return Promise.reject(new Error("pairing frame exceeds the 1 MiB limit"));
  }
  return new Promise((resolve, reject) => {
    socket.send(encoded, (error) => (error ? reject(error) : resolve()));
  });
}

function rawDataLength(data: RawData): number {
  if (Array.isArray(data)) {
    return data.reduce((total, part) => total + part.byteLength, 0);
  }
  return data.byteLength;
}

function rawDataText(data: RawData): string {
  if (Array.isArray(data)) {
    return Buffer.concat(data.map((part) => Buffer.from(part))).toString(
      "utf8",
    );
  }
  if (data instanceof ArrayBuffer) {
    return Buffer.from(new Uint8Array(data)).toString("utf8");
  }
  return Buffer.from(data).toString("utf8");
}

function isNostrEvent(value: unknown): value is NostrEvent {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.pubkey === "string" &&
    typeof value.created_at === "number" &&
    typeof value.kind === "number" &&
    Array.isArray(value.tags) &&
    typeof value.content === "string" &&
    typeof value.sig === "string"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safeError(error: unknown): string {
  return error instanceof Error ? error.message : "unknown transport error";
}
