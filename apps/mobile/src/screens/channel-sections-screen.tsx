import { Ionicons } from "@expo/vector-icons";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { useEffect, useState } from "react";
import {
  Alert,
  FlatList,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";

import type { RootStackParams } from "../navigation/types";
import type { ChannelSection } from "../services/client-local-state";
import { useClientState } from "../state/client-state";
import { Header, IconButton, Page } from "../ui/components";
import { useBuzzTheme } from "../ui/theme";

type Props = NativeStackScreenProps<RootStackParams, "ChannelSections">;

export function ChannelSectionsScreen({ navigation }: Props) {
  const theme = useBuzzTheme();
  const sections = useClientState((state) => state.sections);
  const channels = useClientState((state) => state.channels);
  const setSections = useClientState((state) => state.setSections);
  const [name, setName] = useState("");
  const sorted = [...sections].sort((left, right) => left.order - right.order);

  const create = () => {
    const normalized = name.trim();
    if (!normalized) return;
    setSections([
      ...sorted,
      {
        id: crypto.randomUUID(),
        name: normalized,
        order: sorted.length,
      },
    ]);
    setName("");
  };
  const update = (section: ChannelSection) =>
    setSections(
      sorted.map((item) => (item.id === section.id ? section : item)),
    );
  const move = (section: ChannelSection, direction: -1 | 1) => {
    const index = sorted.findIndex((item) => item.id === section.id);
    const targetIndex = index + direction;
    const target = sorted[targetIndex];
    if (index < 0 || !target) return;
    setSections(
      sorted.map((item) =>
        item.id === section.id
          ? { ...item, order: target.order }
          : item.id === target.id
            ? { ...item, order: section.order }
            : item,
      ),
    );
  };

  return (
    <Page>
      <Header
        eyebrow="Encrypted sync"
        left={
          <IconButton
            icon="chevron-back"
            label="Back"
            onPress={() => navigation.goBack()}
          />
        }
        subtitle="Private groups shared across your signed-in devices"
        title="Channel sections"
      />
      <View style={styles.add}>
        <TextInput
          maxLength={128}
          placeholder="New section name"
          placeholderTextColor={theme.colors.faint}
          returnKeyType="done"
          style={[
            styles.input,
            {
              backgroundColor: theme.colors.elevated,
              borderColor: theme.colors.border,
              color: theme.colors.text,
              fontFamily: "Inter",
            },
          ]}
          value={name}
          onChangeText={setName}
          onSubmitEditing={create}
        />
        <IconButton
          disabled={!name.trim()}
          icon="add"
          label="Create section"
          onPress={create}
        />
      </View>
      <FlatList
        contentContainerStyle={styles.list}
        data={sorted}
        keyExtractor={(item) => item.id}
        ListEmptyComponent={
          <View style={styles.empty}>
            <Ionicons
              color={theme.colors.faint}
              name="albums-outline"
              size={30}
            />
            <Text
              style={{
                color: theme.colors.muted,
                fontFamily: "Inter",
                textAlign: "center",
              }}
            >
              Create sections for projects, teams, or any channel grouping that
              helps you focus.
            </Text>
          </View>
        }
        renderItem={({ item, index }) => (
          <SectionEditor
            assignedCount={
              Object.values(channels).filter(
                (channel) => channel.sectionId === item.id,
              ).length
            }
            canMoveDown={index < sorted.length - 1}
            canMoveUp={index > 0}
            section={item}
            onDelete={() =>
              Alert.alert(
                `Delete ${item.name}?`,
                "Channels in this section will return to the default group.",
                [
                  { style: "cancel", text: "Cancel" },
                  {
                    onPress: () =>
                      setSections(
                        sorted.filter((section) => section.id !== item.id),
                      ),
                    style: "destructive",
                    text: "Delete",
                  },
                ],
              )
            }
            onMoveDown={() => move(item, 1)}
            onMoveUp={() => move(item, -1)}
            onUpdate={update}
          />
        )}
      />
    </Page>
  );
}

function SectionEditor({
  section,
  assignedCount,
  canMoveUp,
  canMoveDown,
  onUpdate,
  onMoveUp,
  onMoveDown,
  onDelete,
}: {
  readonly section: ChannelSection;
  readonly assignedCount: number;
  readonly canMoveUp: boolean;
  readonly canMoveDown: boolean;
  readonly onUpdate: (section: ChannelSection) => void;
  readonly onMoveUp: () => void;
  readonly onMoveDown: () => void;
  readonly onDelete: () => void;
}) {
  const theme = useBuzzTheme();
  const [name, setName] = useState(section.name);
  useEffect(() => setName(section.name), [section.name]);
  const save = () => {
    const normalized = name.trim();
    if (normalized && normalized !== section.name) {
      onUpdate({ ...section, name: normalized });
    } else {
      setName(section.name);
    }
  };
  return (
    <View
      style={[
        styles.row,
        {
          backgroundColor: theme.colors.surface,
          borderColor: theme.colors.border,
        },
      ]}
    >
      <View style={styles.copy}>
        <TextInput
          maxLength={128}
          style={{
            color: theme.colors.text,
            fontFamily: "Inter",
            fontSize: 14,
            fontWeight: "700",
            padding: 0,
          }}
          value={name}
          onBlur={save}
          onChangeText={setName}
          onSubmitEditing={save}
        />
        <Text
          style={{
            color: theme.colors.faint,
            fontFamily: "GeistMono",
            fontSize: 9,
          }}
        >
          {assignedCount} {assignedCount === 1 ? "channel" : "channels"}
        </Text>
      </View>
      <SmallAction
        disabled={!canMoveUp}
        icon="arrow-up"
        label="Move up"
        onPress={onMoveUp}
      />
      <SmallAction
        disabled={!canMoveDown}
        icon="arrow-down"
        label="Move down"
        onPress={onMoveDown}
      />
      <SmallAction
        color={theme.colors.danger}
        icon="trash-outline"
        label="Delete"
        onPress={onDelete}
      />
    </View>
  );
}

function SmallAction({
  icon,
  label,
  onPress,
  color,
  disabled,
}: {
  readonly icon: React.ComponentProps<typeof Ionicons>["name"];
  readonly label: string;
  readonly onPress: () => void;
  readonly color?: string;
  readonly disabled?: boolean;
}) {
  const theme = useBuzzTheme();
  return (
    <Pressable
      accessibilityLabel={label}
      disabled={disabled}
      hitSlop={6}
      style={{ opacity: disabled ? 0.28 : 1 }}
      onPress={onPress}
    >
      <Ionicons color={color ?? theme.colors.muted} name={icon} size={18} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  add: {
    alignItems: "center",
    flexDirection: "row",
    gap: 8,
    padding: 12,
  },
  copy: { flex: 1, gap: 3 },
  empty: {
    alignItems: "center",
    flex: 1,
    gap: 12,
    justifyContent: "center",
    padding: 40,
  },
  input: {
    borderRadius: 13,
    borderWidth: StyleSheet.hairlineWidth,
    flex: 1,
    fontSize: 14,
    minHeight: 44,
    paddingHorizontal: 12,
  },
  list: { flexGrow: 1, gap: 8, padding: 12, paddingBottom: 42 },
  row: {
    alignItems: "center",
    borderRadius: 15,
    borderWidth: StyleSheet.hairlineWidth,
    flexDirection: "row",
    gap: 12,
    padding: 12,
  },
});
