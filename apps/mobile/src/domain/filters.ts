import {
  KIND_AGENT_PROFILE,
  KIND_CANVAS,
  KIND_CONTACT_LIST,
  KIND_DELETION,
  KIND_DM_VISIBILITY,
  KIND_EMOJI_SET,
  KIND_FORUM_COMMENT,
  KIND_FORUM_POST,
  KIND_NIP29_DELETE_EVENT,
  KIND_NIP29_GROUP_MEMBERS,
  KIND_NIP29_GROUP_METADATA,
  KIND_NIP43_MEMBERSHIP_LIST,
  KIND_PROFILE,
  KIND_REACTION,
  KIND_STREAM_MESSAGE,
  KIND_STREAM_MESSAGE_DIFF,
  KIND_STREAM_MESSAGE_EDIT,
  KIND_STREAM_MESSAGE_V2,
  KIND_SYSTEM_MESSAGE,
  KIND_TEXT_NOTE,
  type NostrFilter,
} from "@buzz/core";

export type BridgeFilter = NostrFilter & {
  readonly page?: number;
  readonly search_mode?: "prefix";
};

export const CHANNEL_EVENT_KINDS = [
  KIND_DELETION,
  KIND_REACTION,
  KIND_NIP29_DELETE_EVENT,
  KIND_STREAM_MESSAGE,
  KIND_STREAM_MESSAGE_V2,
  KIND_STREAM_MESSAGE_DIFF,
  KIND_STREAM_MESSAGE_EDIT,
  KIND_SYSTEM_MESSAGE,
  43_001,
  43_002,
  43_003,
  43_004,
  43_005,
  43_006,
  48_100,
  48_101,
  48_102,
  48_103,
] as const;

export const CHANNEL_WINDOW_CONTENT_KINDS = [
  KIND_STREAM_MESSAGE,
  KIND_STREAM_MESSAGE_V2,
  KIND_STREAM_MESSAGE_DIFF,
  KIND_SYSTEM_MESSAGE,
  43_001,
  43_002,
  43_003,
  43_004,
  43_005,
  43_006,
  48_100,
] as const;

export const filters = {
  agentProfiles: (): NostrFilter => ({
    kinds: [KIND_AGENT_PROFILE],
    limit: 100,
  }),
  canvas: (channelId: string): NostrFilter => ({
    "#h": [channelId],
    kinds: [KIND_CANVAS],
    limit: 1,
  }),
  channelMembers: (channelId: string): NostrFilter => ({
    "#d": [channelId],
    kinds: [KIND_NIP29_GROUP_MEMBERS],
    limit: 1,
  }),
  channelMetadata: (ids: readonly string[]): NostrFilter => ({
    "#d": ids,
    kinds: [KIND_NIP29_GROUP_METADATA],
    limit: Math.max(ids.length, 1),
  }),
  contactList: (pubkey: string): NostrFilter => ({
    authors: [pubkey],
    kinds: [KIND_CONTACT_LIST],
    limit: 1,
  }),
  customEmoji: (): NostrFilter => ({
    "#d": ["buzz:custom-emoji"],
    kinds: [KIND_EMOJI_SET],
    limit: 500,
  }),
  forumPosts: (channelId: string, until?: number): NostrFilter => ({
    "#h": [channelId],
    kinds: [KIND_FORUM_POST],
    limit: 50,
    ...(until === undefined ? {} : { until }),
  }),
  forumThread: (rootId: string, channelId: string): NostrFilter => ({
    "#e": [rootId],
    "#h": [channelId],
    kinds: [KIND_STREAM_MESSAGE, KIND_FORUM_COMMENT],
    limit: 200,
  }),
  globalNotes: (until?: number): NostrFilter => ({
    kinds: [KIND_TEXT_NOTE],
    limit: 50,
    ...(until === undefined ? {} : { until }),
  }),
  hiddenDms: (pubkey: string): NostrFilter => ({
    "#p": [pubkey],
    kinds: [KIND_DM_VISIBILITY],
    limit: 1,
  }),
  messages: (channelId: string, until?: number): NostrFilter => ({
    "#h": [channelId],
    kinds: CHANNEL_EVENT_KINDS,
    limit: 200,
    ...(until === undefined ? {} : { until }),
  }),
  myChannels: (pubkey: string): NostrFilter => ({
    "#p": [pubkey],
    kinds: [KIND_NIP29_GROUP_MEMBERS],
    limit: 500,
  }),
  notesByAuthors: (
    authors: readonly string[],
    until?: number,
  ): NostrFilter => ({
    authors,
    kinds: [KIND_TEXT_NOTE],
    limit: 200,
    ...(until === undefined ? {} : { until }),
  }),
  profile: (pubkey: string): NostrFilter => ({
    authors: [pubkey],
    kinds: [KIND_PROFILE],
    limit: 1,
  }),
  profiles: (pubkeys: readonly string[]): NostrFilter => ({
    authors: pubkeys,
    kinds: [KIND_PROFILE],
    limit: Math.max(pubkeys.length, 1),
  }),
  reactions: (eventIds: readonly string[]): NostrFilter => ({
    "#e": eventIds,
    kinds: [KIND_REACTION],
    limit: 500,
  }),
  relayMembers: (): NostrFilter => ({
    kinds: [KIND_NIP43_MEMBERSHIP_LIST],
    limit: 1,
  }),
  searchMessages: (query: string, channelId?: string): BridgeFilter => ({
    ...(channelId === undefined ? {} : { "#h": [channelId] }),
    kinds: [
      KIND_STREAM_MESSAGE,
      KIND_STREAM_MESSAGE_V2,
      KIND_FORUM_POST,
      KIND_FORUM_COMMENT,
    ],
    limit: 50,
    search: query,
  }),
  searchUsers: (query: string): BridgeFilter => ({
    kinds: [KIND_PROFILE],
    limit: 50,
    search: query,
    search_mode: "prefix",
  }),
} as const;
