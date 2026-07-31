import { createHash, randomUUID } from "node:crypto";

import {
  buildAddMember,
  buildArchive,
  buildCreateChannel,
  buildDeleteChannel,
  buildDeleteCompatibility,
  buildDmOpen,
  buildEdit,
  buildForumComment,
  buildForumPost,
  buildJoin,
  buildLeave,
  buildMessage,
  buildReaction,
  buildRemoveMember,
  buildRemoveReaction,
  buildSetCanvas,
  buildSetPurpose,
  buildSetTopic,
  buildUnarchive,
  buildUpdateChannel,
  type EventTemplate,
  type MemberRole,
} from "@buzz/sdk";
import type { Event } from "nostr-tools";

import type { IdentityService } from "./identity.js";
import type { ProfileService } from "./profile.js";
import type { RelayFilter, RelayHttpClient } from "./relay-http.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HEX_EVENT = /^[0-9a-f]{64}$/;
const MESSAGE_KINDS = [9, 11, 1_111, 40_000, 40_001, 40_002, 45_001, 45_003];
const STARTER_NAMESPACE = "3ce33bea-8f09-5f1b-9c85-8a7d2659e6b0";

export type ChannelInfo = {
  archived_at: string | null;
  channel_type: string;
  description: string;
  id: string;
  is_member: boolean;
  last_message_at: string | null;
  member_count: number;
  member_pubkeys: string[];
  name: string;
  participant_pubkeys: string[];
  participants: string[];
  purpose: string | null;
  topic: string | null;
  ttl_deadline: string | null;
  ttl_seconds: number | null;
  visibility: string;
};

export class ChannelService {
  readonly #identity: IdentityService;
  readonly #profiles: ProfileService;
  readonly #relay: RelayHttpClient;
  #relayScope: string;
  readonly #pendingOwned = new Set<string>();

  constructor(input: {
    identity: IdentityService;
    profiles: ProfileService;
    relay: RelayHttpClient;
    relayScope: string;
  }) {
    this.#identity = input.identity;
    this.#profiles = input.profiles;
    this.#relay = input.relay;
    this.#relayScope = input.relayScope;
  }

  setRelayScope(relayScope: string): void {
    const value = new URL(relayScope);
    if (
      !["http:", "https:"].includes(value.protocol) ||
      value.username ||
      value.password ||
      value.hash
    ) {
      throw new Error("relay scope must be a safe HTTP URL");
    }
    this.#relayScope = value.toString();
  }

