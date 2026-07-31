import { Ionicons } from "@expo/vector-icons";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { useRef } from "react";
import {
  FlatList,
  StyleSheet,
  Text,
  View,
  type ListRenderItemInfo,
} from "react-native";

import type { TranscriptItem } from "../domain/observer";
import { shortPubkey } from "../domain/models";
import type { RootStackParams } from "../navigation/types";
import { useObserverTranscript } from "../state/observer-state";
import { useProfile } from "../state/queries";
import {
  Avatar,
  EmptyState,
  Header,
  IconButton,
  Page,
  formatRelativeTime,
} from "../ui/components";
import { useBuzzTheme } from "../ui/theme";

type Props = NativeStackScreenProps<RootStackParams, "AgentActivity">;

export function AgentActivityScreen({ navigation, route }: Props) {
  const theme = useBuzzTheme();
  const list = useRef<FlatList<TranscriptItem>>(null);
  const { agentPubkey, channelId } = route.params;
  const profile = useProfile(agentPubkey).data;
  const observer = useObserverTranscript(agentPubkey, channelId);
  const connection = connectionPresentation(observer.connection, theme);
  return (
    <Page>
      <Header
        eyebrow="Private observer"
        left={
          <IconButton
            icon="chevron-back"
            label="Back"
            onPress={() => navigation.goBack()}
          />
        }
        right={
          <View
            accessibilityLabel={`Observer ${connection.label}`}
            style={[styles.badge, { backgroundColor: `${connection.color}20` }]}
          >
            <View
              style={[styles.statusDot, { backgroundColor: connection.color }]}
            />
            <Text
              style={{
                color: connection.color,
                fontFamily: "GeistMono",
                fontSize: 9,
                fontWeight: "700",
                textTransform: "uppercase",
              }}
            >
              {connection.label}
            </Text>
          </View>
        }
        subtitle={
          channelId
            ? "Live encrypted activity in this channel"
            : "Live encrypted activity across channels"
        }
        title={profile?.displayName ?? shortPubkey(agentPubkey)}
      />
      <View style={styles.identity}>
        <Avatar profile={profile} pubkey={agentPubkey} size={34} />
        <Text
          numberOfLines={1}
          style={{
            color: theme.colors.faint,
            flex: 1,
            fontFamily: "GeistMono",
            fontSize: 9,
          }}
        >
          {agentPubkey}
        </Text>
      </View>
      <FlatList
        ref={list}
        contentContainerStyle={
          observer.transcript.length ? styles.transcript : styles.empty
        }
        data={observer.transcript}
        keyExtractor={(item) => item.id}
        ListEmptyComponent={
          <EmptyState
            body={
              observer.connection === "connected"
                ? "The secure subscription is live. New prompts, thoughts, replies, and tool calls will appear here."
                : "Activity will resume automatically when the authenticated relay connection is available."
            }
            icon={
              observer.connection === "connected"
                ? "radio-outline"
                : "cloud-offline-outline"
            }
            title={
              observer.connection === "connected"
                ? "Waiting for agent activity"
                : "Observer is reconnecting"
            }
          />
        }
        renderItem={(info) => <TranscriptRow {...info} />}
        onContentSizeChange={() =>
          list.current?.scrollToEnd({ animated: true })
        }
      />
    </Page>
  );
}

