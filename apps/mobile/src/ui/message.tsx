import { Ionicons } from "@expo/vector-icons";
import { useNavigation } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import * as DocumentPicker from "expo-document-picker";
import { Image } from "expo-image";
import * as ImagePicker from "expo-image-picker";
import * as Linking from "expo-linking";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  FlatList,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
  type ListRenderItemInfo,
} from "react-native";

import type { NostrTag } from "@buzz/core";

import { buildCustomEmojiTags, emojiUrlFromTags } from "../domain/custom-emoji";
import {
  activeEmojiQuery,
  activeMentionQuery,
  applyMarkup,
  buildMentionTags,
  replaceActiveToken,
  type SelectedMention,
  type TextSelection,
} from "../domain/composer";
import { parseMediaTags } from "../domain/media";
import {
  parseInlineMarkdown,
  parseMarkdownBlocks,
  type MarkdownInline,
} from "../domain/markdown";
import {
  describeSystemMessage,
  shortPubkey,
  type TimelineMessage,
} from "../domain/models";
import { mediaTags, uploadMedia, type PendingMedia } from "../services/media";
import type { RootStackParams } from "../navigation/types";
import {
  useChannelMembers,
  useCustomEmoji,
  useProfile,
  useProfiles,
} from "../state/queries";
import { useRelay } from "../state/relay-context";
import { useClientState } from "../state/client-state";
import { Avatar, formatRelativeTime } from "./components";
import { useBuzzTheme } from "./theme";

export function MessageList({
  messages,
  onOpenThread,
  onAction,
  ListHeaderComponent,
  focusEventId,
}: {
  readonly messages: readonly TimelineMessage[];
  readonly onOpenThread: (message: TimelineMessage) => void;
  readonly onAction: (message: TimelineMessage) => void;
  readonly ListHeaderComponent?:
    | React.ComponentType
    | React.ReactElement
    | null;
  readonly focusEventId?: string;
}) {
  const reversed = [...messages].reverse();
  const list = useRef<FlatList<TimelineMessage>>(null);
  const focusIndex = focusEventId
    ? reversed.findIndex((message) => message.event.id === focusEventId)
    : -1;
  useEffect(() => {
    if (focusIndex < 0) return undefined;
    const timeout = setTimeout(
      () =>
        list.current?.scrollToIndex({
          animated: true,
          index: focusIndex,
          viewPosition: 0.5,
        }),
      120,
    );
    return () => clearTimeout(timeout);
  }, [focusIndex]);
  return (
    <FlatList
      ref={list}
      data={reversed}
      inverted
      keyboardDismissMode="interactive"
      keyboardShouldPersistTaps="handled"
      keyExtractor={(item) => item.event.id}
      ListFooterComponent={ListHeaderComponent}
      maintainVisibleContentPosition={{ minIndexForVisible: 0 }}
      renderItem={({ item }: ListRenderItemInfo<TimelineMessage>) => (
        <MessageRow
          highlighted={item.event.id === focusEventId}
          message={item}
          onAction={() => onAction(item)}
          onOpenThread={() => onOpenThread(item)}
        />
      )}
      contentContainerStyle={styles.list}
      onScrollToIndexFailed={(info) => {
        list.current?.scrollToOffset({
          animated: true,
          offset: info.averageItemLength * info.index,
        });
      }}
    />
  );
}

