import { Ionicons } from "@expo/vector-icons";
import * as Application from "expo-application";
import * as Clipboard from "expo-clipboard";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { useMemo, useState } from "react";
import {
  Alert,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";

import { KIND_USER_STATUS } from "@buzz/core";

import type { RootStackParams } from "../navigation/types";
import { claimInvite } from "../services/invites";
import { MobileActions } from "../services/actions";
import { useAppStore } from "../state/app-store";
import { useProfile } from "../state/queries";
import { useRelay } from "../state/relay-context";
import {
  Avatar,
  Button,
  Card,
  ConnectionPill,
  Header,
  IconButton,
  Page,
  SectionLabel,
} from "../ui/components";
import { useBuzzTheme } from "../ui/theme";

type SettingsProps = NativeStackScreenProps<RootStackParams, "Settings">;
type NoteProps = NativeStackScreenProps<RootStackParams, "ComposeNote">;
type InviteProps = NativeStackScreenProps<RootStackParams, "Invite">;

const ACCENTS = [
  "#f5a524",
  "#f97316",
  "#ef4444",
  "#ec4899",
  "#a855f7",
  "#6366f1",
  "#3b82f6",
  "#06b6d4",
  "#10b981",
  "#84cc16",
] as const;

export function SettingsScreen({ navigation }: SettingsProps) {
  const theme = useBuzzTheme();
  const { community, relay } = useRelay();
  const actions = useMemo(() => new MobileActions(relay), [relay]);
  const profile = useProfile(community.pubkey);
  const communities = useAppStore((state) => state.communities);
  const switchCommunity = useAppStore((state) => state.switchCommunity);
  const removeCommunity = useAppStore((state) => state.removeCommunity);
  const themeMode = useAppStore((state) => state.themeMode);
  const setThemeMode = useAppStore((state) => state.setThemeMode);
  const accent = useAppStore((state) => state.accent);
  const setAccent = useAppStore((state) => state.setAccent);
  const [editingProfile, setEditingProfile] = useState(false);
  const [displayName, setDisplayName] = useState(
    profile.data?.displayName ?? "",
  );
  const [about, setAbout] = useState(profile.data?.about ?? "");
  const [picture, setPicture] = useState(profile.data?.picture ?? "");
  const [status, setStatus] = useState("");
  const [statusEmoji, setStatusEmoji] = useState("");

  return (
    <Page scroll contentContainerStyle={styles.page}>
      <Header
        eyebrow="Device"
        left={
          <IconButton
            icon="chevron-back"
            label="Back"
            onPress={() => navigation.goBack()}
          />
        }
        right={<ConnectionPill />}
        subtitle="Identity, communities, and visual rhythm"
        title="Settings"
      />
      <SectionLabel>Profile</SectionLabel>
      <Card style={styles.card}>
        <Pressable
          style={styles.profileHeader}
          onPress={() => setEditingProfile((value) => !value)}
        >
          <Avatar
            profile={profile.data}
            pubkey={community.pubkey}
            size={54}
            status="online"
          />
          <View style={styles.copy}>
            <Text
              style={[
                styles.profileName,
                { color: theme.colors.text, fontFamily: "Inter" },
              ]}
            >
              {profile.data?.displayName ?? "Set your name"}
            </Text>
            <Text
              numberOfLines={1}
              style={{
                color: theme.colors.faint,
                fontFamily: "GeistMono",
                fontSize: 9,
              }}
            >
              {community.pubkey}
            </Text>
          </View>
          <Ionicons
            color={theme.colors.faint}
            name={editingProfile ? "chevron-up" : "pencil-outline"}
            size={18}
          />
        </Pressable>
        {editingProfile ? (
          <View style={styles.editProfile}>
            <SettingInput
              label="Display name"
              maxLength={128}
              value={displayName}
              onChangeText={setDisplayName}
            />
            <SettingInput
              label="About"
              maxLength={4_096}
              multiline
              value={about}
              onChangeText={setAbout}
            />
            <SettingInput
              autoCapitalize="none"
              label="Avatar URL"
              maxLength={2_048}
              value={picture}
              onChangeText={setPicture}
            />
            <Button
              label="Publish profile"
              onPress={() =>
                void actions
                  .setProfile({
                    about,
                    displayName,
                    name: displayName || community.pubkey.slice(0, 8),
                    ...(picture.trim() ? { picture: picture.trim() } : {}),
                  })
                  .then(() => {
                    setEditingProfile(false);
                    void profile.refetch();
                  })
                  .catch((error: unknown) =>
                    showError("Profile not published", error),
                  )
              }
            />
          </View>
        ) : null}
        <View
          style={[styles.divider, { backgroundColor: theme.colors.border }]}
        />
        <View style={styles.statusRow}>
          <TextInput
            maxLength={16}
            placeholder="✨"
            placeholderTextColor={theme.colors.faint}
            style={[
              styles.emojiInput,
              {
                backgroundColor: theme.colors.elevated,
                borderColor: theme.colors.border,
                color: theme.colors.text,
              },
            ]}
            value={statusEmoji}
            onChangeText={setStatusEmoji}
          />
          <TextInput
            maxLength={280}
            placeholder="What are you focused on?"
            placeholderTextColor={theme.colors.faint}
            style={[
              styles.statusInput,
              {
                backgroundColor: theme.colors.elevated,
                borderColor: theme.colors.border,
                color: theme.colors.text,
                fontFamily: "Inter",
              },
            ]}
            value={status}
            onChangeText={setStatus}
          />
          <IconButton
            disabled={!status.trim() && !statusEmoji.trim()}
            icon="send"
            label="Publish status"
            onPress={() =>
              void relay
                .publish({
                  content: status.trim(),
                  kind: KIND_USER_STATUS,
                  tags: [
                    ["d", "general"],
                    ...(statusEmoji.trim()
                      ? [["emoji", statusEmoji.trim()]]
                      : []),
                  ],
                })
                .then(() => {
                  setStatus("");
                  setStatusEmoji("");
                })
                .catch((error: unknown) =>
                  showError("Status not published", error),
                )
            }
          />
        </View>
      </Card>

      <SectionLabel>Appearance</SectionLabel>
      <Card style={styles.card}>
        <View style={styles.modeRow}>
          {(["system", "light", "dark"] as const).map((mode) => (
            <Pressable
              key={mode}
              style={[
                styles.mode,
                {
                  backgroundColor:
                    themeMode === mode
                      ? theme.colors.accentSoft
                      : theme.colors.elevated,
                  borderColor:
                    themeMode === mode
                      ? theme.colors.accent
                      : theme.colors.border,
                },
              ]}
              onPress={() => void setThemeMode(mode)}
            >
              <Ionicons
                color={
                  themeMode === mode ? theme.colors.accent : theme.colors.muted
                }
                name={
                  mode === "system"
                    ? "contrast-outline"
                    : mode === "light"
                      ? "sunny-outline"
                      : "moon-outline"
                }
                size={19}
              />
              <Text
                style={{
                  color:
                    themeMode === mode
                      ? theme.colors.accent
                      : theme.colors.muted,
                  fontFamily: "GeistMono",
                  fontSize: 9,
                  textTransform: "uppercase",
                }}
              >
                {mode}
              </Text>
            </Pressable>
          ))}
        </View>
        <View style={styles.accents}>
          {ACCENTS.map((color) => (
            <Pressable
              key={color}
              accessibilityLabel={`Use accent ${color}`}
              accessibilityState={{ selected: accent === color }}
              style={[
                styles.swatchShell,
                {
                  borderColor:
                    accent === color ? theme.colors.text : "transparent",
                },
              ]}
              onPress={() => void setAccent(color)}
            >
              <View style={[styles.swatch, { backgroundColor: color }]} />
            </Pressable>
          ))}
        </View>
      </Card>

      <SectionLabel>Communities</SectionLabel>
      <Card style={styles.communityCard}>
        {communities.map((item, index) => (
          <View key={item.id}>
            {index > 0 ? (
              <View
                style={[
                  styles.divider,
                  { backgroundColor: theme.colors.border },
                ]}
              />
            ) : null}
            <Pressable
              style={styles.communityRow}
              onPress={() => {
                if (item.id !== community.id) {
                  void switchCommunity(item.id).then(() =>
                    navigation.popToTop(),
                  );
                }
              }}
            >
              <View
                style={[
                  styles.communityIcon,
                  {
                    backgroundColor:
                      item.id === community.id
                        ? theme.colors.accentSoft
                        : theme.colors.elevated,
                  },
                ]}
              >
                <Ionicons
                  color={
                    item.id === community.id
                      ? theme.colors.accent
                      : theme.colors.muted
                  }
                  name="radio-outline"
                  size={19}
                />
              </View>
              <View style={styles.copy}>
                <Text
                  style={{
                    color: theme.colors.text,
                    fontFamily: "Inter",
                    fontSize: 14,
                    fontWeight: "700",
                  }}
                >
                  {item.name}
                </Text>
                <Text
                  numberOfLines={1}
                  style={{
                    color: theme.colors.faint,
                    fontFamily: "GeistMono",
                    fontSize: 9,
                  }}
                >
                  {item.relayUrl}
                </Text>
              </View>
              {item.id === community.id ? (
                <Ionicons
                  color={theme.colors.success}
                  name="checkmark-circle"
                  size={20}
                />
              ) : null}
            </Pressable>
          </View>
        ))}
        <Button
          icon="add-circle-outline"
          label="Add another community"
          variant="secondary"
          onPress={() => navigation.navigate("Pairing", {})}
        />
      </Card>

      <SectionLabel>Organization</SectionLabel>
      <Card style={styles.card}>
        <SettingRow
          icon="albums-outline"
          label="Channel sections"
          value="Create and securely sync private channel groups"
          trailingIcon="chevron-forward"
          onPress={() => navigation.navigate("ChannelSections")}
        />
      </Card>

      <SectionLabel>Connection</SectionLabel>
      <Card style={styles.card}>
        <SettingRow
          icon="server-outline"
          label="Connected relay"
          value={community.relayUrl}
        />
        <View
          style={[styles.divider, { backgroundColor: theme.colors.border }]}
        />
        <SettingRow
          icon="key-outline"
          label="Public identity"
          value={`${community.pubkey.slice(0, 12)}…`}
          onPress={() => void Clipboard.setStringAsync(community.pubkey)}
        />
      </Card>

      <Button
        label="Remove this community"
        variant="danger"
        onPress={() =>
          Alert.alert(
            "Remove community?",
            "The device key will be deleted from secure storage. Pair again to reconnect.",
            [
              { style: "cancel", text: "Cancel" },
              {
                onPress: () =>
                  void removeCommunity(community.id).then(() =>
                    navigation.popToTop(),
                  ),
                style: "destructive",
                text: "Remove",
              },
            ],
          )
        }
      />
      <Text
        style={{
          color: theme.colors.faint,
          fontFamily: "GeistMono",
          fontSize: 9,
          paddingVertical: 18,
          textAlign: "center",
        }}
      >
        Buzz {Application.nativeApplicationVersion ?? "dev"} · TypeScript mobile
      </Text>
    </Page>
  );
}

export function ComposeNoteScreen({ navigation, route }: NoteProps) {
  const theme = useBuzzTheme();
  const { relay } = useRelay();
  const actions = useMemo(() => new MobileActions(relay), [relay]);
  const [content, setContent] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <Page>
      <Header
        eyebrow={route.params.replyToEventId ? "Reply" : "Pulse"}
        left={
          <IconButton
            icon="close"
            label="Cancel"
            onPress={() => navigation.goBack()}
          />
        }
        right={
          <Button
            disabled={!content.trim()}
            label="Publish"
            loading={busy}
            onPress={() => {
              setBusy(true);
              void actions
                .publishNote(content.trim(), route.params.replyToEventId)
                .then(() => navigation.goBack())
                .catch((error: unknown) =>
                  showError("Note not published", error),
                )
                .finally(() => setBusy(false));
            }}
          />
        }
        subtitle="A signed note visible across the community"
        title={
          route.params.replyToEventId ? "Continue the thought" : "New note"
        }
      />
      <TextInput
        autoFocus
        maxLength={65_536}
        multiline
        placeholder="What should the wider community know?"
        placeholderTextColor={theme.colors.faint}
        style={[
          styles.noteInput,
          { color: theme.colors.text, fontFamily: "Inter" },
        ]}
        textAlignVertical="top"
        value={content}
        onChangeText={setContent}
      />
    </Page>
  );
}

