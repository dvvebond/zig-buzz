import type { NostrEvent } from "@buzz/core";

import { firstTag, threadReference } from "./models";

export type InboxCategory =
  | "mention"
  | "needs_action"
  | "agent_activity"
  | "activity";

export type InboxSourceItem = {
  readonly event: NostrEvent;
  readonly category: InboxCategory;
};

export type InboxItem = {
  readonly conversationId: string;
  readonly event: NostrEvent;
  readonly events: readonly NostrEvent[];
  readonly categories: readonly InboxCategory[];
  readonly category: InboxCategory;
  readonly channelId?: string;
  readonly threadRootId?: string;
  readonly latestActivityAt: number;
  readonly needsAction: boolean;
};

const PRIORITY: Readonly<Record<InboxCategory, number>> = {
  activity: 3,
  agent_activity: 2,
  mention: 1,
  needs_action: 0,
};

export function buildInboxItems(
  source: readonly InboxSourceItem[],
  dmChannelIds: ReadonlySet<string> = new Set(),
): readonly InboxItem[] {
  const groups = new Map<string, InboxSourceItem[]>();
  for (const item of source) {
    const channelId = firstTag(item.event, "h");
    const thread = threadReference(item.event);
    const conversationId =
      thread?.rootId ??
      (channelId && dmChannelIds.has(channelId)
        ? `dm:${channelId}`
        : item.event.id);
    const group = groups.get(conversationId) ?? [];
    group.push(item);
    groups.set(conversationId, group);
  }
  return [...groups]
    .map(([conversationId, group]) => {
      const sorted = [...group].sort(
        (left, right) =>
          right.event.created_at - left.event.created_at ||
          right.event.id.localeCompare(left.event.id),
      );
      const representative = sorted[0] as InboxSourceItem;
      const categories = [...new Set(group.map((item) => item.category))].sort(
        (left, right) => PRIORITY[left] - PRIORITY[right],
      );
      const threadRootId = group
        .map((item) => threadReference(item.event)?.rootId)
        .find((value) => value !== undefined);
      const channelId = firstTag(representative.event, "h");
      return {
        categories,
        category: categories[0] ?? representative.category,
        ...(channelId ? { channelId } : {}),
        conversationId,
        event: representative.event,
        events: sorted.map((item) => item.event),
        latestActivityAt: representative.event.created_at,
        needsAction: categories.includes("needs_action"),
        ...(threadRootId ? { threadRootId } : {}),
      };
    })
    .sort(
      (left, right) =>
        right.latestActivityAt - left.latestActivityAt ||
        right.event.id.localeCompare(left.event.id),
    );
}

export function inboxItemIsDone(
  item: InboxItem,
  input: {
    readonly doneIds: ReadonlySet<string>;
    readonly unreadIds: ReadonlySet<string>;
    readonly readAt?: number;
  },
): boolean {
  if (input.unreadIds.has(item.conversationId)) return false;
  if (input.doneIds.has(item.conversationId)) return true;
  return (
    input.readAt !== undefined &&
    item.events.every((event) => event.created_at <= (input.readAt as number))
  );
}

export function inboxDeepLinkEvent(
  item: InboxItem,
  readAt?: number,
): NostrEvent {
  if (readAt !== undefined) {
    const oldestUnread = [...item.events]
      .filter((event) => event.created_at > readAt)
      .sort(
        (left, right) =>
          left.created_at - right.created_at || left.id.localeCompare(right.id),
      )[0];
    if (oldestUnread) return oldestUnread;
  }
  return item.event;
}