  async list(): Promise<ChannelInfo[]> {
    const myPubkey = this.#identity.info().pubkey;
    const [metadata, myMemberships, visibilitySnapshots] = await Promise.all([
      this.#relay.query([{ kinds: [39_000], limit: 1_000 }]),
      this.#relay.query([{ "#p": [myPubkey], kinds: [39_002], limit: 1_000 }]),
      this.#relay.query([{ "#p": [myPubkey], kinds: [30_622], limit: 1 }]),
    ]);
    const hiddenDmIds = new Set(
      latestParameterized(visibilitySnapshots, "d")
        .find((event) => tag(event, "d") === myPubkey)
        ?.tags.filter((entry) => entry[0] === "h")
        .map((entry) => entry[1])
        .filter(isString) ?? [],
    );
    const memberIds = new Set(
      myMemberships.map((event) => tag(event, "d")).filter(isString),
    );
    const ids = metadata.map((event) => tag(event, "d")).filter(isString);
    const membershipEvents =
      ids.length > 0
        ? await this.#relay.query([
            { "#d": ids, kinds: [39_002], limit: Math.min(ids.length, 1_000) },
          ])
        : [];
    const membersByChannel = new Map(
      membershipEvents
        .map((event) => {
          const id = tag(event, "d");
          return id ? ([id, memberPubkeys(event)] as const) : null;
        })
        .filter(isNotNull),
    );
    const messageFilters: RelayFilter[] = ids.slice(0, 100).map((id) => ({
      "#h": [id],
      kinds: MESSAGE_KINDS,
      limit: 1,
    }));
    const messages =
      messageFilters.length > 0 ? await this.#relay.query(messageFilters) : [];
    const lastMessage = new Map<string, number>();
    for (const event of messages) {
      const id = tag(event, "h");
      if (id) {
        lastMessage.set(
          id,
          Math.max(lastMessage.get(id) ?? 0, event.created_at),
        );
      }
    }

    return latestParameterized(metadata, "d")
      .map((event) => {
        const id = requireTag(event, "d");
        const members = membersByChannel.get(id) ?? [];
        if (members.includes(myPubkey)) this.#pendingOwned.delete(id);
        const channel = channelFromMetadata(
          event,
          memberIds.has(id) || this.#pendingOwned.has(id),
        );
        channel.member_pubkeys = members;
        channel.member_count = members.length;
        const timestamp = lastMessage.get(id);
        channel.last_message_at = timestamp ? iso(timestamp) : null;
        return channel;
      })
      .filter(
        (channel) =>
          channel.channel_type !== "dm" || !hiddenDmIds.has(channel.id),
      )
      .sort((left, right) => left.name.localeCompare(right.name));
  }

  async details(channelId: unknown): Promise<Record<string, unknown>> {
    const id = requireChannelId(channelId);
    const [event] = await this.#relay.query([
      { "#d": [id], kinds: [39_000], limit: 1 },
    ]);
    if (!event) throw new Error("channel not found");
    const channel = channelFromMetadata(event, true);
    const members = await this.members(id);
    return {
      ...channel,
      created_at: iso(event.created_at),
      created_by: event.pubkey,
      max_members: null,
      member_count: members.members.length,
      member_pubkeys: members.members.map((member) => member.pubkey),
      nip29_group_id: null,
      purpose_set_at: null,
      purpose_set_by: null,
      topic_required: false,
      topic_set_at: null,
      topic_set_by: null,
      updated_at: iso(event.created_at),
    };
  }

  async members(channelId: unknown): Promise<{
    members: Array<{
      display_name: string | null;
      is_agent: boolean;
      joined_at: null;
      pubkey: string;
      role: string;
    }>;
    next_cursor: null;
  }> {
    const id = requireChannelId(channelId);
    const [event] = await this.#relay.query([
      { "#d": [id], kinds: [39_002], limit: 1 },
    ]);
    if (!event) return { members: [], next_cursor: null };
    const entries = membershipEntries(event);
    const profiles = await this.#profiles.usersBatch(
      entries.map((entry) => entry.pubkey),
    );
    return {
      members: entries.map((entry) => ({
        display_name: profiles.profiles[entry.pubkey]?.display_name ?? null,
        is_agent:
          entry.role === "bot" ||
          profiles.profiles[entry.pubkey]?.is_agent === true,
        joined_at: null,
        pubkey: entry.pubkey,
        role: entry.role,
      })),
      next_cursor: null,
    };
  }

  async create(args: Record<string, unknown>): Promise<ChannelInfo> {
    const channelId = randomUUID();
    const template = buildCreateChannel({
      channelId,
      name: requireText(args.name, "name", 256),
      visibility: requireVisibility(args.visibility),
      channelType: requireChannelType(args.channelType),
      ...(typeof args.description === "string"
        ? { about: args.description }
        : {}),
      ...(typeof args.ttlSeconds === "number" ? { ttl: args.ttlSeconds } : {}),
    });
    await this.#publish(template);
    this.#pendingOwned.add(channelId);
    const event = await this.#waitForMetadata(channelId);
    return channelFromMetadata(event, true);
  }

  async ensureStarters(): Promise<ChannelInfo[]> {
    const existing = await this.list();
    for (const starter of [
      {
        description: "General conversation and community updates.",
        name: "general",
      },
      {
        description: "Say hi, ask a question, or share what brought you here.",
        name: "welcome-everyone",
      },
    ]) {
      if (existing.some((channel) => channel.name === starter.name)) continue;
      const channelId = uuidV5(
        `${this.#relayScope}:${starter.name}`,
        STARTER_NAMESPACE,
      );
      try {
        await this.#publish(
          buildCreateChannel({
            about: starter.description,
            channelId,
            channelType: "stream",
            name: starter.name,
            visibility: "open",
          }),
        );
      } catch (error) {
        if (!String(error).toLowerCase().includes("duplicate")) throw error;
      }
      this.#pendingOwned.add(channelId);
    }
    return this.list();
  }

  async openDm(args: Record<string, unknown>): Promise<ChannelInfo> {
    if (
      !Array.isArray(args.pubkeys) ||
      args.pubkeys.length < 1 ||
      args.pubkeys.length > 8
    ) {
      throw new Error("pubkeys must contain between 1 and 8 participants");
    }
    const pubkeys = args.pubkeys.map((value) =>
      requireEventId(value, "DM participant pubkey"),
    );
    const event = this.#identity.sign(
      buildDmOpen(pubkeys) as unknown as Record<string, unknown>,
    );
    const acknowledgement = await this.#relay.publish(event);
    if (!acknowledgement.message.startsWith("response:")) {
      throw new Error("relay did not return the DM channel coordinate");
    }
    let response: unknown;
    try {
      response = JSON.parse(acknowledgement.message.slice("response:".length));
    } catch {
      throw new Error("relay returned an invalid DM response");
    }
    const channelId =
      typeof response === "object" &&
      response !== null &&
      "channel_id" in response
        ? requireChannelId(response.channel_id)
        : (() => {
            throw new Error("relay returned an invalid DM response");
          })();
    const metadata = await this.#waitForMetadata(channelId);
    const channel = channelFromMetadata(metadata, true);
    const members = await this.members(channelId);
    channel.member_pubkeys = members.members.map((member) => member.pubkey);
    channel.member_count = members.members.length;
    return channel;
  }

  async hideDm(channelIdValue: unknown): Promise<void> {
    const channelId = requireChannelId(channelIdValue);
    await this.#publish({
      content: "",
      kind: 41_012,
      tags: [["h", channelId]],
    });
  }

  async update(
    args: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const input = requireObject(args.input, "input");
    const channelId = requireChannelId(input.channelId);
    const template = buildUpdateChannel({
      channelId,
      ...(typeof input.name === "string" ? { name: input.name } : {}),
      ...(typeof input.description === "string"
        ? { about: input.description }
        : {}),
      ...(input.visibility !== undefined
        ? { visibility: requireVisibility(input.visibility) }
        : {}),
      ...(input.ttlSeconds !== undefined
        ? {
            ttl:
              input.ttlSeconds === null
                ? null
                : requirePositiveInteger(input.ttlSeconds, "ttlSeconds"),
          }
        : {}),
    });
    await this.#publish(template);
    return this.details(channelId);
  }

  async mutate(
    operation:
      | "archive"
      | "delete"
      | "join"
      | "leave"
      | "purpose"
      | "topic"
      | "unarchive",
    args: Record<string, unknown>,
  ): Promise<void> {
    const channelId = requireChannelId(args.channelId);
    let template: EventTemplate;
    switch (operation) {
      case "archive":
        template = buildArchive(channelId);
        break;
      case "delete":
        template = buildDeleteChannel(channelId);
        break;
      case "join":
        template = buildJoin(channelId);
        break;
      case "leave":
        template = buildLeave(channelId);
        break;
      case "purpose":
        template = buildSetPurpose(
          channelId,
          requireText(args.purpose, "purpose", 16_384),
        );
        break;
      case "topic":
        template = buildSetTopic(
          channelId,
          requireText(args.topic, "topic", 16_384),
        );
        break;
      case "unarchive":
        template = buildUnarchive(channelId);
        break;
    }
    await this.#publish(template);
  }

  async addMembers(args: Record<string, unknown>): Promise<{
    added: string[];
    errors: Array<{ error: string; pubkey: string }>;
  }> {
    const channelId = requireChannelId(args.channelId);
    if (!Array.isArray(args.pubkeys) || args.pubkeys.length > 500) {
      throw new Error("pubkeys must contain at most 500 members");
    }
    const role = optionalRole(args.role);
    const added: string[] = [];
    const errors: Array<{ error: string; pubkey: string }> = [];
    for (const value of args.pubkeys) {
      const pubkey = typeof value === "string" ? value : String(value);
      try {
        await this.#publish(buildAddMember(channelId, pubkey, role));
        added.push(pubkey);
      } catch (error) {
        errors.push({
          error: error instanceof Error ? error.message : "add failed",
          pubkey,
        });
      }
    }
    return { added, errors };
  }

  async changeMember(
    remove: boolean,
    args: Record<string, unknown>,
  ): Promise<void> {
    const channelId = requireChannelId(args.channelId);
    const pubkey = requireEventId(args.pubkey, "pubkey");
    await this.#publish(
      remove
        ? buildRemoveMember(channelId, pubkey)
        : buildAddMember(channelId, pubkey, requireRole(args.role)),
    );
  }

  async canvas(channelIdValue: unknown): Promise<{
    author: string | null;
    content: string;
    updated_at: number | null;
  }> {
    const channelId = requireChannelId(channelIdValue);
    const [event] = await this.#relay.query([
      { "#h": [channelId], kinds: [40_100], limit: 1 },
    ]);
    return event
      ? {
          author: event.pubkey,
          content: event.content,
          updated_at: event.created_at,
        }
      : { author: null, content: "", updated_at: null };
  }

  async setCanvas(args: Record<string, unknown>): Promise<{
    event_id: string;
    ok: true;
  }> {
    const event = await this.#publish(
      buildSetCanvas(
        requireChannelId(args.channelId),
        requireText(args.content, "content", 64 * 1024),
      ),
    );
    return { event_id: event.id, ok: true };
  }

  async event(eventIdValue: unknown): Promise<Event> {
    const eventId = requireEventId(eventIdValue, "eventId");
    const [event] = await this.#relay.query([{ ids: [eventId], limit: 1 }]);
    if (!event) throw new Error("event not found");
    return event;
  }

  async sendMessage(args: Record<string, unknown>): Promise<{
    created_at: number;
    depth: number;
    event_id: string;
    parent_event_id: string | null;
    root_event_id: string | null;
  }> {
    const channelId = requireChannelId(args.channelId);
    const content = requireText(args.content, "content", 64 * 1024).trim();
    const parentEventId =
      typeof args.parentEventId === "string"
        ? requireEventId(args.parentEventId, "parentEventId")
        : null;
    const thread = parentEventId
      ? await this.#resolveThread(parentEventId)
      : undefined;
    const mentions = optionalPubkeys(args.mentionPubkeys);
    const mediaTags = optionalTags(args.mediaTags, "imeta");
    const emojiTags = optionalTags(args.emojiTags, "emoji");
    const mentionTags = optionalTags(args.mentionTags, "mention");
    const kind =
      typeof args.kind === "number" && Number.isSafeInteger(args.kind)
        ? args.kind
        : 9;
    let template: EventTemplate;
    if (kind === 45_001) {
      template = buildForumPost({ channelId, content, mediaTags, mentions });
    } else if (kind === 45_003) {
      if (!thread) throw new Error("forum comment requires parentEventId");
      template = buildForumComment({
        channelId,
        content,
        mediaTags,
        mentions,
        thread,
      });
    } else {
      template = buildMessage({
        channelId,
        content,
        mediaTags,
        mentions,
        ...(thread ? { thread } : {}),
      });
    }
    template = {
      ...template,
      tags: [...template.tags, ...emojiTags, ...mentionTags],
    };
    const event = await this.#publish(template);
    return {
      created_at: event.created_at,
      depth: parentEventId
        ? thread?.rootEventId === parentEventId
          ? 1
          : 2
        : 0,
      event_id: event.id,
      parent_event_id: parentEventId,
      root_event_id: thread?.rootEventId ?? null,
    };
  }

  async editMessage(args: Record<string, unknown>): Promise<void> {
    let template = buildEdit(
      requireChannelId(args.channelId),
      requireEventId(args.eventId, "eventId"),
      requireText(args.content, "content", 64 * 1024).trim(),
    );
    template = {
      ...template,
      tags: [
        ...template.tags,
        ...optionalTags(args.mediaTags, "imeta"),
        ...optionalTags(args.emojiTags, "emoji"),
        ...optionalPubkeys(args.mentionPubkeys).map((key) => ["p", key]),
      ],
    };
    await this.#publish(template);
  }

  async deleteMessage(args: Record<string, unknown>): Promise<void> {
    await this.#publish(
      buildDeleteCompatibility(
        requireChannelId(args.channelId),
        requireEventId(args.eventId, "eventId"),
      ),
    );
  }

  async reaction(
    remove: boolean,
    args: Record<string, unknown>,
  ): Promise<void> {
    const target = requireEventId(args.eventId, "eventId");
    const emoji = requireText(args.emoji, "emoji", 256).trim();
    if (!remove) {
      let template = buildReaction(target, emoji);
      if (typeof args.emojiUrl === "string") {
        const url = requireHttpUrl(args.emojiUrl, "emojiUrl");
        const shortcode = emoji.replace(/^:+|:+$/g, "");
        template = {
          ...template,
          content: `:${shortcode}:`,
          tags: [...template.tags, ["emoji", shortcode, url]],
        };
      }
      await this.#publish(template);
      return;
    }
    const events = await this.#relay.query([
      {
        "#e": [target],
        authors: [this.#identity.info().pubkey],
        kinds: [7],
        limit: 100,
      },
    ]);
    const reaction = events.find((event) => event.content.trim() === emoji);
    if (!reaction) throw new Error("could not find your reaction event");
    await this.#publish(buildRemoveReaction(reaction.id));
  }

  async search(args: Record<string, unknown>): Promise<{
    found: number;
    hits: Array<Record<string, unknown>>;
  }> {
    const query = requireText(args.q, "q", 1_024).trim();
    const limit =
      typeof args.limit === "number"
        ? Math.min(requirePositiveInteger(args.limit, "limit"), 100)
        : 50;
    const filter: RelayFilter = {
      kinds: MESSAGE_KINDS,
      limit,
      search: query,
      ...(typeof args.channelId === "string"
        ? { "#h": [requireChannelId(args.channelId)] }
        : {}),
      ...(Array.isArray(args.authors)
        ? { authors: args.authors.map((key) => requireEventId(key, "author")) }
        : {}),
      ...(typeof args.since === "number" ? { since: args.since } : {}),
      ...(typeof args.until === "number" ? { until: args.until } : {}),
    };
    const events = await this.#relay.query([filter]);
    return {
      found: events.length,
      hits: events.map((event, index) => ({
        channel_id: tag(event, "h"),
        channel_name: null,
        content: event.content,
        created_at: event.created_at,
        event_id: event.id,
        kind: event.kind,
        pubkey: event.pubkey,
        score: events.length < 2 ? 1 : 1 - index / events.length,
      })),
    };
  }

  async feed(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const since =
      typeof args.since === "number"
        ? args.since
        : Math.floor(Date.now() / 1_000) - 7 * 86_400;
    const limit =
      typeof args.limit === "number"
        ? Math.min(requirePositiveInteger(args.limit, "limit"), 500)
        : 100;
    const events = await this.#relay.query([
      { kinds: MESSAGE_KINDS, limit, since },
    ]);
    const myPubkey = this.#identity.info().pubkey;
    const items = events.map((event) => ({
      category: event.tags.some(
        (entry) => entry[0] === "p" && entry[1] === myPubkey,
      )
        ? "mention"
        : "activity",
      channel_id: tag(event, "h"),
      channel_name: "",
      channel_type: null,
      content: event.content,
      created_at: event.created_at,
      id: event.id,
      kind: event.kind,
      pubkey: event.pubkey,
      tags: event.tags,
    }));
    const mentions = items.filter((item) => item.category === "mention");
    const activity = items.filter((item) => item.category === "activity");
    return {
      feed: {
        activity,
        agent_activity: [],
        mentions,
        needs_action: [],
      },
      meta: {
        generated_at: Math.floor(Date.now() / 1_000),
        since,
        total: items.length,
      },
    };
  }

  async threadReplies(args: Record<string, unknown>): Promise<{
    events: Event[];
    next_cursor: { created_at: number; event_id: string } | null;
  }> {
    const rootEventId = requireEventId(args.rootEventId, "rootEventId");
    const limit =
      typeof args.limit === "number"
        ? Math.min(requirePositiveInteger(args.limit, "limit"), 500)
        : 100;
    const events = await this.#relay.query([
      { "#e": [rootEventId], kinds: MESSAGE_KINDS, limit },
    ]);
    const last = events.at(-1);
    return {
      events,
      next_cursor: last
        ? { created_at: last.created_at, event_id: last.id }
        : null,
    };
  }

  async messagesBefore(args: Record<string, unknown>): Promise<{
    events: Event[];
    next_cursor: { created_at: number; event_id: string } | null;
  }> {
    const channelId = requireChannelId(args.channelId);
    const before = requirePositiveInteger(args.before, "before");
    const limit =
      typeof args.limit === "number"
        ? Math.min(requirePositiveInteger(args.limit, "limit"), 500)
        : 100;
    const filter: RelayFilter = {
      "#h": [channelId],
      before_id:
        typeof args.beforeId === "string"
          ? requireEventId(args.beforeId, "beforeId")
          : undefined,
      kinds: MESSAGE_KINDS,
      limit,
      until: before,
    };
    const events = await this.#relay.query([filter]);
    const last = events.at(-1);
    return {
      events,
      next_cursor:
        events.length === limit && last
          ? { created_at: last.created_at, event_id: last.id }
          : null,
    };
  }

  async window(args: Record<string, unknown>): Promise<Event[]> {
    const channelId = requireChannelId(args.channelId);
    const limit =
      typeof args.limitRows === "number"
        ? Math.min(requirePositiveInteger(args.limitRows, "limitRows"), 500)
        : 50;
    const cursor =
      args.cursor === null || args.cursor === undefined
        ? undefined
        : requireObject(args.cursor, "cursor");
    const filter: RelayFilter = {
      "#h": [channelId],
      kinds: [
        5, 7, 9, 11, 1_111, 40_000, 40_001, 40_002, 40_003, 40_008, 40_099,
        45_001, 45_002, 45_003,
      ],
      limit,
      ...(cursor
        ? {
            before_id: requireEventId(cursor.event_id, "cursor.event_id"),
            until: requirePositiveInteger(
              cursor.created_at,
              "cursor.created_at",
            ),
          }
        : {}),
    };
    return this.#relay.query([filter]);
  }

  async forumPosts(args: Record<string, unknown>): Promise<{
    messages: Array<Record<string, unknown>>;
    next_cursor: number | null;
  }> {
    const channelId = requireChannelId(args.channelId);
    const limit =
      typeof args.limit === "number"
        ? Math.min(requirePositiveInteger(args.limit, "limit"), 100)
        : 30;
    const events = await this.#relay.query([
      {
        "#h": [channelId],
        kinds: [45_001],
        limit,
        ...(typeof args.before === "number"
          ? { until: requirePositiveInteger(args.before, "before") }
          : {}),
      },
    ]);
    const rootIds = events.map((event) => event.id);
    const replies =
      rootIds.length === 0
        ? []
        : await this.#relay.query([
            { "#e": rootIds, kinds: [45_003], limit: 1_000 },
          ]);
    return {
      messages: events.map((event) =>
        forumEvent(event, channelId, threadSummary(event.id, replies)),
      ),
      next_cursor:
        events.length === limit
          ? Math.min(...events.map((event) => event.created_at))
          : null,
    };
  }

  async forumThread(args: Record<string, unknown>): Promise<{
    next_cursor: string | null;
    replies: Array<Record<string, unknown>>;
    root: Record<string, unknown>;
    total_replies: number;
  }> {
    const channelId = requireChannelId(args.channelId);
    const eventId = requireEventId(args.eventId, "eventId");
    const limit =
      typeof args.limit === "number"
        ? Math.min(requirePositiveInteger(args.limit, "limit"), 500)
        : 100;
    const [root] = await this.#relay.query([
      { "#h": [channelId], ids: [eventId], kinds: [45_001], limit: 1 },
    ]);
    if (!root) throw new Error("forum post not found");
    const replies = await this.#relay.query([
      {
        "#e": [eventId],
        kinds: [45_003],
        limit: Math.min(limit + 1, 501),
      },
    ]);
    const page = replies.slice(0, limit);
    return {
      next_cursor: replies.length > limit ? (page.at(-1)?.id ?? null) : null,
      replies: page.map((event) => threadReply(event, channelId, eventId)),
      root: forumEvent(root, channelId, threadSummary(eventId, replies)),
      total_replies: replies.length,
    };
  }

  async presence(pubkeysValue: unknown): Promise<Record<string, string>> {
    if (!Array.isArray(pubkeysValue) || pubkeysValue.length > 500) {
      throw new Error("pubkeys must contain at most 500 keys");
    }
    if (pubkeysValue.length === 0) return {};
    const pubkeys = pubkeysValue.map((value) =>
      requireEventId(value, "presence pubkey"),
    );
    const events = await this.#relay.query([
      { authors: pubkeys, kinds: [20_001] },
    ]);
    const output: Record<string, { status: string; timestamp: number }> = {};
    for (const event of events) {
      const subject = tag(event, "p") ?? event.pubkey;
      const status = event.content.trim();
      if (!["online", "away", "offline"].includes(status)) continue;
      if (!output[subject] || output[subject].timestamp < event.created_at) {
        output[subject] = { status, timestamp: event.created_at };
      }
    }
    return Object.fromEntries(
      Object.entries(output).map(([pubkey, value]) => [pubkey, value.status]),
    );
  }

  async relayMembers(): Promise<{
    members: Array<{
      added_by: null;
      created_at: string;
      pubkey: string;
      role: string;
    }>;
  }> {
    const [snapshot] = await this.#relay.query([{ kinds: [13_534], limit: 1 }]);
    if (!snapshot) return { members: [] };
    return {
      members: snapshot.tags
        .filter(
          (entry) =>
            entry[0] === "member" &&
            entry.length === 3 &&
            HEX_EVENT.test(entry[1] ?? "") &&
            ["owner", "admin", "member"].includes(entry[2] ?? ""),
        )
        .map((entry) => ({
          added_by: null,
          created_at: iso(snapshot.created_at),
          pubkey: entry[1] as string,
          role: entry[2] as string,
        })),
    };
  }

  async myRelayMembership(): Promise<Record<string, unknown>> {
    const { members } = await this.relayMembers();
    const member = members.find(
      (candidate) => candidate.pubkey === this.#identity.info().pubkey,
    );
    if (!member) throw new Error("relay returned 404 Not Found");
    return member;
  }

  async relayAdmin(
    operation: "add" | "remove" | "role",
    args: Record<string, unknown>,
  ): Promise<void> {
    const targetPubkey = requireEventId(args.targetPubkey, "targetPubkey");
    const role =
      operation === "remove"
        ? undefined
        : requireRelayRole(operation === "role" ? args.newRole : args.role);
    await this.#publish({
      content: "",
      kind:
        operation === "add" ? 9_030 : operation === "remove" ? 9_031 : 9_032,
      tags: [["p", targetPubkey], ...(role ? [["role", role]] : [])],
    });
  }

  async relayAgents(): Promise<Array<Record<string, unknown>>> {
    const [profiles, memberships, metadata, presence] = await Promise.all([
      this.#relay.query([{ kinds: [0], limit: 1_000 }]),
      this.#relay.query([{ kinds: [39_002], limit: 1_000 }]),
      this.#relay.query([{ kinds: [39_000], limit: 1_000 }]),
      this.#relay.query([{ kinds: [20_001], limit: 1_000 }]),
    ]);
    const channelNames = new Map(
      metadata
        .map((event) => {
          const id = tag(event, "d");
          return id ? ([id, tag(event, "name") ?? id] as const) : null;
        })
        .filter(isNotNull),
    );
    const latestPresence = new Map<string, Event>();
    for (const event of presence) {
      const current = latestPresence.get(event.pubkey);
      if (!current || current.created_at < event.created_at) {
        latestPresence.set(event.pubkey, event);
      }
    }
    return profiles
      .filter((event) => event.tags.some((entry) => entry[0] === "auth"))
      .map((event) => {
        let profile: Record<string, unknown> = {};
        try {
          const parsed: unknown = JSON.parse(event.content);
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
            profile = parsed as Record<string, unknown>;
          }
        } catch {
          // A malformed profile remains discoverable under its public key.
        }
        const channelIds = memberships
          .filter((membership) =>
            membership.tags.some(
              (entry) => entry[0] === "p" && entry[1] === event.pubkey,
            ),
          )
          .map((membership) => tag(membership, "d"))
          .filter(isString);
        const rawStatus = latestPresence.get(event.pubkey)?.content.trim();
        return {
          agent_type: "managed",
          capabilities: Array.isArray(profile.capabilities)
            ? profile.capabilities.filter(
                (value): value is string => typeof value === "string",
              )
            : [],
          channel_ids: channelIds,
          channels: channelIds.map((id) => channelNames.get(id) ?? id),
          name:
            typeof profile.display_name === "string"
              ? profile.display_name
              : typeof profile.name === "string"
                ? profile.name
                : event.pubkey.slice(0, 12),
          pubkey: event.pubkey,
          respond_to:
            typeof profile.respond_to === "string" ? profile.respond_to : null,
          respond_to_allowlist: Array.isArray(profile.respond_to_allowlist)
            ? profile.respond_to_allowlist.filter(
                (value): value is string => typeof value === "string",
              )
            : [],
          status: ["online", "away"].includes(rawStatus ?? "")
            ? rawStatus
            : "offline",
        };
      });
  }

  async #resolveThread(parentEventId: string): Promise<{
    parentEventId: string;
    rootEventId: string;
  }> {
    const parent = await this.event(parentEventId);
    const explicitRoot = parent.tags.find(
      (entry) => entry[0] === "e" && entry[3] === "root",
    )?.[1];
    const reply = parent.tags.find(
      (entry) => entry[0] === "e" && entry[3] === "reply",
    )?.[1];
    return {
      parentEventId,
      rootEventId:
        explicitRoot && HEX_EVENT.test(explicitRoot)
          ? explicitRoot
          : reply && HEX_EVENT.test(reply)
            ? reply
            : parentEventId,
    };
  }

  async #publish(template: EventTemplate): Promise<Event> {
    const event = this.#identity.sign({
      content: template.content,
      kind: template.kind,
      tags: template.tags,
    });
    await this.#relay.publish(event);
    return event;
  }

  async #waitForMetadata(channelId: string): Promise<Event> {
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const [event] = await this.#relay.query([
        { "#d": [channelId], kinds: [39_000], limit: 1 },
      ]);
      if (event) return event;
      await new Promise((resolve) => setTimeout(resolve, 50 * (attempt + 1)));
    }
    throw new Error("channel created but metadata is not yet available");
  }
}

