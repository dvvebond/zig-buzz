import AsyncStorage from "@react-native-async-storage/async-storage";
import type { RelayConnectionState } from "../services/mobile-relay";
import { create } from "zustand";

import type { Community } from "../domain/models";
import {
  CommunityStorage,
  createCommunity,
  decodeNsec,
} from "../services/community-storage";

export type ThemeMode = "system" | "light" | "dark";

type AppState = {
  readonly ready: boolean;
  readonly busy: boolean;
  readonly communities: readonly Community[];
  readonly active: Community | undefined;
  readonly connection: RelayConnectionState;
  readonly themeMode: ThemeMode;
  readonly accent: string;
  readonly error: string | undefined;
  initialize(): Promise<void>;
  authenticate(input: {
    readonly relayUrl: string;
    readonly nsec: string;
    readonly name?: string;
  }): Promise<void>;
  switchCommunity(id: string): Promise<void>;
  removeCommunity(id: string): Promise<void>;
  renameCommunity(id: string, name: string): Promise<void>;
  setConnection(connection: RelayConnectionState): void;
  setThemeMode(mode: ThemeMode): Promise<void>;
  setAccent(accent: string): Promise<void>;
  clearError(): void;
};

const storage = new CommunityStorage();
const PREFERENCES_KEY = "buzz.mobile.preferences.v2";
const ACCENTS = new Set([
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
]);

export const useAppStore = create<AppState>((set, get) => ({
  accent: "#f5a524",
  active: undefined,
  busy: false,
  communities: [],
  connection: "idle",
  error: undefined,
  ready: false,
  themeMode: "system",

  async initialize() {
    if (get().ready) return;
    set({ busy: true, error: undefined });
    try {
      const [all, activeId, preferences] = await Promise.all([
        storage.loadAll(),
        storage.activeId(),
        readPreferences(),
      ]);
      const valid: Community[] = [];
      for (const community of all) {
        const nsec = await storage.secret(community.id);
        const decoded = nsec ? decodeNsec(nsec) : undefined;
        if (decoded?.pubkey === community.pubkey) valid.push(community);
        else await storage.remove(community.id);
        decoded?.secretKey.fill(0);
      }
      const active =
        valid.find((item) => item.id === activeId) ?? valid[0] ?? undefined;
      if (active) await storage.setActive(active.id);
      else await storage.clearActive();
      set({
        accent: preferences.accent,
        active,
        busy: false,
        communities: valid,
        ready: true,
        themeMode: preferences.themeMode,
      });
    } catch (error) {
      set({
        busy: false,
        error: safeMessage(error, "Could not restore Buzz"),
        ready: true,
      });
    }
  },

  async authenticate(input) {
    set({ busy: true, error: undefined });
    try {
      const community = createCommunity(input);
      await storage.save(community, input.nsec);
      await storage.setActive(community.id);
      const communities = [
        ...get().communities.filter((item) => item.id !== community.id),
        community,
      ];
      set({ active: community, busy: false, communities });
    } catch (error) {
      const message = safeMessage(error, "Could not add community");
      set({ busy: false, error: message });
      throw new Error(message);
    }
  },

  async switchCommunity(id) {
    const community = get().communities.find((item) => item.id === id);
    if (!community) throw new Error("community not found");
    const nsec = await storage.secret(id);
    const decoded = nsec ? decodeNsec(nsec) : undefined;
    if (!decoded || decoded.pubkey !== community.pubkey) {
      decoded?.secretKey.fill(0);
      await storage.remove(id);
      set({
        communities: get().communities.filter((item) => item.id !== id),
        error: "This community no longer has a usable device key.",
      });
      return;
    }
    decoded.secretKey.fill(0);
    await storage.setActive(id);
    set({ active: community, connection: "idle", error: undefined });
  },

  async removeCommunity(id) {
    await storage.remove(id);
    const communities = get().communities.filter((item) => item.id !== id);
    const active = get().active?.id === id ? communities[0] : get().active;
    if (active) await storage.setActive(active.id);
    else await storage.clearActive();
    set({
      active,
      communities,
      connection: "idle",
    });
  },

  async renameCommunity(id, name) {
    await storage.rename(id, name);
    const communities = get().communities.map((item) =>
      item.id === id ? { ...item, name: name.trim() } : item,
    );
    set({
      active:
        get().active?.id === id
          ? communities.find((item) => item.id === id)
          : get().active,
      communities,
    });
  },

  setConnection(connection) {
    set({ connection });
  },

  async setThemeMode(themeMode) {
    set({ themeMode });
    await writePreferences(themeMode, get().accent);
  },

  async setAccent(accent) {
    if (!ACCENTS.has(accent)) throw new TypeError("unsupported accent color");
    set({ accent });
    await writePreferences(get().themeMode, accent);
  },

  clearError() {
    set({ error: undefined });
  },
}));

export async function activeSecret(
  community: Community,
): Promise<{ readonly nsec: string; readonly secretKey: Uint8Array }> {
  const nsec = await storage.secret(community.id);
  const decoded = nsec ? decodeNsec(nsec) : undefined;
  if (!nsec || !decoded || decoded.pubkey !== community.pubkey) {
    decoded?.secretKey.fill(0);
    throw new Error("community identity is unavailable");
  }
  return { nsec, secretKey: decoded.secretKey };
}

async function readPreferences(): Promise<{
  readonly themeMode: ThemeMode;
  readonly accent: string;
}> {
  const fallback = {
    accent: "#f5a524",
    themeMode: "system" as const,
  };
  const raw = await AsyncStorage.getItem(PREFERENCES_KEY);
  if (!raw || raw.length > 4_096) return fallback;
  try {
    const value = JSON.parse(raw) as {
      readonly themeMode?: unknown;
      readonly accent?: unknown;
    };
    const themeMode =
      value.themeMode === "light" ||
      value.themeMode === "dark" ||
      value.themeMode === "system"
        ? value.themeMode
        : fallback.themeMode;
    const accent =
      typeof value.accent === "string" && ACCENTS.has(value.accent)
        ? value.accent
        : fallback.accent;
    return { accent, themeMode };
  } catch {
    return fallback;
  }
}

async function writePreferences(
  themeMode: ThemeMode,
  accent: string,
): Promise<void> {
  await AsyncStorage.setItem(
    PREFERENCES_KEY,
    JSON.stringify({ accent, themeMode }),
  );
}

function safeMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.length <= 512
    ? error.message
    : fallback;
}
