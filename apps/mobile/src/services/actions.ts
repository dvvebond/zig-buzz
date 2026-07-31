import {
  type KIND_BOOKMARK_LIST,
  type KIND_PIN_LIST,
  KIND_READ_STATE,
  KIND_STREAM_MESSAGE_BOOKMARKED,
  KIND_STREAM_MESSAGE_PINNED,
} from "@buzz/core";
import {
  buildAddMember,
  buildArchive,
  buildCreateChannel,
  buildCustomEmojiReaction,
  buildDeleteMessage,
  buildDmAddMember,
  buildDmOpen,
  buildEdit,
  buildForumComment,
  buildForumPost,
  buildJoin,
  buildLeave,
  buildMessage,
  buildNote,
  buildProfile,
  buildReaction,
  buildRemoveMember,
  buildSetCanvas,
  buildUpdateChannel,
  type ChannelType,
  type ChannelVisibility,
  type MemberRole,
  type MediaTag,
  type ThreadRef,
} from "@buzz/sdk";

import type { MobileRelay } from "./mobile-relay";

export class MobileActions {
  public constructor(private readonly relay: MobileRelay) {}

  public createChannel(input: {
    readonly channelId: string;
    readonly name: string;
    readonly about?: string;
    readonly type: ChannelType;
    readonly visibility: ChannelVisibility;
    readonly ttlSeconds?: number;
  }) {
    return this.relay.publish(
      buildCreateChannel({
        channelId: input.channelId,
        channelType: input.type,
        name: input.name,
        visibility: input.visibility,
        ...(input.about === undefined ? {} : { about: input.about }),
        ...(input.ttlSeconds === undefined ? {} : { ttl: input.ttlSeconds }),
      }),
    );
  }

  public updateChannel(input: {
    readonly channelId: string;
    readonly name?: string;
    readonly about?: string;
    readonly visibility?: ChannelVisibility;
  }) {
    return this.relay.publish(
      buildUpdateChannel({
        channelId: input.channelId,
        ...(input.about === undefined ? {} : { about: input.about }),
        ...(input.name === undefined ? {} : { name: input.name }),
        ...(input.visibility === undefined
          ? {}
          : { visibility: input.visibility }),
      }),
    );
  }

  public join(channelId: string) {
    return this.relay.publish(buildJoin(channelId));
  }

  public leave(channelId: string) {
    return this.relay.publish(buildLeave(channelId));
  }

  public archive(channelId: string) {
    return this.relay.publish(buildArchive(channelId));
  }

  public addMember(
    channelId: string,
    pubkey: string,
    role: MemberRole = "member",
  ) {
    return this.relay.publish(buildAddMember(channelId, pubkey, role));
  }

  public removeMember(channelId: string, pubkey: string) {
    return this.relay.publish(buildRemoveMember(channelId, pubkey));
  }

  public openDm(pubkeys: readonly string[]) {
    return this.relay.publish(buildDmOpen(pubkeys));
  }

  public addDmMember(channelId: string, pubkey: string) {
    return this.relay.publish(buildDmAddMember(channelId, pubkey));
  }

  public sendMessage(input: {
    readonly channelId: string;
    readonly content: string;
    readonly thread?: ThreadRef;
    readonly mentions?: readonly string[];
    readonly mediaTags?: readonly MediaTag[];
  }) {
    return this.relay.publish(buildMessage(input));
  }

  public sendForumPost(input: {
    readonly channelId: string;
    readonly content: string;
    readonly mentions?: readonly string[];
    readonly mediaTags?: readonly MediaTag[];
  }) {
    return this.relay.publish(buildForumPost(input));
  }

  public sendForumComment(input: {
    readonly channelId: string;
    readonly content: string;
    readonly thread: ThreadRef;
    readonly mentions?: readonly string[];
    readonly mediaTags?: readonly MediaTag[];
  }) {
    return this.relay.publish(buildForumComment(input));
  }

  public edit(channelId: string, eventId: string, content: string) {
    return this.relay.publish(buildEdit(channelId, eventId, content));
  }

  public delete(channelId: string, eventId: string) {
    return this.relay.publish(buildDeleteMessage(channelId, eventId));
  }

  public react(eventId: string, emoji: string, emojiUrl?: string) {
    return this.relay.publish(
      emojiUrl
        ? buildCustomEmojiReaction(eventId, emoji, emojiUrl)
        : buildReaction(eventId, emoji),
    );
  }

  public setCanvas(channelId: string, markdown: string) {
    return this.relay.publish(buildSetCanvas(channelId, markdown));
  }

  public setProfile(profile: {
    readonly name: string;
    readonly displayName?: string;
    readonly about?: string;
    readonly picture?: string;
  }) {
    return this.relay.publish(buildProfile(profile));
  }

  public publishNote(content: string, replyToEventId?: string) {
    return this.relay.publish(buildNote(content, replyToEventId));
  }

  public pin(channelId: string, eventId: string, pinned: boolean) {
    return this.relay.publish({
      content: "",
      kind: KIND_STREAM_MESSAGE_PINNED,
      tags: [
        ["h", channelId],
        ["e", eventId],
        ["value", String(pinned)],
      ],
    });
  }

  public bookmark(channelId: string, eventId: string, bookmarked: boolean) {
    return this.relay.publish({
      content: "",
      kind: KIND_STREAM_MESSAGE_BOOKMARKED,
      tags: [
        ["h", channelId],
        ["e", eventId],
        ["value", String(bookmarked)],
      ],
    });
  }

  public setReadState(channelId: string, createdAt: number, eventId: string) {
    return this.relay.publish({
      content: "",
      kind: KIND_READ_STATE,
      tags: [
        ["d", `channel:${channelId}`],
        ["h", channelId],
        ["read_at", String(createdAt)],
        ["e", eventId],
      ],
    });
  }

  public setLegacyList(
    kind: typeof KIND_PIN_LIST | typeof KIND_BOOKMARK_LIST,
    eventIds: readonly string[],
  ) {
    return this.relay.publish({
      content: "",
      kind,
      tags: eventIds.map((eventId) => ["e", eventId]),
    });
  }
}
