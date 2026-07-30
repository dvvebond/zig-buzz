import {
  KIND_FORUM_COMMENT,
  KIND_FORUM_POST,
  KIND_HUDDLE_ENDED,
  KIND_HUDDLE_STARTED,
  KIND_STREAM_MESSAGE,
  KIND_STREAM_MESSAGE_DIFF,
  KIND_STREAM_MESSAGE_EDIT,
  KIND_STREAM_MESSAGE_V2,
  KIND_SYSTEM_MESSAGE,
  type NostrEvent,
  type NostrTag,
} from "@buzz/core";

const HEX_64 = /^[0-9a-f]{64}$/;
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type Community = {
  readonly id: string;
  readonly name: string;
  readonly relayUrl: string;
  readonly pubkey: string;
  readonly createdAt: number;
};

export type Profile = {
  readonly pubkey: string;
  readonly displayName: string;
  readonly about: string;
  readonly picture?: string;
};

export type ChannelType = "stream" | "forum" | "dm" | "workflow";
export type ChannelVisibility = "open" | "private";

export type Channel = {
  readonly id: string;
  readonly name: string;
  readonly about: string;
  readonly type: ChannelType;
  readonly visibility: ChannelVisibility;
  readonly picture?: string;
  readonly ownerPubkey?: string;
  readonly archived: boolean;
  readonly ephemeral: boolean;
  readonly expiresAt?: number;
};

export type MemberRole = "owner" | "admin" | "member" | "guest" | "bot";

export type ChannelMember = {
  readonly pubkey: string;
  readonly role: MemberRole;
};

export type ThreadReference = {
  readonly parentId: string;
  readonly rootId: string;
};

export type TimelineMessage = {
  readonly event: NostrEvent;
  readonly channelId: string;
  readonly author: string;
  readonly content: string;
  readonly tags: readonly NostrTag[];
  readonly thread?: ThreadReference;
  readonly editedAt?: number;
  readonly reactions: ReadonlyMap<string, readonly string[]>;
  readonly reactionEmojiUrls: ReadonlyMap<string, string>;
  readonly deleted: boolean;
  readonly pending?: boolean;
  readonly system?: SystemMessage;
  readonly replyCount?: number;
  readonly replyParticipants?: readonly string[];
  readonly lastReplyAt?: number;
};

export type SystemMessageType =
  | "member_joined"
  | "member_left"
  | "member_removed"
  | "topic_changed"
  | "purpose_changed"
  | "channel_created"
  | "channel_archived"
  | "channel_unarchived"
  | "huddle_started"
  | "huddle_ended";

export type SystemMessage = {
  readonly type: SystemMessageType;
  readonly actorPubkey?: string;
  readonly targetPubkey?: string;
  readonly topic?: string;
  readonly purpose?: string;
};

export type SearchHit = {
  readonly event: NostrEvent;
  readonly channelId?: string;
  readonly title: string;
  readonly excerpt: string;
};

export function firstTag(
  event: Pick<NostrEvent, "tags">,
  name: string,
): string | undefined {
  return event.tags.find(
    (tag) => tag[0] === name && typeof tag[1] === "string",
  )?.[1];
}

export function tagsNamed(
  event: Pick<NostrEvent, "tags">,
  name: string,
): readonly string[][] {
  return event.tags.filter(
    (tag) => tag[0] === name && typeof tag[1] === "string",
  );
}

export function parseProfile(event: NostrEvent): Profile {
  const value = parseBoundedJson(event.content, 32 * 1024);
  const item = isRecord(value) ? value : {};
  const displayName =
    boundedString(item.display_name, 256) ??
    boundedString(item.displayName, 256) ??
    boundedString(item.name, 256) ??
    shortPubkey(event.pubkey);
  const picture = safeHttpUrl(item.picture);
  return {
    about: boundedString(item.about, 4_096) ?? "",
    displayName,
    ...(picture === undefined ? {} : { picture }),
    pubkey: event.pubkey,
  };
}

