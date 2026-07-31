import { buildContactList, buildNote, type EventTemplate } from "@buzz/sdk";
import type { Event } from "nostr-tools";

import type { IdentityService } from "./identity.js";
import type { RelayFilter, RelayHttpClient } from "./relay-http.js";

const HEX = /^[0-9a-f]{64}$/;

export class SocialService {
  readonly #identity: IdentityService;
  readonly #relay: RelayHttpClient;

  constructor(identity: IdentityService, relay: RelayHttpClient) {
    this.#identity = identity;
    this.#relay = relay;
  }

  async note(idValue: unknown): Promise<Record<string, unknown> | null> {
    const id = requireHex(idValue, "noteId");
    const [event] = await this.#relay.query([
      { ids: [id], kinds: [1], limit: 1 },
    ]);
    return event ? noteFromEvent(event) : null;
  }

  async notes(input: {
    authors?: unknown;
    before?: unknown;
    beforeId?: unknown;
    limit?: unknown;
  }): Promise<Record<string, unknown>> {
    const limit = parseLimit(input.limit, 50);
    const filter: RelayFilter = { kinds: [1], limit };
    if (input.authors !== undefined) {
      if (!Array.isArray(input.authors) || input.authors.length > 500) {
        throw new Error("authors must contain at most 500 pubkeys");
      }
      filter.authors = input.authors.map((value) =>
        requireHex(value, "author"),
      );
    }
    if (typeof input.before === "number") filter.until = input.before;
    if (typeof input.beforeId === "string") {
      filter.before_id = requireHex(input.beforeId, "beforeId");
    }
    const events = await this.#relay.query([filter]);
    return notesResponse(events, limit);
  }

  async publish(
    args: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const content = requireText(args.content, "content", 64 * 1024).trim();
    let template = buildNote(
      content,
      typeof args.replyTo === "string"
        ? requireHex(args.replyTo, "replyTo")
        : undefined,
    );
    template = {
      ...template,
      tags: [
        ...template.tags,
        ...parsePubkeys(args.mentionPubkeys).map((key) => ["p", key]),
        ...parsePrefixedTags(args.mediaTags, "imeta"),
      ],
    };
    const event = await this.#publish(template);
    return { accepted: true, event_id: event.id, message: "" };
  }

  async contactList(pubkeyValue: unknown): Promise<Record<string, unknown>> {
    const pubkey = requireHex(pubkeyValue, "pubkey");
    const [event] = await this.#relay.query([
      { authors: [pubkey], kinds: [3], limit: 1 },
    ]);
    return event
      ? {
          content: event.content,
          created_at: event.created_at,
          id: event.id,
          pubkey: event.pubkey,
          tags: event.tags,
        }
      : {
          content: "",
          created_at: 0,
          id: "0".repeat(64),
          pubkey,
          tags: [],
        };
  }

  async setContactList(
    args: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    if (!Array.isArray(args.contacts) || args.contacts.length > 10_000) {
      throw new Error("contacts must contain at most 10,000 entries");
    }
    const contacts = args.contacts.map((value, index) => {
      const contact = requireObject(value, `contacts[${index}]`);
      const relayUrl =
        typeof contact.relay_url === "string" && contact.relay_url
          ? requireRelayUrl(contact.relay_url)
          : undefined;
      const petname =
        typeof contact.petname === "string" && contact.petname
          ? requireText(contact.petname, "petname", 256)
          : undefined;
      return {
        pubkey: requireHex(contact.pubkey, `contacts[${index}].pubkey`),
        ...(relayUrl ? { relayUrl } : {}),
        ...(petname ? { petname } : {}),
      };
    });
    const event = await this.#publish(buildContactList(contacts));
    return { accepted: true, event_id: event.id, message: "" };
  }

  async reactions(
    noteIdsValue: unknown,
  ): Promise<Array<Record<string, unknown>>> {
    if (!Array.isArray(noteIdsValue) || noteIdsValue.length > 500) {
      throw new Error("noteIds must contain at most 500 event IDs");
    }
    const noteIds = noteIdsValue.map((value) => requireHex(value, "noteId"));
    if (noteIds.length === 0) return [];
    const events = await this.#relay.query([
      { "#e": noteIds, kinds: [7], limit: 1_000 },
    ]);
    const grouped = new Map<
      string,
      { emoji: string; noteId: string; pubkeys: Set<string> }
    >();
    for (const event of events) {
      const noteId = event.tags.find((tag) => tag[0] === "e")?.[1];
      if (!noteId || !noteIds.includes(noteId)) continue;
      const key = `${noteId}\0${event.content}`;
      const entry = grouped.get(key) ?? {
        emoji: event.content,
        noteId,
        pubkeys: new Set<string>(),
      };
      entry.pubkeys.add(event.pubkey);
      grouped.set(key, entry);
    }
    return [...grouped.values()].map((entry) => ({
      count: entry.pubkeys.size,
      emoji: entry.emoji,
      note_id: entry.noteId,
      pubkeys: [...entry.pubkeys],
    }));
  }

  async liked(
    authorValue: unknown,
    limitValue: unknown,
  ): Promise<Record<string, unknown>> {
    const author = requireHex(authorValue, "authorPubkey");
    const limit = parseLimit(limitValue, 50);
    const reactions = await this.#relay.query([
      { authors: [author], kinds: [7], limit: Math.min(limit * 4, 1_000) },
    ]);
    const ids = [
      ...new Set(
        reactions
          .filter((event) => event.content === "+" || event.content === "❤️")
          .map((event) => event.tags.find((tag) => tag[0] === "e")?.[1])
          .filter((value): value is string =>
            Boolean(value && HEX.test(value)),
          ),
      ),
    ].slice(0, limit);
    const notes =
      ids.length > 0
        ? await this.#relay.query([{ ids, kinds: [1], limit: ids.length }])
        : [];
    return notesResponse(notes, limit);
  }

  async timeline(
    pubkeysValue: unknown,
    limitValue: unknown,
  ): Promise<Record<string, unknown>> {
    if (!Array.isArray(pubkeysValue) || pubkeysValue.length > 500) {
      throw new Error("pubkeys must contain at most 500 keys");
    }
    const authors = pubkeysValue.map((value) => requireHex(value, "pubkey"));
    const perUser = parseLimit(limitValue, 20);
    const events =
      authors.length > 0
        ? await this.#relay.query([
            {
              authors,
              kinds: [1],
              limit: Math.min(authors.length * perUser, 1_000),
            },
          ])
        : [];
    return notesResponse(events, Math.min(authors.length * perUser, 1_000));
  }

  async #publish(template: EventTemplate): Promise<Event> {
    const event = this.#identity.sign({
      content: template.content,
      kind: template.kind,
      tags: template.tags,
    });
    await this.#relay.publish(event);
    return event;
  }
}

