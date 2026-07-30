import { decodePairingQr, PairingError, PairingSession } from "@buzz/pairing";
import { verifyNostrEvent, type NostrEvent } from "@buzz/core";
import { nip19 } from "nostr-tools";

import { useAppStore } from "../state/app-store";
import { decodeNsec, normalizeRelayInput } from "./community-storage";
import { MobileRelay } from "./mobile-relay";

export type PairingViewState =
  | { readonly status: "idle" }
  | { readonly status: "connecting" }
  | { readonly status: "confirming"; readonly sasCode: string }
  | { readonly status: "transferring"; readonly sasCode: string }
  | { readonly status: "success" }
  | { readonly status: "error"; readonly message: string };

export class PairingController {
  readonly #listeners = new Set<() => void>();
  #state: PairingViewState = { status: "idle" };
  #socket: WebSocket | undefined;
  #session: PairingSession | undefined;
  #relayUrl: string | undefined;
  #pendingPayload: NostrEvent | undefined;
  #authEventId: string | undefined;
  #timeout: ReturnType<typeof setTimeout> | undefined;
  #closed = false;

  public snapshot = (): PairingViewState => this.#state;

  public subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  public async pair(rawValue: string): Promise<void> {
    if (
      this.#state.status === "connecting" ||
      this.#state.status === "confirming" ||
      this.#state.status === "transferring"
    ) {
      return;
    }
    this.#closed = false;
    const value = rawValue.trim();
    this.#set({ status: "connecting" });
    try {
      if (value.startsWith("nostrpair://")) {
        await this.#pairNipAb(value);
      } else {
        await this.#pairLegacy(value);
      }
    } catch (error) {
      this.#fail(friendlyPairingError(error));
    }
  }

