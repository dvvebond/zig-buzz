import {
  effectiveEventAuthor,
  KIND_DELETION,
  KIND_NIP29_DELETE_EVENT,
  KIND_REACTION,
  type NostrEvent,
} from "@buzz/core";
import { eventChannelId, type EventStore } from "@buzz/db";
import { RemoteProtocolError } from "@buzz/remote-agent-protocol";

/**
 * Resolve event kinds whose authorization/persistence coordinate belongs to a
 * referenced event. `undefined` means no override; `null` means explicitly
 * community-global.
 */
export async function resolveTargetCoordinate(
  eventStore: EventStore,
  community: string,
  event: NostrEvent,
  relaySelfPubkey?: string,
): Promise<string | null | undefined> {
  if (event.kind === KIND_DELETION || event.kind === KIND_NIP29_DELETE_EVENT) {
    return resolveDeletionCoordinate(
      eventStore,
      community,
      event,
      relaySelfPubkey,
    );
  }
  if (event.kind !== KIND_REACTION) return undefined;
  const targetId = [...event.tags]
    .reverse()
    .find(
      (tag) =>
        tag.length >= 2 &&
        tag[0] === "e" &&
        /^[0-9a-f]{64}$/i.test(tag[1] as string),
    )?.[1];
  if (!targetId) {
    throw new RemoteProtocolError(
      "CONFIG_INVALID",
      "reaction must reference a target event via e tag",
    );
  }
  const target = await eventStore.getById(community, targetId.toLowerCase());
  if (!target) {
    throw new RemoteProtocolError(
      "CONFIG_INVALID",
      "reaction target event was not found",
    );
  }
  const emoji = event.content.length === 0 ? "+" : event.content;
  if ([...emoji].length > 64) {
    throw new RemoteProtocolError(
      "CONFIG_INVALID",
      "reaction emoji exceeds 64 characters",
    );
  }
  return target.channelId ?? null;
}

async function resolveDeletionCoordinate(
  eventStore: EventStore,
  community: string,
  event: NostrEvent,
  relaySelfPubkey: string | undefined,
): Promise<string | null> {
  const targetTags = event.tags.filter(
    (tag) => tag[0] === "e" || tag[0] === "a",
  );
  if (targetTags.length !== 1) {
    throw new RemoteProtocolError(
      "CONFIG_INVALID",
      "deletion events must reference exactly one target via e or a tag",
    );
  }
  const tag = targetTags[0] as string[];
  const value = tag[1];
  if (tag[0] === "e") {
    if (!value || !/^[0-9a-f]{64}$/i.test(value)) {
      throw new RemoteProtocolError(
        "CONFIG_INVALID",
        "deletion event has a malformed e target",
      );
    }
    const target = await eventStore.getById(
      community,
      value.toLowerCase(),
      event.kind === KIND_DELETION ? { includeDeleted: true } : {},
    );
    if (!target) {
      throw new RemoteProtocolError(
        "CONFIG_INVALID",
        "deletion target event was not found",
      );
    }
    if (event.kind === KIND_NIP29_DELETE_EVENT) {
      const channelId = eventChannelId(event);
      if (
        !channelId ||
        target.channelId !== channelId ||
        !(await eventStore.canDeleteChannelEvent(
          community,
          event.pubkey,
          target,
          channelId,
          effectiveEventAuthor(target.event, relaySelfPubkey),
        ))
      ) {
        throw new RemoteProtocolError(
          "CAPABILITY_DENIED",
          "must be the event author or a channel owner/admin",
        );
      }
      return channelId;
    }
    if (
      !(await eventStore.canManageAuthor(
        community,
        event.pubkey,
        effectiveEventAuthor(target.event, relaySelfPubkey),
      ))
    ) {
      throw new RemoteProtocolError(
        "CAPABILITY_DENIED",
        "deletion must be signed by the event author or its agent owner",
      );
    }
    return target.channelId ?? null;
  }

  if (event.kind === KIND_NIP29_DELETE_EVENT || !value) {
    throw new RemoteProtocolError(
      "CONFIG_INVALID",
      "NIP-29 channel deletion requires an e target",
    );
  }
  const parts = value.split(":");
  const eventKind = Number(parts.shift());
  const pubkey = parts.shift()?.toLowerCase();
  const dTag = parts.join(":");
  if (
    !Number.isSafeInteger(eventKind) ||
    eventKind < 0 ||
    !pubkey ||
    !/^[0-9a-f]{64}$/.test(pubkey)
  ) {
    throw new RemoteProtocolError(
      "CONFIG_INVALID",
      "deletion event has a malformed a target",
    );
  }
  if (!(await eventStore.canManageAuthor(community, event.pubkey, pubkey))) {
    throw new RemoteProtocolError(
      "CAPABILITY_DENIED",
      "addressable deletion must be signed by the coordinate owner",
    );
  }
  const target = await eventStore.getByAddress(
    community,
    eventKind,
    pubkey,
    dTag,
    { includeDeleted: true },
  );
  return target?.channelId ?? null;
}
