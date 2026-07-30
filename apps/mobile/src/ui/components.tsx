import { Ionicons } from "@expo/vector-icons";
import { Image } from "expo-image";
import * as Haptics from "expo-haptics";
import {
  ActivityIndicator,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
  type ColorValue,
  type GestureResponderEvent,
  type ScrollViewProps,
  type StyleProp,
  type ViewStyle,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { shortPubkey, type Profile } from "../domain/models";
import { useAppStore } from "../state/app-store";
import { useBuzzTheme } from "./theme";

export function Page({
  children,
  scroll = false,
  refreshing,
  onRefresh,
  contentContainerStyle,
}: {
  readonly children: React.ReactNode;
  readonly scroll?: boolean;
  readonly refreshing?: boolean;
  readonly onRefresh?: () => void;
  readonly contentContainerStyle?: StyleProp<ViewStyle>;
}) {
  const theme = useBuzzTheme();
  const content = scroll ? (
    <ScrollView
      contentContainerStyle={[styles.pageContent, contentContainerStyle]}
      keyboardShouldPersistTaps="handled"
      refreshControl={
        onRefresh ? (
          <RefreshControl
            refreshing={refreshing ?? false}
            tintColor={theme.colors.accent}
            onRefresh={onRefresh}
          />
        ) : undefined
      }
    >
      {children}
    </ScrollView>
  ) : (
    <View style={[styles.pageContent, styles.flex, contentContainerStyle]}>
      {children}
    </View>
  );
  return (
    <SafeAreaView
      edges={["top", "left", "right"]}
      style={[styles.flex, { backgroundColor: theme.colors.background }]}
    >
      {content}
    </SafeAreaView>
  );
}

export function Header({
  eyebrow,
  title,
  subtitle,
  left,
  right,
}: {
  readonly eyebrow?: string;
  readonly title: string;
  readonly subtitle?: string;
  readonly left?: React.ReactNode;
  readonly right?: React.ReactNode;
}) {
  const theme = useBuzzTheme();
  return (
    <View style={styles.header}>
      {left}
      <View style={styles.headerCopy}>
        {eyebrow ? (
          <Text
            style={[
              styles.eyebrow,
              { color: theme.colors.accent, fontFamily: "GeistMono" },
            ]}
          >
            {eyebrow.toUpperCase()}
          </Text>
        ) : null}
        <Text
          numberOfLines={1}
          style={[
            styles.title,
            { color: theme.colors.text, fontFamily: "Inter" },
          ]}
        >
          {title}
        </Text>
        {subtitle ? (
          <Text
            numberOfLines={1}
            style={[
              styles.subtitle,
              { color: theme.colors.muted, fontFamily: "Inter" },
            ]}
          >
            {subtitle}
          </Text>
        ) : null}
      </View>
      {right}
    </View>
  );
}

export function IconButton({
  icon,
  label,
  onPress,
  color,
  disabled,
}: {
  readonly icon: React.ComponentProps<typeof Ionicons>["name"];
  readonly label: string;
  readonly onPress: (event: GestureResponderEvent) => void;
  readonly color?: ColorValue;
  readonly disabled?: boolean;
}) {
  const theme = useBuzzTheme();
  return (
    <Pressable
      accessibilityLabel={label}
      accessibilityRole="button"
      disabled={disabled}
      hitSlop={8}
      style={({ pressed }) => [
        styles.iconButton,
        {
          backgroundColor: theme.colors.elevated,
          borderColor: theme.colors.border,
          opacity: disabled ? 0.4 : pressed ? 0.62 : 1,
        },
      ]}
      onPress={(event) => {
        void Haptics.selectionAsync();
        onPress(event);
      }}
    >
      <Ionicons color={color ?? theme.colors.text} name={icon} size={20} />
    </Pressable>
  );
}

export function Button({
  label,
  onPress,
  variant = "primary",
  icon,
  disabled,
  loading,
  style,
}: {
  readonly label: string;
  readonly onPress: () => void;
  readonly variant?: "primary" | "secondary" | "danger" | "ghost";
  readonly icon?: React.ComponentProps<typeof Ionicons>["name"];
  readonly disabled?: boolean;
  readonly loading?: boolean;
  readonly style?: StyleProp<ViewStyle>;
}) {
  const theme = useBuzzTheme();
  const palette =
    variant === "primary"
      ? {
          background: theme.colors.accent,
          border: theme.colors.accent,
          text: theme.dark ? "#101214" : "#ffffff",
        }
      : variant === "danger"
        ? {
            background: theme.colors.danger,
            border: theme.colors.danger,
            text: "#ffffff",
          }
        : variant === "ghost"
          ? {
              background: "transparent",
              border: "transparent",
              text: theme.colors.text,
            }
          : {
              background: theme.colors.elevated,
              border: theme.colors.border,
              text: theme.colors.text,
            };
  return (
    <Pressable
      accessibilityRole="button"
      disabled={disabled || loading}
      style={({ pressed }) => [
        styles.button,
        {
          backgroundColor: palette.background,
          borderColor: palette.border,
          opacity: disabled || loading ? 0.44 : pressed ? 0.72 : 1,
        },
        style,
      ]}
      onPress={() => {
        void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
        onPress();
      }}
    >
      {loading ? (
        <ActivityIndicator color={palette.text} size="small" />
      ) : icon ? (
        <Ionicons color={palette.text} name={icon} size={18} />
      ) : null}
      <Text
        style={[
          styles.buttonLabel,
          { color: palette.text, fontFamily: "Inter" },
        ]}
      >
        {label}
      </Text>
    </Pressable>
  );
}

export function Card({
  children,
  style,
}: {
  readonly children: React.ReactNode;
  readonly style?: StyleProp<ViewStyle>;
}) {
  const theme = useBuzzTheme();
  return (
    <View
      style={[
        styles.card,
        {
          backgroundColor: theme.colors.surface,
          borderColor: theme.colors.border,
        },
        style,
      ]}
    >
      {children}
    </View>
  );
}

export function SectionLabel({
  children,
  trailing,
}: {
  readonly children: React.ReactNode;
  readonly trailing?: React.ReactNode;
}) {
  const theme = useBuzzTheme();
  return (
    <View style={styles.sectionLabelRow}>
      <Text
        style={[
          styles.sectionLabel,
          { color: theme.colors.faint, fontFamily: "GeistMono" },
        ]}
      >
        {children}
      </Text>
      {trailing}
    </View>
  );
}

export function Avatar({
  profile,
  pubkey,
  size = 40,
  status,
}: {
  readonly profile?: Profile | undefined;
  readonly pubkey: string;
  readonly size?: number;
  readonly status?: "online" | "away" | "busy" | "offline";
}) {
  const theme = useBuzzTheme();
  const letter = (profile?.displayName ?? pubkey).slice(0, 1).toUpperCase();
  return (
    <View style={{ height: size, width: size }}>
      <View
        style={[
          styles.avatar,
          {
            backgroundColor: profile?.picture
              ? theme.colors.elevated
              : colorFromPubkey(pubkey, theme.dark),
            borderColor: theme.colors.border,
            borderRadius: size / 2,
            height: size,
            width: size,
          },
        ]}
      >
        {profile?.picture ? (
          <Image
            accessibilityLabel={`${profile.displayName} avatar`}
            contentFit="cover"
            source={{ uri: profile.picture }}
            style={{ height: size, width: size }}
          />
        ) : (
          <Text
            style={{
              color: theme.dark ? "#101214" : "#ffffff",
              fontFamily: "Inter",
              fontSize: size * 0.38,
              fontWeight: "700",
            }}
          >
            {letter}
          </Text>
        )}
      </View>
      {status ? (
        <View
          accessibilityLabel={status}
          style={[
            styles.status,
            {
              backgroundColor:
                status === "online"
                  ? theme.colors.success
                  : status === "busy"
                    ? theme.colors.danger
                    : status === "away"
                      ? theme.colors.warning
                      : theme.colors.faint,
              borderColor: theme.colors.background,
            },
          ]}
        />
      ) : null}
    </View>
  );
}

export function EmptyState({
  icon,
  title,
  body,
  action,
}: {
  readonly icon: React.ComponentProps<typeof Ionicons>["name"];
  readonly title: string;
  readonly body: string;
  readonly action?: React.ReactNode;
}) {
  const theme = useBuzzTheme();
  return (
    <View style={styles.empty}>
      <View
        style={[styles.emptyIcon, { backgroundColor: theme.colors.accentSoft }]}
      >
        <Ionicons color={theme.colors.accent} name={icon} size={28} />
      </View>
      <Text
        style={[
          styles.emptyTitle,
          { color: theme.colors.text, fontFamily: "Inter" },
        ]}
      >
        {title}
      </Text>
      <Text
        style={[
          styles.emptyBody,
          { color: theme.colors.muted, fontFamily: "Inter" },
        ]}
      >
        {body}
      </Text>
      {action}
    </View>
  );
}

export function LoadingState({
  label = "Syncing",
}: {
  readonly label?: string;
}) {
  const theme = useBuzzTheme();
  return (
    <View style={styles.loading}>
      <ActivityIndicator color={theme.colors.accent} />
      <Text
        style={{
          color: theme.colors.muted,
          fontFamily: "GeistMono",
          fontSize: 12,
        }}
      >
        {label}
      </Text>
    </View>
  );
}

export function ConnectionPill() {
  const connection = useAppStore((state) => state.connection);
  const theme = useBuzzTheme();
  const connected = connection === "connected";
  return (
    <View
      accessibilityLabel={`Relay ${connection}`}
      style={[
        styles.connection,
        {
          backgroundColor: connected
            ? `${theme.colors.success}18`
            : theme.colors.elevated,
          borderColor: connected ? theme.colors.success : theme.colors.border,
        },
      ]}
    >
      <View
        style={[
          styles.connectionDot,
          {
            backgroundColor: connected
              ? theme.colors.success
              : connection === "offline"
                ? theme.colors.danger
                : theme.colors.warning,
          },
        ]}
      />
      <Text
        style={[
          styles.connectionText,
          {
            color: connected ? theme.colors.success : theme.colors.muted,
            fontFamily: "GeistMono",
          },
        ]}
      >
        {connection}
      </Text>
    </View>
  );
}

export function ProfileLine({
  profile,
  pubkey,
  detail,
}: {
  readonly profile?: Profile | undefined;
  readonly pubkey: string;
  readonly detail?: string;
}) {
  const theme = useBuzzTheme();
  return (
    <View style={styles.profileLine}>
      <Avatar profile={profile} pubkey={pubkey} size={38} />
      <View style={styles.flex}>
        <Text
          numberOfLines={1}
          style={{
            color: theme.colors.text,
            fontFamily: "Inter",
            fontSize: 15,
            fontWeight: "600",
          }}
        >
          {profile?.displayName ?? shortPubkey(pubkey)}
        </Text>
        {detail ? (
          <Text
            numberOfLines={1}
            style={{
              color: theme.colors.muted,
              fontFamily: "Inter",
              fontSize: 12,
            }}
          >
            {detail}
          </Text>
        ) : null}
      </View>
    </View>
  );
}

export function BuzzScrollView(props: ScrollViewProps) {
  return (
    <ScrollView
      keyboardShouldPersistTaps="handled"
      {...props}
      contentContainerStyle={[styles.pageContent, props.contentContainerStyle]}
    />
  );
}

export function formatRelativeTime(unixSeconds: number): string {
  const delta = Math.max(0, Math.floor(Date.now() / 1_000) - unixSeconds);
  if (delta < 60) return "now";
  if (delta < 3_600) return `${Math.floor(delta / 60)}m`;
  if (delta < 86_400) return `${Math.floor(delta / 3_600)}h`;
  if (delta < 604_800) return `${Math.floor(delta / 86_400)}d`;
  return new Date(unixSeconds * 1_000).toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
  });
}

