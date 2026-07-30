import { Ionicons } from "@expo/vector-icons";
import { useNavigation } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { useMemo, useState } from "react";
import {
  Alert,
  FlatList,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";

import type { NostrEvent } from "@buzz/core";

import {
  buildInboxItems,
  inboxDeepLinkEvent,
  inboxItemIsDone,
  type InboxItem,
} from "../domain/inbox";
import type { Reminder } from "../domain/reminders";
import { firstTag, shortPubkey, type Channel } from "../domain/models";
import type { RootStackParams } from "../navigation/types";
import { MobileActions } from "../services/actions";
import { replaceReminder } from "../services/reminders";
import { useClientState } from "../state/client-state";
import {
  useActivity,
  useChannels,
  useProfile,
  usePulse,
  useReminders,
  useSearch,
} from "../state/queries";
import { useRelay } from "../state/relay-context";
import {
  Avatar,
  Button,
  EmptyState,
  Header,
  IconButton,
  LoadingState,
  Page,
  formatRelativeTime,
} from "../ui/components";
import { useBuzzTheme } from "../ui/theme";

type Navigation = NativeStackNavigationProp<RootStackParams>;
type PulseMode = "everyone" | "following" | "liked" | "agents" | "mine";
type SearchMode = "all" | "messages" | "channels" | "people";
type ActivityFilter =
  | "all"
  | InboxItem["category"]
  | "thread"
  | "reminders"
  | "drafts";

export function ActivityScreen() {
  const theme = useBuzzTheme();
  const navigation = useNavigation<Navigation>();
  const { community, relay, secretKey } = useRelay();
  const channels = useChannels();
  const dms = useMemo(
    () =>
      channels.data
        ?.filter((channel) => channel.type === "dm")
        .map((channel) => channel.id) ?? [],
    [channels.data],
  );
  const activity = useActivity(dms);
  const reminders = useReminders();
  const drafts = useClientState((state) => state.drafts);
  const inboxDoneIds = useClientState((state) => state.inboxDoneIds);
  const inboxUnreadIds = useClientState((state) => state.inboxUnreadIds);
  const readMarkers = useClientState((state) => state.readMarkers);
  const markInboxDone = useClientState((state) => state.markInboxDone);
  const markInboxUnread = useClientState((state) => state.markInboxUnread);
  const clearInboxUnread = useClientState((state) => state.clearInboxUnread);
  const removeDraft = useClientState((state) => state.removeDraft);
  const [filter, setFilter] = useState<ActivityFilter>("all");
  const byId = new Map(channels.data?.map((channel) => [channel.id, channel]));
  const inboxItems = useMemo(
    () => buildInboxItems(activity.data ?? [], new Set(dms)),
    [activity.data, dms],
  );
  const doneIds = new Set(inboxDoneIds);
  const unreadIds = new Set(inboxUnreadIds);
  const visible = inboxItems.filter(
    (item) =>
      filter === "all" ||
      filter === "reminders" ||
      filter === "drafts" ||
      (filter === "thread"
        ? item.threadRootId !== undefined
        : item.categories.includes(filter)),
  );
  const pendingReminders = (reminders.data ?? []).filter(
    (reminder) => reminder.content.status === "pending",
  );
  const dueCount = pendingReminders.filter(
    (reminder) =>
      reminder.notBefore !== undefined &&
      reminder.notBefore <= Math.floor(Date.now() / 1_000),
  ).length;
  return (
    <Page>
      <Header
        eyebrow="Inbox"
        subtitle="Mentions, decisions, DMs, and agent turns"
        title="Activity"
      />
      <View style={styles.chips}>
        {(
          [
            ["all", "All"],
            ["mention", "Mentions"],
            ["thread", "Threads"],
            ["needs_action", "Needs action"],
            ["agent_activity", "Agents"],
            ["activity", "DMs"],
            ["reminders", `Reminders${dueCount ? ` ${dueCount}` : ""}`],
            ["drafts", `Drafts${drafts.length ? ` ${drafts.length}` : ""}`],
          ] as const
        ).map(([value, label]) => (
          <FilterChip
            key={value}
            label={label}
            selected={filter === value}
            onPress={() => setFilter(value)}
          />
        ))}
      </View>
      {filter === "reminders" ? (
        <FlatList
          contentContainerStyle={
            pendingReminders.length ? styles.feed : styles.grow
          }
          data={pendingReminders}
          keyExtractor={(item) => item.id}
          ListEmptyComponent={
            <EmptyState
              body="Use Remind me from any message to bring it back at the right time."
              icon="alarm-outline"
              title="No reminders"
            />
          }
          renderItem={({ item }) => (
            <ReminderRow
              reminder={item}
              onDone={() =>
                void replaceReminder({
                  community,
                  relay,
                  reminder: item,
                  secretKey,
                  status: "done",
                }).catch((error: unknown) =>
                  showError("Reminder not updated", error),
                )
              }
              onOpen={() => {
                const target = item.content.target;
                if (target) {
                  navigation.navigate("Channel", {
                    channelId: target.channelId,
                    focusEventId: target.eventId,
                  });
                }
              }}
              onSnooze={() =>
                void replaceReminder({
                  community,
                  notBefore: Math.floor(Date.now() / 1_000) + 60 * 60,
                  relay,
                  reminder: item,
                  secretKey,
                  status: "pending",
                }).catch((error: unknown) =>
                  showError("Reminder not snoozed", error),
                )
              }
            />
          )}
        />
      ) : filter === "drafts" ? (
        <FlatList
          contentContainerStyle={drafts.length ? styles.feed : styles.grow}
          data={drafts}
          keyExtractor={(item) => item.key}
          ListEmptyComponent={
            <EmptyState
              body="Unsent channel and thread text is kept privately on this device."
              icon="document-text-outline"
              title="No drafts"
            />
          }
          renderItem={({ item }) => (
            <Pressable
              style={[
                styles.searchRow,
                {
                  backgroundColor: theme.colors.surface,
                  borderColor: theme.colors.border,
                },
              ]}
              onLongPress={() =>
                Alert.alert("Delete draft?", item.text.slice(0, 160), [
                  { style: "cancel", text: "Cancel" },
                  {
                    onPress: () => removeDraft(item.key),
                    style: "destructive",
                    text: "Delete",
                  },
                ])
              }
              onPress={() =>
                item.threadRootId
                  ? navigation.navigate("Thread", {
                      channelId: item.channelId,
                      rootId: item.threadRootId,
                    })
                  : navigation.navigate("Channel", {
                      channelId: item.channelId,
                    })
              }
            >
              <Ionicons
                color={theme.colors.accent}
                name="document-text-outline"
                size={20}
              />
              <View style={styles.copy}>
                <Text
                  numberOfLines={2}
                  style={{
                    color: theme.colors.text,
                    fontFamily: "Inter",
                    fontSize: 14,
                  }}
                >
                  {item.text}
                </Text>
                <Text
                  style={{
                    color: theme.colors.faint,
                    fontFamily: "GeistMono",
                    fontSize: 9,
                  }}
                >
                  {formatRelativeTime(Math.floor(item.updatedAt / 1_000))}
                </Text>
              </View>
            </Pressable>
          )}
        />
      ) : activity.isPending ? (
        <LoadingState label="Building inbox" />
      ) : (
        <FlatList
          contentContainerStyle={visible.length ? styles.feed : styles.grow}
          data={visible}
          keyExtractor={(item) => item.conversationId}
          ListEmptyComponent={
            <EmptyState
              body="Mentions, approvals, agent progress, and direct messages will land here."
              icon="checkmark-done-outline"
              title="All caught up"
            />
          }
          refreshControl={
            <RefreshControl
              refreshing={activity.isRefetching}
              tintColor={theme.colors.accent}
              onRefresh={() => void activity.refetch()}
            />
          }
          renderItem={({ item }) => {
            const channelId = item.channelId;
            const channel = channelId ? byId.get(channelId) : undefined;
            const marker = item.threadRootId
              ? readMarkers[`thread:${item.threadRootId}`]
              : channelId
                ? readMarkers[`channel:${channelId}`]
                : undefined;
            const done = inboxItemIsDone(item, {
              doneIds,
              ...(marker ? { readAt: marker.createdAt } : {}),
              unreadIds,
            });
            return (
              <ActivityRow
                channel={channel}
                done={done}
                item={item}
                onLongPress={() =>
                  Alert.alert(
                    done ? "Mark unread?" : "Mark as read?",
                    "This changes the inbox state on this device.",
                    [
                      { style: "cancel", text: "Cancel" },
                      done
                        ? {
                            onPress: () =>
                              markInboxUnread([item.conversationId]),
                            text: "Mark unread",
                          }
                        : {
                            onPress: () => markInboxDone(item.conversationId),
                            text: "Mark as read",
                          },
                    ],
                  )
                }
                onPress={() => {
                  clearInboxUnread([item.conversationId]);
                  if (!channelId) markInboxDone(item.conversationId);
                  if (item.category === "agent_activity") {
                    navigation.navigate("AgentActivity", {
                      agentPubkey: item.event.pubkey,
                      ...(channelId ? { channelId } : {}),
                    });
                    return;
                  }
                  if (channelId) {
                    const target = inboxDeepLinkEvent(item, marker?.createdAt);
                    if (item.threadRootId) {
                      navigation.navigate("Thread", {
                        channelId,
                        rootId: item.threadRootId,
                      });
                    } else {
                      navigation.navigate("Channel", {
                        channelId,
                        focusEventId: target.id,
                      });
                    }
                  } else {
                    navigation.navigate("Profile", {
                      pubkey: item.event.pubkey,
                    });
                  }
                }}
              />
            );
          }}
        />
      )}
    </Page>
  );
}

function ReminderRow({
  reminder,
  onDone,
  onOpen,
  onSnooze,
}: {
  readonly reminder: Reminder;
  readonly onDone: () => void;
  readonly onOpen: () => void;
  readonly onSnooze: () => void;
}) {
  const theme = useBuzzTheme();
  const due =
    reminder.notBefore !== undefined &&
    reminder.notBefore <= Math.floor(Date.now() / 1_000);
  return (
    <Pressable
      style={[
        styles.searchRow,
        {
          backgroundColor: theme.colors.surface,
          borderColor: due ? theme.colors.warning : theme.colors.border,
        },
      ]}
      onPress={onOpen}
    >
      <View
        style={[
          styles.searchIcon,
          {
            backgroundColor: theme.colors.accentSoft,
          },
        ]}
      >
        <Ionicons
          color={due ? theme.colors.warning : theme.colors.accent}
          name="alarm-outline"
          size={20}
        />
      </View>
      <View style={styles.copy}>
        <Text
          numberOfLines={2}
          style={[
            styles.rowTitle,
            { color: theme.colors.text, fontFamily: "Inter" },
          ]}
        >
          {reminder.content.note ||
            reminder.content.target?.preview ||
            "Reminder"}
        </Text>
        <Text
          style={{
            color: due ? theme.colors.warning : theme.colors.faint,
            fontFamily: "GeistMono",
            fontSize: 9,
          }}
        >
          {due
            ? "DUE NOW"
            : reminder.notBefore
              ? `DUE ${formatRelativeTime(reminder.notBefore)}`
              : "PENDING"}
        </Text>
      </View>
      <FeedAction icon="time-outline" label="1h" onPress={onSnooze} />
      <FeedAction icon="checkmark-outline" label="Done" onPress={onDone} />
    </Pressable>
  );
}

export function SearchScreen() {
  const theme = useBuzzTheme();
  const navigation = useNavigation<Navigation>();
  const channels = useChannels();
  const [query, setQuery] = useState("");
  const [mode, setMode] = useState<SearchMode>("all");
  const search = useSearch(query);
  const localChannels = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (needle.length < 2) return [];
    return (channels.data ?? []).filter(
      (channel) =>
        channel.name.toLowerCase().includes(needle) ||
        channel.about.toLowerCase().includes(needle),
    );
  }, [channels.data, query]);
  const allItems = [
    ...localChannels.map((channel) => ({
      id: `channel:${channel.id}`,
      type: "channel" as const,
      value: channel,
    })),
    ...(search.data?.profiles ?? []).map((profile) => ({
      id: `profile:${profile.pubkey}`,
      type: "profile" as const,
      value: profile,
    })),
    ...(search.data?.messages ?? []).map((event) => ({
      id: `message:${event.id}`,
      type: "message" as const,
      value: event,
    })),
  ];
  const items = allItems.filter(
    (item) =>
      mode === "all" ||
      (mode === "channels" && item.type === "channel") ||
      (mode === "people" && item.type === "profile") ||
      (mode === "messages" && item.type === "message"),
  );
  return (
    <Page>
      <Header
        eyebrow="NIP-50"
        subtitle="Search messages, people, and joined spaces"
        title="Search"
      />
      <View
        style={[
          styles.search,
          {
            backgroundColor: theme.colors.surface,
            borderColor: theme.colors.border,
          },
        ]}
      >
        <Ionicons color={theme.colors.faint} name="search" size={20} />
        <TextInput
          autoCapitalize="none"
          autoCorrect={false}
          placeholder="Names, phrases, decisions…"
          placeholderTextColor={theme.colors.faint}
          returnKeyType="search"
          style={[
            styles.searchInput,
            { color: theme.colors.text, fontFamily: "Inter" },
          ]}
          value={query}
          onChangeText={setQuery}
        />
        {query ? (
          <Pressable
            accessibilityLabel="Clear search"
            onPress={() => setQuery("")}
          >
            <Ionicons
              color={theme.colors.faint}
              name="close-circle"
              size={19}
            />
          </Pressable>
        ) : null}
      </View>
      <View style={styles.chips}>
        {(["all", "messages", "channels", "people"] as const).map((value) => (
          <FilterChip
            key={value}
            label={value}
            selected={mode === value}
            onPress={() => setMode(value)}
          />
        ))}
      </View>
      {query.trim().length < 2 ? (
        <EmptyState
          body="Search starts after two characters and stays scoped to the authenticated community."
          icon="search-outline"
          title="Find the signal"
        />
      ) : search.isPending ? (
        <LoadingState label="Searching relay index" />
      ) : (
        <FlatList
          contentContainerStyle={items.length ? styles.feed : styles.grow}
          data={items}
          keyExtractor={(item) => item.id}
          ListEmptyComponent={
            <EmptyState
              body="Try a shorter phrase, a display name, or a channel topic."
              icon="telescope-outline"
              title="No matches"
            />
          }
          renderItem={({ item }) => {
            if (item.type === "channel") {
              return (
                <SearchChannelRow
                  channel={item.value}
                  onPress={() =>
                    navigation.navigate("Channel", {
                      channelId: item.value.id,
                    })
                  }
                />
              );
            }
            if (item.type === "profile") {
              return (
                <Pressable
                  style={[
                    styles.searchRow,
                    {
                      backgroundColor: theme.colors.surface,
                      borderColor: theme.colors.border,
                    },
                  ]}
                  onPress={() =>
                    navigation.navigate("Profile", {
                      pubkey: item.value.pubkey,
                    })
                  }
                >
                  <Avatar
                    profile={item.value}
                    pubkey={item.value.pubkey}
                    size={38}
                  />
                  <View style={styles.copy}>
                    <Text
                      style={[
                        styles.rowTitle,
                        { color: theme.colors.text, fontFamily: "Inter" },
                      ]}
                    >
                      {item.value.displayName}
                    </Text>
                    <Text
                      numberOfLines={1}
                      style={{
                        color: theme.colors.muted,
                        fontFamily: "Inter",
                        fontSize: 12,
                      }}
                    >
                      {item.value.about || shortPubkey(item.value.pubkey)}
                    </Text>
                  </View>
                </Pressable>
              );
            }
            const channelId = firstTag(item.value, "h");
            return (
              <SearchMessageRow
                event={item.value}
                onPress={() => {
                  if (channelId) {
                    navigation.navigate("Channel", {
                      channelId,
                      focusEventId: item.value.id,
                    });
                  }
                }}
              />
            );
          }}
        />
      )}
    </Page>
  );
}

