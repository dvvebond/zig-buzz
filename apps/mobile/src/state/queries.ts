import {
  KIND_AGENT_PROFILE,
  KIND_CONTACT_LIST,
  KIND_DELETION,
  KIND_EVENT_REMINDER,
  KIND_NIP29_GROUP_MEMBERS,
  KIND_NIP29_GROUP_METADATA,
  KIND_NIP43_MEMBERSHIP_LIST,
  KIND_READ_STATE,
  KIND_REACTION,
  KIND_TEXT_NOTE,
  type NostrEvent,
  type NostrFilter,
} from "@buzz/core";
import {
  useQuery,
  useQueryClient,
  type UseQueryResult,
} from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useState } from "react";

import {
  CHANNEL_EVENT_KINDS,
  CHANNEL_WINDOW_CONTENT_KINDS,
  filters,
} from "../domain/filters";
import {
  parseChannelWindow,
  type ChannelCursor,
  type ChannelWindowPage,
  type ThreadSummary,
} from "../domain/channel-window";
import { type CustomEmoji, unionCustomEmoji } from "../domain/custom-emoji";
import { newestReminders, type Reminder } from "../domain/reminders";
import {
  firstTag,
  isMessageEvent,
  parseChannel,
  parseMembers,
  parseProfile,
  projectTimeline,
  threadReference,
  validChannelId,
  type Channel,
  type ChannelMember,
  type Profile,
} from "../domain/models";
import { useClientState } from "./client-state";
import { useRelay } from "./relay-context";

export function useChannels(): UseQueryResult<readonly Channel[]> {
  const { community, relay } = useRelay();
  const queryClient = useQueryClient();
  const key = useMemo(
    () => ["channels", community.id] as const,
    [community.id],
  );
  useEffect(
    () =>
      relay.subscribe(
        [
          {
            "#p": [community.pubkey],
            kinds: [KIND_NIP29_GROUP_MEMBERS],
          },
          { kinds: [KIND_NIP29_GROUP_METADATA] },
        ],
        () => void queryClient.invalidateQueries({ queryKey: key }),
      ),
    [community.pubkey, queryClient, relay, key],
  );
  return useQuery({
    queryFn: async () => {
      const memberships = await queryAllPages(
        relay,
        filters.myChannels(community.pubkey),
        500,
      );
      const ids = [
        ...new Set(
          memberships
            .map((event) => firstTag(event, "d"))
            .map(validChannelId)
            .filter((value): value is string => Boolean(value)),
        ),
      ];
      if (ids.length === 0) return [];
      const metadata = await relay.query([filters.channelMetadata(ids)]);
      const latest = latestByCoordinate(metadata, "d");
      const channels = [...latest.values()]
        .map(parseChannel)
        .filter((channel) => ids.includes(channel.id));
      const hidden = await relay
        .query([filters.hiddenDms(community.pubkey)])
        .catch(() => []);
      const hiddenIds = new Set(
        latestEvent(hidden)
          ?.tags.filter((tag) => tag[0] === "h")
          .map((tag) => tag[1])
          .filter((value): value is string => Boolean(value)) ?? [],
      );
      return channels
        .filter((channel) => !hiddenIds.has(channel.id))
        .sort(compareChannels);
    },
    queryKey: key,
  });
}

export function useChannel(channelId: string) {
  const channels = useChannels();
  return {
    ...channels,
    data: channels.data?.find((channel) => channel.id === channelId),
  };
}

export function useChannelMembers(
  channelId: string,
): UseQueryResult<readonly ChannelMember[]> {
  const { community, relay } = useRelay();
  const queryClient = useQueryClient();
  const key = useMemo(
    () => ["channel-members", community.id, channelId] as const,
    [channelId, community.id],
  );
  useEffect(
    () =>
      relay.subscribe(
        [filters.channelMembers(channelId)],
        () => void queryClient.invalidateQueries({ queryKey: key }),
      ),
    [channelId, queryClient, relay, key],
  );
  return useQuery({
    queryFn: async () => {
      const events = await relay.query([filters.channelMembers(channelId)]);
      const latest = latestEvent(events);
      return latest ? parseMembers(latest) : [];
    },
    queryKey: key,
  });
}

