import { useEffect, useMemo } from "react";
import { create } from "zustand";

import { KIND_AGENT_OBSERVER_FRAME } from "@buzz/core";

import {
  buildObserverTranscript,
  decodeObserverFrame,
  type ObserverFrame,
  type TranscriptItem,
} from "../domain/observer";
import { firstTag } from "../domain/models";
import type { RelayConnectionState } from "../services/mobile-relay";
import { useAppStore } from "./app-store";
import { useRelay } from "./relay-context";

type ObserverState = {
  readonly identity: string;
  readonly framesByAgent: Readonly<Record<string, readonly ObserverFrame[]>>;
  reset(identity: string): void;
  add(agentPubkey: string, frame: ObserverFrame): void;
};

const useObserverState = create<ObserverState>((set, get) => ({
  framesByAgent: {},
  identity: "",
  reset(identity) {
    if (get().identity !== identity) set({ framesByAgent: {}, identity });
  },
  add(agentPubkey, frame) {
    const current = get().framesByAgent[agentPubkey] ?? [];
    const dedupeKey = `${frame.seq}:${frame.timestamp}`;
    if (current.some((item) => `${item.seq}:${item.timestamp}` === dedupeKey)) {
      return;
    }
    const frames = [...current, frame]
      .sort(
        (left, right) =>
          Date.parse(left.timestamp) - Date.parse(right.timestamp) ||
          left.seq - right.seq,
      )
      .slice(-800);
    set({
      framesByAgent: {
        ...get().framesByAgent,
        [agentPubkey]: frames,
      },
    });
  },
}));

export function ObserverRuntime() {
  const { community, relay, secretKey } = useRelay();
  const reset = useObserverState((state) => state.reset);
  useEffect(() => {
    reset(`${community.id}:${community.pubkey}`);
    return relay.subscribe(
      [
        {
          "#p": [community.pubkey],
          kinds: [KIND_AGENT_OBSERVER_FRAME],
        },
      ],
      (event) => {
        const agentPubkey = firstTag(event, "agent");
        if (!agentPubkey) return;
        const frame = decodeObserverFrame(event, community.pubkey, secretKey);
        if (frame) useObserverState.getState().add(agentPubkey, frame);
      },
    );
  }, [community.id, community.pubkey, relay, reset, secretKey]);
  return null;
}

export function useObserverTranscript(
  agentPubkey: string,
  channelId?: string,
): {
  readonly connection: RelayConnectionState;
  readonly frames: readonly ObserverFrame[];
  readonly transcript: readonly TranscriptItem[];
} {
  const connection = useAppStore((state) => state.connection);
  const all = useObserverState(
    (state) => state.framesByAgent[agentPubkey] ?? [],
  );
  return useMemo(() => {
    const frames = channelId
      ? all.filter((frame) => !frame.channelId || frame.channelId === channelId)
      : all;
    return {
      connection,
      frames,
      transcript: buildObserverTranscript(frames),
    };
  }, [all, channelId, connection]);
}