export function PulseScreen() {
  const theme = useBuzzTheme();
  const navigation = useNavigation<Navigation>();
  const { relay } = useRelay();
  const actions = useMemo(() => new MobileActions(relay), [relay]);
  const [mode, setMode] = useState<PulseMode>("everyone");
  const notes = usePulse(mode);
  return (
    <Page>
      <Header
        eyebrow="Pulse"
        right={
          <IconButton
            icon="create-outline"
            label="Compose note"
            onPress={() => navigation.navigate("ComposeNote", {})}
          />
        }
        subtitle="Community-wide notes outside channel walls"
        title="The wider signal"
      />
      <View style={styles.chips}>
        {(["everyone", "following", "liked", "agents", "mine"] as const).map(
          (value) => (
            <FilterChip
              key={value}
              label={value}
              selected={mode === value}
              onPress={() => setMode(value)}
            />
          ),
        )}
      </View>
      {notes.isPending ? (
        <LoadingState label="Loading pulse" />
      ) : (
        <FlatList
          contentContainerStyle={notes.data?.length ? styles.feed : styles.grow}
          data={notes.data ?? []}
          keyExtractor={(item) => item.id}
          ListEmptyComponent={
            <EmptyState
              action={
                <Button
                  label="Write a note"
                  onPress={() => navigation.navigate("ComposeNote", {})}
                />
              }
              body="Short updates from people and agents will collect here."
              icon="pulse-outline"
              title="No pulse in this view"
            />
          }
          refreshControl={
            <RefreshControl
              refreshing={notes.isRefetching}
              tintColor={theme.colors.accent}
              onRefresh={() => void notes.refetch()}
            />
          }
          renderItem={({ item }) => (
            <NoteRow
              event={item}
              onLike={() =>
                void actions
                  .react(item.id, "+")
                  .catch((error: unknown) =>
                    showError("Reaction not sent", error),
                  )
              }
              onOpenProfile={() =>
                navigation.navigate("Profile", { pubkey: item.pubkey })
              }
              onReply={() =>
                navigation.navigate("ComposeNote", {
                  replyToEventId: item.id,
                })
              }
            />
          )}
        />
      )}
    </Page>
  );
}

