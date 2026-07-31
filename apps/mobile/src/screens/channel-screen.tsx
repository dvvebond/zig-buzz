import { Ionicons } from "@expo/vector-icons";
import * as Clipboard from "expo-clipboard";
import { Image } from "expo-image";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { useEffect, useMemo, useState } from "react";
import {
  Alert,
  FlatList,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";

import { KIND_TYPING_INDICATOR, type NostrEvent } from "@buzz/core";

import type { RootStackParams } from "../navigation/types";
import { MobileActions } from "../services/actions";
import { createReminder } from "../services/reminders";
import { buildMessageLink } from "../domain/deep-links";
import {
  buildMainTimeline,
  firstTag,
  type TimelineMessage,
} from "../domain/models";
import {
  useChannel,
  useCustomEmoji,
  useForumPosts,
  useMessages,
  useProfile,
  useThread,
} from "../state/queries";
import { useClientState } from "../state/client-state";
import { useRelay } from "../state/relay-context";
import {
  Button,
  EmptyState,
  Header,
  IconButton,
  LoadingState,
  Page,
  formatRelativeTime,
} from "../ui/components";
import { Composer, MessageList } from "../ui/message";
import { useBuzzTheme } from "../ui/theme";

type ChannelProps = NativeStackScreenProps<RootStackParams, "Channel">;
type ThreadProps = NativeStackScreenProps<RootStackParams, "Thread">;

export function ChannelScreen({ navigation, route }: ChannelProps) {
  const theme = useBuzzTheme();
  const { community, relay, secretKey } = useRelay();
  const actions = useMemo(() => new MobileActions(relay), [relay]);
  const setReadMarker = useClientState((state) => state.setReadMarker);
  const channel = useChannel(route.params.channelId);
  const messages = useMessages(
    route.params.channelId,
    route.params.focusEventId,
  );
  const mainMessages = useMemo(
    () => buildMainTimeline(messages.data ?? []),
    [messages.data],
  );
  const [selected, setSelected] = useState<TimelineMessage>();
  const [editing, setEditing] = useState<TimelineMessage>();
  const typing = useTyping(route.params.channelId);

  useEffect(() => {
    const latest = messages.data?.at(-1);
    if (!latest || latest.event.pubkey === community.pubkey) return;
    const timeout = setTimeout(() => {
      setReadMarker(`channel:${route.params.channelId}`, {
        createdAt: latest.event.created_at,
        eventId: latest.event.id,
      });
      void actions
        .setReadState(
          route.params.channelId,
          latest.event.created_at,
          latest.event.id,
        )
        .catch(() => undefined);
    }, 1_000);
    return () => clearTimeout(timeout);
  }, [
    actions,
    community.pubkey,
    messages.data,
    route.params.channelId,
    setReadMarker,
  ]);

  if (channel.isPending) {
    return (
      <Page>
        <LoadingState label="Opening channel" />
      </Page>
    );
  }
  const value = channel.data;
  if (!value) {
    return (
      <Page>
        <Header
          left={
            <IconButton
              icon="chevron-back"
              label="Back"
              onPress={() => navigation.goBack()}
            />
          }
          title="Channel unavailable"
        />
        <EmptyState
          body="The channel may have been removed or your membership changed."
          icon="alert-circle-outline"
          title="No channel metadata"
        />
      </Page>
    );
  }

  if (value.type === "forum") {
    return (
      <ForumChannel
        channelId={value.id}
        name={value.name}
        navigation={navigation}
      />
    );
  }

  const openThread = (message: TimelineMessage) =>
    navigation.navigate("Thread", {
      channelId: value.id,
      rootId: message.thread?.rootId ?? message.event.id,
    });

  return (
    <Page>
      <Header
        eyebrow={value.type}
        left={
          <IconButton
            icon="chevron-back"
            label="Back"
            onPress={() => navigation.goBack()}
          />
        }
        right={
          <View style={styles.headerActions}>
            <IconButton
              icon="document-text-outline"
              label="Channel canvas"
              onPress={() =>
                navigation.navigate("Canvas", { channelId: value.id })
              }
            />
            <IconButton
              icon="people-outline"
              label="Members"
              onPress={() =>
                navigation.navigate("Members", { channelId: value.id })
              }
            />
          </View>
        }
        subtitle={value.about || `${value.visibility} ${value.type}`}
        title={value.name}
      />
      {messages.isPending ? (
        <LoadingState label="Loading conversation" />
      ) : mainMessages.length ? (
        <MessageList
          {...(route.params.focusEventId
            ? { focusEventId: route.params.focusEventId }
            : {})}
          ListHeaderComponent={
            messages.hasMore ? (
              <View style={styles.loadOlder}>
                <Button
                  label="Load older messages"
                  loading={messages.isLoadingOlder}
                  variant="secondary"
                  onPress={() =>
                    void messages
                      .loadOlder()
                      .catch((error: unknown) =>
                        showError(error, "Could not load older messages"),
                      )
                  }
                />
              </View>
            ) : null
          }
          messages={mainMessages}
          onAction={setSelected}
          onOpenThread={openThread}
        />
      ) : (
        <EmptyState
          body="Start with context, a decision, or a question worth answering."
          icon="chatbox-ellipses-outline"
          title="Begin the signal"
        />
      )}
      {typing.length > 0 ? (
        <Text
          numberOfLines={1}
          style={[
            styles.typing,
            { color: theme.colors.faint, fontFamily: "Inter" },
          ]}
        >
          {typing.length === 1
            ? `${typing[0]} is typing…`
            : `${typing.length} people are typing…`}
        </Text>
      ) : null}
      {selected ? (
        <MessageActionBar
          canEdit={selected.author === community.pubkey && !selected.deleted}
          message={selected}
          onClose={() => setSelected(undefined)}
          onDelete={() => {
            void actions
              .delete(value.id, selected.event.id)
              .then(() => setSelected(undefined))
              .catch(showError);
          }}
          onEdit={() => {
            setEditing(selected);
            setSelected(undefined);
          }}
          onReact={(emoji, emojiUrl) => {
            void actions
              .react(selected.event.id, emoji, emojiUrl)
              .then(() => setSelected(undefined))
              .catch(showError);
          }}
          onReply={() => openThread(selected)}
          onReminder={() =>
            Alert.alert("Remind me", "When should Buzz bring this back?", [
              {
                text: "In 20 minutes",
                onPress: () =>
                  void scheduleMessageReminder(
                    selected,
                    value.id,
                    20 * 60,
                    community,
                    relay,
                    secretKey,
                    () => setSelected(undefined),
                  ),
              },
              {
                text: "In 1 hour",
                onPress: () =>
                  void scheduleMessageReminder(
                    selected,
                    value.id,
                    60 * 60,
                    community,
                    relay,
                    secretKey,
                    () => setSelected(undefined),
                  ),
              },
              {
                text: "Tomorrow",
                onPress: () =>
                  void scheduleMessageReminder(
                    selected,
                    value.id,
                    24 * 60 * 60,
                    community,
                    relay,
                    secretKey,
                    () => setSelected(undefined),
                  ),
              },
              { style: "cancel", text: "Cancel" },
            ])
          }
          onMore={async () => {
            const link = buildMessageLink({
              channelId: value.id,
              messageId: selected.event.id,
              ...(selected.thread
                ? { threadRootId: selected.thread.rootId }
                : {}),
            });
            await Clipboard.setStringAsync(link);
            setSelected(undefined);
          }}
        />
      ) : null}
      {!value.archived ? (
        editing ? (
          <EditComposer
            initialValue={editing.content}
            onCancel={() => setEditing(undefined)}
            onSave={(content) =>
              actions
                .edit(value.id, editing.event.id, content)
                .then(() => setEditing(undefined))
            }
          />
        ) : (
          <Composer
            channelId={value.id}
            placeholder={
              value.type === "dm" ? "Private message" : `Message ${value.name}`
            }
            onSend={(content, tags) =>
              actions
                .sendMessage({
                  channelId: value.id,
                  content,
                  mediaTags: tags,
                })
                .then(() => undefined)
            }
            onTyping={() =>
              void relay
                .publish({
                  content: "",
                  kind: KIND_TYPING_INDICATOR,
                  tags: [["h", value.id]],
                })
                .catch(() => undefined)
            }
          />
        )
      ) : (
        <View
          style={[
            styles.archived,
            {
              backgroundColor: theme.colors.elevated,
              borderTopColor: theme.colors.border,
            },
          ]}
        >
          <Ionicons
            color={theme.colors.faint}
            name="archive-outline"
            size={17}
          />
          <Text style={{ color: theme.colors.muted, fontFamily: "Inter" }}>
            This channel is archived and read-only.
          </Text>
        </View>
      )}
    </Page>
  );
}

export function ThreadScreen({ navigation, route }: ThreadProps) {
  const { community, relay } = useRelay();
  const actions = useMemo(() => new MobileActions(relay), [relay]);
  const setReadMarker = useClientState((state) => state.setReadMarker);
  const follows = useClientState((state) => state.follows);
  const followThread = useClientState((state) => state.followThread);
  const following = follows.some(
    (follow) => follow.rootId === route.params.rootId,
  );
  const messages = useThread(route.params.channelId, route.params.rootId);
  const root =
    messages.data?.find(
      (message) => message.event.id === route.params.rootId,
    ) ?? messages.data?.[0];
  useEffect(() => {
    const latest = messages.data?.at(-1);
    if (!latest || latest.event.pubkey === community.pubkey) return;
    const timeout = setTimeout(() => {
      setReadMarker(`thread:${route.params.rootId}`, {
        createdAt: latest.event.created_at,
        eventId: latest.event.id,
      });
      setReadMarker(`channel:${route.params.channelId}`, {
        createdAt: latest.event.created_at,
        eventId: latest.event.id,
      });
      void actions
        .setReadState(
          route.params.channelId,
          latest.event.created_at,
          latest.event.id,
        )
        .catch(() => undefined);
    }, 1_000);
    return () => clearTimeout(timeout);
  }, [
    actions,
    community.pubkey,
    messages.data,
    route.params.channelId,
    route.params.rootId,
    setReadMarker,
  ]);
  return (
    <Page>
      <Header
        eyebrow="Thread"
        left={
          <IconButton
            icon="chevron-back"
            label="Back"
            onPress={() => navigation.goBack()}
          />
        }
        right={
          <IconButton
            icon={following ? "notifications" : "notifications-outline"}
            label={following ? "Unfollow thread" : "Follow thread"}
            onPress={() => followThread(route.params.rootId, !following)}
          />
        }
        subtitle={root ? root.content.slice(0, 80) : "Focused conversation"}
        title="Replies"
      />
      {messages.isPending ? (
        <LoadingState />
      ) : messages.data?.length ? (
        <MessageList
          messages={messages.data}
          onAction={() => undefined}
          onOpenThread={() => undefined}
        />
      ) : (
        <EmptyState
          body="The thread may be outside the current channel window."
          icon="return-down-forward-outline"
          title="No replies yet"
        />
      )}
      <Composer
        channelId={route.params.channelId}
        draftKey={`${route.params.channelId}:${route.params.rootId}`}
        placeholder="Reply in thread"
        threadRootId={route.params.rootId}
        onSend={(content, tags) =>
          actions
            .sendMessage({
              channelId: route.params.channelId,
              content,
              mediaTags: tags,
              thread: {
                parentEventId: root?.event.id ?? route.params.rootId,
                rootEventId: route.params.rootId,
              },
            })
            .then(() => undefined)
        }
      />
    </Page>
  );
}

function ForumChannel({
  channelId,
  name,
  navigation,
}: {
  readonly channelId: string;
  readonly name: string;
  readonly navigation: ChannelProps["navigation"];
}) {
  const _theme = useBuzzTheme();
  const { relay } = useRelay();
  const actions = useMemo(() => new MobileActions(relay), [relay]);
  const posts = useForumPosts(channelId);
  return (
    <Page>
      <Header
        eyebrow="Forum"
        left={
          <IconButton
            icon="chevron-back"
            label="Back"
            onPress={() => navigation.goBack()}
          />
        }
        right={
          <View style={styles.headerActions}>
            <IconButton
              icon="document-text-outline"
              label="Canvas"
              onPress={() => navigation.navigate("Canvas", { channelId })}
            />
            <IconButton
              icon="people-outline"
              label="Members"
              onPress={() => navigation.navigate("Members", { channelId })}
            />
          </View>
        }
        subtitle="Longer questions, durable answers"
        title={name}
      />
      {posts.isPending ? (
        <LoadingState label="Loading forum" />
      ) : (
        <FlatList
          contentContainerStyle={styles.forumList}
          data={posts.data ?? []}
          keyExtractor={(item) => item.id}
          ListEmptyComponent={
            <EmptyState
              body="Frame the first topic so the right people can respond."
              icon="albums-outline"
              title="No topics yet"
            />
          }
          ListFooterComponent={
            posts.hasMore ? (
              <View style={styles.loadOlder}>
                <Button
                  label="Load older topics"
                  loading={posts.isLoadingOlder}
                  variant="secondary"
                  onPress={() =>
                    void posts
                      .loadOlder()
                      .catch((error: unknown) =>
                        showError(error, "Could not load older topics"),
                      )
                  }
                />
              </View>
            ) : null
          }
          renderItem={({ item }) => (
            <ForumPost
              event={item}
              onPress={() =>
                navigation.navigate("Thread", {
                  channelId,
                  rootId: item.id,
                })
              }
            />
          )}
        />
      )}
      <Composer
        channelId={channelId}
        draftKey={`forum:${channelId}`}
        placeholder="Start a forum topic"
        onSend={(content, tags) =>
          actions
            .sendForumPost({
              channelId,
              content,
              mediaTags: tags,
            })
            .then(() => undefined)
        }
      />
    </Page>
  );
}

function ForumPost({
  event,
  onPress,
}: {
  readonly event: NostrEvent;
  readonly onPress: () => void;
}) {
  const theme = useBuzzTheme();
  const profile = useProfile(event.pubkey).data;
  const title =
    firstTag(event, "title") ??
    event.content.split("\n")[0]?.slice(0, 120) ??
    "Untitled topic";
  const body =
    event.content.startsWith(title) && event.content.length > title.length
      ? event.content.slice(title.length).trim()
      : event.content;
  return (
    <Pressable
      style={({ pressed }) => [
        styles.forumPost,
        {
          backgroundColor: pressed
            ? theme.colors.accentSoft
            : theme.colors.surface,
          borderColor: theme.colors.border,
        },
      ]}
      onPress={onPress}
    >
      <Text
        numberOfLines={2}
        style={[
          styles.forumTitle,
          { color: theme.colors.text, fontFamily: "Inter" },
        ]}
      >
        {title}
      </Text>
      <Text
        numberOfLines={3}
        style={{
          color: theme.colors.muted,
          fontFamily: "Inter",
          fontSize: 14,
          lineHeight: 20,
        }}
      >
        {body}
      </Text>
      <View style={styles.forumMeta}>
        <Text
          style={{
            color: theme.colors.faint,
            fontFamily: "GeistMono",
            fontSize: 10,
          }}
        >
          {profile?.displayName ?? event.pubkey.slice(0, 8)}
        </Text>
        <Text
          style={{
            color: theme.colors.faint,
            fontFamily: "GeistMono",
            fontSize: 10,
          }}
        >
          {formatRelativeTime(event.created_at)}
        </Text>
        <Ionicons color={theme.colors.accent} name="arrow-forward" size={14} />
      </View>
    </Pressable>
  );
}

function MessageActionBar({
  message,
  canEdit,
  onClose,
  onReply,
  onReact,
  onEdit,
  onDelete,
  onMore,
  onReminder,
}: {
  readonly message: TimelineMessage;
  readonly canEdit: boolean;
  readonly onClose: () => void;
  readonly onReply: () => void;
  readonly onReact: (emoji: string, emojiUrl?: string) => void;
  readonly onEdit: () => void;
  readonly onDelete: () => void;
  readonly onMore: () => void;
  readonly onReminder: () => void;
}) {
  const theme = useBuzzTheme();
  const customEmoji = useCustomEmoji().data?.slice(0, 4) ?? [];
  return (
    <View
      style={[
        styles.actions,
        {
          backgroundColor: theme.colors.elevated,
          borderColor: theme.colors.border,
        },
      ]}
    >
      <ScrollView
        horizontal
        contentContainerStyle={styles.actionContent}
        showsHorizontalScrollIndicator={false}
      >
        {["👍", "❤️", "😂", "🎉"].map((emoji) => (
          <Pressable key={emoji} hitSlop={5} onPress={() => onReact(emoji)}>
            <Text style={styles.actionEmoji}>{emoji}</Text>
          </Pressable>
        ))}
        {customEmoji.map((emoji) => (
          <Pressable
            key={emoji.shortcode}
            accessibilityLabel={`React with :${emoji.shortcode}:`}
            hitSlop={5}
            onPress={() => onReact(`:${emoji.shortcode}:`, emoji.url)}
          >
            <Image
              source={{ uri: emoji.url }}
              style={styles.actionEmojiImage}
            />
          </Pressable>
        ))}
        <ActionIcon
          icon="return-down-forward-outline"
          label="Reply"
          onPress={onReply}
        />
        {canEdit ? (
          <ActionIcon icon="pencil-outline" label="Edit" onPress={onEdit} />
        ) : null}
        {canEdit ? (
          <ActionIcon
            color={theme.colors.danger}
            icon="trash-outline"
            label="Delete"
            onPress={() =>
              Alert.alert(
                "Delete message?",
                "This publishes a signed deletion.",
                [
                  { style: "cancel", text: "Cancel" },
                  { onPress: onDelete, style: "destructive", text: "Delete" },
                ],
              )
            }
          />
        ) : null}
        <ActionIcon icon="link-outline" label="Copy link" onPress={onMore} />
        <ActionIcon
          icon="alarm-outline"
          label="Remind me"
          onPress={onReminder}
        />
        <ActionIcon icon="close" label="Close" onPress={onClose} />
      </ScrollView>
      <Text
        numberOfLines={1}
        style={{
          color: theme.colors.faint,
          display: "none",
          fontSize: 1,
        }}
      >
        {message.event.id}
      </Text>
    </View>
  );
}

async function scheduleMessageReminder(
  message: TimelineMessage,
  channelId: string,
  delaySeconds: number,
  community: ReturnType<typeof useRelay>["community"],
  relay: ReturnType<typeof useRelay>["relay"],
  secretKey: Uint8Array,
  done: () => void,
): Promise<void> {
  try {
    await createReminder({
      community,
      notBefore: Math.floor(Date.now() / 1_000) + delaySeconds,
      relay,
      secretKey,
      target: {
        authorPubkey: message.author,
        channelId,
        eventId: message.event.id,
        preview: message.content.slice(0, 1_024),
      },
    });
    done();
  } catch (error) {
    showError(error);
  }
}

function ActionIcon({
  icon,
  label,
  onPress,
  color,
}: {
  readonly icon: React.ComponentProps<typeof Ionicons>["name"];
  readonly label: string;
  readonly onPress: () => void;
  readonly color?: string;
}) {
  const theme = useBuzzTheme();
  return (
    <Pressable
      accessibilityLabel={label}
      hitSlop={5}
      style={styles.actionIcon}
      onPress={onPress}
    >
      <Ionicons color={color ?? theme.colors.muted} name={icon} size={20} />
    </Pressable>
  );
}

function EditComposer({
  initialValue,
  onCancel,
  onSave,
}: {
  readonly initialValue: string;
  readonly onCancel: () => void;
  readonly onSave: (content: string) => Promise<unknown>;
}) {
  const theme = useBuzzTheme();
  const [content, setContent] = useState(initialValue);
  const [saving, setSaving] = useState(false);
  return (
    <View
      style={[
        styles.edit,
        {
          backgroundColor: theme.colors.background,
          borderTopColor: theme.colors.border,
        },
      ]}
    >
      <TextInput
        autoFocus
        maxLength={65_536}
        multiline
        style={[
          styles.editInput,
          {
            backgroundColor: theme.colors.surface,
            borderColor: theme.colors.border,
            color: theme.colors.text,
            fontFamily: "Inter",
          },
        ]}
        value={content}
        onChangeText={setContent}
      />
      <ActionIcon icon="close" label="Cancel edit" onPress={onCancel} />
      <Pressable
        disabled={saving || !content.trim()}
        onPress={() => {
          setSaving(true);
          void onSave(content.trim())
            .catch(showError)
            .finally(() => setSaving(false));
        }}
      >
        <Ionicons
          color={theme.colors.accent}
          name={saving ? "hourglass-outline" : "checkmark-circle"}
          size={28}
        />
      </Pressable>
    </View>
  );
}

function useTyping(channelId: string): readonly string[] {
  const { community, relay } = useRelay();
  const [entries, setEntries] = useState<ReadonlyMap<string, number>>(
    new Map(),
  );
  useEffect(() => {
    const unsubscribe = relay.subscribe(
      [{ "#h": [channelId], kinds: [KIND_TYPING_INDICATOR] }],
      (event) => {
        if (event.pubkey === community.pubkey) return;
        setEntries((current) => {
          const next = new Map(current);
          next.set(event.pubkey, Date.now() + 8_000);
          return next;
        });
      },
    );
    const interval = setInterval(
      () =>
        setEntries((current) => {
          const next = new Map(
            [...current].filter(([, expiresAt]) => expiresAt > Date.now()),
          );
          return next.size === current.size ? current : next;
        }),
      1_000,
    );
    return () => {
      unsubscribe();
      clearInterval(interval);
    };
  }, [channelId, community.pubkey, relay]);
  return [...entries.keys()].map((pubkey) => pubkey.slice(0, 8));
}

function showError(error: unknown, title = "Action failed"): void {
  Alert.alert(
    title,
    error instanceof Error ? error.message : "Please try again.",
  );
}

const styles = StyleSheet.create({
  actionEmoji: { fontSize: 19 },
  actionEmojiImage: { borderRadius: 4, height: 21, width: 21 },
  actionContent: { alignItems: "center", gap: 8 },
  actionIcon: {
    alignItems: "center",
    height: 32,
    justifyContent: "center",
    width: 32,
  },
  actions: {
    alignItems: "center",
    borderRadius: 18,
    borderWidth: StyleSheet.hairlineWidth,
    bottom: 78,
    elevation: 8,
    flexDirection: "row",
    gap: 6,
    left: 10,
    paddingHorizontal: 10,
    paddingVertical: 8,
    position: "absolute",
    right: 10,
    shadowColor: "#000",
    shadowOffset: { height: 6, width: 0 },
    shadowOpacity: 0.18,
    shadowRadius: 14,
    zIndex: 20,
  },
  archived: {
    alignItems: "center",
    borderTopWidth: StyleSheet.hairlineWidth,
    flexDirection: "row",
    gap: 8,
    justifyContent: "center",
    minHeight: 58,
    padding: 12,
  },
  edit: {
    alignItems: "center",
    borderTopWidth: StyleSheet.hairlineWidth,
    flexDirection: "row",
    gap: 8,
    padding: 10,
  },
  editInput: {
    borderRadius: 14,
    borderWidth: StyleSheet.hairlineWidth,
    flex: 1,
    fontSize: 14,
    maxHeight: 100,
    minHeight: 44,
    padding: 10,
  },
  forumList: { gap: 9, padding: 12, paddingBottom: 24 },
  forumMeta: { alignItems: "center", flexDirection: "row", gap: 8 },
  forumPost: {
    borderRadius: 20,
    borderWidth: StyleSheet.hairlineWidth,
    gap: 9,
    padding: 16,
  },
  forumTitle: { fontSize: 18, fontWeight: "700", letterSpacing: -0.25 },
  headerActions: { flexDirection: "row", gap: 7 },
  loadOlder: { alignItems: "center", padding: 12 },
  typing: { fontSize: 11, paddingBottom: 4, paddingHorizontal: 16 },
});