export function useCustomEmoji(): UseQueryResult<readonly CustomEmoji[]> {
  const { community, relay } = useRelay();
  const queryClient = useQueryClient();
  const key = useMemo(
    () => ["custom-emoji", community.id] as const,
    [community.id],
  );
  useEffect(
    () =>
      relay.subscribe(
        [filters.customEmoji()],
        () => void queryClient.invalidateQueries({ queryKey: key }),
      ),
    [queryClient, relay, key],
  );
  return useQuery({
    queryFn: async () =>
      unionCustomEmoji(await relay.query([filters.customEmoji()])),
    queryKey: key,
  });
}

export function useReminders(): UseQueryResult<readonly Reminder[]> {
  const { community, relay, secretKey } = useRelay();
  const queryClient = useQueryClient();
  const key = useMemo(
    () => ["reminders", community.id] as const,
    [community.id],
  );
  useEffect(
    () =>
      relay.subscribe(
        [
          {
            authors: [community.pubkey],
            kinds: [KIND_EVENT_REMINDER],
          },
        ],
        () => void queryClient.invalidateQueries({ queryKey: key }),
      ),
    [community.pubkey, key, queryClient, relay],
  );
  return useQuery({
    queryFn: async () =>
      newestReminders(
        await relay.query([
          {
            authors: [community.pubkey],
            kinds: [KIND_EVENT_REMINDER],
            limit: 200,
          },
        ]),
        secretKey,
        community.pubkey,
      ),
    queryKey: key,
  });
}

export function useMessages(channelId: string, focusEventId?: string) {
  const { community, relay } = useRelay();
  const [pending, setPending] = useState(relay.pendingEvents);
  const scope = `${community.id}:${channelId}`;
  const [olderState, setOlderState] = useState<{
    readonly scope: string;
    readonly pages: readonly MessagePage[];
  }>({ pages: [], scope });
  const olderPages =
    olderState.scope === scope ? olderState.pages : ([] as const);
  const [isLoadingOlder, setIsLoadingOlder] = useState(false);
  const queryClient = useQueryClient();
  const key = useMemo(
    () => ["messages", community.id, channelId] as const,
    [channelId, community.id],
  );
  const eventKey = useMemo(
    () => [...key, "events", focusEventId ?? ""] as const,
    [focusEventId, key],
  );
  useEffect(
    () =>
      relay.subscribe([filters.messages(channelId)], (event) => {
        queryClient.setQueryData<MessagePage>(eventKey, (current) =>
          current
            ? { ...current, events: mergeEvent(current.events, event) }
            : current,
        );
      }),
    [channelId, eventKey, queryClient, relay],
  );
  useEffect(() => relay.onOutbox(setPending), [relay]);
  const events = useQuery({
    queryFn: () => fetchMessageHead(relay, channelId, focusEventId),
    queryKey: eventKey,
  });
  const pendingInChannel = pending.filter(
    (event) => firstTag(event, "h") === channelId,
  );
  const pendingIds = new Set(pendingInChannel.map((event) => event.id));
  const combined = events.data
    ? [
        ...new Map(
          [
            ...events.data.events,
            ...olderPages.flatMap((page) => page.events),
            ...pendingInChannel,
          ].map((event) => [event.id, event]),
        ).values(),
      ]
    : undefined;
  const summaries = new Map<string, ThreadSummary>();
  for (const page of [events.data, ...olderPages]) {
    if (!page) continue;
    for (const [rootId, summary] of page.summaries) {
      if (!summaries.has(rootId)) summaries.set(rootId, summary);
    }
  }
  const tail = olderPages.at(-1) ?? events.data;
  const loadOlder = useCallback(async (): Promise<void> => {
    const currentTail = olderPages.at(-1) ?? events.data;
    if (!currentTail?.hasMore || !currentTail.nextCursor || isLoadingOlder) {
      return;
    }
    setIsLoadingOlder(true);
    try {
      const page = currentTail.window
        ? await fetchWindowPage(relay, channelId, currentTail.nextCursor)
        : await fetchLegacyPage(relay, channelId, currentTail.nextCursor);
      setOlderState((current) => ({
        pages: current.scope === scope ? [...current.pages, page] : [page],
        scope,
      }));
    } finally {
      setIsLoadingOlder(false);
    }
  }, [channelId, events.data, isLoadingOlder, olderPages, relay, scope]);
  const projected = combined
    ? projectTimeline(combined, pendingIds)
    : undefined;
  return {
    ...events,
    data: projected?.map((message) => {
      const summary = summaries.get(message.event.id);
      return summary
        ? {
            ...message,
            replyCount: summary.replyCount,
            replyParticipants: summary.participantPubkeys,
            ...(summary.lastReplyAt === undefined
              ? {}
              : { lastReplyAt: summary.lastReplyAt }),
          }
        : message;
    }),
    hasMore: tail?.hasMore ?? false,
    isLoadingOlder,
    loadOlder,
  };
}