function ActivityRow({
  item,
  channel,
  done,
  onLongPress,
  onPress,
}: {
  readonly item: InboxItem;
  readonly channel?: Channel | undefined;
  readonly done: boolean;
  readonly onLongPress: () => void;
  readonly onPress: () => void;
}) {
  const theme = useBuzzTheme();
  const profile = useProfile(item.event.pubkey).data;
  const labels = {
    activity: "Direct message",
    agent_activity: "Agent activity",
    mention: "Mention",
    needs_action: "Needs action",
  };
  return (
    <Pressable
      style={({ pressed }) => [
        styles.activityRow,
        {
          backgroundColor: pressed
            ? theme.colors.accentSoft
            : theme.colors.surface,
          borderColor:
            item.category === "needs_action"
              ? theme.colors.warning
              : theme.colors.border,
        },
      ]}
      onLongPress={onLongPress}
      onPress={onPress}
    >
      <Avatar profile={profile} pubkey={item.event.pubkey} size={40} />
      <View style={styles.copy}>
        <View style={styles.meta}>
          <Text
            style={{
              color:
                item.category === "needs_action"
                  ? theme.colors.warning
                  : theme.colors.accent,
              fontFamily: "GeistMono",
              fontSize: 9,
              fontWeight: "700",
              textTransform: "uppercase",
            }}
          >
            {labels[item.category]}
            {channel ? ` · ${channel.name}` : ""}
          </Text>
          <Text
            style={{
              color: theme.colors.faint,
              fontFamily: "GeistMono",
              fontSize: 9,
            }}
          >
            {formatRelativeTime(item.event.created_at)}
          </Text>
        </View>
        <Text
          numberOfLines={2}
          style={{
            color: theme.colors.text,
            fontFamily: "Inter",
            fontSize: 14,
            lineHeight: 19,
          }}
        >
          {item.event.content || "Signed activity event"}
        </Text>
        {!done ? (
          <View
            accessibilityLabel="Unread"
            style={[styles.unreadDot, { backgroundColor: theme.colors.accent }]}
          />
        ) : null}
      </View>
    </Pressable>
  );
}

