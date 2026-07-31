import { Ionicons } from "@expo/vector-icons";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import {
  Alert,
  FlatList,
  Pressable,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from "react-native";

import { KIND_CANVAS, type NostrEvent } from "@buzz/core";
import type { ChannelType, ChannelVisibility, MemberRole } from "@buzz/sdk";

import { filters } from "../domain/filters";
import { shortPubkey, validPubkey } from "../domain/models";
import type { RootStackParams } from "../navigation/types";
import { MobileActions } from "../services/actions";
import { useChannel, useChannelMembers, useProfile } from "../state/queries";
import { useRelay } from "../state/relay-context";
import {
  Avatar,
  Button,
  Card,
  EmptyState,
  Header,
  IconButton,
  LoadingState,
  Page,
  SectionLabel,
} from "../ui/components";
import { useBuzzTheme } from "../ui/theme";

type CreateProps = NativeStackScreenProps<RootStackParams, "CreateChannel">;
type MembersProps = NativeStackScreenProps<RootStackParams, "Members">;
type CanvasProps = NativeStackScreenProps<RootStackParams, "Canvas">;
type ProfileProps = NativeStackScreenProps<RootStackParams, "Profile">;

export function CreateChannelScreen({ navigation }: CreateProps) {
  const theme = useBuzzTheme();
  const { relay } = useRelay();
  const actions = useMemo(() => new MobileActions(relay), [relay]);
  const [name, setName] = useState("");
  const [about, setAbout] = useState("");
  const [type, setType] = useState<ChannelType>("stream");
  const [visibility, setVisibility] = useState<ChannelVisibility>("open");
  const [ephemeral, setEphemeral] = useState(false);
  const [ttlHours, setTtlHours] = useState("24");
  const [busy, setBusy] = useState(false);

  const create = async () => {
    setBusy(true);
    const channelId = crypto.randomUUID();
    try {
      await actions.createChannel({
        channelId,
        name,
        type,
        visibility,
        ...(about.trim() ? { about: about.trim() } : {}),
        ...(ephemeral
          ? {
              ttlSeconds: Math.max(300, Math.floor(Number(ttlHours) * 3_600)),
            }
          : {}),
      });
      navigation.replace("Channel", { channelId });
    } catch (error) {
      Alert.alert(
        "Channel not created",
        error instanceof Error ? error.message : "Please try again.",
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <Page scroll contentContainerStyle={styles.formPage}>
      <Header
        eyebrow="New space"
        left={
          <IconButton
            icon="close"
            label="Cancel"
            onPress={() => navigation.goBack()}
          />
        }
        subtitle="Create once; the relay signs the durable channel snapshot."
        title="Shape a channel"
      />
      <Card style={styles.formCard}>
        <Field
          label="Name"
          maxLength={128}
          placeholder="release-room"
          value={name}
          onChangeText={setName}
        />
        <Field
          label="Purpose"
          maxLength={4_096}
          multiline
          placeholder="What belongs here, and what does not?"
          value={about}
          onChangeText={setAbout}
        />
      </Card>
      <SectionLabel>Channel format</SectionLabel>
      <View style={styles.optionGrid}>
        {(
          [
            ["stream", "chatbubble-ellipses-outline", "Fast conversation"],
            ["forum", "albums-outline", "Durable topics"],
            ["workflow", "git-network-outline", "Automation runs"],
            ["dm", "lock-closed-outline", "Private group"],
          ] as const
        ).map(([value, icon, detail]) => (
          <OptionCard
            key={value}
            detail={detail}
            icon={icon}
            label={value}
            selected={type === value}
            onPress={() => setType(value)}
          />
        ))}
      </View>
      <SectionLabel>Access</SectionLabel>
      <Card style={styles.formCard}>
        <ToggleRow
          detail="Only explicitly added identities can read channel content."
          label="Private membership"
          value={visibility === "private"}
          onValueChange={(value) => setVisibility(value ? "private" : "open")}
        />
        <View
          style={[styles.divider, { backgroundColor: theme.colors.border }]}
        />
        <ToggleRow
          detail="Relay auto-archives this space at its signed deadline."
          label="Ephemeral channel"
          value={ephemeral}
          onValueChange={setEphemeral}
        />
        {ephemeral ? (
          <Field
            keyboardType="decimal-pad"
            label="Lifetime in hours"
            maxLength={7}
            placeholder="24"
            value={ttlHours}
            onChangeText={setTtlHours}
          />
        ) : null}
      </Card>
      <Button
        disabled={!name.trim() || (ephemeral && Number(ttlHours) <= 0)}
        label="Create channel"
        loading={busy}
        onPress={() => void create()}
      />
    </Page>
  );
}

export function MembersScreen({ navigation, route }: MembersProps) {
  const theme = useBuzzTheme();
  const { community, relay } = useRelay();
  const actions = useMemo(() => new MobileActions(relay), [relay]);
  const channel = useChannel(route.params.channelId).data;
  const members = useChannelMembers(route.params.channelId);
  const [pubkey, setPubkey] = useState("");
  const [role, setRole] = useState<MemberRole>("member");
  const [busy, setBusy] = useState(false);

  const add = async () => {
    const normalized = validPubkey(pubkey.trim().toLowerCase());
    if (!normalized) {
      Alert.alert("Enter a 64-character lowercase Nostr public key.");
      return;
    }
    setBusy(true);
    try {
      await actions.addMember(route.params.channelId, normalized, role);
      setPubkey("");
      await members.refetch();
    } catch (error) {
      showError("Member not added", error);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Page>
      <Header
        eyebrow={channel?.name ?? "Channel"}
        left={
          <IconButton
            icon="chevron-back"
            label="Back"
            onPress={() => navigation.goBack()}
          />
        }
        subtitle={`${members.data?.length ?? 0} identities`}
        title="Members"
      />
      <Card style={styles.addMember}>
        <Text
          style={{
            color: theme.colors.text,
            fontFamily: "Inter",
            fontSize: 15,
            fontWeight: "700",
          }}
        >
          Add identity
        </Text>
        <Field
          autoCapitalize="none"
          label="Public key"
          maxLength={64}
          placeholder="64 lowercase hex characters"
          value={pubkey}
          onChangeText={setPubkey}
        />
        <View style={styles.roleRow}>
          {(["member", "admin", "guest", "bot"] as const).map((value) => (
            <Pressable
              key={value}
              style={[
                styles.role,
                {
                  backgroundColor:
                    role === value
                      ? theme.colors.accentSoft
                      : theme.colors.elevated,
                  borderColor:
                    role === value ? theme.colors.accent : theme.colors.border,
                },
              ]}
              onPress={() => setRole(value)}
            >
              <Text
                style={{
                  color:
                    role === value ? theme.colors.accent : theme.colors.muted,
                  fontFamily: "GeistMono",
                  fontSize: 9,
                  textTransform: "uppercase",
                }}
              >
                {value}
              </Text>
            </Pressable>
          ))}
        </View>
        <Button
          disabled={!pubkey.trim()}
          label="Add member"
          loading={busy}
          variant="secondary"
          onPress={() => void add()}
        />
      </Card>
      {members.isPending ? (
        <LoadingState />
      ) : (
        <FlatList
          contentContainerStyle={styles.memberList}
          data={members.data ?? []}
          keyExtractor={(item) => item.pubkey}
          ListHeaderComponent={<SectionLabel>Channel roster</SectionLabel>}
          renderItem={({ item }) => (
            <MemberRow
              canRemove={
                item.pubkey !== community.pubkey && item.role !== "owner"
              }
              pubkey={item.pubkey}
              role={item.role}
              {...(item.role === "bot"
                ? {
                    onActivity: () =>
                      navigation.navigate("AgentActivity", {
                        agentPubkey: item.pubkey,
                        channelId: route.params.channelId,
                      }),
                  }
                : {})}
              onOpen={() =>
                navigation.navigate("Profile", { pubkey: item.pubkey })
              }
              onRemove={() =>
                Alert.alert(
                  "Remove member?",
                  `Remove ${shortPubkey(item.pubkey)} from this channel?`,
                  [
                    { style: "cancel", text: "Cancel" },
                    {
                      onPress: () =>
                        void actions
                          .removeMember(route.params.channelId, item.pubkey)
                          .then(() => members.refetch())
                          .catch((error: unknown) =>
                            showError("Member not removed", error),
                          ),
                      style: "destructive",
                      text: "Remove",
                    },
                  ],
                )
              }
            />
          )}
        />
      )}
    </Page>
  );
}

export function CanvasScreen({ navigation, route }: CanvasProps) {
  const theme = useBuzzTheme();
  const { community, relay } = useRelay();
  const actions = useMemo(() => new MobileActions(relay), [relay]);
  const queryClient = useQueryClient();
  const key = useMemo(
    () => ["canvas", community.id, route.params.channelId] as const,
    [community.id, route.params.channelId],
  );
  const canvas = useQuery({
    queryFn: async () =>
      latestEvent(await relay.query([filters.canvas(route.params.channelId)]))
        ?.content ?? "",
    queryKey: key,
  });
  const [content, setContent] = useState("");
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    if (!editing && canvas.data !== undefined) setContent(canvas.data);
  }, [canvas.data, editing]);
  useEffect(
    () =>
      relay.subscribe(
        [{ "#h": [route.params.channelId], kinds: [KIND_CANVAS] }],
        () => void queryClient.invalidateQueries({ queryKey: key }),
      ),
    [key, queryClient, relay, route.params.channelId],
  );

  return (
    <Page>
      <Header
        eyebrow="Shared context"
        left={
          <IconButton
            icon="chevron-back"
            label="Back"
            onPress={() => navigation.goBack()}
          />
        }
        right={
          editing ? (
            <IconButton
              disabled={saving}
              icon="checkmark"
              label="Save canvas"
              onPress={() => {
                setSaving(true);
                void actions
                  .setCanvas(route.params.channelId, content)
                  .then(() => {
                    setEditing(false);
                    void canvas.refetch();
                  })
                  .catch((error: unknown) =>
                    showError("Canvas not saved", error),
                  )
                  .finally(() => setSaving(false));
              }}
            />
          ) : (
            <IconButton
              icon="pencil-outline"
              label="Edit canvas"
              onPress={() => setEditing(true)}
            />
          )
        }
        subtitle="A signed, versioned markdown surface"
        title="Canvas"
      />
      {canvas.isPending ? (
        <LoadingState />
      ) : editing ? (
        <TextInput
          autoFocus
          maxLength={256 * 1024}
          multiline
          placeholder="Write shared context in Markdown…"
          placeholderTextColor={theme.colors.faint}
          style={[
            styles.canvasEditor,
            {
              backgroundColor: theme.colors.surface,
              borderColor: theme.colors.border,
              color: theme.colors.text,
              fontFamily: "GeistMono",
            },
          ]}
          textAlignVertical="top"
          value={content}
          onChangeText={setContent}
        />
      ) : content ? (
        <Card style={styles.canvas}>
          <Text
            selectable
            style={{
              color: theme.colors.text,
              fontFamily: "Inter",
              fontSize: 15,
              lineHeight: 23,
            }}
          >
            {content}
          </Text>
        </Card>
      ) : (
        <EmptyState
          body="Capture the brief, decisions, links, and durable context this channel needs."
          icon="document-text-outline"
          title="Blank canvas"
        />
      )}
    </Page>
  );
}

export function ProfileScreen({ navigation, route }: ProfileProps) {
  const theme = useBuzzTheme();
  const profile = useProfile(route.params.pubkey);
  return (
    <Page scroll>
      <Header
        left={
          <IconButton
            icon="chevron-back"
            label="Back"
            onPress={() => navigation.goBack()}
          />
        }
        title="Profile"
      />
      {profile.isPending ? (
        <LoadingState />
      ) : (
        <View style={styles.profile}>
          <Avatar
            profile={profile.data}
            pubkey={route.params.pubkey}
            size={88}
          />
          <Text
            style={[
              styles.profileName,
              { color: theme.colors.text, fontFamily: "Inter" },
            ]}
          >
            {profile.data?.displayName ?? shortPubkey(route.params.pubkey)}
          </Text>
          <Text
            selectable
            style={[
              styles.profileKey,
              { color: theme.colors.faint, fontFamily: "GeistMono" },
            ]}
          >
            {route.params.pubkey}
          </Text>
          {profile.data?.about ? (
            <Card>
              <Text
                style={{
                  color: theme.colors.text,
                  fontFamily: "Inter",
                  fontSize: 15,
                  lineHeight: 23,
                }}
              >
                {profile.data.about}
              </Text>
            </Card>
          ) : null}
        </View>
      )}
    </Page>
  );
}

function Field({
  label,
  ...props
}: React.ComponentProps<typeof TextInput> & { readonly label: string }) {
  const theme = useBuzzTheme();
  return (
    <View style={styles.field}>
      <Text
        style={{
          color: theme.colors.faint,
          fontFamily: "GeistMono",
          fontSize: 9,
          letterSpacing: 1,
          textTransform: "uppercase",
        }}
      >
        {label}
      </Text>
      <TextInput
        placeholderTextColor={theme.colors.faint}
        {...props}
        style={[
          styles.fieldInput,
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

function ToggleRow({
  label,
  detail,
  value,
  onValueChange,
}: {
  readonly label: string;
  readonly detail: string;
  readonly value: boolean;
  readonly onValueChange: (value: boolean) => void;
}) {
  const theme = useBuzzTheme();
  return (
    <View style={styles.toggle}>
      <View style={styles.toggleCopy}>
        <Text
          style={{
            color: theme.colors.text,
            fontFamily: "Inter",
            fontSize: 15,
            fontWeight: "600",
          }}
        >
          {label}
        </Text>
        <Text
          style={{
            color: theme.colors.muted,
            fontFamily: "Inter",
            fontSize: 12,
            lineHeight: 17,
          }}
        >
          {detail}
        </Text>
      </View>
      <Switch
        trackColor={{
          false: theme.colors.border,
          true: theme.colors.accentSoft,
        }}
        thumbColor={value ? theme.colors.accent : theme.colors.faint}
        value={value}
        onValueChange={onValueChange}
      />
    </View>
  );
}

function OptionCard({
  icon,
  label,
  detail,
  selected,
  onPress,
}: {
  readonly icon: React.ComponentProps<typeof Ionicons>["name"];
  readonly label: string;
  readonly detail: string;
  readonly selected: boolean;
  readonly onPress: () => void;
}) {
  const theme = useBuzzTheme();
  return (
    <Pressable
      accessibilityState={{ selected }}
      style={[
        styles.option,
        {
          backgroundColor: selected
            ? theme.colors.accentSoft
            : theme.colors.surface,
          borderColor: selected ? theme.colors.accent : theme.colors.border,
        },
      ]}
      onPress={onPress}
    >
      <Ionicons
        color={selected ? theme.colors.accent : theme.colors.muted}
        name={icon}
        size={22}
      />
      <Text
        style={{
          color: theme.colors.text,
          fontFamily: "Inter",
          fontSize: 14,
          fontWeight: "700",
          textTransform: "capitalize",
        }}
      >
        {label}
      </Text>
      <Text
        style={{
          color: theme.colors.muted,
          fontFamily: "Inter",
          fontSize: 11,
        }}
      >
        {detail}
      </Text>
    </Pressable>
  );
}

function MemberRow({
  pubkey,
  role,
  canRemove,
  onActivity,
  onOpen,
  onRemove,
}: {
  readonly pubkey: string;
  readonly role: string;
  readonly canRemove: boolean;
  readonly onActivity?: () => void;
  readonly onOpen: () => void;
  readonly onRemove: () => void;
}) {
  const theme = useBuzzTheme();
  const profile = useProfile(pubkey).data;
  return (
    <Pressable
      style={[
        styles.member,
        {
          backgroundColor: theme.colors.surface,
          borderColor: theme.colors.border,
        },
      ]}
      onPress={onOpen}
    >
      <Avatar profile={profile} pubkey={pubkey} size={40} />
      <View style={styles.toggleCopy}>
        <Text
          numberOfLines={1}
          style={{
            color: theme.colors.text,
            fontFamily: "Inter",
            fontSize: 14,
            fontWeight: "700",
          }}
        >
          {profile?.displayName ?? shortPubkey(pubkey)}
        </Text>
        <Text
          style={{
            color: theme.colors.accent,
            fontFamily: "GeistMono",
            fontSize: 9,
            textTransform: "uppercase",
          }}
        >
          {role}
        </Text>
      </View>
      {onActivity ? (
        <Pressable
          accessibilityLabel="Open live agent activity"
          hitSlop={8}
          onPress={(event) => {
            event.stopPropagation();
            onActivity();
          }}
        >
          <Ionicons
            color={theme.colors.accent}
            name="pulse-outline"
            size={19}
          />
        </Pressable>
      ) : null}
      {canRemove ? (
        <Pressable
          accessibilityLabel="Remove member"
          hitSlop={8}
          onPress={(event) => {
            event.stopPropagation();
            onRemove();
          }}
        >
          <Ionicons
            color={theme.colors.danger}
            name="person-remove-outline"
            size={19}
          />
        </Pressable>
      ) : null}
    </Pressable>
  );
}

function latestEvent(events: readonly NostrEvent[]): NostrEvent | undefined {
  return [...events].sort(
    (left, right) =>
      right.created_at - left.created_at || right.id.localeCompare(left.id),
  )[0];
}

function showError(title: string, error: unknown): void {
  Alert.alert(
    title,
    error instanceof Error ? error.message : "Please try again.",
  );
}

const styles = StyleSheet.create({
  addMember: { gap: 14, margin: 12 },
  canvas: { margin: 14, padding: 20 },
  canvasEditor: {
    borderRadius: 18,
    borderWidth: StyleSheet.hairlineWidth,
    flex: 1,
    fontSize: 13,
    lineHeight: 20,
    margin: 12,
    padding: 16,
  },
  divider: { height: StyleSheet.hairlineWidth },
  field: { gap: 6 },
  fieldInput: {
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    fontSize: 14,
    minHeight: 46,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  formCard: { gap: 16 },
  formPage: { gap: 14, paddingHorizontal: 14 },
  member: {
    alignItems: "center",
    borderRadius: 16,
    borderWidth: StyleSheet.hairlineWidth,
    flexDirection: "row",
    gap: 11,
    marginBottom: 7,
    marginHorizontal: 12,
    padding: 11,
  },
  memberList: { paddingBottom: 60 },
  multiline: { minHeight: 92, textAlignVertical: "top" },
  option: {
    borderRadius: 16,
    borderWidth: StyleSheet.hairlineWidth,
    flexBasis: "47%",
    flexGrow: 1,
    gap: 5,
    minHeight: 112,
    padding: 14,
  },
  optionGrid: { flexDirection: "row", flexWrap: "wrap", gap: 9 },
  profile: { alignItems: "center", gap: 14, padding: 22 },
  profileKey: { fontSize: 10, lineHeight: 15, textAlign: "center" },
  profileName: { fontSize: 24, fontWeight: "800" },
  role: {
    borderRadius: 999,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 9,
    paddingVertical: 6,
  },
  roleRow: { flexDirection: "row", flexWrap: "wrap", gap: 6 },
  toggle: { alignItems: "center", flexDirection: "row", gap: 14 },
  toggleCopy: { flex: 1, gap: 2 },
});
