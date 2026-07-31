import AsyncStorage from "@react-native-async-storage/async-storage";

import type { Community } from "../domain/models";

const KEY_PREFIX = "buzz.mobile.client-state.v1";
const MAX_BYTES = 512 * 1024;
const MAX_CHANNELS = 2_000;
const MAX_SECTIONS = 50;
const MAX_FOLLOWS = 500;
const MAX_DRAFTS = 50;
const MAX_INBOX_IDS = 2_000;
const HEX_64 = /^[0-9a-f]{64}$/;

export type ChannelLocalState = {
  readonly starred: boolean;
  readonly muted: boolean;
  readonly updatedAt: number;
  readonly sectionId?: string;
};

export type ChannelSection = {
  readonly id: string;
  readonly name: string;
  readonly icon?: string;
  readonly order: number;
};

export type ThreadFollow = {
  readonly rootId: string;
  readonly followedAt: number;
};

export type ComposeDraft = {
  readonly key: string;
  readonly channelId: string;
  readonly threadRootId?: string;
  readonly text: string;
  readonly updatedAt: number;
};

export type ReadMarker = {
  readonly createdAt: number;
  readonly eventId?: string;
};

export type ClientLocalState = {
  readonly version: 1;
  readonly channels: Readonly<Record<string, ChannelLocalState>>;
  readonly sections: readonly ChannelSection[];
  readonly follows: readonly ThreadFollow[];
  readonly drafts: readonly ComposeDraft[];
  readonly inboxDoneIds: readonly string[];
  readonly inboxUnreadIds: readonly string[];
  readonly readMarkers: Readonly<Record<string, ReadMarker>>;
};

export type ChannelSectionEnvelope = {
  readonly version: 1;
  readonly sections: readonly ChannelSection[];
  readonly assignments: Readonly<Record<string, string>>;
};

export const EMPTY_CLIENT_STATE: ClientLocalState = {
  channels: {},
  drafts: [],
  follows: [],
  inboxDoneIds: [],
  inboxUnreadIds: [],
  readMarkers: {},
  sections: [],
  version: 1,
};

export class ClientLocalStateStorage {
  public async read(community: Community): Promise<ClientLocalState> {
    return parseClientLocalState(
      await AsyncStorage.getItem(storageKey(community)),
    );
  }

  public async write(
    community: Community,
    state: ClientLocalState,
  ): Promise<void> {
    const normalized = normalizeClientLocalState(state);
    const encoded = JSON.stringify(normalized);
    if (new TextEncoder().encode(encoded).byteLength > MAX_BYTES) {
      throw new RangeError("local client state exceeds its storage budget");
    }
    await AsyncStorage.setItem(storageKey(community), encoded);
  }

  public async remove(community: Community): Promise<void> {
    await AsyncStorage.removeItem(storageKey(community));
  }
}

export function parseClientLocalState(raw: string | null): ClientLocalState {
  if (!raw || new TextEncoder().encode(raw).byteLength > MAX_BYTES) {
    return EMPTY_CLIENT_STATE;
  }
  try {
    const value = JSON.parse(raw) as unknown;
    return isRecord(value) && value.version === 1
      ? normalizeClientLocalState(value)
      : EMPTY_CLIENT_STATE;
  } catch {
    return EMPTY_CLIENT_STATE;
  }
}

