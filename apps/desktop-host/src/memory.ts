import { createHmac } from "node:crypto";

import type { Event } from "nostr-tools";

import type { IdentityService } from "./identity.js";
import type { ManagedAgentService } from "./managed-agents.js";
import type { RelayHttpClient } from "./relay-http.js";
import type { SnapshotMemoryLevel } from "./snapshots.js";

const HEX_PUBKEY = /^[0-9a-f]{64}$/;
const HEX_D_TAG = /^[0-9a-f]{64}$/;
const MAX_ENGRAMS = 5_000;

export type EngramEntry = {
  readonly slug: string;
  readonly body: string;
  readonly eventId: string;
  readonly createdAt: number;
  readonly outgoingRefs: string[];
};

export type AgentMemoryListing = {
  readonly core: EngramEntry | null;
  readonly memories: EngramEntry[];
  readonly truncated: boolean;
  readonly fetchedAt: number;
};

type Decoded = {
  readonly body: string | null;
  readonly event: Event;
  readonly slug: string;
};

export class AgentMemoryService {
  readonly #identity: IdentityService;
  readonly #managedAgents: ManagedAgentService;
  readonly #relay: RelayHttpClient;

  constructor(input: {
    readonly identity: IdentityService;
    readonly managedAgents: ManagedAgentService;
    readonly relay: RelayHttpClient;
  }) {
    this.#identity = input.identity;
    this.#managedAgents = input.managedAgents;
    this.#relay = input.relay;
  }

  async list(pubkeyValue: unknown): Promise<AgentMemoryListing> {
    const pubkey = requirePubkey(pubkeyValue);
    if (!this.#managedAgents.owns(pubkey)) {
      throw new Error(`not the owner of managed agent ${pubkey}`);
    }
    const owner = this.#identity.info().pubkey;
    const events = await this.#relay.query([
      {
        "#p": [owner],
        authors: [pubkey],
        kinds: [30_174],
        limit: MAX_ENGRAMS,
      },
    ]);
    const conversationKey = this.#identity.conversationKey(pubkey);
    const groups = new Map<string, Decoded[]>();
    try {
      for (const event of events) {
        const decoded = this.#decode(event, pubkey, owner, conversationKey);
        if (!decoded) continue;
        const d = event.tags.find((tag) => tag[0] === "d")?.[1];
        if (!d) continue;
        const members = groups.get(d) ?? [];
        members.push(decoded);
        groups.set(d, members);
      }
    } finally {
      conversationKey.fill(0);
    }

    let core: EngramEntry | null = null;
    const memories: EngramEntry[] = [];
    for (const members of groups.values()) {
      const head = members.reduce((best, candidate) =>
        candidate.event.created_at > best.event.created_at ||
        (candidate.event.created_at === best.event.created_at &&
          candidate.event.id < best.event.id)
          ? candidate
          : best,
      );
      if (head.body === null) continue;
      const entry: EngramEntry = {
        body: head.body,
        createdAt: head.event.created_at,
        eventId: head.event.id,
        outgoingRefs: extractReferences(head.body),
        slug: head.slug,
      };
      if (head.slug === "core") core = entry;
      else memories.push(entry);
    }
    memories.sort((left, right) => left.slug.localeCompare(right.slug));
    return {
      core,
      fetchedAt: Math.floor(Date.now() / 1_000),
      memories,
      truncated: events.length >= MAX_ENGRAMS,
    };
  }

  async snapshotEntries(
    pubkey: unknown,
    level: SnapshotMemoryLevel,
  ): Promise<Array<{ readonly slug: string; readonly body: string }>> {
    if (level === "none") return [];
    const listing = await this.list(pubkey);
    const entries: Array<{ slug: string; body: string }> = [];
    if (listing.core) {
      entries.push({ body: listing.core.body, slug: "core" });
    }
    if (level === "everything") {
      entries.push(
        ...listing.memories.map((entry) => ({
          body: entry.body,
          slug: entry.slug,
        })),
      );
    }
    return entries;
  }

  async restore(
    pubkey: unknown,
    entries: readonly { readonly slug: string; readonly body: string }[],
  ): Promise<{ readonly errors: string[]; readonly written: number }> {
    if (entries.length > 10_000) throw new Error("too many memory entries");
    const errors: string[] = [];
    let written = 0;
    const now = Math.floor(Date.now() / 1_000);
    for (const [index, entry] of entries.entries()) {
      try {
        await this.#managedAgents.publishEngram(
          pubkey,
          entry.slug,
          entry.body,
          now + index,
        );
        written += 1;
      } catch (error) {
        errors.push(
          `slug ${JSON.stringify(entry.slug)}: ${
            error instanceof Error ? error.message : "publish failed"
          }`,
        );
      }
    }
    return { errors, written };
  }

  #decode(
    event: Event,
    agent: string,
    owner: string,
    conversationKey: Uint8Array,
  ): Decoded | null {
    if (event.kind !== 30_174 || event.pubkey !== agent) return null;
    const d = exactTag(event, "d");
    const addressedOwner = exactTag(event, "p");
    if (!d || !HEX_D_TAG.test(d) || addressedOwner !== owner) return null;
    let plaintext: string;
    try {
      plaintext = this.#identity.decryptFromPeer(agent, event.content);
    } catch {
      return null;
    }
    if (Buffer.byteLength(plaintext, "utf8") > 65_535) return null;
    let value: unknown;
    try {
      value = JSON.parse(plaintext);
    } catch {
      return null;
    }
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return null;
    }
    const body = value as Record<string, unknown>;
    if (typeof body.slug !== "string" || !isEngramSlug(body.slug)) return null;
    const expectedD = createHmac("sha256", conversationKey)
      .update("agent-memory/v1/d-tag", "utf8")
      .update(Buffer.from([0]))
      .update(body.slug, "utf8")
      .digest("hex");
    if (expectedD !== d) return null;
    if (body.slug === "core") {
      return typeof body.profile === "string"
        ? { body: body.profile, event, slug: body.slug }
        : null;
    }
    return body.value === null || typeof body.value === "string"
      ? { body: body.value, event, slug: body.slug }
      : null;
  }
}

function exactTag(event: Event, name: string): string | null {
  const matches = event.tags.filter(
    (tag) => tag.length === 2 && tag[0] === name && typeof tag[1] === "string",
  );
  return matches.length === 1 ? (matches[0]?.[1] ?? null) : null;
}

function isEngramSlug(value: string): boolean {
  return (
    value === "core" ||
    (value.length <= 255 &&
      /^mem\/[a-z0-9][a-z0-9_-]{0,63}(?:\/[a-z0-9][a-z0-9_-]{0,63})*$/.test(
        value,
      ))
  );
}

function extractReferences(value: string): string[] {
  const result: string[] = [];
  for (const match of value.matchAll(/\[\[([^\[\]]{1,255})\]\]/g)) {
    const slug = match[1];
    if (slug && isEngramSlug(slug) && !result.includes(slug)) result.push(slug);
  }
  return result;
}

function requirePubkey(value: unknown): string {
  if (typeof value !== "string" || !HEX_PUBKEY.test(value.toLowerCase())) {
    throw new Error("agentPubkey must be 64 hexadecimal characters");
  }
  return value.toLowerCase();
}