  public confirmSas(): void {
    if (this.#state.status !== "confirming" || !this.#session) return;
    try {
      this.#session.confirmTargetSas();
      this.#set({
        sasCode: this.#state.sasCode,
        status: "transferring",
      });
      const pending = this.#pendingPayload;
      this.#pendingPayload = undefined;
      if (pending) void this.#handlePayload(pending);
    } catch (error) {
      this.#fail(friendlyPairingError(error));
    }
  }

  public denySas(): void {
    if (!this.#session) return;
    try {
      const event = this.#session.abort("sas_mismatch");
      if (event) this.#publish(event);
    } catch {
      // The local denial remains authoritative even if the advisory abort
      // cannot be delivered.
    }
    this.#fail("The security codes did not match. Pairing was cancelled.");
  }

  public reset(): void {
    this.#cleanup();
    this.#closed = false;
    this.#set({ status: "idle" });
  }

  public dispose(): void {
    this.#closed = true;
    this.#cleanup();
    this.#listeners.clear();
  }

  async #pairLegacy(rawValue: string): Promise<void> {
    const payload = parseLegacyPairing(rawValue);
    await validateCredentials(payload.relayUrl, payload.nsec);
    if (this.#closed) return;
    await useAppStore.getState().authenticate(payload);
    this.#set({ status: "success" });
  }

  async #pairNipAb(uri: string): Promise<void> {
    const qr = decodePairingQr(uri);
    const { offer, session } = PairingSession.target(qr);
    this.#session = session;
    this.#relayUrl = qr.relays[0];
    if (!this.#relayUrl) throw new PairingError("INVALID_QR", "no relay");
    const socket = new WebSocket(this.#relayUrl);
    this.#socket = socket;
    socket.addEventListener("message", (event) =>
      this.#handleMessage(decodeFrame(event.data)),
    );
    socket.addEventListener("close", () => {
      if (
        !this.#closed &&
        this.#state.status !== "success" &&
        this.#state.status !== "error"
      ) {
        this.#fail("The pairing relay disconnected.");
      }
    });
    socket.addEventListener("error", () => {
      if (!this.#closed) this.#fail("Could not reach the pairing relay.");
    });
    await waitForSocket(socket);
    this.#timeout = setTimeout(
      () => this.#fail("Pairing timed out. Create a new code and try again."),
      120_000,
    );
    // Authentication is challenge-driven. The offer is sent only after the
    // relay accepts the ephemeral NIP-42 identity.
    this.#pendingPayload = offer;
  }

  #handleMessage(raw: string): void {
    if (raw.length > 512 * 1024) {
      this.#fail("The pairing relay sent an oversized message.");
      return;
    }
    let value: unknown;
    try {
      value = JSON.parse(raw) as unknown;
    } catch {
      return;
    }
    if (!Array.isArray(value) || typeof value[0] !== "string") return;
    const session = this.#session;
    const relayUrl = this.#relayUrl;
    if (!session || !relayUrl) return;

    if (value[0] === "AUTH" && typeof value[1] === "string") {
      try {
        const auth = session.createAuth(value[1], relayUrl);
        this.#authEventId = auth.id;
        this.#socket?.send(JSON.stringify(["AUTH", auth]));
      } catch (error) {
        this.#fail(friendlyPairingError(error));
      }
      return;
    }
    if (
      value[0] === "OK" &&
      value[1] === this.#authEventId &&
      value[2] === true &&
      value[1] !== this.#pendingPayload?.id
    ) {
      this.#authEventId = undefined;
      const offer = this.#pendingPayload;
      if (!offer) return;
      this.#pendingPayload = undefined;
      this.#socket?.send(
        JSON.stringify([
          "REQ",
          "mobile-pairing",
          { "#p": [session.pubkey], kinds: [24_134], limit: 50 },
        ]),
      );
      this.#publish(offer);
      this.#set({
        sasCode: session.sasCode ?? "••••••",
        status: "confirming",
      });
      return;
    }
    if (
      value[0] === "OK" &&
      typeof value[1] === "string" &&
      value[2] === false
    ) {
      this.#fail(
        typeof value[3] === "string"
          ? `Pairing relay rejected the request: ${value[3].slice(0, 160)}`
          : "Pairing relay rejected the request.",
      );
      return;
    }
    if (value[0] === "CLOSED") {
      this.#fail("The pairing relay closed the secure session.");
      return;
    }
    if (
      value[0] !== "EVENT" ||
      value[1] !== "mobile-pairing" ||
      !verifyNostrEvent(value[2])
    ) {
      return;
    }
    const event = value[2];
    try {
      if (session.state === "confirming") {
        const sasCode = session.handleSasConfirm(event);
        this.#set({ sasCode, status: "confirming" });
      } else if (session.state === "awaiting_confirmation") {
        this.#pendingPayload = event;
      } else if (session.state === "transferring") {
        void this.#handlePayload(event);
      } else if (event.pubkey) {
        session.handleAbort(event);
        this.#fail("The source device cancelled pairing.");
      }
    } catch (error) {
      if (
        error instanceof PairingError &&
        error.code === "UNEXPECTED_MESSAGE"
      ) {
        try {
          session.handleAbort(event);
          this.#fail("The source device cancelled pairing.");
        } catch {
          // A message from the correct peer can arrive early; keep the state
          // machine authoritative and wait for the expected next frame.
        }
        return;
      }
      this.#fail(friendlyPairingError(error));
    }
  }

  async #handlePayload(event: NostrEvent): Promise<void> {
    const session = this.#session;
    if (!session) return;
    try {
      const payload = session.handlePayload(event);
      if (payload.type !== "custom" && payload.type !== "nsec") {
        throw new Error(`unsupported pairing payload type: ${payload.type}`);
      }
      const credentials =
        payload.type === "custom"
          ? parseCredentialObject(payload.payload)
          : parseNsecPayload(payload.payload, this.#relayUrl);
      await validateCredentials(credentials.relayUrl, credentials.nsec);
      if (this.#closed) return;
      await useAppStore.getState().authenticate(credentials);
      const complete = session.sendComplete();
      this.#publish(complete);
      this.#set({ status: "success" });
      this.#cleanup();
    } catch (error) {
      try {
        const abort = session.abort("protocol_error");
        if (abort) this.#publish(abort);
      } catch {
        // Best effort only.
      }
      this.#fail(friendlyPairingError(error));
    }
  }

  #publish(event: NostrEvent): void {
    if (this.#socket?.readyState !== WebSocket.OPEN) {
      throw new Error("pairing socket is not connected");
    }
    this.#socket.send(JSON.stringify(["EVENT", event]));
  }

  #fail(message: string): void {
    this.#cleanup();
    this.#set({ message, status: "error" });
  }

  #cleanup(disposeSession = true): void {
    if (this.#timeout) clearTimeout(this.#timeout);
    this.#timeout = undefined;
    const socket = this.#socket;
    this.#socket = undefined;
    if (socket?.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(["CLOSE", "mobile-pairing"]));
    }
    socket?.close(1000, "pairing complete");
    if (disposeSession) this.#session?.dispose();
    this.#session = undefined;
    this.#relayUrl = undefined;
    this.#pendingPayload = undefined;
    this.#authEventId = undefined;
  }

  #set(state: PairingViewState): void {
    this.#state = state;
    for (const listener of this.#listeners) listener();
  }
}