function forumEvent(
  event: Event,
  channelId: string,
  summary: Record<string, unknown> | null,
): Record<string, unknown> {
  return {
    channel_id: channelId,
    content: event.content,
    created_at: event.created_at,
    event_id: event.id,
    kind: event.kind,
    pubkey: event.pubkey,
    reactions: {},
    sig: event.sig,
    tags: event.tags,
    thread_summary: summary,
  };
}

function threadSummary(
  rootId: string,
  replies: Event[],
): Record<string, unknown> {
  const matching = replies.filter((event) =>
    event.tags.some((entry) => entry[0] === "e" && entry[1] === rootId),
  );
  return {
    descendant_count: matching.length,
    last_reply_at:
      matching.length > 0
        ? Math.max(...matching.map((event) => event.created_at))
        : null,
    participants: [...new Set(matching.map((event) => event.pubkey))],
    reply_count: matching.length,
  };
}

function threadReply(
  event: Event,
  channelId: string,
  defaultRootId: string,
): Record<string, unknown> {
  const root =
    event.tags.find(
      (entry) =>
        entry[0] === "e" && (entry[3] === "root" || entry[2] === "root"),
    )?.[1] ?? defaultRootId;
  const parent =
    event.tags.find(
      (entry) =>
        entry[0] === "e" && (entry[3] === "reply" || entry[2] === "reply"),
    )?.[1] ?? root;
  return {
    broadcast: false,
    channel_id: channelId,
    content: event.content,
    created_at: event.created_at,
    depth: parent === root ? 1 : 2,
    event_id: event.id,
    kind: event.kind,
    parent_event_id: parent,
    pubkey: event.pubkey,
    reactions: {},
    root_event_id: root,
    sig: event.sig,
    tags: event.tags,
  };
}

