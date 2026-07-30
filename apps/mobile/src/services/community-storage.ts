import AsyncStorage from "@react-native-async-storage/async-storage";
import * as SecureStore from "expo-secure-store";
import { Platform } from "react-native";
import { nip19 } from "nostr-tools";
import { getPublicKey } from "nostr-tools/pure";

import type { Community } from "../domain/models";
import { validateRelayUrl } from "../domain/deep-links";

const COMMUNITIES_KEY = "buzz.mobile.communities.v2";
const ACTIVE_KEY = "buzz.mobile.active-community.v2";
const SECRET_PREFIX = "buzz.mobile.nsec.";
const LEGACY_COMMUNITIES = ["buzz_communities", "buzz_workspaces"] as const;
const MAX_COMMUNITIES = 100;
const memorySecrets = new Map<string, string>();

type LegacyCommunity = {
  readonly id?: unknown;
  readonly name?: unknown;
  readonly relayUrl?: unknown;
  readonly pubkey?: unknown;
  readonly nsec?: unknown;
  readonly addedAt?: unknown;
};

export class CommunityStorage {
  public async loadAll(): Promise<readonly Community[]> {
    await this.#migrateLegacy();
    return parseCommunities(await AsyncStorage.getItem(COMMUNITIES_KEY));
  }

  public async activeId(): Promise<string | undefined> {
    const value = await AsyncStorage.getItem(ACTIVE_KEY);
    return value && value.length <= 128 ? value : undefined;
  }

  public async setActive(id: string): Promise<void> {
    assertId(id);
    await AsyncStorage.setItem(ACTIVE_KEY, id);
  }

  public async clearActive(): Promise<void> {
    await AsyncStorage.removeItem(ACTIVE_KEY);
  }

  public async secret(id: string): Promise<string | undefined> {
    assertId(id);
    const value =
      Platform.OS === "web"
        ? memorySecrets.get(id)
        : ((await SecureStore.getItemAsync(`${SECRET_PREFIX}${id}`)) ??
          undefined);
    const decoded = value ? decodeNsec(value) : undefined;
    decoded?.secretKey.fill(0);
    return decoded ? value : undefined;
  }

  public async save(community: Community, nsec: string): Promise<void> {
    const validated = validateCommunity(community);
    const decoded = decodeNsec(nsec);
    if (!decoded) throw new TypeError("invalid Nostr secret");
    decoded.secretKey.fill(0);
    const all = [...(await this.loadAll())];
    const index = all.findIndex((item) => item.id === validated.id);
    if (index >= 0) all[index] = validated;
    else {
      if (all.length >= MAX_COMMUNITIES) {
        throw new RangeError("community limit reached");
      }
      all.push(validated);
    }
    await this.#writeSecret(validated.id, nsec);
    await AsyncStorage.setItem(COMMUNITIES_KEY, JSON.stringify(all));
  }

  public async rename(id: string, name: string): Promise<void> {
    const bounded = name.trim();
    if (!bounded || bounded.length > 128) {
      throw new TypeError("community name must contain 1-128 characters");
    }
    const all = [...(await this.loadAll())];
    const index = all.findIndex((item) => item.id === id);
    const existing = all[index];
    if (!existing) throw new Error("community not found");
    all[index] = { ...existing, name: bounded };
    await AsyncStorage.setItem(COMMUNITIES_KEY, JSON.stringify(all));
  }

  public async remove(id: string): Promise<void> {
    assertId(id);
    const all = (await this.loadAll()).filter((item) => item.id !== id);
    await AsyncStorage.setItem(COMMUNITIES_KEY, JSON.stringify(all));
    if ((await this.activeId()) === id) await this.clearActive();
    memorySecrets.delete(id);
    if (Platform.OS !== "web") {
      await SecureStore.deleteItemAsync(`${SECRET_PREFIX}${id}`);
    }
  }