type MessagePage = ChannelWindowPage & {
  readonly window: boolean;
};

async function fetchMessageHead(
  relay: ReturnType<typeof useRelay>["relay"],
  channelId: string,
  focusEventId?: string,
): Promise<MessagePage> {
  let page: MessagePage;
  try {
    page = await fetchWindowPage(relay, channelId);
  } catch {
    page = await fetchLegacyPage(relay, channelId);
  }
  if (!focusEventId || page.events.some((event) => event.id === focusEventId)) {
    return page;
  }
  const target = (await relay.query([{ ids: [focusEventId], limit: 1 }])).find(
    (event) => firstTag(event, "h") === channelId,
  );
  return target ? { ...page, events: [...page.events, target] } : page;
}

async function fetchWindowPage(
  relay: ReturnType<typeof useRelay>["relay"],
  channelId: string,
  cursor?: ChannelCursor,
): Promise<MessagePage> {
  const events = await relay.query([
    {
      "#h": [channelId],
      include_aux: true,
      include_summaries: true,
      kinds: [...CHANNEL_WINDOW_CONTENT_KINDS],
      limit: 50,
      top_level: true,
      ...(cursor ? { before_id: cursor.eventId, until: cursor.createdAt } : {}),
    },
  ]);
  return {
    ...parseChannelWindow(events, channelId, cursor),
    window: true,
  };
}

async function fetchLegacyPage(
  relay: ReturnType<typeof useRelay>["relay"],
  channelId: string,
  cursor?: ChannelCursor,
): Promise<MessagePage> {
  const events = await relay.query([
    {
      ...filters.messages(channelId),
      ...(cursor ? { before_id: cursor.eventId, until: cursor.createdAt } : {}),
      limit: 200,
    },
  ]);
  const oldest = [...events].sort(
    (left, right) =>
      left.created_at - right.created_at || right.id.localeCompare(left.id),
  )[0];
  const nextCursor =
    events.length >= 200 && oldest
      ? { createdAt: oldest.created_at, eventId: oldest.id }
      : undefined;
  return {
    events,
    hasMore: nextCursor !== undefined,
    ...(nextCursor ? { nextCursor } : {}),
    summaries: new Map(),
    window: false,
  };
}