function channelFromMetadata(event: Event, isMember: boolean): ChannelInfo {
  const id = requireTag(event, "d");
  const participantPubkeys = tags(event, "p");
  const type = tag(event, "t") ?? (hasTag(event, "hidden") ? "dm" : "stream");
  const visibility =
    hasTag(event, "private") || tag(event, "visibility") === "private"
      ? "private"
      : "open";
  const ttl = Number(tag(event, "ttl"));
  return {
    archived_at:
      tag(event, "archived") === "true" ? iso(event.created_at) : null,
    channel_type: type,
    description: tag(event, "about") ?? "",
    id,
    is_member: isMember,
    last_message_at: null,
    member_count: 0,
    member_pubkeys: [],
    name: tag(event, "name") ?? "",
    participant_pubkeys: participantPubkeys,
    participants: participantPubkeys,
    purpose: tag(event, "purpose"),
    topic: tag(event, "topic"),
    ttl_deadline: tag(event, "ttl_deadline"),
    ttl_seconds: Number.isSafeInteger(ttl) && ttl > 0 ? ttl : null,
    visibility,
  };
}

function latestParameterized(events: Event[], parameter: string): Event[] {
  const latest = new Map<string, Event>();
  for (const event of events) {
    const key = tag(event, parameter);
    if (!key) continue;
    const current = latest.get(key);
    if (
      !current ||
      event.created_at > current.created_at ||
      (event.created_at === current.created_at && event.id > current.id)
    ) {
      latest.set(key, event);
    }
  }
  return [...latest.values()];
}