export function parseChannel(event: NostrEvent): Channel {
  const value = parseBoundedJson(event.content, 64 * 1024);
  const item = isRecord(value) ? value : {};
  const id = firstTag(event, "d") ?? firstTag(event, "h") ?? "";
  const type = parseChannelType(
    boundedString(item.type, 32) ?? firstTag(event, "t"),
  );
  const expiresAt = parsePositiveInteger(
    item.expires_at ?? firstTag(event, "expiration"),
  );
  const picture = safeHttpUrl(item.picture);
  const ownerPubkey =
    validPubkey(item.owner_pubkey) ?? validPubkey(firstTag(event, "owner"));
  return {
    about:
      boundedString(item.about, 4_096) ??
      boundedString(item.description, 4_096) ??
      "",
    archived: item.archived === true || firstTag(event, "archived") === "true",
    ephemeral:
      item.ephemeral === true ||
      firstTag(event, "ephemeral") === "true" ||
      expiresAt !== undefined,
    id,
    name: boundedString(item.name, 256) ?? "Untitled channel",
    ...(ownerPubkey === undefined ? {} : { ownerPubkey }),
    ...(picture === undefined ? {} : { picture }),
    ...(expiresAt === undefined ? {} : { expiresAt }),
    type,
    visibility:
      item.visibility === "private" ||
      firstTag(event, "visibility") === "private"
        ? "private"
        : "open",
  };
}

export function parseMembers(event: NostrEvent): readonly ChannelMember[] {
  const seen = new Set<string>();
  const members: ChannelMember[] = [];
  for (const tag of event.tags) {
    const pubkey = validPubkey(tag[1]);
    if (tag[0] !== "p" || !pubkey || seen.has(pubkey)) continue;
    seen.add(pubkey);
    members.push({
      pubkey,
      role: parseMemberRole(tag[2]),
    });
  }
  return members;
}

export function threadReference(
  event: NostrEvent,
): ThreadReference | undefined {
  const eventTags = tagsNamed(event, "e");
  const reply = eventTags.find((tag) => tag[3] === "reply");
  if (!reply?.[1] || !HEX_64.test(reply[1])) return undefined;
  const root = eventTags.find((tag) => tag[3] === "root")?.[1] ?? reply[1];
  if (!HEX_64.test(root)) return undefined;
  return { parentId: reply[1], rootId: root };
}

export function isMessageEvent(event: NostrEvent): boolean {
  const messageKinds: ReadonlySet<number> = new Set([
    KIND_STREAM_MESSAGE,
    KIND_STREAM_MESSAGE_V2,
    KIND_STREAM_MESSAGE_DIFF,
    KIND_FORUM_POST,
    KIND_FORUM_COMMENT,
  ]);
  return messageKinds.has(event.kind);
}