function parseLegacyPairing(value: string): {
  readonly relayUrl: string;
  readonly nsec: string;
  readonly name?: string;
} {
  const encoded = value.startsWith("buzz://")
    ? value.slice("buzz://".length)
    : value;
  if (
    !encoded ||
    encoded.length > 16_384 ||
    !/^[A-Za-z0-9_-]+={0,2}$/.test(encoded)
  ) {
    throw new TypeError("legacy pairing code is invalid");
  }
  const normalized = encoded
    .replaceAll("-", "+")
    .replaceAll("_", "/")
    .padEnd(Math.ceil(encoded.length / 4) * 4, "=");
  let decoded: string;
  try {
    const binary = atob(normalized);
    const bytes = Uint8Array.from(binary, (character) =>
      character.charCodeAt(0),
    );
    decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    bytes.fill(0);
  } catch {
    throw new TypeError("legacy pairing code cannot be decoded");
  }
  return parseCredentialObject(decoded);
}

function parseCredentialObject(payload: string): {
  readonly relayUrl: string;
  readonly nsec: string;
  readonly name?: string;
} {
  if (new TextEncoder().encode(payload).byteLength > 65_000) {
    throw new RangeError("pairing payload is too large");
  }
  let value: unknown;
  try {
    value = JSON.parse(payload) as unknown;
  } catch {
    throw new TypeError("pairing payload is invalid JSON");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("pairing payload must be an object");
  }
  const item = value as Record<string, unknown>;
  if (typeof item.relayUrl !== "string" || typeof item.nsec !== "string") {
    throw new TypeError("pairing payload is missing relay credentials");
  }
  const decoded = decodeNsec(item.nsec);
  if (!decoded) throw new TypeError("pairing payload has an invalid nsec");
  if (
    typeof item.pubkey === "string" &&
    item.pubkey.toLowerCase() !== decoded.pubkey
  ) {
    decoded.secretKey.fill(0);
    throw new Error("pairing public key does not match the device key");
  }
  decoded.secretKey.fill(0);
  return {
    nsec: item.nsec,
    relayUrl: normalizeRelayInput(item.relayUrl),
    ...(typeof item.name === "string" && item.name.trim()
      ? { name: item.name.trim().slice(0, 128) }
      : {}),
  };
}

function parseNsecPayload(
  payload: string,
  relayUrl: string | undefined,
): { readonly relayUrl: string; readonly nsec: string } {
  if (!relayUrl) throw new Error("pairing relay URL is missing");
  const decoded = nip19.decode(payload);
  if (decoded.type !== "nsec") throw new TypeError("payload is not an nsec");
  return { nsec: payload, relayUrl: normalizeRelayInput(relayUrl) };
}

async function validateCredentials(
  relayUrl: string,
  nsec: string,
): Promise<void> {
  const decoded = decodeNsec(nsec);
  if (!decoded) throw new TypeError("device key is invalid");
  const relay = new MobileRelay({
    relayUrl: normalizeRelayInput(relayUrl),
    secretKey: decoded.secretKey,
  });
  try {
    await withTimeout(
      relay.connect(),
      10_000,
      "relay authentication timed out",
    );
  } finally {
    relay.close();
    decoded.secretKey.fill(0);
  }
}

function withTimeout<T>(
  promise: Promise<T>,
  milliseconds: number,
  message: string,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(message)), milliseconds);
    promise.then(
      (value) => {
        clearTimeout(timeout);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timeout);
        reject(error);
      },
    );
  });
}

function waitForSocket(socket: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("pairing connection timed out")),
      10_000,
    );
    socket.addEventListener("open", () => {
      clearTimeout(timeout);
      resolve();
    });
    socket.addEventListener("error", () => {
      clearTimeout(timeout);
      reject(new Error("pairing connection failed"));
    });
  });
}

function decodeFrame(value: unknown): string {
  if (typeof value === "string") return value;
  if (value instanceof ArrayBuffer) return new TextDecoder().decode(value);
  if (ArrayBuffer.isView(value)) {
    return new TextDecoder().decode(
      new Uint8Array(value.buffer, value.byteOffset, value.byteLength),
    );
  }
  return "";
}

function friendlyPairingError(error: unknown): string {
  if (error instanceof PairingError) {
    if (error.code === "TRANSCRIPT_MISMATCH") {
      return "Security verification failed. The pairing transcript did not match.";
    }
    if (error.code === "SESSION_EXPIRED") {
      return "This pairing code expired. Create a new code and try again.";
    }
    return error.message;
  }
  const message = error instanceof Error ? error.message : "";
  if (/network|connect|socket|timed out/i.test(message)) {
    return "Could not reach the relay. Check your network and try again.";
  }
  return message && message.length <= 256 ? message : "Pairing failed.";
}