function NoteRow({
  event,
  onLike,
  onReply,
  onOpenProfile,
}: {
  readonly event: NostrEvent;
  readonly onLike: () => void;
  readonly onReply: () => void;
  readonly onOpenProfile: () => void;
}) {
  const theme = useBuzzTheme();
  const profile = useProfile(event.pubkey).data;
  return (
    <View
      style={[
        styles.note,
        {
          backgroundColor: theme.colors.surface,
          borderColor: theme.colors.border,
        },
      ]}
    >
      <Pressable style={styles.noteAuthor} onPress={onOpenProfile}>
        <Avatar profile={profile} pubkey={event.pubkey} size={40} />
        <View style={styles.copy}>
          <Text
            style={[
              styles.rowTitle,
              { color: theme.colors.text, fontFamily: "Inter" },
            ]}
          >
            {profile?.displayName ?? shortPubkey(event.pubkey)}
          </Text>
          <Text
            style={{
              color: theme.colors.faint,
              fontFamily: "GeistMono",
              fontSize: 9,
            }}
          >
            {formatRelativeTime(event.created_at)}
          </Text>
        </View>
      </Pressable>
      <Text
        selectable
        style={{
          color: theme.colors.text,
          fontFamily: "Inter",
          fontSize: 15,
          lineHeight: 22,
        }}
      >
        {event.content}
      </Text>
      <View style={styles.noteActions}>
        <FeedAction icon="heart-outline" label="Like" onPress={onLike} />
        <FeedAction icon="chatbubble-outline" label="Reply" onPress={onReply} />
      </View>
    </View>
  );
}

