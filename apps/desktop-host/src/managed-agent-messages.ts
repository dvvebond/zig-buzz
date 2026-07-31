import { buildMessage, type EventTemplate, type ThreadRef } from "@buzz/sdk";
import type { Event } from "nostr-tools";

import type { ManagedAgentService } from "./managed-agents.js";
import type { RelayFilter, RelayHttpClient } from "./relay-http.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HEX_EVENT = /^[0-9a-f]{64}$/;
const MAX_MARKER_BYTES = 512;

export class ManagedAgentMessageService {
  readonly #managedAgents: ManagedAgentService;
  readonly #relay: RelayHttpClient;

  constructor(managedAgents: ManagedAgentService, relay: RelayHttpClient) {
    this.#managedAgents = managedAgents;
    this.#relay = relay;
  }

  async hasMarker(args: Record<string, unknown>): Promise<boolean> {
    const channelId = requireChannelId(args.channelId);
    const marker = requireMarker(args.marker);
    const author = markerAuthor(args.markerScope, args.agentPubkey);
    return (await this.#find(channelId, marker, author)) !== undefined;
  }

  async send(args: Record<string, unknown>): Promise<{
    created_at: number;
    depth: number;
    event_id: string;
    parent_event_id: string | null;
    root_event_id: string | null;
  }> {
    const agentPubkey = requirePubkey(args.agentPubkey, "agentPubkey");
    if (!this.#managedAgents.owns(agentPubkey)) {
      throw new Error("managed agent not found");
    }
    const channelId = requireChannelId(args.channelId);
    const content = requireText(args.content, "content", 64 * 1024).trim();
    if (!content) throw new Error("message content is required");
    const marker =
      args.marker === undefined || args.marker === null || args.marker === ""
        ? null
        : requireMarker(args.marker);
    const scope = markerScope(args.markerScope);
    const parentEventId =
      args.parentEventId === undefined ||
      args.parentEventId === null ||
      args.parentEventId === ""
        ? null
        : requireEventId(args.parentEventId, "parentEventId");
    const thread = parentEventId
      ? await this.#resolveThread(parentEventId)
      : undefined;

    if (marker) {
      const existing = await this.#find(
        channelId,
        marker,
        scope === "channel" ? undefined : agentPubkey,
      );
      if (existing) {
        return response(existing, parentEventId, thread);
      }
    }

    const mentions = optionalPubkeys(args.mentionPubkeys);
    const clientMarkers = [
      ...(marker ? [marker] : []),
      ...optionalMarkers(args.additionalMarkers),
    ];
    const built = buildMessage({
      channelId,
      content,
      mentions,
      ...(thread ? { thread } : {}),
    });
    const template: EventTemplate = {
      ...built,
      tags: [
        ...built.tags,
        ...clientMarkers.map((value): string[] => ["client", value]),
      ],
    };
    const event = await this.#managedAgents.publishAsAgent(
      agentPubkey,
      template,
    );
    return response(event, parentEventId, thread);
  }

  async #find(
    channelId: string,
    marker: string,
    author: string | undefined,
  ): Promise<Event | undefined> {
    let until: number | undefined;
    for (let page = 0; page < 10; page += 1) {
      const filter: RelayFilter = {
        "#h": [channelId],
        kinds: [9],
        limit: 500,
        ...(author ? { authors: [author] } : {}),
        ...(until === undefined ? {} : { until }),
      };
      const events = await this.#relay.query([filter]);
      const existing = events.find((event) =>
        event.tags.some(
          (tag) => tag.length >= 2 && tag[0] === "client" && tag[1] === marker,
        ),
      );
      if (existing) return existing;
      if (events.length < 500) return undefined;
      const oldest = Math.min(...events.map((event) => event.created_at));
      until = Math.max(0, oldest - 1);
    }
    return undefined;
  }

  async #resolveThread(parentEventId: string): Promise<ThreadRef> {
    const [parent] = await this.#relay.query([
      { ids: [parentEventId], limit: 1 },
    ]);
    if (!parent) throw new Error("parent event not found");
    const explicitRoot = parent.tags.find(
      (tag) => tag[0] === "e" && tag[3] === "root",
    )?.[1];
    const reply = parent.tags.find(
      (tag) => tag[0] === "e" && tag[3] === "reply",
    )?.[1];
    return {
      parentEventId,
      rootEventId:
        explicitRoot && HEX_EVENT.test(explicitRoot)
          ? explicitRoot
          : reply && HEX_EVENT.test(reply)
            ? reply
            : parentEventId,
    };
  }
}

function response(
  event: Event,
  parentEventId: string | null,
  thread: ThreadRef | undefined,
): {
  created_at: number;
  depth: number;
  event_id: string;
  parent_event_id: string | null;
  root_event_id: string | null;
} {
  return {
    created_at: event.created_at,
    depth: parentEventId ? 1 : 0,
    event_id: event.id,
    parent_event_id: parentEventId,
    root_event_id: thread?.rootEventId ?? null,
  };
}

function markerAuthor(
  scopeValue: unknown,
  agentPubkeyValue: unknown,
): string | undefined {
  const scope = markerScope(scopeValue);
  if (scope === "channel") return undefined;
  return requirePubkey(agentPubkeyValue, "agentPubkey");
}

function markerScope(value: unknown): "agent" | "channel" {
  if (value === undefined || value === null || value === "agent")
    return "agent";
  if (value === "channel") return "channel";
  throw new Error("markerScope must be agent or channel");
}

function optionalMarkers(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > 64) {
    throw new Error("additionalMarkers must contain at most 64 entries");
  }
  return [...new Set(value.map(requireMarker))];
}

function optionalPubkeys(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > 256) {
    throw new Error("mentionPubkeys must contain at most 256 entries");
  }
  return [
    ...new Set(value.map((item) => requirePubkey(item, "mentionPubkey"))),
  ];
}

function requireMarker(value: unknown): string {
  const marker = requireText(value, "marker", MAX_MARKER_BYTES).trim();
  if (!marker) throw new Error("message marker is required");
  return marker;
}

function requireChannelId(value: unknown): string {
  if (typeof value !== "string" || !UUID.test(value)) {
    throw new Error("channelId must be a UUID");
  }
  return value.toLowerCase();
}

function requireEventId(value: unknown, name: string): string {
  if (typeof value !== "string" || !HEX_EVENT.test(value)) {
    throw new Error(`${name} must be a 64-character hexadecimal event ID`);
  }
  return value;
}

function requirePubkey(value: unknown, name: string): string {
  if (typeof value !== "string" || !HEX_EVENT.test(value.toLowerCase())) {
    throw new Error(`${name} must be a 64-character hexadecimal pubkey`);
  }
  return value.toLowerCase();
}

function requireText(
  value: unknown,
  name: string,
  maximumBytes: number,
): string {
  if (typeof value !== "string") throw new Error(`${name} must be a string`);
  if (Buffer.byteLength(value, "utf8") > maximumBytes) {
    throw new Error(`${name} exceeds ${maximumBytes} bytes`);
  }
  return value;
}