export function useUnreadCounts(
  channelIds: readonly string[],
): UseQueryResult<Readonly<Record<string, number>>> {
  const { community, relay } = useRelay();
  const localReadMarkers = useClientState((state) => state.readMarkers);
  const follows = useClientState((state) => state.follows);
  const followedRootIds = useMemo(
    () => follows.map((follow) => follow.rootId),
    [follows],
  );
  const queryClient = useQueryClient();
  const ids = useMemo(() => [...new Set(channelIds)].sort(), [channelIds]);
  const key = useMemo(
    () =>
      [
        "unread-counts",
        community.id,
        ids,
        localReadMarkers,
        followedRootIds,
      ] as const,
    [community.id, followedRootIds, ids, localReadMarkers],
  );
  useEffect(() => {
    if (ids.length === 0) return undefined;
    return relay.subscribe(
      [
        { "#h": ids, kinds: [...CHANNEL_EVENT_KINDS] },
        {
          authors: [community.pubkey],
          kinds: [KIND_READ_STATE],
        },
      ],
      () => void queryClient.invalidateQueries({ queryKey: key }),
    );
  }, [community.pubkey, ids, key, queryClient, relay]);
  return useQuery({
    enabled: ids.length > 0,
    queryFn: async () => {
      const events = await relay.query([
        {
          "#h": ids,
          kinds: [...CHANNEL_EVENT_KINDS],
          limit: Math.min(10_000, Math.max(200, ids.length * 50)),
        },
        {
          authors: [community.pubkey],
          kinds: [KIND_READ_STATE],
          limit: Math.min(2_000, Math.max(100, ids.length * 2)),
        },
      ]);
      const readAt = new Map<string, number>();
      for (const [context, marker] of Object.entries(localReadMarkers)) {
        if (context.startsWith("channel:")) {
          readAt.set(context.slice(8), marker.createdAt);
        }
      }
      for (const event of events) {
        if (event.kind !== KIND_READ_STATE) continue;
        const channelId = firstTag(event, "h");
        const value = strictTimestamp(firstTag(event, "read_at"));
        if (
          channelId &&
          value !== undefined &&
          value > (readAt.get(channelId) ?? 0)
        ) {
          readAt.set(channelId, value);
        }
      }
      const counts: Record<string, number> = Object.fromEntries(
        ids.map((id) => [id, 0]),
      );
      const participatedRoots = new Set<string>();
      const authoredRoots = new Set<string>();
      for (const event of events) {
        if (!isMessageEvent(event) || event.pubkey !== community.pubkey) {
          continue;
        }
        const thread = threadReference(event);
        if (thread) participatedRoots.add(thread.rootId);
        else authoredRoots.add(event.id);
      }
      const followedRoots = new Set(followedRootIds);
      for (const event of events) {
        if (!isMessageEvent(event) || event.pubkey === community.pubkey) {
          continue;
        }
        const channelId = firstTag(event, "h");
        const thread = threadReference(event);
        const broadcast = event.tags.some(
          (tag) => tag[0] === "broadcast" && tag[1] === "1",
        );
        const mentioned = event.tags.some(
          (tag) => tag[0] === "p" && tag[1] === community.pubkey,
        );
        const relevant =
          !thread ||
          broadcast ||
          mentioned ||
          followedRoots.has(thread.rootId) ||
          participatedRoots.has(thread.rootId) ||
          authoredRoots.has(thread.rootId);
        if (
          relevant &&
          channelId &&
          channelId in counts &&
          event.created_at > (readAt.get(channelId) ?? 0)
        ) {
          counts[channelId] = (counts[channelId] ?? 0) + 1;
        }
      }
      return counts;
    },
    queryKey: key,
  });
}