export function projectTimeline(
  events: readonly NostrEvent[],
  pendingIds: ReadonlySet<string> = new Set(),
): readonly TimelineMessage[] {
  const newest = [...events].sort(compareEvents);
  const edits = new Map<string, NostrEvent>();
  const deletions = new Set<string>();
  const reactions = new Map<string, Map<string, Set<string>>>();
  const reactionEmojiUrls = new Map<string, Map<string, string>>();

  for (const event of newest) {
    if (event.kind !== 5 && event.kind !== 9_005) continue;
    for (const tag of tagsNamed(event, "e")) {
      if (tag[1]) deletions.add(tag[1]);
    }
  }

  for (const event of newest) {
    if (deletions.has(event.id)) continue;
    const target = lastTag(event, "e");
    if (!target || deletions.has(target)) continue;
    if (event.kind === KIND_STREAM_MESSAGE_EDIT) {
      const prior = edits.get(target);
      if (!prior || compareEvents(prior, event) < 0) edits.set(target, event);
    } else if (event.kind === 7 && event.content.length <= 256) {
      const emoji = event.content.trim();
      if (!emoji) continue;
      const byEmoji = reactions.get(target) ?? new Map<string, Set<string>>();
      const authors = byEmoji.get(emoji) ?? new Set<string>();
      authors.add(event.pubkey);
      byEmoji.set(emoji, authors);
      reactions.set(target, byEmoji);
      const shortcode = normalizeShortcode(emoji);
      if (shortcode) {
        const emojiTag = event.tags.find(
          (tag) =>
            tag[0] === "emoji" &&
            normalizeShortcode(tag[1] ?? "") === shortcode &&
            safeHttpUrl(tag[2]) !== undefined,
        );
        const url = safeHttpUrl(emojiTag?.[2]);
        if (url) {
          const byEmojiUrl =
            reactionEmojiUrls.get(target) ?? new Map<string, string>();
          byEmojiUrl.set(emoji, url);
          reactionEmojiUrls.set(target, byEmojiUrl);
        }
      }
    }
  }

  return newest
    .filter(
      (event) =>
        !deletions.has(event.id) &&
        (isMessageEvent(event) ||
          event.kind === KIND_SYSTEM_MESSAGE ||
          event.kind === KIND_HUDDLE_STARTED ||
          event.kind === KIND_HUDDLE_ENDED),
    )
    .map((event): TimelineMessage | undefined => {
      const channelId = firstTag(event, "h");
      if (!channelId) return undefined;
      const system = parseSystemMessage(event);
      if (
        !isMessageEvent(event) &&
        (event.kind === KIND_SYSTEM_MESSAGE ||
          event.kind === KIND_HUDDLE_STARTED ||
          event.kind === KIND_HUDDLE_ENDED) &&
        !system
      ) {
        return undefined;
      }
      const edit = edits.get(event.id);
      const reactionMap = new Map<string, readonly string[]>();
      for (const [emoji, authors] of reactions.get(event.id) ?? []) {
        reactionMap.set(emoji, [...authors].sort());
      }
      const thread = threadReference(event);
      return {
        author: event.pubkey,
        channelId,
        content: edit?.content ?? event.content,
        deleted: false,
        event,
        pending: pendingIds.has(event.id),
        reactions: reactionMap,
        reactionEmojiUrls:
          reactionEmojiUrls.get(event.id) ?? new Map<string, string>(),
        tags: edit?.tags ?? event.tags,
        ...(edit === undefined ? {} : { editedAt: edit.created_at }),
        ...(thread === undefined ? {} : { thread }),
        ...(system === undefined ? {} : { system }),
      };
    })
    .filter((value): value is TimelineMessage => value !== undefined)
    .sort(compareTimeline);
}

export function buildMainTimeline(
  messages: readonly TimelineMessage[],
): readonly TimelineMessage[] {
  const repliesByRoot = new Map<string, TimelineMessage[]>();
  for (const message of messages) {
    if (!message.thread) continue;
    const replies = repliesByRoot.get(message.thread.rootId) ?? [];
    replies.push(message);
    repliesByRoot.set(message.thread.rootId, replies);
  }
  return messages
    .filter(
      (message) =>
        !message.thread ||
        message.tags.some((tag) => tag[0] === "broadcast" && tag[1] === "1"),
    )
    .map((message) => {
      const replies = repliesByRoot.get(message.event.id);
      if (!replies?.length) return message;
      const participants: string[] = [];
      const seen = new Set<string>();
      for (
        let index = replies.length - 1;
        index >= 0 && participants.length < 3;
        index -= 1
      ) {
        const author = replies[index]?.author;
        if (author && !seen.has(author)) {
          seen.add(author);
          participants.unshift(author);
        }
      }
      const lastReplyAt = replies.at(-1)?.event.created_at;
      return {
        ...message,
        ...(lastReplyAt === undefined ? {} : { lastReplyAt }),
        replyCount: replies.length,
        replyParticipants: participants,
      };
    });
}

export function parseSystemMessage(
  event: NostrEvent,
): SystemMessage | undefined {
  if (event.kind === KIND_HUDDLE_STARTED || event.kind === KIND_HUDDLE_ENDED) {
    return {
      actorPubkey: event.pubkey,
      type:
        event.kind === KIND_HUDDLE_STARTED ? "huddle_started" : "huddle_ended",
    };
  }
  if (event.kind !== KIND_SYSTEM_MESSAGE) return undefined;
  const value = parseBoundedJson(event.content, 32 * 1024);
  if (!isRecord(value) || !isSystemMessageType(value.type)) return undefined;
  const actorPubkey = validPubkey(value.actor);
  const targetPubkey = validPubkey(value.target);
  const topic = boundedString(value.topic, 1_024);
  const purpose = boundedString(value.purpose, 4_096);
  return {
    type: value.type,
    ...(actorPubkey ? { actorPubkey } : {}),
    ...(targetPubkey ? { targetPubkey } : {}),
    ...(topic ? { topic } : {}),
    ...(purpose ? { purpose } : {}),
  };
}

