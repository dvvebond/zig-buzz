import { createHash } from "node:crypto";

import { schnorr } from "@noble/curves/secp256k1.js";
import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
  nip19,
  nip44,
  verifyEvent,
  type Event,
} from "nostr-tools";

import type { DesktopState } from "./secure-store.js";

const HEX_SECRET = /^[0-9a-f]{64}$/;
const MAX_CONTENT_BYTES = 256 * 1024;
const MAX_TAGS = 2_048;
const MAX_TAG_PART_BYTES = 16 * 1024;

export type IdentityInfo = {
  display_name: string;
  locked: false;
  lost: boolean;
  pubkey: string;
  reset_failed: false;
};

export class IdentityService {
  #state: DesktopState;
  #lost: boolean;
  readonly #persist: (state: DesktopState) => Promise<void>;

  private constructor(
    state: DesktopState,
    lost: boolean,
    persist: (state: DesktopState) => Promise<void>,
  ) {
    this.#state = state;
    this.#lost = lost;
    this.#persist = persist;
  }

  static create(
    stored: DesktopState | undefined,
    persist: (state: DesktopState) => Promise<void>,
  ): IdentityService {
    if (stored) return new IdentityService(stored, false, persist);
    const secret = generateSecretKey();
    return new IdentityService(
      {
        identitySecretHex: Buffer.from(secret).toString("hex"),
        settings: {},
      },
      true,
      persist,
    );
  }