export function useThread(channelId: string, rootId: string) {
  const { community, relay } = useRelay();
  const queryClient = useQueryClient();
  const [pending, setPending] = useState(relay.pendingEvents);
  const key = useMemo(
    () => ["thread", community.id, channelId, rootId] as const,
    [channelId, community.id, rootId],
  );
  useEffect(() => relay.onOutbox(setPending), [relay]);
  useEffect(
    () =>
      relay.subscribe(
        [{ "#h": [channelId], kinds: [...CHANNEL_EVENT_KINDS] }],
        (event) => {
          queryClient.setQueryData<readonly NostrEvent[]>(
            key,
            (current = []) => {
              const knownIds = new Set(current.map((item) => item.id));
              const related =
                event.id === rootId ||
                threadReference(event)?.rootId === rootId ||
                event.tags.some(
                  (tag) => tag[0] === "e" && knownIds.has(tag[1] ?? ""),
                );
              return related ? mergeEvent(current, event) : current;
            },
          );
        },
      ),
    [channelId, key, queryClient, relay, rootId],
  );
  const events = useQuery({
    queryFn: async () => {
      const [root, related] = await Promise.all([
        relay.query([{ ids: [rootId], limit: 1 }]),
        relay.query([
          {
            "#e": [rootId],
            "#h": [channelId],
            kinds: [...CHANNEL_EVENT_KINDS],
            limit: 500,
          },
        ]),
      ]);
      const content = [
        ...new Map(
          [...root, ...related].map((event) => [event.id, event]),
        ).values(),
      ];
      const ids = content
        .filter(isMessageEvent)
        .map((event) => event.id)
        .slice(0, 500);
      const aux = ids.length
        ? await relay.query([
            {
              "#e": ids,
              kinds: [5, 7, 9_005, 40_003],
              limit: 1_000,
            },
          ])
        : [];
      return [
        ...new Map(
          [...content, ...aux].map((event) => [event.id, event]),
        ).values(),
      ];
    },
    queryKey: key,
  });
  const pendingThread = pending.filter(
    (event) =>
      firstTag(event, "h") === channelId &&
      (event.id === rootId || threadReference(event)?.rootId === rootId),
  );
  const pendingIds = new Set(pendingThread.map((event) => event.id));
  const combined = events.data
    ? [
        ...new Map(
          [...events.data, ...pendingThread].map((event) => [event.id, event]),
        ).values(),
      ]
    : undefined;
  return {
    ...events,
    data: combined
      ? projectTimeline(combined, pendingIds).filter(
          (message) =>
            message.event.id === rootId || message.thread?.rootId === rootId,
        )
      : undefined,
  };
}

export function useForumPosts(channelId: string) {
  const { community, relay } = useRelay();
  const scope = `${community.id}:${channelId}`;
  const [olderState, setOlderState] = useState<{
    readonly scope: string;
    readonly pages: readonly (readonly NostrEvent[])[];
  }>({ pages: [], scope });
  const olderPages =
    olderState.scope === scope ? olderState.pages : ([] as const);
  const [isLoadingOlder, setIsLoadingOlder] = useState(false);
  const queryClient = useQueryClient();
  const key = useMemo(
    () => ["forum-posts", community.id, channelId] as const,
    [channelId, community.id],
  );
  useEffect(
    () =>
      relay.subscribe(
        [filters.forumPosts(channelId)],
        () => void queryClient.invalidateQueries({ queryKey: key }),
      ),
    [channelId, queryClient, relay, key],
  );
  const head = useQuery({
    queryFn: async () =>
      [...(await relay.query([filters.forumPosts(channelId)]))].sort(
        (left, right) => right.created_at - left.created_at,
      ),
    queryKey: key,
  });
  const tail = olderPages.at(-1) ?? head.data;
  const hasMore = (tail?.length ?? 0) >= 50;
  const loadOlder = useCallback(async (): Promise<void> => {
    if (!hasMore || !tail?.length || isLoadingOlder) return;
    const oldest = [...tail].sort(
      (left, right) =>
        left.created_at - right.created_at || right.id.localeCompare(left.id),
    )[0];
    if (!oldest) return;
    setIsLoadingOlder(true);
    try {
      const page = await relay.query([
        {
          ...filters.forumPosts(channelId),
          before_id: oldest.id,
          limit: 50,
          until: oldest.created_at,
        },
      ]);
      setOlderState((current) => ({
        pages: current.scope === scope ? [...current.pages, page] : [page],
        scope,
      }));
    } finally {
      setIsLoadingOlder(false);
    }
  }, [channelId, hasMore, isLoadingOlder, relay, scope, tail]);
  const data = head.data
    ? [
        ...new Map(
          [...head.data, ...olderPages.flat()].map((event) => [
            event.id,
            event,
          ]),
        ).values(),
      ].sort(
        (left, right) =>
          right.created_at - left.created_at || right.id.localeCompare(left.id),
      )
    : undefined;
  return {
    ...head,
    data,
    hasMore,
    isLoadingOlder,
    loadOlder,
  };
}