export function InviteScreen({ navigation, route }: InviteProps) {
  const theme = useBuzzTheme();
  const communities = useAppStore((state) => state.communities);
  const switchCommunity = useAppStore((state) => state.switchCommunity);
  const [busy, setBusy] = useState(false);
  const host = new URL(route.params.relayUrl).host;
  const existing = communities.find(
    (item) => new URL(item.relayUrl).host.toLowerCase() === host.toLowerCase(),
  );
  return (
    <Page scroll contentContainerStyle={styles.invitePage}>
      <Header
        left={
          <IconButton
            icon="close"
            label="Close"
            onPress={() => navigation.goBack()}
          />
        }
        title="Community invite"
      />
      <Card style={styles.invite}>
        <View
          style={[
            styles.inviteIcon,
            { backgroundColor: theme.colors.accentSoft },
          ]}
        >
          <Ionicons
            color={theme.colors.accent}
            name="ticket-outline"
            size={34}
          />
        </View>
        <Text
          style={[
            styles.inviteTitle,
            { color: theme.colors.text, fontFamily: "Inter" },
          ]}
        >
          Join {host}
        </Text>
        <Text
          style={{
            color: theme.colors.muted,
            fontFamily: "Inter",
            fontSize: 14,
            lineHeight: 21,
            textAlign: "center",
          }}
        >
          Buzz will generate a fresh device key, bind the signed NIP-98 claim to
          this exact relay and request body, then store the key in the device
          vault.
        </Text>
        <Button
          label={existing ? "Switch to community" : "Accept invite"}
          loading={busy}
          onPress={() => {
            setBusy(true);
            const operation = existing
              ? switchCommunity(existing.id)
              : claimInvite(route.params);
            void operation
              .then(() => navigation.popToTop())
              .catch((error: unknown) => showError("Could not join", error))
              .finally(() => setBusy(false));
          }}
        />
      </Card>
    </Page>
  );
}