function TranscriptRow({ item }: ListRenderItemInfo<TranscriptItem>) {
  const theme = useBuzzTheme();
  const presentation =
    item.type === "tool"
      ? {
          color:
            item.status === "failed"
              ? theme.colors.danger
              : item.status === "completed"
                ? theme.colors.success
                : theme.colors.warning,
          icon: "terminal-outline" as const,
        }
      : item.type === "thought"
        ? {
            color: theme.colors.warning,
            icon: "bulb-outline" as const,
          }
        : item.type === "lifecycle"
          ? {
              color: theme.colors.faint,
              icon: "git-commit-outline" as const,
            }
          : item.type === "message" && item.role === "user"
            ? {
                color: theme.colors.accent,
                icon: "person-outline" as const,
              }
            : {
                color: theme.colors.success,
                icon: "sparkles-outline" as const,
              };
  return (
    <View
      style={[
        styles.item,
        {
          backgroundColor: theme.colors.surface,
          borderColor: theme.colors.border,
        },
      ]}
    >
      <View style={styles.itemHeader}>
        <Ionicons
          color={presentation.color}
          name={presentation.icon}
          size={16}
        />
        <Text
          numberOfLines={1}
          style={{
            color: presentation.color,
            flex: 1,
            fontFamily: "GeistMono",
            fontSize: 9,
            fontWeight: "700",
            textTransform: "uppercase",
          }}
        >
          {item.title}
          {item.type === "tool" ? ` · ${item.status}` : ""}
        </Text>
        <Text
          style={{
            color: theme.colors.faint,
            fontFamily: "GeistMono",
            fontSize: 8,
          }}
        >
          {formatRelativeTime(Math.floor(Date.parse(item.timestamp) / 1_000))}
        </Text>
      </View>
      {item.type === "tool" ? (
        <>
          <Text
            selectable
            style={[
              styles.toolName,
              { color: theme.colors.text, fontFamily: "GeistMono" },
            ]}
          >
            {item.toolName}
          </Text>
          {Object.keys(item.args).length ? (
            <CodeBlock value={safeJson(item.args)} />
          ) : null}
          {item.result ? <CodeBlock value={item.result} /> : null}
        </>
      ) : (
        <Text
          selectable
          style={{
            color:
              item.type === "thought" ? theme.colors.muted : theme.colors.text,
            fontFamily: item.type === "lifecycle" ? "GeistMono" : "Inter",
            fontSize: item.type === "lifecycle" ? 11 : 14,
            lineHeight: item.type === "lifecycle" ? 17 : 20,
          }}
        >
          {item.text}
        </Text>
      )}
    </View>
  );
}

function CodeBlock({ value }: { readonly value: string }) {
  const theme = useBuzzTheme();
  return (
    <View
      style={[
        styles.code,
        {
          backgroundColor: theme.colors.elevated,
          borderColor: theme.colors.border,
        },
      ]}
    >
      <Text
        selectable
        style={{
          color: theme.colors.muted,
          fontFamily: "GeistMono",
          fontSize: 10,
          lineHeight: 15,
        }}
      >
        {value}
      </Text>
    </View>
  );
}

function connectionPresentation(
  connection: string,
  theme: ReturnType<typeof useBuzzTheme>,
): {
  readonly color: string;
  readonly label: string;
} {
  if (connection === "connected") {
    return { color: theme.colors.success, label: "Live" };
  }
  if (connection === "offline") {
    return { color: theme.colors.danger, label: "Offline" };
  }
  if (connection === "idle") {
    return { color: theme.colors.faint, label: "Idle" };
  }
  return { color: theme.colors.warning, label: "Connecting" };
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2).slice(0, 65_535);
  } catch {
    return "Unserializable tool arguments";
  }
}

const styles = StyleSheet.create({
  badge: {
    alignItems: "center",
    borderRadius: 999,
    flexDirection: "row",
    gap: 6,
    paddingHorizontal: 9,
    paddingVertical: 6,
  },
  code: {
    borderRadius: 9,
    borderWidth: StyleSheet.hairlineWidth,
    padding: 9,
  },
  empty: { flexGrow: 1 },
  identity: {
    alignItems: "center",
    flexDirection: "row",
    gap: 9,
    paddingHorizontal: 14,
    paddingVertical: 8,
  },
  item: {
    borderRadius: 15,
    borderWidth: StyleSheet.hairlineWidth,
    gap: 8,
    padding: 12,
  },
  itemHeader: {
    alignItems: "center",
    flexDirection: "row",
    gap: 7,
  },
  statusDot: { borderRadius: 999, height: 6, width: 6 },
  toolName: { fontSize: 12, fontWeight: "700" },
  transcript: { gap: 8, padding: 12, paddingBottom: 42 },
});