export function MessageRow({
  message,
  onOpenThread,
  onAction,
  compact = false,
  highlighted = false,
}: {
  readonly message: TimelineMessage;
  readonly onOpenThread?: () => void;
  readonly onAction?: () => void;
  readonly compact?: boolean;
  readonly highlighted?: boolean;
}) {
  const theme = useBuzzTheme();
  const profile = useProfile(message.author).data;
  const reactionCount = [...message.reactions.values()].reduce(
    (sum, authors) => sum + authors.length,
    0,
  );
  if (message.system) {
    return (
      <View style={styles.systemMessage}>
        <View
          style={[styles.systemRule, { backgroundColor: theme.colors.border }]}
        />
        <Text
          style={{
            color: theme.colors.faint,
            fontFamily: "GeistMono",
            fontSize: 10,
          }}
        >
          {describeSystemMessage(message.system)}
        </Text>
        <View
          style={[styles.systemRule, { backgroundColor: theme.colors.border }]}
        />
      </View>
    );
  }
  return (
    <Pressable
      accessibilityRole="button"
      style={({ pressed }) => [
        styles.message,
        {
          backgroundColor: pressed ? theme.colors.accentSoft : "transparent",
          borderColor: highlighted ? theme.colors.accent : "transparent",
          borderWidth: highlighted ? StyleSheet.hairlineWidth : 0,
          opacity: message.pending ? 0.6 : 1,
          paddingVertical: compact ? 7 : 11,
        },
      ]}
      onLongPress={onAction}
      onPress={message.thread || reactionCount ? onOpenThread : undefined}
    >
      <Avatar
        profile={profile}
        pubkey={message.author}
        size={compact ? 32 : 38}
      />
      <View style={styles.messageBody}>
        <View style={styles.messageMeta}>
          <Text
            numberOfLines={1}
            style={[
              styles.author,
              { color: theme.colors.text, fontFamily: "Inter" },
            ]}
          >
            {profile?.displayName ?? shortPubkey(message.author)}
          </Text>
          <Text
            style={[
              styles.time,
              { color: theme.colors.faint, fontFamily: "GeistMono" },
            ]}
          >
            {formatRelativeTime(message.event.created_at)}
          </Text>
          {message.editedAt ? (
            <Text style={[styles.time, { color: theme.colors.faint }]}>
              edited
            </Text>
          ) : null}
          {message.pending ? (
            <ActivityIndicator color={theme.colors.accent} size={10} />
          ) : null}
        </View>
        {message.deleted ? (
          <Text
            style={[
              styles.deleted,
              { color: theme.colors.faint, fontFamily: "Inter" },
            ]}
          >
            Message removed
          </Text>
        ) : (
          <>
            <RichContent content={message.content} tags={message.tags} />
            <MessageMedia tags={message.tags} />
          </>
        )}
        {message.reactions.size > 0 ? (
          <View style={styles.reactions}>
            {[...message.reactions].map(([emoji, authors]) => {
              const emojiUrl = message.reactionEmojiUrls.get(emoji);
              return (
                <View
                  key={emoji}
                  style={[
                    styles.reaction,
                    {
                      backgroundColor: theme.colors.elevated,
                      borderColor: theme.colors.border,
                    },
                  ]}
                >
                  {emojiUrl ? (
                    <Image
                      accessibilityLabel={emoji}
                      source={{ uri: emojiUrl }}
                      style={styles.reactionImage}
                    />
                  ) : (
                    <Text style={styles.reactionEmoji}>{emoji}</Text>
                  )}
                  <Text
                    style={{
                      color: theme.colors.muted,
                      fontFamily: "GeistMono",
                      fontSize: 11,
                    }}
                  >
                    {authors.length}
                  </Text>
                </View>
              );
            })}
          </View>
        ) : null}
        {message.thread || message.replyCount ? (
          <Pressable
            accessibilityRole="button"
            style={styles.threadLink}
            onPress={onOpenThread}
          >
            <Ionicons
              color={theme.colors.accent}
              name="return-down-forward-outline"
              size={14}
            />
            <Text
              style={{
                color: theme.colors.accent,
                fontFamily: "Inter",
                fontSize: 12,
                fontWeight: "600",
              }}
            >
              {message.replyCount
                ? `${message.replyCount} ${message.replyCount === 1 ? "reply" : "replies"}`
                : "View thread"}
            </Text>
          </Pressable>
        ) : null}
      </View>
    </Pressable>
  );
}

