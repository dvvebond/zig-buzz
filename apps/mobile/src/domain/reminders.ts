import { KIND_EVENT_REMINDER, type NostrEvent } from "@buzz/core";
import { nip44 } from "nostr-tools";

import { firstTag, validPubkey } from "./models";

const HEX_32 = /^[0-9a-f]{32}$/;
const HEX_64 = /^[0-9a-f]{64}$/;

export type ReminderTarget = {
  readonly eventId: string;
  readonly channelId: string;
  readonly preview: string;
  readonly authorPubkey: string;
};

export type ReminderStatus = "pending" | "done" | "cancelled";

export type ReminderContent = {
  readonly status: ReminderStatus;
  readonly target?: ReminderTarget;
  readonly note?: string;
};

export type Reminder = {
  readonly id: string;
  readonly notBefore?: number;
  readonly content: ReminderContent;
  readonly createdAt: number;
  readonly eventId: string;
};

export function parseNotBefore(value: string): number | undefined {
  if (!/^(0|[1-9][0-9]*)$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

export function parseReminderContent(
  plaintext: string,
): ReminderContent | undefined {
  if (new TextEncoder().encode(plaintext).byteLength > 64 * 1024) {
    return undefined;
  }
  let value: unknown;
  try {
    value = JSON.parse(plaintext) as unknown;
  } catch {
    return undefined;
  }
  if (!isRecord(value) || !isReminderStatus(value.status)) return undefined;
  const note =
    typeof value.note === "string" && value.note.length <= 8_192
      ? value.note
      : value.note === undefined
        ? undefined
        : null;
  if (note === null) return undefined;
  const target =
    value.target === undefined ? undefined : parseTarget(value.target);
  if (value.target !== undefined && !target) return undefined;
  if (!target && !note?.length) return undefined;
  return {
    status: value.status,
    ...(target ? { target } : {}),
    ...(note ? { note } : {}),
  };
}

export function encryptReminderContent(
  content: ReminderContent,
  secretKey: Uint8Array,
  pubkey: string,
): string {
  const valid = validPubkey(pubkey);
  if (!valid) throw new TypeError("invalid reminder owner pubkey");
  const conversationKey = nip44.v2.utils.getConversationKey(secretKey, valid);
  try {
    return nip44.v2.encrypt(JSON.stringify(content), conversationKey);
  } finally {
    conversationKey.fill(0);
  }
}

export function decryptReminderEvent(
  event: NostrEvent,
  secretKey: Uint8Array,
  pubkey: string,
): Reminder | undefined {
  if (event.kind !== KIND_EVENT_REMINDER || event.pubkey !== pubkey) {
    return undefined;
  }
  const id = firstTag(event, "d");
  if (!id || (!HEX_32.test(id) && id.length > 128)) return undefined;
  const conversationKey = nip44.v2.utils.getConversationKey(secretKey, pubkey);
  let plaintext: string;
  try {
    plaintext = nip44.v2.decrypt(event.content, conversationKey);
  } catch {
    return undefined;
  } finally {
    conversationKey.fill(0);
  }
  const content = parseReminderContent(plaintext);
  if (!content) return undefined;
  const rawNotBefore = firstTag(event, "not_before");
  const notBefore =
    rawNotBefore === undefined ? undefined : parseNotBefore(rawNotBefore);
  if (rawNotBefore !== undefined && notBefore === undefined) return undefined;
  return {
    content,
    createdAt: event.created_at,
    eventId: event.id,
    id,
    ...(notBefore === undefined ? {} : { notBefore }),
  };
}

export function newestReminders(
  events: readonly NostrEvent[],
  secretKey: Uint8Array,
  pubkey: string,
): readonly Reminder[] {
  const byId = new Map<string, NostrEvent>();
  for (const event of events) {
    const id = firstTag(event, "d");
    if (!id) continue;
    const current = byId.get(id);
    if (
      !current ||
      event.created_at > current.created_at ||
      (event.created_at === current.created_at && event.id > current.id)
    ) {
      byId.set(id, event);
    }
  }
  return [...byId.values()]
    .flatMap((event) => {
      const reminder = decryptReminderEvent(event, secretKey, pubkey);
      return reminder ? [reminder] : [];
    })
    .sort(
      (left, right) =>
        (left.notBefore ?? left.createdAt) -
          (right.notBefore ?? right.createdAt) ||
        left.id.localeCompare(right.id),
    );
}

export function randomReminderId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function assertReminderTarget(target: ReminderTarget): ReminderTarget {
  if (
    !HEX_64.test(target.eventId) ||
    !validPubkey(target.authorPubkey) ||
    !/^[A-Za-z0-9:._-]{1,256}$/.test(target.channelId) ||
    target.preview.length > 1_024
  ) {
    throw new TypeError("invalid reminder target");
  }
  return target;
}

function parseTarget(value: unknown): ReminderTarget | undefined {
  if (!isRecord(value)) return undefined;
  if (
    typeof value.eventId !== "string" ||
    typeof value.channelId !== "string" ||
    typeof value.preview !== "string" ||
    typeof value.authorPubkey !== "string"
  ) {
    return undefined;
  }
  try {
    return assertReminderTarget({
      authorPubkey: value.authorPubkey,
      channelId: value.channelId,
      eventId: value.eventId,
      preview: value.preview,
    });
  } catch {
    return undefined;
  }
}

function isReminderStatus(value: unknown): value is ReminderStatus {
  return value === "pending" || value === "done" || value === "cancelled";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
