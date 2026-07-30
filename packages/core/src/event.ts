import {
  finalizeEvent,
  getEventHash,
  getPublicKey,
  verifyEvent,
} from "nostr-tools/pure";

import type { NostrEvent, NostrTag, UnsignedNostrEvent } from "./types.js";

const HEX_32_BYTES = /^[0-9a-f]{64}$/;
const HEX_64_BYTES = /^[0-9a-f]{128}$/;

export function unixNow(): number {
  return Math.floor(Date.now() / 1_000);
}

export function validateEventShape(value: unknown): value is NostrEvent {
  if (typeof value !== "object" || value === null) return false;
  const event = value as Partial<NostrEvent>;
  return (
    typeof event.id === "string" &&
    HEX_32_BYTES.test(event.id) &&
    typeof event.pubkey === "string" &&
    HEX_32_BYTES.test(event.pubkey) &&
    Number.isSafeInteger(event.created_at) &&
    (event.created_at ?? -1) >= 0 &&
    Number.isSafeInteger(event.kind) &&
    (event.kind ?? -1) >= 0 &&
    Array.isArray(event.tags) &&
    event.tags.every(isNostrTag) &&
    typeof event.content === "string" &&
    typeof event.sig === "string" &&
    HEX_64_BYTES.test(event.sig)
  );
}

export function verifyNostrEvent(value: unknown): value is NostrEvent {
  if (!validateEventShape(value)) return false;
  // nostr-tools memoizes verification on event objects. Recalculate the ID
  // first so a copied or mutated previously-verified object cannot inherit a
  // stale cache marker and bypass content/tag integrity.
  if (getEventHash(value) !== value.id) return false;
  return verifyEvent(value);
}

export function calculateEventId(
  event: Omit<NostrEvent, "id" | "sig">,
): string {
  return getEventHash(event);
}

export function signNostrEvent(
  event: Omit<UnsignedNostrEvent, "pubkey">,
  secretKey: Uint8Array,
): NostrEvent {
  const signed = finalizeEvent(
    {
      ...event,
      tags: event.tags.map((tag) => [...tag] as NostrTag),
    },
    secretKey,
  );
  return signed;
}

export function publicKeyFromSecret(secretKey: Uint8Array): string {
  return getPublicKey(secretKey);
}

/**
 * Resolve the attributed author of a stored relay-signed event.
 *
 * Attribution tags are trusted only when the event is signed by the configured
 * relay identity. User-signed events always author themselves.
 */
export function effectiveEventAuthor(
  event: NostrEvent,
  relayPubkey: string | undefined,
): string {
  if (!relayPubkey || event.pubkey !== relayPubkey) return event.pubkey;
  for (const name of ["actor", "p"]) {
    const value = event.tags.find(
      (tag) =>
        tag[0] === name && tag[1] !== undefined && HEX_32_BYTES.test(tag[1]),
    )?.[1];
    if (value !== undefined) return value;
  }
  return event.pubkey;
}

function isNostrTag(value: unknown): value is NostrTag {
  return (
    Array.isArray(value) &&
    value.length >= 1 &&
    value.every((part) => typeof part === "string")
  );
}
