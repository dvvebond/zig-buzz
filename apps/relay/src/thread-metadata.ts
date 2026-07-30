import type { NostrEvent } from "@buzz/core";
import type {
  EventStore,
  ThreadMetadata,
  ThreadMetadataRecord,
} from "@buzz/db";
import { RemoteProtocolError } from "@buzz/remote-agent-protocol";

const EVENT_ID = /^[0-9a-fA-F]{64}$/;

/**
 * Resolve and validate NIP-10 ancestry for one channel-scoped event.
 *
 * The relay, rather than the client, determines the authoritative root and
 * depth. This prevents forged root tags from splitting counters, crossing
 * channels, or bypassing the depth bound.
 */
export async function resolveThreadMetadata(
  store: EventStore,
  community: string,
  event: NostrEvent,
  channelId: string | undefined,
): Promise<ThreadMetadata | undefined> {
  if (!channelId) return undefined;
  let rootId: string | undefined;
  let parentId: string | undefined;
  for (const tag of event.tags) {
    if (tag.length < 4 || tag[0] !== "e" || !tag[1] || !EVENT_ID.test(tag[1])) {
      continue;
    }
    if (tag[3] === "root") rootId = tag[1].toLowerCase();
    if (tag[3] === "reply") parentId = tag[1].toLowerCase();
  }
  if (!rootId && !parentId) return undefined;
  if (!parentId) return undefined;
  rootId ??= parentId;

  const parent = await store.getById(community, parentId);
  if (!parent) invalid("reply parent not found");
  if (!parent.channelId) invalid("reply parent has no channel association");
  if (parent.channelId !== channelId) {
    invalid("reply parent belongs to a different channel");
  }

  const parentMetadata = await store.getThreadMetadata(community, parentId);
  const ancestry = await authoritativeAncestry(
    store,
    community,
    parent.event,
    parentMetadata,
    parentId,
  );
  if (rootId !== ancestry.rootId) {
    invalid("root tag does not match thread ancestry");
  }
  const depth = ancestry.parentDepth + 1;
  if (depth > 100) invalid("thread depth limit exceeded");

  return {
    broadcast: event.tags.some(
      (tag) => tag.length >= 2 && tag[0] === "broadcast" && tag[1] === "1",
    ),
    channelId,
    depth,
    eventCreatedAt: event.created_at,
    eventId: event.id,
    parentEventCreatedAt: parent.event.created_at,
    parentEventId: parentId,
    rootEventCreatedAt: ancestry.rootCreatedAt,
    rootEventId: ancestry.rootId,
  };
}

async function authoritativeAncestry(
  store: EventStore,
  community: string,
  parent: NostrEvent,
  metadata: ThreadMetadataRecord | undefined,
  parentId: string,
): Promise<{
  readonly parentDepth: number;
  readonly rootCreatedAt: number;
  readonly rootId: string;
}> {
  if (metadata) {
    const rootId = metadata.depth === 0 ? parentId : metadata.rootEventId;
    const root = await store.getById(community, rootId);
    return {
      parentDepth: metadata.depth,
      rootCreatedAt: root?.event.created_at ?? metadata.rootEventCreatedAt,
      rootId,
    };
  }

  const markedRoot = markedEventId(parent, "root");
  const markedReply = markedEventId(parent, "reply");
  const rootId = markedRoot ?? markedReply ?? parentId;
  const root =
    rootId === parentId ? undefined : await store.getById(community, rootId);
  return {
    parentDepth: rootId === parentId ? 0 : 1,
    rootCreatedAt: root?.event.created_at ?? parent.created_at,
    rootId,
  };
}

function markedEventId(
  event: NostrEvent,
  marker: "reply" | "root",
): string | undefined {
  for (const tag of event.tags) {
    if (
      tag.length >= 4 &&
      tag[0] === "e" &&
      tag[1] &&
      EVENT_ID.test(tag[1]) &&
      tag[3] === marker
    ) {
      return tag[1].toLowerCase();
    }
  }
  return undefined;
}

function invalid(message: string): never {
  throw new RemoteProtocolError("CONFIG_INVALID", message);
}
