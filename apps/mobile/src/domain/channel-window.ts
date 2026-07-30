import {
  KIND_THREAD_SUMMARY,
  KIND_WINDOW_BOUNDS,
  type NostrEvent,
} from "@buzz/core";

import { firstTag } from "./models";

export type ChannelCursor = {
  readonly createdAt: number;
  readonly eventId: string;
};

export type ThreadSummary = {
  readonly replyCount: number;
  readonly descendantCount: number;
  readonly lastReplyAt?: number;
  readonly participantPubkeys: readonly string[];
};

export type ChannelWindowPage = {
  readonly events: readonly NostrEvent[];
  readonly summaries: ReadonlyMap<string, ThreadSummary>;
  readonly nextCursor?: ChannelCursor;
  readonly hasMore: boolean;
};

const HEX_64 = /^[0-9a-f]{64}$/;

export function parseChannelWindow(
  events: readonly NostrEvent[],
  channelId: string,
  cursor?: ChannelCursor,
): ChannelWindowPage {
  const bounds = events.filter((event) => event.kind === KIND_WINDOW_BOUNDS);
  if (bounds.length !== 1) {
    throw new Error("channel window requires exactly one bounds event");
  }
  const boundsEvent = bounds[0] as NostrEvent;
  const suffix = cursor
    ? `${cursor.createdAt}:${cursor.eventId.toLowerCase()}`
    : "head";
  if (
    firstTag(boundsEvent, "d") !== `${channelId.toLowerCase()}:${suffix}` ||
    firstTag(boundsEvent, "h")?.toLowerCase() !== channelId.toLowerCase()
  ) {
    throw new Error("channel window bounds do not match the request");
  }
  const payload = jsonRecord(boundsEvent.content);
  const hasMore = payload.has_more;
  if (typeof hasMore !== "boolean") {
    throw new Error("channel window has invalid has_more");
  }
  const nextCursor = parseCursor(payload.next_cursor);
  if (hasMore !== (nextCursor !== undefined)) {
    throw new Error("channel window cursor and has_more disagree");
  }

  const summaries = new Map<string, ThreadSummary>();
  for (const event of events) {
    if (event.kind !== KIND_THREAD_SUMMARY) continue;
    const rootId = firstTag(event, "e");
    if (!rootId || !HEX_64.test(rootId)) continue;
    try {
      const value = jsonRecord(event.content);
      const replyCount = safeCount(value.reply_count);
      const descendantCount = safeCount(value.descendant_count);
      const lastReplyAt =
        value.last_reply_at === null
          ? undefined
          : safeCount(value.last_reply_at);
      const participantPubkeys = Array.isArray(value.participants)
        ? value.participants
            .filter(
              (item): item is string =>
                typeof item === "string" && HEX_64.test(item),
            )
            .slice(0, 10)
        : [];
      if (replyCount === undefined || descendantCount === undefined) continue;
      summaries.set(rootId, {
        descendantCount,
        participantPubkeys,
        replyCount,
        ...(lastReplyAt === undefined ? {} : { lastReplyAt }),
      });
    } catch {}
  }
  return {
    events: events.filter(
      (event) =>
        event.kind !== KIND_THREAD_SUMMARY && event.kind !== KIND_WINDOW_BOUNDS,
    ),
    hasMore,
    ...(nextCursor ? { nextCursor } : {}),
    summaries,
  };
}

function parseCursor(value: unknown): ChannelCursor | undefined {
  if (value === null) return undefined;
  if (!isRecord(value)) throw new Error("invalid channel window cursor");
  const createdAt = safeCount(value.created_at);
  const eventId =
    typeof value.id === "string" && HEX_64.test(value.id)
      ? value.id
      : undefined;
  if (createdAt === undefined || !eventId) {
    throw new Error("invalid channel window cursor");
  }
  return { createdAt, eventId };
}

function safeCount(value: unknown): number | undefined {
  return Number.isSafeInteger(value) && Number(value) >= 0
    ? Number(value)
    : undefined;
}

function jsonRecord(content: string): Record<string, unknown> {
  if (content.length > 64 * 1024) throw new Error("window payload too large");
  const value = JSON.parse(content) as unknown;
  if (!isRecord(value)) throw new Error("window payload is not an object");
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