function membershipEntries(event: Event): Array<{
  pubkey: string;
  role: string;
}> {
  const seen = new Set<string>();
  const output: Array<{ pubkey: string; role: string }> = [];
  for (const entry of event.tags) {
    const pubkey = entry[0] === "p" ? entry[1] : undefined;
    if (!pubkey || !HEX_EVENT.test(pubkey) || seen.has(pubkey)) continue;
    seen.add(pubkey);
    output.push({ pubkey, role: entry[3] || "member" });
  }
  return output;
}

function memberPubkeys(event: Event): string[] {
  return membershipEntries(event).map((entry) => entry.pubkey);
}

function optionalTags(value: unknown, requiredPrefix: string): string[][] {
  if (value === null || value === undefined) return [];
  if (!Array.isArray(value) || value.length > 256) {
    throw new Error(`${requiredPrefix} tags must be an array`);
  }
  return value.map((entry, index) => {
    if (
      !Array.isArray(entry) ||
      entry[0] !== requiredPrefix ||
      entry.some((part) => typeof part !== "string")
    ) {
      throw new Error(
        `${requiredPrefix} tag ${index} must contain strings and use the ${requiredPrefix} prefix`,
      );
    }
    return entry as string[];
  });
}

function optionalPubkeys(value: unknown): string[] {
  if (value === null || value === undefined) return [];
  if (!Array.isArray(value) || value.length > 50) {
    throw new Error("mentionPubkeys must contain at most 50 keys");
  }
  return value.map((key) => requireEventId(key, "mention pubkey"));
}