function SettingInput({
  label,
  ...props
}: React.ComponentProps<typeof TextInput> & { readonly label: string }) {
  const theme = useBuzzTheme();
  return (
    <View style={styles.settingInputGroup}>
      <Text
        style={{
          color: theme.colors.faint,
          fontFamily: "GeistMono",
          fontSize: 9,
          textTransform: "uppercase",
        }}
      >
        {label}
      </Text>
      <TextInput
        placeholderTextColor={theme.colors.faint}
        {...props}
        style={[
          styles.settingInput,
          {
            backgroundColor: theme.colors.elevated,
            borderColor: theme.colors.border,
            color: theme.colors.text,
            fontFamily: "Inter",
          },
          props.multiline ? styles.multiline : null,
          props.style,
        ]}
      />
    </View>
  );
}

function SettingRow({
  icon,
  label,
  value,
  onPress,
  trailingIcon,
}: {
  readonly icon: React.ComponentProps<typeof Ionicons>["name"];
  readonly label: string;
  readonly value: string;
  readonly onPress?: () => void;
  readonly trailingIcon?: React.ComponentProps<typeof Ionicons>["name"];
}) {
  const theme = useBuzzTheme();
  return (
    <Pressable disabled={!onPress} style={styles.settingRow} onPress={onPress}>
      <Ionicons color={theme.colors.muted} name={icon} size={20} />
      <View style={styles.copy}>
        <Text
          style={{
            color: theme.colors.text,
            fontFamily: "Inter",
            fontSize: 14,
            fontWeight: "600",
          }}
        >
          {label}
        </Text>
        <Text
          numberOfLines={2}
          style={{
            color: theme.colors.faint,
            fontFamily: "GeistMono",
            fontSize: 9,
            lineHeight: 14,
          }}
        >
          {value}
        </Text>
      </View>
      {onPress ? (
        <Ionicons
          color={theme.colors.faint}
          name={trailingIcon ?? "copy-outline"}
          size={17}
        />
      ) : null}
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
  accents: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  card: { gap: 14 },
  communityCard: { gap: 12 },
  communityIcon: {
    alignItems: "center",
    borderRadius: 12,
    height: 40,
    justifyContent: "center",
    width: 40,
  },
  communityRow: {
    alignItems: "center",
    flexDirection: "row",
    gap: 11,
    paddingVertical: 3,
  },
  copy: { flex: 1, gap: 2 },
  divider: { height: StyleSheet.hairlineWidth },
  editProfile: { gap: 12 },
  emojiInput: {
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    fontSize: 18,
    height: 44,
    textAlign: "center",
    width: 48,
  },
  invite: {
    alignItems: "center",
    gap: 18,
    marginHorizontal: "auto",
    maxWidth: 420,
  },
  inviteIcon: {
    alignItems: "center",
    borderRadius: 30,
    height: 64,
    justifyContent: "center",
    width: 64,
  },
  invitePage: { padding: 18, paddingTop: 36 },
  inviteTitle: { fontSize: 24, fontWeight: "800" },
  mode: {
    alignItems: "center",
    borderRadius: 14,
    borderWidth: StyleSheet.hairlineWidth,
    flex: 1,
    gap: 6,
    padding: 12,
  },
  modeRow: { flexDirection: "row", gap: 8 },
  multiline: { minHeight: 84, textAlignVertical: "top" },
  noteInput: {
    flex: 1,
    fontSize: 20,
    lineHeight: 30,
    paddingHorizontal: 20,
    paddingTop: 20,
  },
  page: { gap: 12, paddingHorizontal: 14 },
  profileHeader: { alignItems: "center", flexDirection: "row", gap: 12 },
  profileName: { fontSize: 17, fontWeight: "700" },
  settingInput: {
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    fontSize: 14,
    minHeight: 44,
    paddingHorizontal: 11,
    paddingVertical: 9,
  },
  settingInputGroup: { gap: 5 },
  settingRow: { alignItems: "center", flexDirection: "row", gap: 11 },
  statusInput: {
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    flex: 1,
    fontSize: 13,
    height: 44,
    paddingHorizontal: 11,
  },
  statusRow: { alignItems: "center", flexDirection: "row", gap: 8 },
  swatch: { borderRadius: 12, height: 24, width: 24 },
  swatchShell: {
    borderRadius: 16,
    borderWidth: 2,
    padding: 2,
  },
});