export function Composer({
  channelId,
  draftKey = channelId,
  threadRootId,
  placeholder = "Message the channel",
  onSend,
  onTyping,
}: {
  readonly channelId: string;
  readonly draftKey?: string;
  readonly threadRootId?: string;
  readonly placeholder?: string;
  readonly onSend: (
    content: string,
    tags: readonly NostrTag[],
  ) => Promise<void>;
  readonly onTyping?: () => void;
}) {
  const theme = useBuzzTheme();
  const { community, secretKey } = useRelay();
  const customEmoji = useCustomEmoji().data ?? [];
  const members = useChannelMembers(channelId).data ?? [];
  const memberPubkeys = useMemo(
    () => members.map((member) => member.pubkey),
    [members],
  );
  const memberProfiles = useProfiles(memberPubkeys).data ?? [];
  const clientStateReady = useClientState((state) => state.ready);
  const saveDraft = useClientState((state) => state.saveDraft);
  const removeDraft = useClientState((state) => state.removeDraft);
  const [content, setContent] = useState("");
  const [attachments, setAttachments] = useState<readonly PendingMedia[]>([]);
  const [mentions, setMentions] = useState<readonly SelectedMention[]>([]);
  const [selection, setSelection] = useState<TextSelection>({
    end: 0,
    start: 0,
  });
  const [sending, setSending] = useState(false);
  const lastTyping = useRef(0);
  const draftHydrated = useRef(false);
  const mentionQuery = activeMentionQuery(content);
  const emojiQuery = activeEmojiQuery(content);
  const mentionSuggestions =
    mentionQuery === undefined
      ? []
      : memberProfiles
          .filter((profile) => {
            const query = mentionQuery.toLowerCase();
            return (
              profile.displayName.toLowerCase().includes(query) ||
              profile.pubkey.startsWith(query)
            );
          })
          .slice(0, 5);
  const emojiSuggestions =
    emojiQuery === undefined
      ? []
      : customEmoji
          .filter((emoji) => emoji.shortcode.includes(emojiQuery))
          .slice(0, 8);

  useEffect(() => {
    if (!clientStateReady) return;
    const draft = useClientState
      .getState()
      .drafts.find((item) => item.key === draftKey);
    setContent(draft?.text ?? "");
    draftHydrated.current = true;
  }, [clientStateReady, draftKey]);

  useEffect(() => {
    if (!clientStateReady || !draftHydrated.current) return;
    const timeout = setTimeout(() => {
      saveDraft({
        channelId,
        key: draftKey,
        text: content,
        ...(threadRootId ? { threadRootId } : {}),
      });
    }, 400);
    return () => clearTimeout(timeout);
  }, [channelId, clientStateReady, content, draftKey, saveDraft, threadRootId]);

  const submit = async () => {
    if (sending || (!content.trim() && !attachments.length)) return;
    setSending(true);
    try {
      const uploaded = [];
      for (const media of attachments) {
        uploaded.push(
          await uploadMedia({
            channelId,
            media,
            relayUrl: community.relayUrl,
            secretKey,
          }),
        );
      }
      await onSend(content.trim(), [
        ...mediaTags(uploaded),
        ...buildCustomEmojiTags(content, customEmoji),
        ...buildMentionTags(content, mentions),
      ]);
      setContent("");
      setAttachments([]);
      setMentions([]);
      removeDraft(draftKey);
    } catch (error) {
      Alert.alert(
        "Message not sent",
        error instanceof Error ? error.message : "Please try again.",
      );
    } finally {
      setSending(false);
    }
  };

  const choosePhoto = async () => {
    const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!permission.granted) {
      Alert.alert("Photos permission required");
      return;
    }
    const result = await ImagePicker.launchImageLibraryAsync({
      allowsMultipleSelection: true,
      mediaTypes: ["images", "videos"],
      quality: 0.9,
      selectionLimit: Math.max(1, 8 - attachments.length),
    });
    if (!result.canceled) {
      setAttachments((current) =>
        appendUniqueMedia(
          current,
          result.assets.map((asset) => ({
            mimeType: asset.mimeType ?? "application/octet-stream",
            name: asset.fileName ?? `attachment-${Date.now()}`,
            ...(asset.fileSize === undefined ? {} : { size: asset.fileSize }),
            uri: asset.uri,
          })),
        ),
      );
    }
  };

  const chooseFile = async () => {
    const result = await DocumentPicker.getDocumentAsync({
      copyToCacheDirectory: true,
      multiple: true,
    });
    if (!result.canceled) {
      setAttachments((current) =>
        appendUniqueMedia(
          current,
          result.assets.map((asset) => ({
            mimeType: asset.mimeType ?? "application/octet-stream",
            name: asset.name,
            ...(asset.size === undefined ? {} : { size: asset.size }),
            uri: asset.uri,
          })),
        ),
      );
    }
  };

  const capturePhoto = async () => {
    const permission = await ImagePicker.requestCameraPermissionsAsync();
    if (!permission.granted) {
      Alert.alert("Camera permission required");
      return;
    }
    const result = await ImagePicker.launchCameraAsync({
      mediaTypes: ["images", "videos"],
      quality: 0.9,
    });
    if (!result.canceled) {
      setAttachments((current) =>
        appendUniqueMedia(
          current,
          result.assets.map((asset) => ({
            mimeType: asset.mimeType ?? "application/octet-stream",
            name: asset.fileName ?? `capture-${Date.now()}`,
            ...(asset.fileSize === undefined ? {} : { size: asset.fileSize }),
            uri: asset.uri,
          })),
        ),
      );
    }
  };

  const format = (prefix: string, suffix = prefix) => {
    const formatted = applyMarkup(content, selection, prefix, suffix);
    setContent(formatted.content);
    setSelection(formatted.selection);
  };

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === "ios" ? "padding" : undefined}
      keyboardVerticalOffset={88}
      style={[
        styles.composerShell,
        {
          backgroundColor: theme.colors.background,
          borderTopColor: theme.colors.border,
        },
      ]}
    >
      {attachments.length > 0 ? (
        <View style={styles.attachmentStrip}>
          {attachments.map((attachment) => (
            <Pressable
              key={attachment.uri}
              style={[
                styles.attachment,
                {
                  backgroundColor: theme.colors.elevated,
                  borderColor: theme.colors.border,
                },
              ]}
              onPress={() =>
                setAttachments((current) =>
                  current.filter((item) => item.uri !== attachment.uri),
                )
              }
            >
              <Ionicons
                color={theme.colors.accent}
                name={
                  attachment.mimeType.startsWith("image/")
                    ? "image-outline"
                    : attachment.mimeType.startsWith("video/")
                      ? "videocam-outline"
                      : "document-outline"
                }
                size={16}
              />
              <Text
                numberOfLines={1}
                style={{
                  color: theme.colors.muted,
                  flex: 1,
                  fontFamily: "Inter",
                  fontSize: 11,
                }}
              >
                {attachment.name}
              </Text>
              <Ionicons color={theme.colors.faint} name="close" size={14} />
            </Pressable>
          ))}
        </View>
      ) : null}
      {mentionSuggestions.length > 0 || emojiSuggestions.length > 0 ? (
        <View
          style={[
            styles.suggestions,
            {
              backgroundColor: theme.colors.surface,
              borderColor: theme.colors.border,
            },
          ]}
        >
          {mentionSuggestions.map((profile) => {
            const token = mentionToken(profile.displayName, profile.pubkey);
            return (
              <Pressable
                key={profile.pubkey}
                style={styles.suggestion}
                onPress={() => {
                  setContent((value) => replaceActiveToken(value, "@", token));
                  setMentions((current) => [
                    ...current.filter(
                      (mention) => mention.pubkey !== profile.pubkey,
                    ),
                    { pubkey: profile.pubkey, token },
                  ]);
                }}
              >
                <Avatar profile={profile} pubkey={profile.pubkey} size={28} />
                <Text
                  style={{
                    color: theme.colors.text,
                    fontFamily: "Inter",
                    fontSize: 12,
                  }}
                >
                  {profile.displayName}
                </Text>
              </Pressable>
            );
          })}
          {emojiSuggestions.map((emoji) => (
            <Pressable
              key={emoji.shortcode}
              style={styles.suggestion}
              onPress={() =>
                setContent((value) =>
                  replaceActiveToken(value, ":", emoji.shortcode),
                )
              }
            >
              <Image
                accessibilityLabel={`:${emoji.shortcode}:`}
                source={{ uri: emoji.url }}
                style={styles.suggestionEmoji}
              />
              <Text
                style={{
                  color: theme.colors.text,
                  fontFamily: "GeistMono",
                  fontSize: 11,
                }}
              >
                :{emoji.shortcode}:
              </Text>
            </Pressable>
          ))}
        </View>
      ) : null}
      <View style={styles.formatting}>
        <FormatButton label="B" onPress={() => format("**")} />
        <FormatButton label="I" onPress={() => format("_")} />
        <FormatButton label="S" onPress={() => format("~~")} />
        <FormatButton label="`" onPress={() => format("`")} />
        <FormatButton label="```" onPress={() => format("```\n", "\n```")} />
      </View>
      <View
        style={[
          styles.composer,
          {
            backgroundColor: theme.colors.surface,
            borderColor: theme.colors.border,
          },
        ]}
      >
        <Pressable
          accessibilityLabel="Capture a photo or video"
          hitSlop={8}
          onPress={() => void capturePhoto()}
        >
          <Ionicons
            color={theme.colors.muted}
            name="camera-outline"
            size={22}
          />
        </Pressable>
        <Pressable
          accessibilityLabel="Choose a photo or video"
          hitSlop={8}
          onPress={() => void choosePhoto()}
        >
          <Ionicons color={theme.colors.muted} name="image-outline" size={22} />
        </Pressable>
        <Pressable
          accessibilityLabel="Choose a file"
          hitSlop={8}
          onPress={() => void chooseFile()}
        >
          <Ionicons
            color={theme.colors.muted}
            name="attach-outline"
            size={22}
          />
        </Pressable>
        <TextInput
          accessibilityLabel={placeholder}
          maxLength={65_536}
          multiline
          placeholder={placeholder}
          placeholderTextColor={theme.colors.faint}
          style={[
            styles.input,
            { color: theme.colors.text, fontFamily: "Inter" },
          ]}
          value={content}
          selection={selection}
          onSelectionChange={(event) =>
            setSelection(event.nativeEvent.selection)
          }
          onChangeText={(value) => {
            setContent(value);
            const now = Date.now();
            if (value.trim() && now - lastTyping.current > 3_000) {
              lastTyping.current = now;
              onTyping?.();
            }
          }}
        />
        <Pressable
          accessibilityLabel="Send message"
          accessibilityRole="button"
          disabled={sending || (!content.trim() && !attachments.length)}
          style={[
            styles.send,
            {
              backgroundColor: theme.colors.accent,
              opacity:
                sending || (!content.trim() && !attachments.length) ? 0.4 : 1,
            },
          ]}
          onPress={() => void submit()}
        >
          {sending ? (
            <ActivityIndicator color={theme.dark ? "#111" : "#fff"} size={16} />
          ) : (
            <Ionicons
              color={theme.dark ? "#111" : "#fff"}
              name="arrow-up"
              size={18}
            />
          )}
        </Pressable>
      </View>
    </KeyboardAvoidingView>
  );
}

