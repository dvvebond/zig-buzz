import { create } from "zustand";

import type { Community } from "../domain/models";
import {
  ClientLocalStateStorage,
  EMPTY_CLIENT_STATE,
  type ChannelLocalState,
  type ChannelSection,
  type ComposeDraft,
  type ReadMarker,
  type ThreadFollow,
} from "../services/client-local-state";

type ClientState = {
  readonly ready: boolean;
  readonly community: Community | undefined;
  readonly channels: Readonly<Record<string, ChannelLocalState>>;
  readonly sections: readonly ChannelSection[];
  readonly follows: readonly ThreadFollow[];
  readonly drafts: readonly ComposeDraft[];
  readonly inboxDoneIds: readonly string[];
  readonly inboxUnreadIds: readonly string[];
  readonly readMarkers: Readonly<Record<string, ReadMarker>>;
  initialize(community: Community): Promise<void>;
  toggleStar(channelId: string): void;
  toggleMute(channelId: string): void;
  assignSection(channelId: string, sectionId?: string): void;
  setSections(sections: readonly ChannelSection[]): void;
  replaceSections(
    sections: readonly ChannelSection[],
    assignments: Readonly<Record<string, string>>,
  ): void;
  followThread(rootId: string, followed: boolean): void;
  saveDraft(input: Omit<ComposeDraft, "updatedAt">): void;
  removeDraft(key: string): void;
  setReadMarker(context: string, marker: ReadMarker): void;
  markInboxDone(id: string): void;
  markInboxUnread(ids: readonly string[]): void;
  clearInboxUnread(ids: readonly string[]): void;
};

const storage = new ClientLocalStateStorage();
let writeQueue = Promise.resolve();

export const useClientState = create<ClientState>((set, get) => ({
  channels: EMPTY_CLIENT_STATE.channels,
  community: undefined,
  drafts: EMPTY_CLIENT_STATE.drafts,
  follows: EMPTY_CLIENT_STATE.follows,
  inboxDoneIds: EMPTY_CLIENT_STATE.inboxDoneIds,
  inboxUnreadIds: EMPTY_CLIENT_STATE.inboxUnreadIds,
  readMarkers: EMPTY_CLIENT_STATE.readMarkers,
  ready: false,
  sections: EMPTY_CLIENT_STATE.sections,

  async initialize(community) {
    const key = identityKey(community);
    set({
      channels: {},
      community,
      drafts: [],
      follows: [],
      inboxDoneIds: [],
      inboxUnreadIds: [],
      readMarkers: {},
      ready: false,
      sections: [],
    });
    const value = await storage.read(community);
    if (identityKey(get().community) !== key) return;
    set({ ...value, ready: true });
  },

  toggleStar(channelId) {
    updateChannel(channelId, (current) => ({
      ...current,
      starred: !current.starred,
    }));
  },

  toggleMute(channelId) {
    updateChannel(channelId, (current) => ({
      ...current,
      muted: !current.muted,
    }));
  },

  assignSection(channelId, sectionId) {
    if (
      sectionId !== undefined &&
      !get().sections.some((section) => section.id === sectionId)
    ) {
      throw new Error("channel section does not exist");
    }
    updateChannel(channelId, (current) => ({
      muted: current.muted,
      starred: current.starred,
      updatedAt: current.updatedAt,
      ...(sectionId ? { sectionId } : {}),
    }));
  },

  setSections(sections) {
    const ids = new Set(sections.map((section) => section.id));
    const channels = Object.fromEntries(
      Object.entries(get().channels).map(([channelId, value]) => [
        channelId,
        value.sectionId && !ids.has(value.sectionId)
          ? {
              muted: value.muted,
              starred: value.starred,
              updatedAt: Date.now(),
            }
          : value,
      ]),
    );
    set({ channels, sections: [...sections] });
    persist();
  },

  replaceSections(sections, assignments) {
    const sectionIds = new Set(sections.map((section) => section.id));
    const channels: Record<string, ChannelLocalState> = {};
    const now = Date.now();
    for (const [channelId, value] of Object.entries(get().channels)) {
      const sectionId = assignments[channelId];
      channels[channelId] = {
        muted: value.muted,
        starred: value.starred,
        updatedAt: value.updatedAt,
        ...(sectionId && sectionIds.has(sectionId) ? { sectionId } : {}),
      };
    }
    for (const [channelId, sectionId] of Object.entries(assignments)) {
      if (channels[channelId] || !sectionIds.has(sectionId)) continue;
      channels[channelId] = {
        muted: false,
        sectionId,
        starred: false,
        updatedAt: now,
      };
    }
    set({ channels, sections: [...sections] });
    persist();
  },

  followThread(rootId, followed) {
    const without = get().follows.filter((item) => item.rootId !== rootId);
    const follows = followed
      ? [{ followedAt: Date.now(), rootId }, ...without].slice(0, 500)
      : without;
    set({ follows });
    persist();
  },

  saveDraft(input) {
    const without = get().drafts.filter((draft) => draft.key !== input.key);
    if (!input.text.trim()) {
      set({ drafts: without });
    } else {
      set({
        drafts: [{ ...input, updatedAt: Date.now() }, ...without].slice(0, 50),
      });
    }
    persist();
  },

  removeDraft(key) {
    set({ drafts: get().drafts.filter((draft) => draft.key !== key) });
    persist();
  },

  setReadMarker(context, marker) {
    const current = get().readMarkers[context];
    if (current && current.createdAt > marker.createdAt) return;
    set({
      readMarkers: { ...get().readMarkers, [context]: marker },
    });
    persist();
  },

  markInboxDone(id) {
    set({
      inboxDoneIds: capIds([...get().inboxDoneIds, id]),
      inboxUnreadIds: get().inboxUnreadIds.filter((item) => item !== id),
    });
    persist();
  },

  markInboxUnread(ids) {
    const marked = new Set(ids);
    set({
      inboxDoneIds: get().inboxDoneIds.filter((id) => !marked.has(id)),
      inboxUnreadIds: capIds([...get().inboxUnreadIds, ...ids]),
    });
    persist();
  },

  clearInboxUnread(ids) {
    const cleared = new Set(ids);
    set({
      inboxUnreadIds: get().inboxUnreadIds.filter((id) => !cleared.has(id)),
    });
    persist();
  },
}));

function updateChannel(
  channelId: string,
  update: (state: ChannelLocalState) => ChannelLocalState,
): void {
  if (!/^[A-Za-z0-9:._-]{1,256}$/.test(channelId)) {
    throw new TypeError("invalid channel ID");
  }
  const current = useClientState.getState().channels[channelId] ?? {
    muted: false,
    starred: false,
    updatedAt: 0,
  };
  const value = update(current);
  useClientState.setState({
    channels: {
      ...useClientState.getState().channels,
      [channelId]: { ...value, updatedAt: Date.now() },
    },
  });
  persist();
}

function persist(): void {
  const state = useClientState.getState();
  const community = state.community;
  if (!community || !state.ready) return;
  const snapshot = {
    channels: state.channels,
    drafts: state.drafts,
    follows: state.follows,
    inboxDoneIds: state.inboxDoneIds,
    inboxUnreadIds: state.inboxUnreadIds,
    readMarkers: state.readMarkers,
    sections: state.sections,
    version: 1 as const,
  };
  writeQueue = writeQueue
    .then(() => storage.write(community, snapshot))
    .catch(() => undefined);
}

function identityKey(community: Community | undefined): string {
  return community ? `${community.id}:${community.pubkey}` : "";
}

function capIds(ids: readonly string[]): readonly string[] {
  return [...new Set(ids)].slice(-2_000);
}
