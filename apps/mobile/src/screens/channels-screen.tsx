import { Ionicons } from "@expo/vector-icons";
import { useNavigation } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { useMemo, useState } from "react";
import {
  Alert,
  Pressable,
  RefreshControl,
  SectionList,
  StyleSheet,
  Text,
  View,
} from "react-native";

import type { Channel, ChannelType } from "../domain/models";
import type { RootStackParams } from "../navigation/types";
import { useAppStore } from "../state/app-store";
import { useClientState } from "../state/client-state";
import { useChannels, useUnreadCounts } from "../state/queries";
import {
  ConnectionPill,
  EmptyState,
  Header,
  IconButton,
  LoadingState,
  Page,
  SectionLabel,
} from "../ui/components";
import { useBuzzTheme } from "../ui/theme";

type Navigation = NativeStackNavigationProp<RootStackParams>;

export function ChannelsScreen() {
  const theme = useBuzzTheme();
  const navigation = useNavigation<Navigation>();
  const community = useAppStore((state) => state.active);
  const channels = useChannels();
  const channelIds = useMemo(
    () => (channels.data ?? []).map((channel) => channel.id),
    [channels.data],
  );
  const unreadCounts = useUnreadCounts(channelIds).data ?? {};
  const channelState = useClientState((state) => state.channels);
  const sections = useClientState((state) => state.sections);
  const assignSection = useClientState((state) => state.assignSection);
  const toggleStar = useClientState((state) => state.toggleStar);
  const toggleMute = useClientState((state) => state.toggleMute);
  const [filter, setFilter] = useState<ChannelType | "all">("all");
  const visible = useMemo(
    () =>
      (channels.data ?? [])
        .filter((channel) => filter === "all" || channel.type === filter)
        .sort((left, right) => {
          const starDifference =
            Number(channelState[right.id]?.starred ?? false) -
            Number(channelState[left.id]?.starred ?? false);
          return starDifference || left.name.localeCompare(right.name);
        }),
    [channelState, channels.data, filter],
  );
  const channelGroups = useMemo(() => {
    const sortedSections = [...sections].sort(
      (left, right) => left.order - right.order,
    );
    const groups = sortedSections.map((section) => ({
      data: visible.filter(
        (channel) => channelState[channel.id]?.sectionId === section.id,
      ),
      id: section.id,
      title: section.name,
    }));
    groups.push({
      data: visible.filter((channel) => !channelState[channel.id]?.sectionId),
      id: "default",
      title: sortedSections.length ? "Other channels" : "Joined spaces",
    });
    return groups.filter((group) => group.data.length > 0);
  }, [channelState, sections, visible]);

  return (
    <Page>
      <Header
        eyebrow={community?.name ?? "Community"}
        title="Channels"
        subtitle={`${visible.length} signal${visible.length === 1 ? "" : "s"} in view`}
        right={
          <View style={styles.headerActions}>
            <ConnectionPill />
            <IconButton
              icon="settings-outline"
              label="Settings"
              onPress={() => navigation.navigate("Settings")}
            />
          </View>
        }
      />
      <View style={styles.filterBar}>
        {(["all", "stream", "forum", "dm", "workflow"] as const).map(
          (value) => (
            <Pressable
              key={value}
              accessibilityRole="button"
              accessibilityState={{ selected: filter === value }}
              style={[
                styles.filter,
                {
                  backgroundColor:
                    filter === value ? theme.colors.accentSoft : "transparent",
                  borderColor:
                    filter === value
                      ? theme.colors.accent
                      : theme.colors.border,
                },
              ]}
              onPress={() => setFilter(value)}
            >
              <Text
                style={{
                  color:
                    filter === value ? theme.colors.accent : theme.colors.muted,
                  fontFamily: "GeistMono",
                  fontSize: 10,
                  fontWeight: "600",
                  textTransform: "uppercase",
                }}
              >
                {value}
              </Text>
            </Pressable>
          ),
        )}
      </View>
      {channels.isPending ? (
        <LoadingState label="Loading channel index" />
      ) : channels.isError ? (
        <EmptyState
          action={
            <Pressable onPress={() => void channels.refetch()}>
              <Text style={{ color: theme.colors.accent }}>Try again</Text>
            </Pressable>
          }
          body={channels.error.message}
          icon="cloud-offline-outline"
          title="Channel index unavailable"
        />
      ) : (
        <SectionList
          contentContainerStyle={
            visible.length ? styles.list : styles.emptyList
          }
          sections={channelGroups}
          keyExtractor={(item) => item.id}
          ListEmptyComponent={
            <EmptyState
              action={
                <Pressable onPress={() => navigation.navigate("CreateChannel")}>
                  <Text
                    style={{
                      color: theme.colors.accent,
                      fontFamily: "Inter",
                      fontWeight: "700",
                    }}
                  >
                    Create the first channel
                  </Text>
                </Pressable>
              }
              body="Create a focused place for conversation, a forum, a workflow, or a private DM."
              icon="sparkles-outline"
              title="Quiet for now"
            />
          }
          refreshControl={
            <RefreshControl
              refreshing={channels.isRefetching}
              tintColor={theme.colors.accent}
              onRefresh={() => void channels.refetch()}
            />
          }
          renderSectionHeader={({ section }) => (
            <SectionLabel>{section.title}</SectionLabel>
          )}
          renderItem={({ item }) => (
            <ChannelRow
              channel={item}
              muted={channelState[item.id]?.muted ?? false}
              starred={channelState[item.id]?.starred ?? false}
              unreadCount={unreadCounts[item.id] ?? 0}
              onLongPress={() =>
                Alert.alert(item.name, "Keep this channel organized.", [
                  {
                    text: channelState[item.id]?.starred
                      ? "Remove star"
                      : "Star channel",
                    onPress: () => toggleStar(item.id),
                  },
                  {
                    text: channelState[item.id]?.muted
                      ? "Unmute"
                      : "Mute notifications",
                    onPress: () => toggleMute(item.id),
                  },
                  ...sections.map((section) => ({
                    onPress: () => assignSection(item.id, section.id),
                    text: `Move to ${section.name}`,
                  })),
                  ...(channelState[item.id]?.sectionId
                    ? [
                        {
                          onPress: () => assignSection(item.id),
                          text: "Remove from section",
                        },
                      ]
                    : []),
                  { style: "cancel", text: "Cancel" },
                ])
              }
              onPress={() =>
                navigation.navigate("Channel", { channelId: item.id })
              }
            />
          )}
        />
      )}
      <Pressable
        accessibilityLabel="Create channel"
        accessibilityRole="button"
        style={({ pressed }) => [
          styles.fab,
          {
            backgroundColor: theme.colors.accent,
            opacity: pressed ? 0.75 : 1,
            shadowColor: theme.colors.accent,
          },
        ]}
        onPress={() => navigation.navigate("CreateChannel")}
      >
        <Ionicons
          color={theme.dark ? "#111417" : "#ffffff"}
          name="add"
          size={26}
        />
      </Pressable>
    </Page>
  );
}