export function useProfile(pubkey: string): UseQueryResult<Profile> {
  const { community, relay } = useRelay();
  const queryClient = useQueryClient();
  const key = useMemo(
    () => ["profile", community.id, pubkey] as const,
    [community.id, pubkey],
  );
  useEffect(
    () =>
      relay.subscribe(
        [filters.profile(pubkey)],
        () => void queryClient.invalidateQueries({ queryKey: key }),
      ),
    [pubkey, queryClient, relay, key],
  );
  return useQuery({
    queryFn: async () => {
      const event = latestEvent(await relay.query([filters.profile(pubkey)]));
      return event
        ? parseProfile(event)
        : { about: "", displayName: short(pubkey), pubkey };
    },
    queryKey: key,
  });
}

export function useProfiles(
  pubkeys: readonly string[],
): UseQueryResult<readonly Profile[]> {
  const { community, relay } = useRelay();
  const queryClient = useQueryClient();
  const pubkeyKey = pubkeys.join(",");
  const authors = useMemo(
    () =>
      [...new Set(pubkeyKey.split(",").filter(Boolean))].sort().slice(0, 500),
    [pubkeyKey],
  );
  const key = useMemo(
    () => ["profiles", community.id, authors] as const,
    [authors, community.id],
  );
  useEffect(() => {
    if (authors.length === 0) return undefined;
    return relay.subscribe(
      [filters.profiles(authors)],
      () => void queryClient.invalidateQueries({ queryKey: key }),
    );
  }, [authors, key, queryClient, relay]);
  return useQuery({
    enabled: authors.length > 0,
    queryFn: async () => {
      const profiles = latestByCoordinate(
        await relay.query([filters.profiles(authors)]),
        "pubkey",
      );
      return authors.map((pubkey) => {
        const event = profiles.get(pubkey);
        return event
          ? parseProfile(event)
          : { about: "", displayName: short(pubkey), pubkey };
      });
    },
    queryKey: key,
  });
}