  async #writeSecret(id: string, nsec: string): Promise<void> {
    if (Platform.OS === "web") {
      // Web builds deliberately keep durable identity material in memory only.
      // A reload requires pairing again instead of persisting an nsec in DOM
      // storage that any same-origin script could read.
      memorySecrets.set(id, nsec);
      return;
    }
    await SecureStore.setItemAsync(`${SECRET_PREFIX}${id}`, nsec, {
      keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
    });
  }

  async #migrateLegacy(): Promise<void> {
    if (await AsyncStorage.getItem(COMMUNITIES_KEY)) return;
    if (Platform.OS === "web") return;

    for (const key of LEGACY_COMMUNITIES) {
      const raw = await SecureStore.getItemAsync(key).catch(() => null);
      if (!raw || raw.length > 256 * 1024) continue;
      let decoded: unknown;
      try {
        decoded = JSON.parse(raw) as unknown;
      } catch {
        continue;
      }
      if (!Array.isArray(decoded)) continue;
      const migrated: Community[] = [];
      for (const value of decoded.slice(0, MAX_COMMUNITIES)) {
        if (!isRecord(value)) continue;
        const legacy = value as LegacyCommunity;
        const nsec = typeof legacy.nsec === "string" ? legacy.nsec : undefined;
        const community = legacyCommunity(legacy);
        if (!nsec || !community || !decodeNsec(nsec)) continue;
        await this.#writeSecret(community.id, nsec);
        migrated.push(community);
      }
      if (migrated.length > 0) {
        await AsyncStorage.setItem(COMMUNITIES_KEY, JSON.stringify(migrated));
        const legacyActive =
          (await SecureStore.getItemAsync("buzz_active_community_id").catch(
            () => null,
          )) ??
          (await SecureStore.getItemAsync("buzz_active_workspace_id").catch(
            () => null,
          ));
        const active = migrated.some((item) => item.id === legacyActive)
          ? legacyActive
          : migrated[0]?.id;
        if (active) await this.setActive(active);
      }
      await SecureStore.deleteItemAsync(key).catch(() => undefined);
      return;
    }
  }
}

export function createCommunity(input: {
  readonly name?: string;
  readonly relayUrl: string;
  readonly nsec: string;
}): Community {
  const secret = decodeNsec(input.nsec);
  if (!secret) throw new TypeError("pairing payload contains an invalid nsec");
  const relayUrl = normalizeRelayInput(input.relayUrl);
  const url = new URL(relayUrl);
  const name =
    input.name?.trim() ||
    (url.hostname === "localhost" || url.hostname.startsWith("127.")
      ? "Local Dev"
      : (url.hostname.split(".")[0] ?? "Community"));
  const community = validateCommunity({
    createdAt: Date.now(),
    id: crypto.randomUUID(),
    name,
    pubkey: secret.pubkey,
    relayUrl,
  });
  secret.secretKey.fill(0);
  return community;
}

export function decodeNsec(
  value: string,
): { readonly secretKey: Uint8Array; readonly pubkey: string } | undefined {
  try {
    const decoded = nip19.decode(value);
    if (decoded.type !== "nsec" || !(decoded.data instanceof Uint8Array)) {
      return undefined;
    }
    if (
      decoded.data.byteLength !== 32 ||
      decoded.data.every((byte) => byte === 0)
    ) {
      decoded.data.fill(0);
      return undefined;
    }
    const secretKey = Uint8Array.from(decoded.data);
    decoded.data.fill(0);
    return { pubkey: getPublicKey(secretKey), secretKey };
  } catch {
    return undefined;
  }
}

export function normalizeRelayInput(value: string): string {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new TypeError("relay URL is invalid");
  }
  if (url.protocol === "https:") url.protocol = "wss:";
  else if (url.protocol === "http:") url.protocol = "ws:";
  const normalized = validateRelayUrl(
    url.toString(),
    typeof __DEV__ !== "undefined" && __DEV__,
  );
  if (!normalized) {
    throw new TypeError(
      "relay must use WSS and may not target a private network address",
    );
  }
  return normalized;
}

function validateCommunity(value: Community): Community {
  assertId(value.id);
  const relayUrl = normalizeRelayInput(value.relayUrl);
  if (!/^[0-9a-f]{64}$/.test(value.pubkey)) {
    throw new TypeError("community public key is invalid");
  }
  const name = value.name.trim();
  if (!name || name.length > 128) {
    throw new TypeError("community name is invalid");
  }
  if (
    !Number.isSafeInteger(value.createdAt) ||
    value.createdAt < 0 ||
    value.createdAt > Date.now() + 60_000
  ) {
    throw new TypeError("community creation timestamp is invalid");
  }
  return { ...value, name, relayUrl };
}

function parseCommunities(raw: string | null): readonly Community[] {
  if (!raw || raw.length > 256 * 1024) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .slice(0, MAX_COMMUNITIES)
      .filter(isRecord)
      .flatMap((value) => {
        try {
          return [validateCommunity(value as Community)];
        } catch {
          return [];
        }
      });
  } catch {
    return [];
  }
}

function legacyCommunity(value: LegacyCommunity): Community | undefined {
  if (
    typeof value.id !== "string" ||
    typeof value.name !== "string" ||
    typeof value.relayUrl !== "string" ||
    typeof value.pubkey !== "string"
  ) {
    return undefined;
  }
  const createdAt =
    typeof value.addedAt === "string"
      ? Date.parse(value.addedAt)
      : typeof value.addedAt === "number"
        ? value.addedAt
        : Date.now();
  try {
    return validateCommunity({
      createdAt,
      id: value.id,
      name: value.name,
      pubkey: value.pubkey,
      relayUrl: value.relayUrl,
    });
  } catch {
    return undefined;
  }
}

function assertId(value: string): void {
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(value)) {
    throw new TypeError("community ID is invalid");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