export function normalizeClientLocalState(value: unknown): ClientLocalState {
  if (!isRecord(value)) return EMPTY_CLIENT_STATE;

  const channels: Record<string, ChannelLocalState> = {};
  if (isRecord(value.channels)) {
    for (const [channelId, raw] of Object.entries(value.channels).slice(
      0,
      MAX_CHANNELS,
    )) {
      if (!validKey(channelId) || !isRecord(raw)) continue;
      const updatedAt = nonNegativeInteger(raw.updatedAt);
      if (
        updatedAt === undefined ||
        typeof raw.starred !== "boolean" ||
        typeof raw.muted !== "boolean"
      ) {
        continue;
      }
      const sectionId = validKey(raw.sectionId) ? raw.sectionId : undefined;
      channels[channelId] = {
        muted: raw.muted,
        starred: raw.starred,
        updatedAt,
        ...(sectionId ? { sectionId } : {}),
      };
    }
  }

  const sections = Array.isArray(value.sections)
    ? value.sections
        .slice(0, MAX_SECTIONS)
        .flatMap((raw): ChannelSection[] => {
          if (!isRecord(raw)) return [];
          const id = validKey(raw.id) ? raw.id : undefined;
          const name = boundedText(raw.name, 128);
          const order = nonNegativeInteger(raw.order);
          const icon = boundedText(raw.icon, 32);
          return id && name && order !== undefined
            ? [{ id, name, order, ...(icon ? { icon } : {}) }]
            : [];
        })
        .filter(
          (section, index, all) =>
            all.findIndex((item) => item.id === section.id) === index,
        )
        .sort((left, right) => left.order - right.order)
    : [];
  const sectionIds = new Set(sections.map((section) => section.id));
  for (const [channelId, state] of Object.entries(channels)) {
    if (state.sectionId && !sectionIds.has(state.sectionId)) {
      channels[channelId] = {
        muted: state.muted,
        starred: state.starred,
        updatedAt: state.updatedAt,
      };
    }
  }

  const follows = Array.isArray(value.follows)
    ? value.follows
        .flatMap((raw): ThreadFollow[] => {
          if (!isRecord(raw) || !HEX_64.test(String(raw.rootId))) return [];
          const followedAt = nonNegativeInteger(raw.followedAt);
          return followedAt === undefined
            ? []
            : [{ followedAt, rootId: String(raw.rootId) }];
        })
        .sort((left, right) => right.followedAt - left.followedAt)
        .filter(
          (follow, index, all) =>
            all.findIndex((item) => item.rootId === follow.rootId) === index,
        )
        .slice(0, MAX_FOLLOWS)
    : [];

  const drafts = Array.isArray(value.drafts)
    ? value.drafts
        .flatMap((raw): ComposeDraft[] => {
          if (!isRecord(raw)) return [];
          const key = validKey(raw.key) ? raw.key : undefined;
          const channelId = validKey(raw.channelId) ? raw.channelId : undefined;
          const text = boundedText(raw.text, 65_536, false);
          const updatedAt = nonNegativeInteger(raw.updatedAt);
          const threadRootId =
            typeof raw.threadRootId === "string" &&
            HEX_64.test(raw.threadRootId)
              ? raw.threadRootId
              : undefined;
          return key && channelId && text?.trim() && updatedAt !== undefined
            ? [
                {
                  channelId,
                  key,
                  text,
                  updatedAt,
                  ...(threadRootId ? { threadRootId } : {}),
                },
              ]
            : [];
        })
        .sort((left, right) => right.updatedAt - left.updatedAt)
        .filter(
          (draft, index, all) =>
            all.findIndex((item) => item.key === draft.key) === index,
        )
        .slice(0, MAX_DRAFTS)
    : [];

  const inboxDoneIds = parseIdList(value.inboxDoneIds, MAX_INBOX_IDS);
  const inboxUnreadIds = parseIdList(
    value.inboxUnreadIds,
    MAX_INBOX_IDS,
  ).filter((id) => !inboxDoneIds.includes(id));

  const readMarkers: Record<string, ReadMarker> = {};
  if (isRecord(value.readMarkers)) {
    for (const [context, raw] of Object.entries(value.readMarkers).slice(
      0,
      MAX_CHANNELS,
    )) {
      if (!validKey(context) || !isRecord(raw)) continue;
      const createdAt = nonNegativeInteger(raw.createdAt);
      const eventId =
        typeof raw.eventId === "string" && HEX_64.test(raw.eventId)
          ? raw.eventId
          : undefined;
      if (createdAt !== undefined) {
        readMarkers[context] = {
          createdAt,
          ...(eventId ? { eventId } : {}),
        };
      }
    }
  }

  return {
    channels,
    drafts,
    follows,
    inboxDoneIds,
    inboxUnreadIds,
    readMarkers,
    sections,
    version: 1,
  };
}

export function parseChannelSectionEnvelope(
  value: unknown,
): ChannelSectionEnvelope | undefined {
  if (!isRecord(value) || value.version !== 1) return undefined;
  const sections = Array.isArray(value.sections)
    ? value.sections
        .slice(0, MAX_SECTIONS)
        .flatMap((raw): ChannelSection[] => {
          if (!isRecord(raw)) return [];
          const id = validKey(raw.id) ? raw.id : undefined;
          const name = boundedText(raw.name, 128);
          const order = nonNegativeInteger(raw.order);
          const icon = boundedText(raw.icon, 32);
          return id && name && order !== undefined
            ? [{ id, name, order, ...(icon ? { icon } : {}) }]
            : [];
        })
        .filter(
          (section, index, all) =>
            all.findIndex((item) => item.id === section.id) === index,
        )
        .sort((left, right) => left.order - right.order)
    : [];
  const sectionIds = new Set(sections.map((section) => section.id));
  const assignments: Record<string, string> = {};
  if (isRecord(value.assignments)) {
    for (const [channelId, sectionId] of Object.entries(
      value.assignments,
    ).slice(0, MAX_CHANNELS)) {
      if (
        validKey(channelId) &&
        validKey(sectionId) &&
        sectionIds.has(sectionId)
      ) {
        assignments[channelId] = sectionId;
      }
    }
  }
  return { assignments, sections, version: 1 };
}

export function mergeChannelLocalStates(
  local: Readonly<Record<string, ChannelLocalState>>,
  remote: Readonly<Record<string, ChannelLocalState>>,
): Readonly<Record<string, ChannelLocalState>> {
  const merged: Record<string, ChannelLocalState> = { ...local };
  for (const [channelId, value] of Object.entries(remote)) {
    const current = merged[channelId];
    if (
      !current ||
      value.updatedAt > current.updatedAt ||
      (value.updatedAt === current.updatedAt &&
        JSON.stringify(value) < JSON.stringify(current))
    ) {
      merged[channelId] = value;
    }
  }
  return merged;
}

function storageKey(community: Community): string {
  return `${KEY_PREFIX}:${community.id}:${community.pubkey}`;
}

function parseIdList(value: unknown, maximum: number): string[] {
  if (!Array.isArray(value)) return [];
  return [
    ...new Set(
      value.filter(
        (item): item is string =>
          typeof item === "string" && /^[A-Za-z0-9:._-]{1,256}$/.test(item),
      ),
    ),
  ].slice(-maximum);
}

function validKey(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9:._-]{1,256}$/.test(value);
}

function boundedText(
  value: unknown,
  maximum: number,
  trim = true,
): string | undefined {
  if (typeof value !== "string" || value.length > maximum) return undefined;
  const result = trim ? value.trim() : value;
  return result.length > 0 ? result : undefined;
}

function nonNegativeInteger(value: unknown): number | undefined {
  return Number.isSafeInteger(value) && Number(value) >= 0
    ? Number(value)
    : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