function FormatButton({
  label,
  onPress,
}: {
  readonly label: string;
  readonly onPress: () => void;
}) {
  const theme = useBuzzTheme();
  return (
    <Pressable
      accessibilityLabel={`Format ${label}`}
      style={[
        styles.formatButton,
        {
          backgroundColor: theme.colors.elevated,
          borderColor: theme.colors.border,
        },
      ]}
      onPress={onPress}
    >
      <Text
        style={{
          color: theme.colors.muted,
          fontFamily: "GeistMono",
          fontSize: 10,
          fontWeight: "700",
        }}
      >
        {label}
      </Text>
    </Pressable>
  );
}

function mentionToken(displayName: string, pubkey: string): string {
  const normalized = displayName
    .toLowerCase()
    .replace(/[^a-z0-9._-]/g, "")
    .slice(0, 64);
  return normalized || pubkey.slice(0, 12);
}

function RichContent({
  content,
  tags,
}: {
  readonly content: string;
  readonly tags: readonly NostrTag[];
}) {
  const theme = useBuzzTheme();
  const segments: React.ReactNode[] = [];
  let cursor = 0;
  for (const match of content.matchAll(/:([a-z0-9_-]+):/gi)) {
    const start = match.index;
    const value = match[0];
    const url = emojiUrlFromTags(match[1] ?? "", tags);
    if (!url) continue;
    if (start > cursor) {
      const text = content.slice(cursor, start);
      segments.push(<RichText key={`${cursor}:${text}`} content={text} />);
    }
    segments.push(
      <Image
        key={`${start}:${value}`}
        accessibilityLabel={value}
        source={{ uri: url }}
        style={[styles.inlineEmoji, { backgroundColor: theme.colors.elevated }]}
      />,
    );
    cursor = start + value.length;
  }
  if (segments.length === 0) return <RichText content={content} />;
  if (cursor < content.length) {
    const text = content.slice(cursor);
    segments.push(<RichText key={`${cursor}:${text}`} content={text} />);
  }
  return <View style={styles.richContent}>{segments}</View>;
}