function requireRelayRole(value: unknown): "owner" | "admin" | "member" {
  if (value !== "owner" && value !== "admin" && value !== "member") {
    throw new Error("relay role must be owner, admin, or member");
  }
  return value;
}

function optionalRole(value: unknown): MemberRole | undefined {
  return value === null || value === undefined ? undefined : requireRole(value);
}

function requireRole(value: unknown): MemberRole {
  if (
    value !== "owner" &&
    value !== "admin" &&
    value !== "member" &&
    value !== "guest" &&
    value !== "bot"
  ) {
    throw new Error("role is invalid");
  }
  return value;
}

function requireVisibility(value: unknown): "open" | "private" {
  if (value !== "open" && value !== "private") {
    throw new Error("visibility must be open or private");
  }
  return value;
}

function requireChannelType(value: unknown): "forum" | "stream" {
  if (value !== "forum" && value !== "stream") {
    throw new Error("channelType must be forum or stream");
  }
  return value;
}

function requireChannelId(value: unknown): string {
  if (typeof value !== "string" || !UUID.test(value)) {
    throw new Error("channelId must be a UUID");
  }
  return value.toLowerCase();
}

function requireEventId(value: unknown, name: string): string {
  if (typeof value !== "string" || !HEX_EVENT.test(value)) {
    throw new Error(`${name} must be 64 lowercase hexadecimal characters`);
  }
  return value;
}