export function usePulse(
  mode: "everyone" | "following" | "liked" | "agents" | "mine",
): UseQueryResult<readonly NostrEvent[]> {
  const { community, relay } = useRelay();
  const key = useMemo(
    () => ["pulse", community.id, mode] as const,
    [community.id, mode],
  );
  const queryClient = useQueryClient();
  useEffect(
    () =>
      relay.subscribe(
        [{ kinds: [KIND_TEXT_NOTE], since: Math.floor(Date.now() / 1_000) }],
        () => void queryClient.invalidateQueries({ queryKey: key }),
      ),
    [queryClient, relay, key],
  );
  return useQuery({
    queryFn: async () => {
      if (mode === "mine") {
        return newestFirst(
          await relay.query([
            {
              authors: [community.pubkey],
              kinds: [KIND_TEXT_NOTE],
              limit: 100,
            },
          ]),
        );
      }
      if (mode === "following") {
        const contacts = latestEvent(
          await relay.query([
            {
              authors: [community.pubkey],
              kinds: [KIND_CONTACT_LIST],
              limit: 1,
            },
          ]),
        );
        const authors =
          contacts?.tags
            .filter((tag) => tag[0] === "p")
            .map((tag) => tag[1])
            .filter((value): value is string => Boolean(value)) ?? [];
        return authors.length
          ? newestFirst(
              await relay.query([
                { authors, kinds: [KIND_TEXT_NOTE], limit: 200 },
              ]),
            )
          : [];
      }
      if (mode === "agents") {
        const [profiles, members] = await Promise.all([
          relay.query([{ kinds: [KIND_AGENT_PROFILE], limit: 100 }]),
          relay.query([{ kinds: [KIND_NIP43_MEMBERSHIP_LIST], limit: 1 }]),
        ]);
        const authors = new Set(profiles.map((event) => event.pubkey));
        for (const tag of latestEvent(members)?.tags ?? []) {
          if (
            (tag[0] === "member" && tag[2] === "bot") ||
            (tag[0] === "p" && tag[3] === "bot")
          ) {
            if (tag[1]) authors.add(tag[1]);
          }
        }
        return authors.size
          ? newestFirst(
              await relay.query([
                {
                  authors: [...authors],
                  kinds: [KIND_TEXT_NOTE],
                  limit: 200,
                },
              ]),
            )
          : [];
      }
      if (mode === "liked") {
        const reactions = await relay.query([
          {
            authors: [community.pubkey],
            kinds: [KIND_REACTION],
            limit: 200,
          },
        ]);
        const liked = reactions
          .filter((event) => event.content === "+")
          .map(
            (event) =>
              [...event.tags].reverse().find((tag) => tag[0] === "e")?.[1],
          )
          .filter((value): value is string => Boolean(value));
        if (!liked.length) return [];
        const deletions = await relay.query([
          {
            "#e": reactions.map((event) => event.id),
            authors: [community.pubkey],
            kinds: [KIND_DELETION],
            limit: 500,
          },
        ]);
        const deleted = new Set(
          deletions.flatMap((event) =>
            event.tags
              .filter((tag) => tag[0] === "e")
              .map((tag) => tag[1])
              .filter((value): value is string => Boolean(value)),
          ),
        );
        const liveIds = reactions
          .filter((event) => !deleted.has(event.id))
          .flatMap((event) =>
            event.content === "+"
              ? [[...event.tags].reverse().find((tag) => tag[0] === "e")?.[1]]
              : [],
          )
          .filter((value): value is string => Boolean(value));
        return newestFirst(
          await relay.query([
            { ids: [...new Set(liveIds)], kinds: [KIND_TEXT_NOTE] },
          ]),
        );
      }
      return newestFirst(await relay.query([filters.globalNotes()]));
    },
    queryKey: key,
  });
}

export type ActivityItem = {
  readonly event: NostrEvent;
  readonly category: "mention" | "needs_action" | "agent_activity" | "activity";
};

export function useActivity(
  dmChannelIds: readonly string[],
): UseQueryResult<readonly ActivityItem[]> {
  const { community, relay } = useRelay();
  const dmKey = dmChannelIds.join(",");
  const key = useMemo(
    () => ["activity", community.id, dmKey] as const,
    [community.id, dmKey],
  );
  const queryClient = useQueryClient();
  const liveFilters = useMemo<NostrFilter[]>(
    () => [
      {
        "#p": [community.pubkey],
        kinds: [
          KIND_TEXT_NOTE,
          9,
          40_002,
          45_001,
          45_003,
          46_010,
          46_011,
          46_012,
          43_001,
          43_002,
          43_003,
          43_004,
          43_005,
          43_006,
        ],
        since: Math.floor(Date.now() / 1_000),
      },
    ],
    [community.pubkey],
  );
  useEffect(
    () =>
      relay.subscribe(
        liveFilters,
        () => void queryClient.invalidateQueries({ queryKey: key }),
      ),
    [liveFilters, queryClient, relay, key],
  );
  return useQuery({
    queryFn: async () => {
      const [mentions, actions, agent, dms] = await Promise.all([
        relay.query([
          {
            "#p": [community.pubkey],
            kinds: [9, 40_002, KIND_TEXT_NOTE, 45_001, 45_003],
            limit: 50,
          },
        ]),
        relay.query([
          {
            "#p": [community.pubkey],
            kinds: [46_010, 46_011, 46_012],
            limit: 20,
          },
        ]),
        relay.query([
          {
            "#p": [community.pubkey],
            kinds: [43_001, 43_002, 43_003, 43_004, 43_005, 43_006],
            limit: 20,
          },
        ]),
        dmChannelIds.length
          ? relay.query([{ "#h": dmChannelIds, kinds: [9, 40_002], limit: 30 }])
          : Promise.resolve([]),
      ]);
      const byId = new Map<string, ActivityItem>();
      const add = (
        events: readonly NostrEvent[],
        category: ActivityItem["category"],
      ) => {
        for (const event of events) {
          if (event.pubkey !== community.pubkey && !byId.has(event.id)) {
            byId.set(event.id, { category, event });
          }
        }
      };
      add(actions, "needs_action");
      add(mentions, "mention");
      add(agent, "agent_activity");
      add(dms, "activity");
      return [...byId.values()].sort(
        (left, right) => right.event.created_at - left.event.created_at,
      );
    },
    queryKey: key,
  });
}