function RichText({ content }: { readonly content: string }) {
  const theme = useBuzzTheme();
  const blocks = parseMarkdownBlocks(content);
  if (blocks.some((block) => block.type === "code")) {
    return (
      <View style={styles.markdownBlocks}>
        {blocks.map((block) =>
          block.type === "code" ? (
            <View
              key={block.id}
              style={[
                styles.codeBlock,
                {
                  backgroundColor: theme.colors.elevated,
                  borderColor: theme.colors.border,
                },
              ]}
            >
              {block.language ? (
                <Text
                  style={{
                    color: theme.colors.faint,
                    fontFamily: "GeistMono",
                    fontSize: 8,
                    textTransform: "uppercase",
                  }}
                >
                  {block.language}
                </Text>
              ) : null}
              <Text
                selectable
                style={{
                  color: theme.colors.text,
                  fontFamily: "GeistMono",
                  fontSize: 12,
                  lineHeight: 18,
                }}
              >
                {block.content}
              </Text>
            </View>
          ) : (
            <MarkdownText key={block.id} content={block.content} />
          ),
        )}
      </View>
    );
  }
  return <MarkdownText content={content} />;
}

function MarkdownText({ content }: { readonly content: string }) {
  const theme = useBuzzTheme();
  const tokens = parseInlineMarkdown(content);
  return (
    <Text
      selectable
      style={[
        styles.content,
        { color: theme.colors.text, fontFamily: "Inter" },
      ]}
    >
      {tokens.map((token) => (
        <MarkdownSpan key={token.id} token={token} />
      ))}
    </Text>
  );
}

