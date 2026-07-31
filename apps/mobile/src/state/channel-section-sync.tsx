import { useEffect, useMemo, useRef, useState } from "react";

import { KIND_READ_STATE, type NostrEvent } from "@buzz/core";

import {
  decryptPrivateState,
  encryptPrivateState,
} from "../domain/private-state";
import { firstTag } from "../domain/models";
import {
  parseChannelSectionEnvelope,
  type ChannelSectionEnvelope,
} from "../services/client-local-state";
import { useClientState } from "./client-state";
import { useRelay } from "./relay-context";

const D_TAG = "channel-sections";
const PUBLISH_DEBOUNCE_MS = 2_000;

export function ChannelSectionSyncRuntime() {
  const { community, relay, secretKey } = useRelay();
  const ready = useClientState((state) => state.ready);
  const sections = useClientState((state) => state.sections);
  const channels = useClientState((state) => state.channels);
  const replaceSections = useClientState((state) => state.replaceSections);
  const [syncReady, setSyncReady] = useState(false);
  const latest = useRef({ createdAt: 0, eventId: "" });
  const lastApplied = useRef("");
  const envelope = useMemo(
    () => buildEnvelope(sections, channels),
    [channels, sections],
  );
  const encoded = useMemo(() => JSON.stringify(envelope), [envelope]);

  useEffect(() => {
    if (!ready) return undefined;
    let active = true;
    setSyncReady(false);
    latest.current = { createdAt: 0, eventId: "" };
    lastApplied.current = "";

    const accept = (event: NostrEvent): boolean => {
      if (
        event.kind !== KIND_READ_STATE ||
        event.pubkey !== community.pubkey ||
        firstTag(event, "d") !== D_TAG ||
        !newerThan(event, latest.current)
      ) {
        return false;
      }
      try {
        const parsed = parseChannelSectionEnvelope(
          decryptPrivateState(secretKey, event, community.pubkey),
        );
        if (!parsed || !active) return false;
        latest.current = {
          createdAt: event.created_at,
          eventId: event.id,
        };
        lastApplied.current = JSON.stringify(parsed);
        replaceSections(parsed.sections, parsed.assignments);
        return true;
      } catch {
        return false;
      }
    };

    const unsubscribe = relay.subscribe(
      [
        {
          "#d": [D_TAG],
          authors: [community.pubkey],
          kinds: [KIND_READ_STATE],
        },
      ],
      accept,
    );
    void relay
      .query([
        {
          "#d": [D_TAG],
          authors: [community.pubkey],
          kinds: [KIND_READ_STATE],
          limit: 1,
        },
      ])
      .then((events) => {
        for (const event of events) accept(event);
      })
      .catch(() => undefined)
      .finally(() => {
        if (active) setSyncReady(true);
      });
    return () => {
      active = false;
      unsubscribe();
    };
  }, [community.pubkey, ready, relay, replaceSections, secretKey]);

  useEffect(() => {
    if (!ready || !syncReady || encoded === lastApplied.current) {
      return undefined;
    }
    const timeout = setTimeout(() => {
      const current = buildEnvelope(
        useClientState.getState().sections,
        useClientState.getState().channels,
      );
      const signature = JSON.stringify(current);
      if (signature === lastApplied.current) return;
      void publishLatest({
        communityPubkey: community.pubkey,
        envelope: current,
        latest,
        relay,
        secretKey,
      })
        .then((event) => {
          lastApplied.current = signature;
          latest.current = {
            createdAt: event.created_at,
            eventId: event.id,
          };
        })
        .catch(() => undefined);
    }, PUBLISH_DEBOUNCE_MS);
    return () => clearTimeout(timeout);
  }, [community.pubkey, encoded, ready, relay, secretKey, syncReady]);
  return null;
}

async function publishLatest(input: {
  readonly communityPubkey: string;
  readonly envelope: ChannelSectionEnvelope;
  readonly latest: React.RefObject<{
    createdAt: number;
    eventId: string;
  }>;
  readonly relay: ReturnType<typeof useRelay>["relay"];
  readonly secretKey: Uint8Array;
}): Promise<NostrEvent> {
  const content = encryptPrivateState(
    input.secretKey,
    input.communityPubkey,
    input.envelope,
  );
  const createdAt = Math.max(
    Math.floor(Date.now() / 1_000),
    input.latest.current.createdAt + 1,
  );
  return input.relay.publish(
    {
      content,
      kind: KIND_READ_STATE,
      tags: [
        ["d", D_TAG],
        ["t", D_TAG],
      ],
    },
    createdAt,
  );
}

function buildEnvelope(
  sections: ChannelSectionEnvelope["sections"],
  channels: ReturnType<typeof useClientState.getState>["channels"],
): ChannelSectionEnvelope {
  const assignments: Record<string, string> = {};
  for (const [channelId, value] of Object.entries(channels)) {
    if (value.sectionId) assignments[channelId] = value.sectionId;
  }
  return { assignments, sections, version: 1 };
}

function newerThan(
  event: NostrEvent,
  current: { readonly createdAt: number; readonly eventId: string },
): boolean {
  return (
    event.created_at > current.createdAt ||
    (event.created_at === current.createdAt && event.id > current.eventId)
  );
}