function SearchChannelRow({
  channel,
  onPress,
}: {
  readonly channel: Channel;
  readonly onPress: () => void;
}) {
  const theme = useBuzzTheme();
  return (
    <Pressable
      style={[
        styles.searchRow,
        {
          backgroundColor: theme.colors.surface,
          borderColor: theme.colors.border,
        },
      ]}
      onPress={onPress}
    >
      <View
        style={[
          styles.searchIcon,
          { backgroundColor: theme.colors.accentSoft },
        ]}
      >
        <Ionicons
          color={theme.colors.accent}
          name="chatbubbles-outline"
          size={19}
        />
      </View>
      <View style={styles.copy}>
        <Text
          style={[
            styles.rowTitle,
            { color: theme.colors.text, fontFamily: "Inter" },
          ]}
        >
          {channel.name}
        </Text>
        <Text
          numberOfLines={1}
          style={{
            color: theme.colors.muted,
            fontFamily: "Inter",
            fontSize: 12,
          }}
        >
          {channel.about || channel.type}
        </Text>
      </View>
    </Pressable>
  );
}

function SearchMessageRow({
  event,
  onPress,
}: {
  readonly event: NostrEvent;
  readonly onPress: () => void;
}) {
  const theme = useBuzzTheme();
  const profile = useProfile(event.pubkey).data;
  return (
    <Pressable
      style={[
        styles.searchRow,
        {
          backgroundColor: theme.colors.surface,
          borderColor: theme.colors.border,
        },
      ]}
      onPress={onPress}
    >
      <Avatar profile={profile} pubkey={event.pubkey} size={36} />
      <View style={styles.copy}>
        <Text
          style={[
            styles.rowTitle,
            { color: theme.colors.text, fontFamily: "Inter" },
          ]}
        >
          {profile?.displayName ?? shortPubkey(event.pubkey)}
        </Text>
        <Text
          numberOfLines={2}
          style={{
            color: theme.colors.muted,
            fontFamily: "Inter",
            fontSize: 12,
            lineHeight: 17,
          }}
        >
          {event.content}
        </Text>
      </View>
    </Pressable>
  );
}