function requireText(
  value: unknown,
  name: string,
  maximumBytes: number,
): string {
  if (typeof value !== "string") throw new Error(`${name} must be a string`);
  if (Buffer.byteLength(value, "utf8") > maximumBytes) {
    throw new Error(`${name} exceeds the ${maximumBytes} byte limit`);
  }
  return value;
}

function requirePositiveInteger(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

function requireObject(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${name} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requireHttpUrl(value: string, name: string): string {
  const url = new URL(value);
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username ||
    url.password
  ) {
    throw new Error(`${name} must be an HTTP(S) URL without credentials`);
  }
  return value;
}

function tag(event: Event, name: string): string | null {
  return event.tags.find((entry) => entry[0] === name && entry[1])?.[1] ?? null;
}

function tags(event: Event, name: string): string[] {
  return event.tags
    .filter((entry) => entry[0] === name && entry[1])
    .map((entry) => entry[1] as string);
}

function requireTag(event: Event, name: string): string {
  const value = tag(event, name);
  if (!value) throw new Error(`event ${event.id} is missing ${name} tag`);
  return value;
}

function hasTag(event: Event, name: string): boolean {
  return event.tags.some((entry) => entry[0] === name);
}

function iso(seconds: number): string {
  return new Date(seconds * 1_000).toISOString();
}

function isString(value: string | null | undefined): value is string {
  return value !== null && value !== undefined;
}

function isNotNull<T>(value: T | null): value is T {
  return value !== null;
}

function uuidV5(name: string, namespace: string): string {
  const namespaceBytes = Buffer.from(namespace.replaceAll("-", ""), "hex");
  const digest = createHash("sha1")
    .update(namespaceBytes)
    .update(name, "utf8")
    .digest()
    .subarray(0, 16);
  digest[6] = ((digest[6] ?? 0) & 0x0f) | 0x50;
  digest[8] = ((digest[8] ?? 0) & 0x3f) | 0x80;
  const hex = digest.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
