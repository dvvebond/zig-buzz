import {
  KIND_PAIRING,
  signNostrEvent,
  verifyNostrEvent,
  type NostrEvent,
} from "@buzz/core";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import {
  bytesToHex,
  concatBytes,
  hexToBytes,
  randomBytes,
  utf8ToBytes,
} from "@noble/hashes/utils.js";
import { generateSecretKey, getPublicKey } from "nostr-tools/pure";
import { nip44 } from "nostr-tools";

export type PayloadType = "nsec" | "bunker" | "connect" | "custom";
export type AbortReason =
  | "sas_mismatch"
  | "user_denied"
  | "timeout"
  | "protocol_error"
  | "unknown";
export type PairingRole = "source" | "target";
export type PairingState =
  | "waiting"
  | "confirming"
  | "awaiting_confirmation"
  | "transferring"
  | "payload_exchanged"
  | "completed"
  | "aborted";

export type PairingMessage =
  | { readonly type: "offer"; readonly session_id: string; readonly version: 1 }
  | { readonly type: "sas-confirm"; readonly transcript_hash: string }
  | {
      readonly type: "payload";
      readonly payload_type: PayloadType;
      readonly payload: string;
    }
  | { readonly type: "complete"; readonly success: boolean }
  | { readonly type: "abort"; readonly reason: AbortReason };

export type PairingQrPayload = {
  readonly sourcePubkey: string;
  readonly sessionSecret: Uint8Array;
  readonly relays: readonly string[];
  readonly version: 1;
};

export class PairingError extends Error {
  public constructor(
    readonly code:
      | "INVALID_QR"
      | "INVALID_EVENT"
      | "INVALID_SESSION"
      | "TRANSCRIPT_MISMATCH"
      | "UNEXPECTED_MESSAGE"
      | "SESSION_EXPIRED",
    message: string,
  ) {
    super(message);
    this.name = "PairingError";
  }
}

export function deriveSessionId(sessionSecret: Uint8Array): Uint8Array {
  assert32(sessionSecret, "session secret");
  return hkdf32(new Uint8Array(), sessionSecret, "nostr-pair-session-id");
}

export function deriveSas(
  ecdhShared: Uint8Array,
  sessionSecret: Uint8Array,
): { readonly code: number; readonly input: Uint8Array } {
  assert32(ecdhShared, "ECDH shared secret");
  assert32(sessionSecret, "session secret");
  const input = hkdf32(sessionSecret, ecdhShared, "nostr-pair-sas-v1");
  const code =
    new DataView(input.buffer, input.byteOffset, input.byteLength).getUint32(
      0,
    ) % 1_000_000;
  return { code, input };
}

export function deriveTranscriptHash(input: {
  readonly sessionId: Uint8Array;
  readonly sourcePubkey: Uint8Array;
  readonly targetPubkey: Uint8Array;
  readonly sasInput: Uint8Array;
  readonly sessionSecret: Uint8Array;
}): Uint8Array {
  for (const [name, value] of Object.entries(input)) {
    assert32(value, name);
  }
  return hkdf32(
    input.sessionSecret,
    concatBytes(
      input.sessionId,
      input.sourcePubkey,
      input.targetPubkey,
      input.sasInput,
    ),
    "nostr-pair-transcript-v1",
  );
}

export function formatSas(code: number): string {
  if (!Number.isInteger(code) || code < 0 || code >= 1_000_000) {
    throw new TypeError("SAS code must be between 0 and 999999");
  }
  return String(code).padStart(6, "0");
}

/** Derive the raw 32-byte secp256k1 ECDH secret used by NIP-AB. */
export function deriveEcdhShared(
  secretKey: Uint8Array,
  peerPubkey: string,
): Uint8Array {
  assert32(secretKey, "secret key");
  if (secretKey.every((byte) => byte === 0)) {
    throw new PairingError("INVALID_SESSION", "secret key cannot be all zero");
  }
  return rawSharedSecret(secretKey, peerPubkey);
}