function MarkdownSpan({ token }: { readonly token: MarkdownInline }) {
  const theme = useBuzzTheme();
  if (token.type === "link") {
    return (
      <Text
        accessibilityRole="link"
        style={{
          color: theme.colors.accent,
          textDecorationLine: "underline",
        }}
        onPress={() => {
          if (token.url) void Linking.openURL(token.url);
        }}
      >
        {token.text}
      </Text>
    );
  }
  return (
    <Text
      style={
        token.type === "strong"
          ? { fontWeight: "800" }
          : token.type === "emphasis"
            ? { fontStyle: "italic" }
            : token.type === "strike"
              ? { textDecorationLine: "line-through" }
              : token.type === "code"
                ? {
                    backgroundColor: theme.colors.elevated,
                    color: theme.colors.muted,
                    fontFamily: "GeistMono",
                  }
                : undefined
      }
    >
      {token.text}
    </Text>
  );
}

function appendUniqueMedia(
  current: readonly PendingMedia[],
  additions: readonly PendingMedia[],
): readonly PendingMedia[] {
  const byUri = new Map(current.map((item) => [item.uri, item]));
  for (const item of additions) {
    if (byUri.size >= 8) break;
    if (!byUri.has(item.uri)) byUri.set(item.uri, item);
  }
  return [...byUri.values()];
}