  info(): IdentityInfo {
    const pubkey = getPublicKey(this.#secret());
    const npub = nip19.npubEncode(pubkey);
    return {
      display_name:
        npub.length > 16 ? `${npub.slice(0, 10)}…${npub.slice(-4)}` : npub,
      locked: false,
      lost: this.#lost,
      pubkey,
      reset_failed: false,
    };
  }

  nsec(): string {
    return nip19.nsecEncode(this.#secret());
  }

  async import(nsec: string): Promise<IdentityInfo> {
    const secret = decodeSecret(nsec);
    this.#state = {
      ...this.#state,
      identitySecretHex: Buffer.from(secret).toString("hex"),
    };
    await this.#persist(this.#state);
    this.#lost = false;
    return this.info();
  }

  async persistCurrent(): Promise<IdentityInfo> {
    if (!this.#lost) throw new Error("identity is not in a lost state");
    await this.#persist(this.#state);
    this.#lost = false;
    return this.info();
  }

  sign(input: Record<string, unknown>): Event {
    const kind = requireInteger(input.kind, "kind", 0, 65_535);
    const content = requireString(input.content, "content", MAX_CONTENT_BYTES);
    const createdAtRaw = input.createdAt ?? input.created_at;
    const created_at =
      createdAtRaw === undefined
        ? Math.floor(Date.now() / 1_000)
        : requireInteger(createdAtRaw, "createdAt", 0, Number.MAX_SAFE_INTEGER);
    const tags = parseTags(input.tags);
    return finalizeEvent({ content, created_at, kind, tags }, this.#secret());
  }

  createAuth(challenge: unknown, relayUrl: unknown): Event {
    const challengeValue = requireString(challenge, "challenge", 4_096);
    const relay = requireRelayUrl(relayUrl);
    return this.sign({
      content: "",
      kind: 22_242,
      tags: [
        ["relay", relay],
        ["challenge", challengeValue],
      ],
    });
  }

  encryptToSelf(plaintext: unknown): string {
    const value = requireString(plaintext, "plaintext", MAX_CONTENT_BYTES);
    const secret = this.#secret();
    const conversationKey = nip44.v2.utils.getConversationKey(
      secret,
      getPublicKey(secret),
    );
    return nip44.v2.encrypt(value, conversationKey);
  }

  decryptFromSelf(ciphertext: unknown): string {
    const value = requireString(
      ciphertext,
      "ciphertext",
      MAX_CONTENT_BYTES * 2,
    );
    const secret = this.#secret();
    const conversationKey = nip44.v2.utils.getConversationKey(
      secret,
      getPublicKey(secret),
    );
    return nip44.v2.decrypt(value, conversationKey);
  }

  decryptFromPeer(peerPubkey: unknown, ciphertext: unknown): string {
    const peer = requirePubkey(peerPubkey, "peerPubkey");
    const value = requireString(
      ciphertext,
      "ciphertext",
      MAX_CONTENT_BYTES * 2,
    );
    const conversationKey = nip44.v2.utils.getConversationKey(
      this.#secret(),
      peer,
    );
    return nip44.v2.decrypt(value, conversationKey);
  }

  buildObserverControlEvent(
    agentPubkeyValue: unknown,
    payload: unknown,
  ): Event {
    const agentPubkey = requirePubkey(agentPubkeyValue, "agentPubkey");
    const plaintext = stringifyPayload(payload, "payload", 65_535);
    const conversationKey = nip44.v2.utils.getConversationKey(
      this.#secret(),
      agentPubkey,
    );
    const ciphertext = nip44.v2.encrypt(plaintext, conversationKey);
    if (ciphertext.length < 132 || ciphertext.length > 87_472) {
      throw new Error(
        "observer control ciphertext is outside the NIP-44 envelope",
      );
    }
    return this.sign({
      content: ciphertext,
      kind: 24_200,
      tags: [
        ["p", agentPubkey],
        ["agent", agentPubkey],
        ["frame", "control"],
      ],
    });
  }

  signIdentityBinding(args: Record<string, unknown>): Event {
    const challengeId = requireUuid(args.challengeId, "challengeId");
    const nonce = requirePattern(args.nonce, "nonce", /^[A-Za-z0-9_-]{43}$/);
    const verificationCode = requirePattern(
      args.verificationCode,
      "verificationCode",
      /^[0-9]{6}$/,
    );
    const origin = requireHttpsOrigin(args.origin);
    const expiresAt = requireFutureRfc3339(args.expiresAt);
    return this.sign({
      content: "",
      kind: 24_243,
      tags: [
        ["challenge_id", challengeId],
        ["nonce", nonce],
        ["verification_code", verificationCode],
        ["audience", "buzz:nostr-identity"],
        ["action", "bind_nostr_identity"],
        ["protocol", "buzz-nostr-identity"],
        ["version", "1"],
        ["origin", origin],
        ["expires_at", expiresAt],
      ],
    });
  }

  conversationKey(peerPubkey: unknown): Uint8Array {
    const peer = requirePubkey(peerPubkey, "peerPubkey");
    return Uint8Array.from(
      nip44.v2.utils.getConversationKey(this.#secret(), peer),
    );
  }

  decryptObserverEvent(eventJson: unknown): unknown {
    const raw = requireString(eventJson, "eventJson", MAX_CONTENT_BYTES * 2);
    const parsed: unknown = JSON.parse(raw);
    if (!isEvent(parsed) || !verifyEvent(parsed)) {
      throw new Error("observer event has an invalid ID or signature");
    }
    const conversationKey = nip44.v2.utils.getConversationKey(
      this.#secret(),
      parsed.pubkey,
    );
    return JSON.parse(nip44.v2.decrypt(parsed.content, conversationKey));
  }

  setting<T>(key: string, fallback: T): T {
    const value = this.#state.settings[key];
    return structuredClone(value === undefined ? fallback : (value as T));
  }

  async setSetting(key: string, value: unknown): Promise<void> {
    if (!/^[a-z][a-z0-9_.-]{0,127}$/.test(key)) {
      throw new Error("setting key has an invalid format");
    }
    const cloned = structuredClone(value);
    this.#state = {
      ...this.#state,
      settings: { ...this.#state.settings, [key]: cloned },
    };
    await this.#persist(this.#state);
  }

  ownerAuthTag(
    agentPubkey: string,
    conditions = "",
  ): [string, string, string, string] {
    if (!/^[0-9a-f]{64}$/.test(agentPubkey)) {
      throw new Error(
        "agent pubkey must be 64 lowercase hexadecimal characters",
      );
    }
    const ownerPubkey = this.info().pubkey;
    if (ownerPubkey === agentPubkey) {
      throw new Error("owner and agent pubkeys must differ");
    }
    if (
      conditions !== "" &&
      !/^(?:(?:kind=(?:0|[1-9][0-9]{0,4})|created_at[<>](?:0|[1-9][0-9]{0,9}))(?:&|$))+$/.test(
        conditions,
      )
    ) {
      throw new Error("NIP-OA conditions are malformed");
    }
    const digest = createHash("sha256")
      .update(`nostr:agent-auth:${agentPubkey}:${conditions}`, "utf8")
      .digest();
    const signature = Buffer.from(
      schnorr.sign(digest, this.#secret()),
    ).toString("hex");
    return ["auth", ownerPubkey, conditions, signature];
  }

  #secret(): Uint8Array {
    return new Uint8Array(Buffer.from(this.#state.identitySecretHex, "hex"));
  }
}

function decodeSecret(value: string): Uint8Array {
  const trimmed = value.trim();
  if (HEX_SECRET.test(trimmed)) {
    return new Uint8Array(Buffer.from(trimmed, "hex"));
  }
  const decoded = nip19.decode(trimmed);
  if (decoded.type !== "nsec" || !(decoded.data instanceof Uint8Array)) {
    throw new Error("Invalid private key: expected nsec or 64 lowercase hex");
  }
  return decoded.data;
}

function parseTags(value: unknown): string[][] {
  if (!Array.isArray(value) || value.length > MAX_TAGS) {
    throw new Error(`tags must be an array with at most ${MAX_TAGS} entries`);
  }
  return value.map((tag, tagIndex) => {
    if (!Array.isArray(tag) || tag.length === 0 || tag.length > 128) {
      throw new Error(`tags[${tagIndex}] must contain 1 to 128 strings`);
    }
    return tag.map((part, partIndex) =>
      requireString(
        part,
        `tags[${tagIndex}][${partIndex}]`,
        MAX_TAG_PART_BYTES,
      ),
    );
  });
}

function requireString(value: unknown, name: string, maxBytes: number): string {
  if (typeof value !== "string") throw new Error(`${name} must be a string`);
  if (Buffer.byteLength(value, "utf8") > maxBytes) {
    throw new Error(`${name} exceeds the ${maxBytes} byte limit`);
  }
  return value;
}

function requirePubkey(value: unknown, name: string): string {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) {
    throw new Error(`${name} must be 64 lowercase hexadecimal characters`);
  }
  return value;
}

function requireInteger(
  value: unknown,
  name: string,
  minimum: number,
  maximum: number,
): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > maximum
  ) {
    throw new Error(`${name} must be an integer from ${minimum} to ${maximum}`);
  }
  return value;
}

function requireRelayUrl(value: unknown): string {
  const raw = requireString(value, "relayUrl", 4_096).trim();
  const parsed = new URL(raw);
  if (parsed.protocol !== "ws:" && parsed.protocol !== "wss:") {
    throw new Error("relayUrl must use ws: or wss:");
  }
  if (parsed.username || parsed.password || parsed.hash) {
    throw new Error("relayUrl may not contain credentials or a fragment");
  }
  return raw;
}

function stringifyPayload(
  value: unknown,
  name: string,
  maximumBytes: number,
): string {
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw new Error(`${name} must be JSON serializable`);
  }
  if (serialized === undefined) {
    throw new Error(`${name} must be JSON serializable`);
  }
  if (Buffer.byteLength(serialized, "utf8") > maximumBytes) {
    throw new Error(`${name} exceeds the ${maximumBytes} byte limit`);
  }
  return serialized;
}

function requireUuid(value: unknown, name: string): string {
  if (
    typeof value !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      value,
    )
  ) {
    throw new Error(`${name} must be a UUID`);
  }
  return value.toLowerCase();
}

function requirePattern(value: unknown, name: string, pattern: RegExp): string {
  if (typeof value !== "string" || !pattern.test(value)) {
    throw new Error(`${name} is invalid`);
  }
  return value;
}

function requireHttpsOrigin(value: unknown): string {
  if (typeof value !== "string" || value.length > 2_048) {
    throw new Error("origin is invalid");
  }
  let origin: URL;
  try {
    origin = new URL(value);
  } catch {
    throw new Error("origin is invalid");
  }
  if (
    origin.protocol !== "https:" ||
    origin.username ||
    origin.password ||
    origin.pathname !== "/" ||
    origin.search ||
    origin.hash ||
    !origin.hostname
  ) {
    throw new Error(
      "origin must be an HTTPS origin without credentials, path, query, or fragment",
    );
  }
  return value;
}

function requireFutureRfc3339(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length > 128 ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(
      value,
    )
  ) {
    throw new Error("expiresAt must be an RFC 3339 timestamp");
  }
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp) || timestamp <= Date.now()) {
    throw new Error("expiresAt is expired or invalid");
  }
  return value;
}

function isEvent(value: unknown): value is Event {
  return (
    typeof value === "object" &&
    value !== null &&
    "pubkey" in value &&
    typeof value.pubkey === "string" &&
    "content" in value &&
    typeof value.content === "string" &&
    "id" in value &&
    typeof value.id === "string" &&
    "sig" in value &&
    typeof value.sig === "string" &&
    "tags" in value &&
    Array.isArray(value.tags) &&
    "kind" in value &&
    typeof value.kind === "number" &&
    "created_at" in value &&
    typeof value.created_at === "number"
  );
}