function FilterChip({
  label,
  selected,
  onPress,
}: {
  readonly label: string;
  readonly selected: boolean;
  readonly onPress: () => void;
}) {
  const theme = useBuzzTheme();
  return (
    <Pressable
      accessibilityState={{ selected }}
      style={[
        styles.chip,
        {
          backgroundColor: selected ? theme.colors.accentSoft : "transparent",
          borderColor: selected ? theme.colors.accent : theme.colors.border,
        },
      ]}
      onPress={onPress}
    >
      <Text
        style={{
          color: selected ? theme.colors.accent : theme.colors.muted,
          fontFamily: "GeistMono",
          fontSize: 9,
          fontWeight: "600",
          textTransform: "uppercase",
        }}
      >
        {label}
      </Text>
    </Pressable>
  );
}

function FeedAction({
  icon,
  label,
  onPress,
}: {
  readonly icon: React.ComponentProps<typeof Ionicons>["name"];
  readonly label: string;
  readonly onPress: () => void;
}) {
  const theme = useBuzzTheme();
  return (
    <Pressable style={styles.feedAction} onPress={onPress}>
      <Ionicons color={theme.colors.muted} name={icon} size={17} />
      <Text
        style={{
          color: theme.colors.muted,
          fontFamily: "Inter",
          fontSize: 11,
        }}
      >
        {label}
      </Text>
    </Pressable>
  );
}