export function useSearch(query: string): UseQueryResult<{
  readonly messages: readonly NostrEvent[];
  readonly profiles: readonly Profile[];
}> {
  const { community, relay } = useRelay();
  const trimmed = query.trim();
  return useQuery({
    enabled: trimmed.length >= 2,
    queryFn: async () => {
      const [messages, profileEvents] = await Promise.all([
        relay.query([filters.searchMessages(trimmed)]),
        relay.query([filters.searchUsers(trimmed)]),
      ]);
      return {
        messages: newestFirst(messages),
        profiles: [...latestByCoordinate(profileEvents, "pubkey").values()].map(
          parseProfile,
        ),
      };
    },
    queryKey: ["search", community.id, trimmed],
  });
}

async function queryAllPages(
  relay: ReturnType<typeof useRelay>["relay"],
  base: NostrFilter,
  pageSize: number,
): Promise<readonly NostrEvent[]> {
  const events = new Map<string, NostrEvent>();
  let until: number | undefined;
  for (let page = 0; page < 20; page += 1) {
    const batch = await relay.query([
      {
        ...base,
        limit: pageSize,
        ...(until === undefined ? {} : { until }),
      },
    ]);
    for (const event of batch) events.set(event.id, event);
    if (batch.length < pageSize) break;
    const oldest = Math.min(...batch.map((event) => event.created_at));
    until = oldest - 1;
  }
  return [...events.values()];
}

function latestByCoordinate(
  events: readonly NostrEvent[],
  tag: "d" | "pubkey",
): ReadonlyMap<string, NostrEvent> {
  const result = new Map<string, NostrEvent>();
  for (const event of events) {
    const coordinate = tag === "pubkey" ? event.pubkey : firstTag(event, tag);
    if (!coordinate) continue;
    const existing = result.get(coordinate);
    if (
      !existing ||
      event.created_at > existing.created_at ||
      (event.created_at === existing.created_at && event.id > existing.id)
    ) {
      result.set(coordinate, event);
    }
  }
  return result;
}

function latestEvent(events: readonly NostrEvent[]): NostrEvent | undefined {
  return [...events].sort(
    (left, right) =>
      right.created_at - left.created_at || right.id.localeCompare(left.id),
  )[0];
}

function mergeEvent(
  events: readonly NostrEvent[],
  event: NostrEvent,
): readonly NostrEvent[] {
  return [...events.filter((item) => item.id !== event.id), event];
}

function newestFirst(events: readonly NostrEvent[]): readonly NostrEvent[] {
  return [...events].sort(
    (left, right) =>
      right.created_at - left.created_at || right.id.localeCompare(left.id),
  );
}

function compareChannels(left: Channel, right: Channel): number {
  const order = { stream: 0, forum: 1, dm: 2, workflow: 3 };
  return (
    order[left.type] - order[right.type] ||
    left.name.localeCompare(right.name, undefined, { sensitivity: "base" })
  );
}

function short(pubkey: string): string {
  return `${pubkey.slice(0, 6)}…${pubkey.slice(-4)}`;
}

function strictTimestamp(value: string | undefined): number | undefined {
  if (!value || !/^(0|[1-9][0-9]*)$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}
