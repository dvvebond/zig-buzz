import { nip44, verifyEvent } from "nostr-tools";

import { KIND_AGENT_OBSERVER_FRAME } from "./kinds.js";
import { signNostrEvent } from "./event.js";
import type { NostrEvent } from "./types.js";

export const OBSERVER_AGENT_TAG = "agent";
export const OBSERVER_FRAME_TAG = "frame";
export const OBSERVER_FRAME_TELEMETRY = "telemetry";
export const OBSERVER_FRAME_CONTROL = "control";
export const OBSERVER_MAX_PLAINTEXT_BYTES = 65_535;
export const NIP44_MIN_CONTENT_LENGTH = 132;
export const NIP44_MAX_CONTENT_LENGTH = 87_472;

const HEX_64 = /^[0-9a-f]{64}$/i;

export function observerContentLooksEncrypted(content: string): boolean {
  return (
    content.length >= NIP44_MIN_CONTENT_LENGTH &&
    content.length <= NIP44_MAX_CONTENT_LENGTH
  );
}

export function encryptObserverPayload(
  senderSecretKey: Uint8Array,
  recipientPubkey: string,
  payload: unknown,
): string {
  assertPubkey(recipientPubkey, "recipientPubkey");
  const plaintext = JSON.stringify(payload);
  const size = utf8Length(plaintext);
  if (size > OBSERVER_MAX_PLAINTEXT_BYTES) {
    throw new RangeError(
      `observer plaintext exceeds ${OBSERVER_MAX_PLAINTEXT_BYTES} bytes (got ${size})`,
    );
  }
  const conversationKey = nip44.v2.utils.getConversationKey(
    senderSecretKey,
    recipientPubkey,
  );
  try {
    const ciphertext = nip44.v2.encrypt(plaintext, conversationKey);
    if (!observerContentLooksEncrypted(ciphertext)) {
      throw new RangeError(
        "observer ciphertext is outside the NIP-44 envelope",
      );
    }
    return ciphertext;
  } finally {
    conversationKey.fill(0);
  }
}

export function decryptObserverPayload<T = unknown>(
  recipientSecretKey: Uint8Array,
  event: NostrEvent,
): T {
  if (!verifyEvent(event)) {
    throw new TypeError("observer event has an invalid ID or signature");
  }
  if (!observerContentLooksEncrypted(event.content)) {
    throw new TypeError(
      `invalid NIP-44 ciphertext length: ${event.content.length}`,
    );
  }
  const conversationKey = nip44.v2.utils.getConversationKey(
    recipientSecretKey,
    event.pubkey,
  );
  try {
    const plaintext = nip44.v2.decrypt(event.content, conversationKey);
    const size = utf8Length(plaintext);
    if (size > OBSERVER_MAX_PLAINTEXT_BYTES) {
      throw new RangeError(
        `observer plaintext exceeds ${OBSERVER_MAX_PLAINTEXT_BYTES} bytes (got ${size})`,
      );
    }
    return JSON.parse(plaintext) as T;
  } finally {
    conversationKey.fill(0);
  }
}

export function buildObserverFrame(input: {
  readonly agentPubkey: string;
  readonly content: string;
  readonly frame: "telemetry" | "control";
  readonly recipientPubkey: string;
  readonly secretKey: Uint8Array;
  readonly createdAt?: number;
}): NostrEvent {
  assertPubkey(input.agentPubkey, "agentPubkey");
  assertPubkey(input.recipientPubkey, "recipientPubkey");
  if (!observerContentLooksEncrypted(input.content)) {
    throw new TypeError("observer content is outside the NIP-44 envelope");
  }
  return signNostrEvent(
    {
      content: input.content,
      created_at: input.createdAt ?? Math.floor(Date.now() / 1_000),
      kind: KIND_AGENT_OBSERVER_FRAME,
      tags: [
        ["p", input.recipientPubkey.toLowerCase()],
        [OBSERVER_AGENT_TAG, input.agentPubkey.toLowerCase()],
        [OBSERVER_FRAME_TAG, input.frame],
      ],
    },
    input.secretKey,
  );
}

function assertPubkey(value: string, name: string): void {
  if (!HEX_64.test(value)) {
    throw new TypeError(`${name} must be a 64-character hexadecimal pubkey`);
  }
}

function utf8Length(value: string): number {
  let length = 0;
  for (const character of value) {
    const point = character.codePointAt(0) as number;
    length += point <= 0x7f ? 1 : point <= 0x7ff ? 2 : point <= 0xffff ? 3 : 4;
  }
  return length;
}