function showError(title: string, error: unknown): void {
  Alert.alert(
    title,
    error instanceof Error ? error.message : "Please try again.",
  );
}

const styles = StyleSheet.create({
  activityRow: {
    alignItems: "flex-start",
    borderRadius: 17,
    borderWidth: StyleSheet.hairlineWidth,
    flexDirection: "row",
    gap: 11,
    padding: 12,
  },
  chip: {
    borderRadius: 999,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 10,
    paddingVertical: 7,
  },
  chips: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 6,
    paddingBottom: 9,
    paddingHorizontal: 14,
  },
  copy: { flex: 1, gap: 2 },
  feed: { gap: 8, padding: 12, paddingBottom: 120 },
  feedAction: { alignItems: "center", flexDirection: "row", gap: 5 },
  grow: { flexGrow: 1 },
  meta: {
    alignItems: "center",
    flexDirection: "row",
    justifyContent: "space-between",
  },
  note: {
    borderRadius: 20,
    borderWidth: StyleSheet.hairlineWidth,
    gap: 13,
    padding: 15,
  },
  noteActions: { flexDirection: "row", gap: 18 },
  noteAuthor: { alignItems: "center", flexDirection: "row", gap: 10 },
  rowTitle: { fontSize: 14, fontWeight: "700" },
  search: {
    alignItems: "center",
    borderRadius: 16,
    borderWidth: StyleSheet.hairlineWidth,
    flexDirection: "row",
    gap: 9,
    marginBottom: 10,
    marginHorizontal: 14,
    minHeight: 50,
    paddingHorizontal: 13,
  },
  searchIcon: {
    alignItems: "center",
    borderRadius: 11,
    height: 38,
    justifyContent: "center",
    width: 38,
  },
  searchInput: { flex: 1, fontSize: 15, minHeight: 46 },
  searchRow: {
    alignItems: "center",
    borderRadius: 16,
    borderWidth: StyleSheet.hairlineWidth,
    flexDirection: "row",
    gap: 11,
    padding: 12,
  },
  unreadDot: {
    borderRadius: 999,
    height: 7,
    position: "absolute",
    right: 0,
    top: 26,
    width: 7,
  },
});