function ChannelRow({
  channel,
  muted,
  starred,
  unreadCount,
  onLongPress,
  onPress,
}: {
  readonly channel: Channel;
  readonly muted: boolean;
  readonly starred: boolean;
  readonly unreadCount: number;
  readonly onLongPress: () => void;
  readonly onPress: () => void;
}) {
  const theme = useBuzzTheme();
  const icon =
    channel.type === "forum"
      ? "albums-outline"
      : channel.type === "dm"
        ? "lock-closed-outline"
        : channel.type === "workflow"
          ? "git-network-outline"
          : "chatbubble-ellipses-outline";
  return (
    <Pressable
      accessibilityLabel={`${channel.name}, ${channel.type} channel`}
      accessibilityRole="button"
      style={({ pressed }) => [
        styles.channel,
        {
          backgroundColor: pressed
            ? theme.colors.accentSoft
            : theme.colors.surface,
          borderColor: theme.colors.border,
          opacity: channel.archived ? 0.58 : 1,
        },
      ]}
      onLongPress={onLongPress}
      onPress={onPress}
    >
      <View
        style={[
          styles.channelIcon,
          { backgroundColor: theme.colors.accentSoft },
        ]}
      >
        <Ionicons
          color={theme.colors.accent}
          name={icon as React.ComponentProps<typeof Ionicons>["name"]}
          size={21}
        />
      </View>
      <View style={styles.channelCopy}>
        <View style={styles.channelTitleRow}>
          <Text
            numberOfLines={1}
            style={[
              styles.channelTitle,
              { color: theme.colors.text, fontFamily: "Inter" },
            ]}
          >
            {channel.name}
          </Text>
          {channel.visibility === "private" ? (
            <Ionicons
              color={theme.colors.faint}
              name="shield-checkmark-outline"
              size={13}
            />
          ) : null}
          {channel.ephemeral ? (
            <Ionicons
              color={theme.colors.warning}
              name="timer-outline"
              size={13}
            />
          ) : null}
          {starred ? (
            <Ionicons color={theme.colors.accent} name="star" size={13} />
          ) : null}
          {muted ? (
            <Ionicons
              color={theme.colors.faint}
              name="notifications-off-outline"
              size={13}
            />
          ) : null}
        </View>
        <Text
          numberOfLines={1}
          style={[
            styles.channelAbout,
            { color: theme.colors.muted, fontFamily: "Inter" },
          ]}
        >
          {channel.about ||
            (channel.type === "dm"
              ? "Private conversation"
              : `${channel.type} channel`)}
        </Text>
      </View>
      {channel.archived ? (
        <Text
          style={{
            color: theme.colors.faint,
            fontFamily: "GeistMono",
            fontSize: 9,
          }}
        >
          ARCHIVED
        </Text>
      ) : unreadCount > 0 && !muted ? (
        <View
          style={[styles.unreadBadge, { backgroundColor: theme.colors.accent }]}
        >
          <Text
            style={{
              color: theme.dark ? "#111417" : "#ffffff",
              fontFamily: "GeistMono",
              fontSize: 9,
              fontWeight: "700",
            }}
          >
            {unreadCount > 99 ? "99+" : unreadCount}
          </Text>
        </View>
      ) : (
        <Ionicons color={theme.colors.faint} name="chevron-forward" size={17} />
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  channel: {
    alignItems: "center",
    borderRadius: 18,
    borderWidth: StyleSheet.hairlineWidth,
    flexDirection: "row",
    gap: 12,
    marginBottom: 8,
    marginHorizontal: 12,
    padding: 13,
  },
  channelAbout: { fontSize: 12, lineHeight: 17 },
  channelCopy: { flex: 1, gap: 2 },
  channelIcon: {
    alignItems: "center",
    borderRadius: 13,
    height: 42,
    justifyContent: "center",
    width: 42,
  },
  channelTitle: { flexShrink: 1, fontSize: 15, fontWeight: "700" },
  channelTitleRow: { alignItems: "center", flexDirection: "row", gap: 5 },
  emptyList: { flexGrow: 1 },
  fab: {
    alignItems: "center",
    borderRadius: 24,
    bottom: 96,
    elevation: 8,
    height: 48,
    justifyContent: "center",
    position: "absolute",
    right: 18,
    shadowOffset: { height: 8, width: 0 },
    shadowOpacity: 0.3,
    shadowRadius: 16,
    width: 48,
  },
  filter: {
    borderRadius: 999,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 11,
    paddingVertical: 7,
  },
  filterBar: {
    flexDirection: "row",
    gap: 7,
    paddingBottom: 8,
    paddingHorizontal: 16,
  },
  headerActions: { alignItems: "center", flexDirection: "row", gap: 8 },
  list: { paddingBottom: 120 },
  unreadBadge: {
    alignItems: "center",
    borderRadius: 999,
    justifyContent: "center",
    minHeight: 22,
    minWidth: 22,
    paddingHorizontal: 6,
  },
});