export function describeSystemMessage(system: SystemMessage): string {
  const actor = shortPubkey(system.actorPubkey ?? "Someone");
  const target = shortPubkey(system.targetPubkey ?? "someone");
  switch (system.type) {
    case "member_joined":
      return system.actorPubkey === system.targetPubkey
        ? `${actor} joined the channel`
        : `${target} was added by ${actor}`;
    case "member_left":
      return `${actor} left the channel`;
    case "member_removed":
      return `${actor} removed ${target} from the channel`;
    case "topic_changed":
      return `${actor} changed the topic${system.topic ? ` to “${system.topic}”` : ""}`;
    case "purpose_changed":
      return `${actor} changed the purpose${system.purpose ? ` to “${system.purpose}”` : ""}`;
    case "channel_created":
      return `${actor} created this channel`;
    case "channel_archived":
      return `${actor} archived this channel`;
    case "channel_unarchived":
      return `${actor} unarchived this channel`;
    case "huddle_started":
      return `${actor} started a huddle`;
    case "huddle_ended":
      return `${actor} ended the huddle`;
  }
}

export function shortPubkey(pubkey: string): string {
  return pubkey.length > 12
    ? `${pubkey.slice(0, 6)}…${pubkey.slice(-4)}`
    : pubkey;
}

export function validChannelId(value: unknown): string | undefined {
  return typeof value === "string" && UUID.test(value)
    ? value.toLowerCase()
    : undefined;
}

export function validPubkey(value: unknown): string | undefined {
  return typeof value === "string" && HEX_64.test(value) ? value : undefined;
}

function compareEvents(left: NostrEvent, right: NostrEvent): number {
  return left.created_at === right.created_at
    ? left.id.localeCompare(right.id)
    : left.created_at - right.created_at;
}

function lastTag(
  event: Pick<NostrEvent, "tags">,
  name: string,
): string | undefined {
  for (let index = event.tags.length - 1; index >= 0; index -= 1) {
    const tag = event.tags[index];
    if (tag?.[0] === name && tag[1]) return tag[1];
  }
  return undefined;
}

function normalizeShortcode(value: string): string | undefined {
  const normalized = value
    .trim()
    .replace(/^:+|:+$/g, "")
    .toLowerCase();
  return /^[a-z0-9_-]+$/.test(normalized) ? normalized : undefined;
}

function isSystemMessageType(value: unknown): value is SystemMessageType {
  return (
    value === "member_joined" ||
    value === "member_left" ||
    value === "member_removed" ||
    value === "topic_changed" ||
    value === "purpose_changed" ||
    value === "channel_created" ||
    value === "channel_archived" ||
    value === "channel_unarchived"
  );
}

function compareTimeline(
  left: TimelineMessage,
  right: TimelineMessage,
): number {
  return compareEvents(left.event, right.event);
}

function parseChannelType(value: unknown): ChannelType {
  return value === "forum" ||
    value === "dm" ||
    value === "workflow" ||
    value === "stream"
    ? value
    : "stream";
}

function parseMemberRole(value: unknown): MemberRole {
  return value === "owner" ||
    value === "admin" ||
    value === "guest" ||
    value === "bot"
    ? value
    : "member";
}

function parsePositiveInteger(value: unknown): number | undefined {
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? Number.parseInt(value, 10)
        : Number.NaN;
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function parseBoundedJson(value: string, maximumBytes: number): unknown {
  if (new TextEncoder().encode(value).byteLength > maximumBytes)
    return undefined;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function boundedString(value: unknown, maximum: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= maximum ? trimmed : undefined;
}

function safeHttpUrl(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 2_048) return undefined;
  try {
    const url = new URL(value);
    return (url.protocol === "https:" || url.protocol === "http:") &&
      !url.username &&
      !url.password
      ? url.toString()
      : undefined;
  } catch {
    return undefined;
  }
}