function colorFromPubkey(pubkey: string, dark: boolean): string {
  const palette = dark
    ? ["#f5a524", "#52c7b8", "#7da4ff", "#da86f5", "#ef7d72"]
    : ["#b86d00", "#187a70", "#416ec4", "#8b4aaa", "#b34139"];
  let hash = 0;
  for (let index = 0; index < pubkey.length; index += 1) {
    hash = (hash * 31 + pubkey.charCodeAt(index)) | 0;
  }
  return palette[Math.abs(hash) % palette.length] ?? palette[0] ?? "#f5a524";
}

const styles = StyleSheet.create({
  avatar: {
    alignItems: "center",
    borderWidth: StyleSheet.hairlineWidth,
    justifyContent: "center",
    overflow: "hidden",
  },
  button: {
    alignItems: "center",
    borderRadius: 999,
    borderWidth: 1,
    flexDirection: "row",
    gap: 8,
    justifyContent: "center",
    minHeight: 46,
    paddingHorizontal: 18,
  },
  buttonLabel: { fontSize: 15, fontWeight: "700" },
  card: {
    borderRadius: 22,
    borderWidth: StyleSheet.hairlineWidth,
    overflow: "hidden",
    padding: 16,
  },
  connection: {
    alignItems: "center",
    borderRadius: 999,
    borderWidth: StyleSheet.hairlineWidth,
    flexDirection: "row",
    gap: 6,
    paddingHorizontal: 9,
    paddingVertical: 6,
  },
  connectionDot: { borderRadius: 4, height: 7, width: 7 },
  connectionText: { fontSize: 9, textTransform: "uppercase" },
  empty: {
    alignItems: "center",
    flex: 1,
    justifyContent: "center",
    paddingHorizontal: 32,
    paddingVertical: 72,
  },
  emptyBody: {
    fontSize: 14,
    lineHeight: 21,
    marginBottom: 18,
    maxWidth: 320,
    textAlign: "center",
  },
  emptyIcon: {
    alignItems: "center",
    borderRadius: 30,
    height: 60,
    justifyContent: "center",
    marginBottom: 18,
    width: 60,
  },
  emptyTitle: { fontSize: 20, fontWeight: "700", marginBottom: 8 },
  eyebrow: { fontSize: 10, fontWeight: "700", letterSpacing: 1.4 },
  flex: { flex: 1 },
  header: {
    alignItems: "center",
    flexDirection: "row",
    gap: 10,
    minHeight: 64,
    paddingBottom: 10,
    paddingHorizontal: 16,
    paddingTop: 6,
  },
  headerCopy: { flex: 1, gap: 1 },
  iconButton: {
    alignItems: "center",
    borderRadius: 20,
    borderWidth: StyleSheet.hairlineWidth,
    height: 40,
    justifyContent: "center",
    width: 40,
  },
  loading: {
    alignItems: "center",
    flex: 1,
    gap: 12,
    justifyContent: "center",
    minHeight: 180,
  },
  pageContent: { paddingBottom: 110 },
  profileLine: { alignItems: "center", flexDirection: "row", gap: 12 },
  sectionLabel: {
    fontSize: 10,
    fontWeight: "600",
    letterSpacing: 1.2,
    textTransform: "uppercase",
  },
  sectionLabelRow: {
    alignItems: "center",
    flexDirection: "row",
    justifyContent: "space-between",
    paddingHorizontal: 18,
    paddingVertical: 10,
  },
  status: {
    borderRadius: 7,
    borderWidth: 2,
    bottom: -1,
    height: 13,
    position: "absolute",
    right: -1,
    width: 13,
  },
  subtitle: { fontSize: 12, lineHeight: 16 },
  title: { fontSize: 24, fontWeight: "800", letterSpacing: -0.6 },
});
