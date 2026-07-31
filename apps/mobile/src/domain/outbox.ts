import { verifyEvent } from "nostr-tools";

import type { NostrEvent } from "@buzz/core";

export const OUTBOX_MAX_EVENTS = 500;
export const OUTBOX_MAX_BYTES = 3 * 1024 * 1024;

export function parseOutbox(raw: string | null): readonly NostrEvent[] {
  if (!raw || new TextEncoder().encode(raw).byteLength > OUTBOX_MAX_BYTES) {
    return [];
  }
  try {
    const value = JSON.parse(raw) as unknown;
    if (!Array.isArray(value)) return [];
    const byId = new Map<string, NostrEvent>();
    for (const item of value.slice(-OUTBOX_MAX_EVENTS)) {
      if (!looksLikeEvent(item) || !verifyEvent(item)) continue;
      byId.set(item.id, item);
    }
    return capOutbox([...byId.values()]);
  } catch {
    return [];
  }
}

export function capOutbox(
  events: readonly NostrEvent[],
): readonly NostrEvent[] {
  return [...events]
    .sort(
      (left, right) =>
        left.created_at - right.created_at || left.id.localeCompare(right.id),
    )
    .slice(-OUTBOX_MAX_EVENTS);
}

export function encodeOutbox(events: readonly NostrEvent[]): string {
  const encoded = JSON.stringify(capOutbox(events));
  if (new TextEncoder().encode(encoded).byteLength > OUTBOX_MAX_BYTES) {
    throw new RangeError("signed event outbox exceeds its storage budget");
  }
  return encoded;
}

function looksLikeEvent(value: unknown): value is NostrEvent {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const event = value as Partial<NostrEvent>;
  return (
    typeof event.id === "string" &&
    typeof event.pubkey === "string" &&
    typeof event.created_at === "number" &&
    typeof event.kind === "number" &&
    Array.isArray(event.tags) &&
    typeof event.content === "string" &&
    typeof event.sig === "string"
  );
}