function MessageMedia({ tags }: { readonly tags: readonly NostrTag[] }) {
  const theme = useBuzzTheme();
  const navigation =
    useNavigation<NativeStackNavigationProp<RootStackParams>>();
  const media = parseMediaTags(tags);
  if (!media.length) return null;
  return (
    <View style={styles.mediaGrid}>
      {media.map((item) =>
        item.kind === "image" ? (
          <Pressable
            key={item.url}
            onPress={() =>
              navigation.navigate("MediaViewer", {
                kind: "image",
                url: item.url,
                ...(item.alt ? { alt: item.alt } : {}),
              })
            }
          >
            <Image
              accessibilityLabel={item.alt ?? "Message attachment"}
              contentFit="cover"
              {...(item.blurhash ? { placeholder: item.blurhash } : {})}
              source={{ uri: item.url }}
              style={[
                styles.mediaImage,
                { backgroundColor: theme.colors.elevated },
              ]}
              transition={180}
            />
          </Pressable>
        ) : item.kind === "video" ? (
          <Pressable
            key={item.url}
            style={[
              styles.videoPreview,
              {
                backgroundColor: theme.colors.elevated,
                borderColor: theme.colors.border,
              },
            ]}
            onPress={() =>
              navigation.navigate("MediaViewer", {
                kind: "video",
                url: item.url,
                ...(item.alt ? { alt: item.alt } : {}),
                ...(item.posterUrl ? { posterUrl: item.posterUrl } : {}),
              })
            }
          >
            {item.posterUrl ? (
              <Image
                accessibilityLabel={item.alt ?? "Video attachment"}
                contentFit="cover"
                source={{ uri: item.posterUrl }}
                style={styles.mediaImage}
              />
            ) : null}
            <View style={styles.play}>
              <Ionicons color="#ffffff" name="play" size={25} />
            </View>
          </Pressable>
        ) : (
          <Pressable
            key={item.url}
            style={[
              styles.file,
              {
                backgroundColor: theme.colors.elevated,
                borderColor: theme.colors.border,
              },
            ]}
            onPress={() => void Linking.openURL(item.url)}
          >
            <Ionicons
              color={theme.colors.accent}
              name={
                item.mimeType?.startsWith("video/")
                  ? "videocam-outline"
                  : "document-text-outline"
              }
              size={24}
            />
            <View style={styles.messageBody}>
              <Text
                numberOfLines={1}
                style={{
                  color: theme.colors.text,
                  fontFamily: "Inter",
                  fontSize: 13,
                  fontWeight: "600",
                }}
              >
                {item.alt ?? "Open attachment"}
              </Text>
              <Text
                style={{
                  color: theme.colors.faint,
                  fontFamily: "GeistMono",
                  fontSize: 10,
                }}
              >
                {item.mimeType ?? "Attachment"}
              </Text>
            </View>
          </Pressable>
        ),
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  attachment: {
    alignItems: "center",
    borderRadius: 8,
    borderWidth: StyleSheet.hairlineWidth,
    flexDirection: "row",
    gap: 6,
    maxWidth: 180,
    paddingHorizontal: 9,
    paddingVertical: 6,
  },
  attachmentStrip: {
    flexDirection: "row",
    gap: 6,
    paddingBottom: 7,
  },
  author: { flexShrink: 1, fontSize: 14, fontWeight: "700" },
  composer: {
    alignItems: "flex-end",
    borderRadius: 23,
    borderWidth: StyleSheet.hairlineWidth,
    flexDirection: "row",
    gap: 10,
    minHeight: 48,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  composerShell: {
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingBottom: Platform.OS === "ios" ? 18 : 10,
    paddingHorizontal: 10,
    paddingTop: 8,
  },
  content: { fontSize: 15, lineHeight: 21 },
  codeBlock: {
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    gap: 5,
    padding: 10,
  },
  deleted: { fontSize: 14, fontStyle: "italic", lineHeight: 20 },
  file: {
    alignItems: "center",
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    flexDirection: "row",
    gap: 10,
    padding: 10,
  },
  formatButton: {
    alignItems: "center",
    borderRadius: 8,
    borderWidth: StyleSheet.hairlineWidth,
    justifyContent: "center",
    minHeight: 28,
    minWidth: 30,
    paddingHorizontal: 7,
  },
  formatting: {
    flexDirection: "row",
    gap: 5,
    paddingBottom: 6,
  },
  input: {
    flex: 1,
    fontSize: 15,
    lineHeight: 20,
    maxHeight: 120,
    minHeight: 34,
    paddingHorizontal: 0,
    paddingVertical: 7,
  },
  inlineEmoji: { borderRadius: 4, height: 20, width: 20 },
  list: { paddingBottom: 8, paddingHorizontal: 6 },
  mediaGrid: { gap: 7, marginTop: 8 },
  markdownBlocks: { gap: 7 },
  mediaImage: { borderRadius: 14, height: 220, maxWidth: 360, width: "100%" },
  play: {
    alignItems: "center",
    backgroundColor: "rgba(0,0,0,0.58)",
    borderRadius: 999,
    height: 52,
    justifyContent: "center",
    left: "50%",
    marginLeft: -26,
    marginTop: -26,
    position: "absolute",
    top: "50%",
    width: 52,
  },
  videoPreview: {
    borderRadius: 14,
    borderWidth: StyleSheet.hairlineWidth,
    minHeight: 160,
    overflow: "hidden",
  },
  message: {
    alignItems: "flex-start",
    borderRadius: 14,
    flexDirection: "row",
    gap: 10,
    paddingHorizontal: 10,
  },
  messageBody: { flex: 1, gap: 3 },
  messageMeta: { alignItems: "center", flexDirection: "row", gap: 7 },
  reaction: {
    alignItems: "center",
    borderRadius: 13,
    borderWidth: StyleSheet.hairlineWidth,
    flexDirection: "row",
    gap: 4,
    paddingHorizontal: 8,
    paddingVertical: 3,
  },
  reactionEmoji: { fontSize: 13 },
  reactionImage: { borderRadius: 3, height: 16, width: 16 },
  reactions: { flexDirection: "row", flexWrap: "wrap", gap: 5, marginTop: 4 },
  richContent: {
    alignItems: "center",
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 2,
  },
  send: {
    alignItems: "center",
    borderRadius: 17,
    height: 34,
    justifyContent: "center",
    marginBottom: 1,
    width: 34,
  },
  threadLink: {
    alignItems: "center",
    flexDirection: "row",
    gap: 4,
    marginTop: 3,
  },
  time: { fontSize: 10 },
  systemMessage: {
    alignItems: "center",
    flexDirection: "row",
    gap: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  systemRule: { flex: 1, height: StyleSheet.hairlineWidth },
  suggestion: {
    alignItems: "center",
    flexDirection: "row",
    gap: 8,
    paddingHorizontal: 9,
    paddingVertical: 7,
  },
  suggestionEmoji: { borderRadius: 4, height: 24, width: 24 },
  suggestions: {
    borderRadius: 13,
    borderWidth: StyleSheet.hairlineWidth,
    marginBottom: 6,
    maxHeight: 220,
    overflow: "hidden",
  },
});