function notesResponse(
  events: Event[],
  limit: number,
): Record<string, unknown> {
  const notes = events.map(noteFromEvent);
  const last = events.at(-1);
  return {
    next_cursor:
      events.length === limit && last
        ? { before: last.created_at, before_id: last.id }
        : null,
    notes,
  };
}

function noteFromEvent(event: Event): Record<string, unknown> {
  return {
    content: event.content,
    created_at: event.created_at,
    id: event.id,
    pubkey: event.pubkey,
    tags: event.tags,
  };
}

function parsePubkeys(value: unknown): string[] {
  if (value === null || value === undefined) return [];
  if (!Array.isArray(value) || value.length > 50) {
    throw new Error("mentionPubkeys must contain at most 50 keys");
  }
  return value.map((entry) => requireHex(entry, "mention pubkey"));
}

function parsePrefixedTags(value: unknown, prefix: string): string[][] {
  if (value === null || value === undefined) return [];
  if (!Array.isArray(value) || value.length > 256) {
    throw new Error(`${prefix} tags must be an array`);
  }
  return value.map((entry) => {
    if (
      !Array.isArray(entry) ||
      entry[0] !== prefix ||
      entry.some((part) => typeof part !== "string")
    ) {
      throw new Error(`invalid ${prefix} tag`);
    }
    return entry as string[];
  });
}

function parseLimit(value: unknown, fallback: number): number {
  if (value === null || value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new Error("limit must be a positive integer");
  }
  return Math.min(value, 1_000);
}

function requireHex(value: unknown, name: string): string {
  if (typeof value !== "string" || !HEX.test(value)) {
    throw new Error(`${name} must be 64 lowercase hexadecimal characters`);
  }
  return value;
}

function requireText(
  value: unknown,
  name: string,
  maximumBytes: number,
): string {
  if (typeof value !== "string") throw new Error(`${name} must be a string`);
  if (Buffer.byteLength(value, "utf8") > maximumBytes) {
    throw new Error(`${name} exceeds the ${maximumBytes} byte limit`);
  }
  return value;
}

function requireObject(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${name} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requireRelayUrl(value: string): string {
  if (Buffer.byteLength(value, "utf8") > 2_048) {
    throw new Error("relay URL exceeds 2,048 bytes");
  }
  const parsed = new URL(value);
  if (
    (parsed.protocol !== "ws:" && parsed.protocol !== "wss:") ||
    parsed.username ||
    parsed.password
  ) {
    throw new Error("relay URL must be ws(s) without credentials");
  }
  return value;
}