export function encodePairingQr(payload: PairingQrPayload): string {
  validateQrPayload(payload);
  const query = new URLSearchParams();
  query.set("secret", bytesToHex(payload.sessionSecret));
  for (const relay of payload.relays) query.append("relay", relay);
  query.set("v", "1");
  return `nostrpair://${payload.sourcePubkey}?${query.toString()}`;
}

export function decodePairingQr(uri: string): PairingQrPayload {
  if (uri.length > 2_048 || !uri.startsWith("nostrpair://")) {
    throw new PairingError("INVALID_QR", "invalid pairing URI");
  }
  const rest = uri.slice("nostrpair://".length);
  const separator = rest.indexOf("?");
  if (separator < 0) {
    throw new PairingError("INVALID_QR", "pairing URI has no query");
  }
  const sourcePubkey = rest.slice(0, separator);
  const query = new URLSearchParams(rest.slice(separator + 1));
  const secretHex = query.get("secret") ?? "";
  const versions = query.getAll("v");
  const relays = query.getAll("relay");
  if (
    !/^[0-9a-f]{64}$/.test(sourcePubkey) ||
    !/^[0-9a-f]{64}$/.test(secretHex) ||
    versions.length > 1 ||
    (versions[0] ?? "1") !== "1"
  ) {
    throw new PairingError("INVALID_QR", "pairing URI fields are invalid");
  }
  const sessionSecret = hexToBytes(secretHex);
  const payload: PairingQrPayload = {
    relays,
    sessionSecret,
    sourcePubkey,
    version: 1,
  };
  validateQrPayload(payload);
  return payload;
}

export class PairingSession {
  readonly #role: PairingRole;
  #state: PairingState;
  readonly #secretKey: Uint8Array;
  readonly #sessionSecret: Uint8Array;
  readonly #sessionId: Uint8Array;
  readonly #relays: readonly string[];
  readonly #createdAt: number;
  readonly #timeoutMilliseconds: number;
  readonly #processed = new Set<string>();
  #peerPubkey: string | undefined;
  #sasCode: number | undefined;
  #sasInput: Uint8Array | undefined;
  #disposed = false;

  private constructor(input: {
    readonly role: PairingRole;
    readonly secretKey: Uint8Array;
    readonly sessionSecret: Uint8Array;
    readonly relays: readonly string[];
    readonly peerPubkey?: string;
    readonly state: PairingState;
    readonly timeoutMilliseconds?: number;
  }) {
    this.#role = input.role;
    this.#state = input.state;
    this.#secretKey = Uint8Array.from(input.secretKey);
    this.#sessionSecret = Uint8Array.from(input.sessionSecret);
    this.#sessionId = deriveSessionId(this.#sessionSecret);
    this.#relays = [...input.relays];
    this.#peerPubkey = input.peerPubkey;
    this.#createdAt = Date.now();
    this.#timeoutMilliseconds = input.timeoutMilliseconds ?? 120_000;
  }

  public static source(
    relay: string,
    timeoutMilliseconds?: number,
  ): { readonly session: PairingSession; readonly qr: PairingQrPayload } {
    validateRelay(relay);
    const secretKey = generateSecretKey();
    const sessionSecret = randomBytes(32);
    const session = new PairingSession({
      relays: [relay],
      role: "source",
      secretKey,
      sessionSecret,
      state: "waiting",
      ...(timeoutMilliseconds === undefined ? {} : { timeoutMilliseconds }),
    });
    secretKey.fill(0);
    const qr: PairingQrPayload = {
      relays: [relay],
      sessionSecret: Uint8Array.from(sessionSecret),
      sourcePubkey: session.pubkey,
      version: 1,
    };
    sessionSecret.fill(0);
    return { qr, session };
  }

