import { nip44, verifyEvent } from "nostr-tools";

import type { NostrEvent } from "@buzz/core";

const HEX_64 = /^[0-9a-f]{64}$/;
const MAX_PLAINTEXT_BYTES = 512 * 1024;

export function encryptPrivateState(
  secretKey: Uint8Array,
  pubkey: string,
  value: unknown,
): string {
  if (!HEX_64.test(pubkey)) throw new TypeError("invalid private-state pubkey");
  const plaintext = JSON.stringify(value);
  if (new TextEncoder().encode(plaintext).byteLength > MAX_PLAINTEXT_BYTES) {
    throw new RangeError("private state exceeds its encryption budget");
  }
  const conversationKey = nip44.v2.utils.getConversationKey(secretKey, pubkey);
  try {
    return nip44.v2.encrypt(plaintext, conversationKey);
  } finally {
    conversationKey.fill(0);
  }
}

export function decryptPrivateState(
  secretKey: Uint8Array,
  event: NostrEvent,
  ownerPubkey: string,
): unknown {
  if (
    event.pubkey !== ownerPubkey ||
    !HEX_64.test(ownerPubkey) ||
    !verifyEvent(event)
  ) {
    throw new TypeError("invalid private-state event");
  }
  const conversationKey = nip44.v2.utils.getConversationKey(
    secretKey,
    event.pubkey,
  );
  try {
    const plaintext = nip44.v2.decrypt(event.content, conversationKey);
    if (new TextEncoder().encode(plaintext).byteLength > MAX_PLAINTEXT_BYTES) {
      throw new RangeError("private state exceeds its decryption budget");
    }
    return JSON.parse(plaintext) as unknown;
  } finally {
    conversationKey.fill(0);
  }
}