  public static target(
    qr: PairingQrPayload,
    timeoutMilliseconds?: number,
  ): { readonly session: PairingSession; readonly offer: NostrEvent } {
    validateQrPayload(qr);
    const secretKey = generateSecretKey();
    const session = new PairingSession({
      peerPubkey: qr.sourcePubkey,
      relays: qr.relays,
      role: "target",
      secretKey,
      sessionSecret: qr.sessionSecret,
      state: "waiting",
      ...(timeoutMilliseconds === undefined ? {} : { timeoutMilliseconds }),
    });
    secretKey.fill(0);
    session.computeSas(qr.sourcePubkey);
    const offer = session.buildEvent({
      session_id: bytesToHex(session.#sessionId),
      type: "offer",
      version: 1,
    });
    session.#state = "confirming";
    return { offer, session };
  }

  public get pubkey(): string {
    return getPublicKey(this.#secretKey);
  }

  public get state(): PairingState {
    return this.#state;
  }

  public get role(): PairingRole {
    return this.#role;
  }

  public get relays(): readonly string[] {
    return this.#relays;
  }

  public get sasCode(): string | undefined {
    return this.#sasCode === undefined ? undefined : formatSas(this.#sasCode);
  }

  public qrUri(): string | undefined {
    if (this.#role !== "source") return undefined;
    return encodePairingQr({
      relays: this.#relays,
      sessionSecret: this.#sessionSecret,
      sourcePubkey: this.pubkey,
      version: 1,
    });
  }

  /**
   * Sign a NIP-42 authentication challenge with the session's ephemeral key.
   *
   * Pairing relays learn only the short-lived pairing public key. The user's
   * durable identity is transferred later inside the SAS-bound NIP-44 payload
   * and is never exposed as relay authentication metadata.
   */
  public createAuth(challenge: string, relay: string): NostrEvent {
    this.checkLive();
    validateRelay(relay);
    if (
      typeof challenge !== "string" ||
      challenge.length === 0 ||
      utf8Length(challenge) > 4_096
    ) {
      throw new PairingError(
        "INVALID_EVENT",
        "relay authentication challenge is invalid",
      );
    }
    return signNostrEvent(
      {
        content: "",
        created_at: Math.floor(Date.now() / 1_000),
        kind: 22_242,
        tags: [
          ["relay", new URL(relay).toString()],
          ["challenge", challenge],
        ],
      },
      this.#secretKey,
    );
  }

  public handleOffer(event: NostrEvent): string {
    this.expect("source", "waiting");
    this.validateEvent(event, false);
    const message = this.decrypt(event);
    if (
      message.type !== "offer" ||
      message.version !== 1 ||
      !constantHexEqual(message.session_id, bytesToHex(this.#sessionId))
    ) {
      throw new PairingError("INVALID_SESSION", "pairing offer is invalid");
    }
    this.#peerPubkey = event.pubkey;
    this.computeSas(event.pubkey);
    this.#state = "confirming";
    this.#processed.add(event.id);
    return this.sasCode as string;
  }

  public confirmSas(): NostrEvent {
    this.expect("source", "confirming");
    const peer = this.requiredPeer();
    const hash = this.transcript(this.pubkey, peer);
    const event = this.buildEvent({
      transcript_hash: bytesToHex(hash),
      type: "sas-confirm",
    });
    this.#state = "transferring";
    return event;
  }

  public handleSasConfirm(event: NostrEvent): string {
    this.expect("target", "confirming");
    this.validateEvent(event, true);
    const message = this.decrypt(event);
    const expected = this.transcript(this.requiredPeer(), this.pubkey);
    if (
      message.type !== "sas-confirm" ||
      !constantHexEqual(message.transcript_hash, bytesToHex(expected))
    ) {
      this.#state = "aborted";
      throw new PairingError(
        "TRANSCRIPT_MISMATCH",
        "pairing transcript does not match",
      );
    }
    this.#processed.add(event.id);
    this.#state = "awaiting_confirmation";
    return this.sasCode as string;
  }

  public confirmTargetSas(): void {
    this.expect("target", "awaiting_confirmation");
    this.#state = "transferring";
  }

  public sendPayload(type: PayloadType, payload: string): NostrEvent {
    this.expect("source", "transferring");
    validatePayload(type, payload);
    const event = this.buildEvent({
      payload,
      payload_type: type,
      type: "payload",
    });
    this.#state = "payload_exchanged";
    return event;
  }

  public handlePayload(event: NostrEvent): {
    readonly type: PayloadType;
    readonly payload: string;
  } {
    this.expect("target", "transferring");
    this.validateEvent(event, true);
    const message = this.decrypt(event);
    if (message.type !== "payload") {
      throw new PairingError("UNEXPECTED_MESSAGE", "expected pairing payload");
    }
    validatePayload(message.payload_type, message.payload);
    this.#processed.add(event.id);
    this.#state = "payload_exchanged";
    return { payload: message.payload, type: message.payload_type };
  }

  public sendComplete(): NostrEvent {
    this.expect("target", "payload_exchanged");
    const event = this.buildEvent({ success: true, type: "complete" });
    this.#state = "completed";
    return event;
  }

  public handleComplete(event: NostrEvent): void {
    this.expect("source", "payload_exchanged");
    this.validateEvent(event, true);
    const message = this.decrypt(event);
    if (message.type !== "complete" || !message.success) {
      this.#state = "aborted";
      throw new PairingError(
        "UNEXPECTED_MESSAGE",
        "target did not complete pairing successfully",
      );
    }
    this.#processed.add(event.id);
    this.#state = "completed";
  }

  public abort(
    reason: Exclude<AbortReason, "unknown">,
  ): NostrEvent | undefined {
    if (this.#state === "completed" || this.#state === "aborted") {
      throw new PairingError(
        "UNEXPECTED_MESSAGE",
        "pairing session is already terminal",
      );
    }
    const event = this.#peerPubkey
      ? this.buildEvent({ reason, type: "abort" })
      : undefined;
    this.#state = "aborted";
    return event;
  }

  public handleAbort(event: NostrEvent): AbortReason {
    if (!this.#peerPubkey) {
      throw new PairingError(
        "INVALID_EVENT",
        "anonymous abort cannot end a pairing session",
      );
    }
    this.validateEvent(event, true);
    const message = this.decrypt(event);
    if (message.type !== "abort") {
      throw new PairingError("UNEXPECTED_MESSAGE", "expected abort");
    }
    this.#processed.add(event.id);
    this.#state = "aborted";
    return message.reason;
  }

  public dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#secretKey.fill(0);
    this.#sessionSecret.fill(0);
    this.#sessionId.fill(0);
    this.#sasInput?.fill(0);
    this.#sasCode = undefined;
    this.#peerPubkey = undefined;
    this.#processed.clear();
  }

  private buildEvent(message: PairingMessage): NostrEvent {
    this.checkLive();
    const peer = this.requiredPeer();
    const encoded = JSON.stringify(message);
    if (utf8Length(encoded) > 65_535) {
      throw new PairingError(
        "UNEXPECTED_MESSAGE",
        "pairing message is too large",
      );
    }
    const conversationKey = nip44.getConversationKey(this.#secretKey, peer);
    const content = nip44.v2.encrypt(encoded, conversationKey);
    conversationKey.fill(0);
    return signNostrEvent(
      {
        content,
        created_at: Math.floor(Date.now() / 1_000) - randomBelow(31),
        kind: KIND_PAIRING,
        tags: [["p", peer]],
      },
      this.#secretKey,
    );
  }

  private decrypt(event: NostrEvent): PairingMessage {
    if (event.content.length < 132 || event.content.length > 87_472) {
      throw new PairingError("INVALID_EVENT", "invalid NIP-44 payload length");
    }
    const key = nip44.getConversationKey(this.#secretKey, event.pubkey);
    let plaintext: string;
    try {
      plaintext = nip44.v2.decrypt(event.content, key);
    } catch {
      throw new PairingError(
        "INVALID_EVENT",
        "pairing message cannot be decrypted",
      );
    } finally {
      key.fill(0);
    }
    if (utf8Length(plaintext) > 65_535) {
      throw new PairingError("INVALID_EVENT", "pairing plaintext is too large");
    }
    try {
      return parseMessage(JSON.parse(plaintext) as unknown);
    } finally {
      plaintext = "";
    }
  }

  private validateEvent(event: NostrEvent, requirePeer: boolean): void {
    this.checkLive();
    if (
      !verifyNostrEvent(event) ||
      event.kind !== KIND_PAIRING ||
      this.#processed.has(event.id)
    ) {
      throw new PairingError("INVALID_EVENT", "pairing event is invalid");
    }
    const recipients = event.tags.filter(
      (tag) => tag[0] === "p" && tag.length === 2,
    );
    if (recipients.length !== 1 || recipients[0]?.[1] !== this.pubkey) {
      throw new PairingError("INVALID_EVENT", "pairing recipient is invalid");
    }
    if (requirePeer && event.pubkey !== this.requiredPeer()) {
      throw new PairingError("INVALID_EVENT", "pairing sender is invalid");
    }
  }

  private computeSas(peer: string): void {
    const shared = deriveEcdhShared(this.#secretKey, peer);
    const sas = deriveSas(shared, this.#sessionSecret);
    shared.fill(0);
    this.#sasCode = sas.code;
    this.#sasInput = sas.input;
  }

  private transcript(source: string, target: string): Uint8Array {
    if (!this.#sasInput) {
      throw new PairingError("INVALID_SESSION", "SAS was not derived");
    }
    return deriveTranscriptHash({
      sasInput: this.#sasInput,
      sessionId: this.#sessionId,
      sessionSecret: this.#sessionSecret,
      sourcePubkey: hexToBytes(source),
      targetPubkey: hexToBytes(target),
    });
  }

  private expect(role: PairingRole, state: PairingState): void {
    this.checkLive();
    if (this.#role !== role || this.#state !== state) {
      throw new PairingError(
        "UNEXPECTED_MESSAGE",
        `expected ${role}/${state}, got ${this.#role}/${this.#state}`,
      );
    }
  }

  private checkLive(): void {
    if (this.#disposed) {
      throw new PairingError("INVALID_SESSION", "pairing session was disposed");
    }
    if (Date.now() - this.#createdAt > this.#timeoutMilliseconds) {
      throw new PairingError("SESSION_EXPIRED", "pairing session expired");
    }
  }

  private requiredPeer(): string {
    if (!this.#peerPubkey) {
      throw new PairingError("INVALID_SESSION", "pairing peer is unknown");
    }
    return this.#peerPubkey;
  }
}

function hkdf32(salt: Uint8Array, ikm: Uint8Array, info: string): Uint8Array {
  return hkdf(sha256, ikm, salt, utf8ToBytes(info), 32);
}

function rawSharedSecret(secret: Uint8Array, peer: string): Uint8Array {
  if (!/^[0-9a-f]{64}$/.test(peer)) {
    throw new PairingError("INVALID_SESSION", "invalid peer public key");
  }
  try {
    return secp256k1
      .getSharedSecret(secret, hexToBytes(`02${peer}`))
      .subarray(1, 33);
  } catch {
    throw new PairingError("INVALID_SESSION", "ECDH failed");
  }
}

function validateQrPayload(payload: PairingQrPayload): void {
  if (
    payload.version !== 1 ||
    !/^[0-9a-f]{64}$/.test(payload.sourcePubkey) ||
    payload.relays.length < 1 ||
    payload.relays.length > 8
  ) {
    throw new PairingError("INVALID_QR", "pairing QR is invalid");
  }
  assert32(payload.sessionSecret, "session secret");
  if (payload.sessionSecret.every((byte) => byte === 0)) {
    throw new PairingError("INVALID_QR", "session secret cannot be all zero");
  }
  for (const relay of payload.relays) validateRelay(relay);
}

function validateRelay(value: string): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new PairingError("INVALID_QR", "pairing relay URL is invalid");
  }
  if (
    (url.protocol !== "ws:" && url.protocol !== "wss:") ||
    !url.hostname ||
    url.username ||
    url.password ||
    url.hash
  ) {
    throw new PairingError("INVALID_QR", "pairing relay URL is invalid");
  }
  if (url.protocol === "ws:" && !isLoopback(url.hostname)) {
    throw new PairingError(
      "INVALID_QR",
      "unencrypted pairing relays are allowed only on loopback",
    );
  }
}

function isLoopback(hostname: string): boolean {
  const normalized = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  return (
    normalized === "localhost" ||
    normalized === "::1" ||
    normalized.startsWith("127.")
  );
}

function validatePayload(
  type: unknown,
  payload: unknown,
): asserts type is PayloadType {
  if (
    !["nsec", "bunker", "connect", "custom"].includes(String(type)) ||
    typeof payload !== "string" ||
    !payload ||
    utf8Length(payload) > 65_000
  ) {
    throw new PairingError("UNEXPECTED_MESSAGE", "pairing payload is invalid");
  }
}

function parseMessage(value: unknown): PairingMessage {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new PairingError("INVALID_EVENT", "pairing message is invalid");
  }
  const item = value as Record<string, unknown>;
  if (
    item.type === "offer" &&
    typeof item.session_id === "string" &&
    /^[0-9a-f]{64}$/.test(item.session_id) &&
    (item.version === undefined || item.version === 1)
  ) {
    return { session_id: item.session_id, type: "offer", version: 1 };
  }
  if (
    item.type === "sas-confirm" &&
    typeof item.transcript_hash === "string" &&
    /^[0-9a-f]{64}$/.test(item.transcript_hash)
  ) {
    return { transcript_hash: item.transcript_hash, type: "sas-confirm" };
  }
  if (item.type === "payload") {
    validatePayload(item.payload_type, item.payload);
    return {
      payload: item.payload as string,
      payload_type: item.payload_type as PayloadType,
      type: "payload",
    };
  }
  if (item.type === "complete" && typeof item.success === "boolean") {
    return { success: item.success, type: "complete" };
  }
  if (item.type === "abort" && typeof item.reason === "string") {
    const reason = [
      "sas_mismatch",
      "user_denied",
      "timeout",
      "protocol_error",
    ].includes(item.reason)
      ? (item.reason as AbortReason)
      : "unknown";
    return { reason, type: "abort" };
  }
  throw new PairingError("INVALID_EVENT", "pairing message is invalid");
}

function constantHexEqual(left: string, right: string): boolean {
  if (!/^[0-9a-f]{64}$/.test(left) || !/^[0-9a-f]{64}$/.test(right)) {
    return false;
  }
  return constantBytesEqual(hexToBytes(left), hexToBytes(right));
}

function assert32(value: Uint8Array, name: string): void {
  if (value.byteLength !== 32) throw new TypeError(`${name} must be 32 bytes`);
}

function utf8Length(value: string): number {
  return utf8ToBytes(value).byteLength;
}

function constantBytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  let difference = 0;
  for (let index = 0; index < left.byteLength; index += 1) {
    difference |= (left[index] ?? 0) ^ (right[index] ?? 0);
  }
  return difference === 0;
}

function randomBelow(maximumExclusive: number): number {
  if (
    !Number.isSafeInteger(maximumExclusive) ||
    maximumExclusive < 1 ||
    maximumExclusive > 0x1_0000_0000
  ) {
    throw new RangeError("random upper bound is invalid");
  }
  const range = 0x1_0000_0000;
  const ceiling = range - (range % maximumExclusive);
  for (;;) {
    const bytes = randomBytes(4);
    const candidate = new DataView(
      bytes.buffer,
      bytes.byteOffset,
      bytes.byteLength,
    ).getUint32(0, false);
    bytes.fill(0);
    if (candidate < ceiling) return candidate % maximumExclusive;
  }
}
