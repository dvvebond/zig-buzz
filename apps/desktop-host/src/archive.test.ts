import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
  nip44,
  type Event,
} from "nostr-tools";
import { afterEach, describe, expect, it } from "vitest";

import { ArchiveService } from "./archive.js";
import { IdentityService } from "./identity.js";
import type { RelayFilter, RelayHttpClient } from "./relay-http.js";

const cleanup: Array<() => void | Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((operation) => operation()));
});

describe("ArchiveService", () => {
  it("atomically merges and removes owner subscription kinds", async () => {
    const { archive, identity } = createMemoryArchive();
    const owner = identity.info().pubkey;

    await archive.createSubscription({
      kinds: [24_200],
      scopeType: "owner_p",
      scopeValue: owner,
    });
    archive.mergeOwnerKind(44_200);
    archive.mergeOwnerKind(24_200);

    expect(archive.listSubscriptions()).toEqual([
      expect.objectContaining({
        kinds: "[24200,44200]",
        scope_type: "owner_p",
        scope_value: owner,
      }),
    ]);

    archive.removeOwnerKind(24_200);
    expect(archive.listSubscriptions()[0]).toMatchObject({
      kinds: "[44200]",
    });
    archive.removeOwnerKind(44_200);
    expect(archive.listSubscriptions()).toEqual([]);

    await expect(
      archive.createSubscription({
        kinds: [1],
        scopeType: "owner_p",
        scopeValue: "f".repeat(64),
      }),
    ).rejects.toThrow("current identity");
  });

  it("validates ephemeral frames, re-probes metrics, indexes channels, and paginates", async () => {
    const relayEvents: Event[] = [];
    const queries: RelayFilter[][] = [];
    const { archive, identity } = createMemoryArchive(relayEvents, queries);
    const owner = identity.info().pubkey;
    archive.mergeOwnerKind(24_200);
    archive.mergeOwnerKind(44_200);

    const createdAt = 1_900_000_000;
    const frames = ["alpha", "beta", "gamma"].map((marker) =>
      observerEvent(
        identity,
        {
          channelId: "channel-archive",
          marker,
        },
        createdAt,
      ),
    );
    const forged = observerEvent(
      identity,
      { channelId: "channel-archive", marker: "forged" },
      createdAt,
      "f".repeat(64),
    );
    const metric = metricEvent(identity, "archive-test-harness", createdAt - 1);
    relayEvents.push(metric);

    const result = await archive.archive({
      candidates: [
        ...frames.map((event) => candidate(event, "owner_p", owner)),
        candidate(forged, "owner_p", owner),
        candidate(metric, "owner_p", owner),
        candidate(metric, "owner_p", owner),
      ],
    });

    expect(result).toEqual({ dropped: 1, persisted: 4 });
    expect(queries).toContainEqual([
      expect.objectContaining({
        "#p": [owner],
        ids: [metric.id],
        kinds: [44_200],
      }),
    ]);

    const sortedFrames = [...frames].sort((left, right) =>
      right.id.localeCompare(left.id),
    );
    const firstPage = archive
      .readObserversForChannel({
        channelId: "channel-archive",
        limit: 2,
      })
      .map(parseEvent);
    expect(firstPage.map((event) => event.id)).toEqual(
      sortedFrames.slice(0, 2).map((event) => event.id),
    );

    const cursor = firstPage.at(-1);
    expect(cursor).toBeDefined();
    const secondPage = archive
      .readObserversForChannel({
        beforeCreatedAt: cursor?.created_at,
        beforeId: cursor?.id,
        channelId: "channel-archive",
        limit: 2,
      })
      .map(parseEvent);
    expect(secondPage.map((event) => event.id)).toEqual([sortedFrames[2]?.id]);
    expect(archive.readUnindexedObservers()).toEqual([]);

    expect(
      archive.read({
        kinds: [44_200],
        limit: 10,
        scopeType: "owner_p",
        scopeValue: owner,
      }),
    ).toEqual([expect.stringContaining('"harness":"archive-test-harness"')]);
  });

  it("encrypts archived bodies at rest and restores them with the same key", async () => {
    const dataDirectory = await mkdtemp(
      path.join(os.tmpdir(), "buzz-archive-test-"),
    );
    cleanup.push(() => rm(dataDirectory, { force: true, recursive: true }));
    const identity = IdentityService.create(undefined, async () => undefined);
    const relayEvents: Event[] = [];
    const relay = fakeRelay(relayEvents);
    const archive = await ArchiveService.create({
      dataDirectory,
      identity,
      relay,
      relayUrl: "ws://127.0.0.1:3000",
    });
    const owner = identity.info().pubkey;
    archive.mergeOwnerKind(44_200);
    const event = metricEvent(identity, "secret-at-rest-marker", 1_900_000_001);
    relayEvents.push(event);

    await expect(
      archive.archive({
        candidates: [candidate(event, "owner_p", owner)],
      }),
    ).resolves.toEqual({ dropped: 0, persisted: 1 });
    expect(
      archive.read({
        kinds: [44_200],
        scopeType: "owner_p",
        scopeValue: owner,
      })[0],
    ).toContain("secret-at-rest-marker");
    archive.close();

    const database = new DatabaseSync(
      path.join(dataDirectory, "archive", "archive.sqlite3"),
      { readOnly: true },
    );
    const row = database
      .prepare("SELECT encrypted_json FROM archived_events WHERE id = ?")
      .get(event.id) as { encrypted_json: string };
    database.close();
    expect(row.encrypted_json).not.toContain("secret-at-rest-marker");

    const reopened = await ArchiveService.create({
      dataDirectory,
      identity,
      relay,
      relayUrl: "ws://127.0.0.1:3000",
    });
    cleanup.push(() => reopened.close());
    expect(
      reopened.read({
        kinds: [44_200],
        scopeType: "owner_p",
        scopeValue: owner,
      })[0],
    ).toContain("secret-at-rest-marker");
  });
});

function createMemoryArchive(
  relayEvents: Event[] = [],
  queries: RelayFilter[][] = [],
): { archive: ArchiveService; identity: IdentityService } {
  const identity = IdentityService.create(undefined, async () => undefined);
  const archive = ArchiveService.memory({
    identity,
    relay: fakeRelay(relayEvents, queries),
    relayUrl: "ws://127.0.0.1:3000",
  });
  cleanup.push(() => archive.close());
  return { archive, identity };
}

function fakeRelay(
  events: readonly Event[],
  queries: RelayFilter[][] = [],
): RelayHttpClient {
  return {
    query: async (filters: readonly RelayFilter[]) => {
      queries.push(structuredClone(filters) as RelayFilter[]);
      return events.filter((event) =>
        filters.some((filter) => matchesFilter(event, filter)),
      );
    },
  } as unknown as RelayHttpClient;
}

function matchesFilter(event: Event, filter: RelayFilter): boolean {
  if (Array.isArray(filter.ids) && !filter.ids.some((id) => id === event.id)) {
    return false;
  }
  if (
    Array.isArray(filter.kinds) &&
    !filter.kinds.some((kind) => kind === event.kind)
  ) {
    return false;
  }
  for (const [key, value] of Object.entries(filter)) {
    if (!key.startsWith("#") || !Array.isArray(value)) continue;
    const tagName = key.slice(1);
    if (
      !event.tags.some(
        (tag) =>
          tag[0] === tagName &&
          typeof tag[1] === "string" &&
          value.includes(tag[1]),
      )
    ) {
      return false;
    }
  }
  return true;
}

function observerEvent(
  identity: IdentityService,
  payload: Record<string, unknown>,
  createdAt: number,
  agentTag?: string,
): Event {
  const secret = generateSecretKey();
  const agent = getPublicKey(secret);
  const content = encryptFrom(secret, identity.info().pubkey, payload);
  return finalizeEvent(
    {
      content,
      created_at: createdAt,
      kind: 24_200,
      tags: [
        ["p", identity.info().pubkey, "wss://relay.example"],
        ["agent", agentTag ?? agent],
        ["frame", "telemetry"],
      ],
    },
    secret,
  );
}

function metricEvent(
  identity: IdentityService,
  harness: string,
  createdAt: number,
): Event {
  const secret = generateSecretKey();
  const agent = getPublicKey(secret);
  const content = encryptFrom(secret, identity.info().pubkey, {
    cumulative: {
      costUsd: 0.01,
      inputTokens: 100,
      outputTokens: 20,
      totalTokens: 120,
    },
    deltaReliable: true,
    harness,
    sessionId: "session-1",
    timestamp: "2030-03-17T17:46:40.000Z",
    turn: {
      costUsd: 0.001,
      inputTokens: 10,
      outputTokens: 2,
      totalTokens: 12,
    },
    turnSeq: 1,
  });
  return finalizeEvent(
    {
      content,
      created_at: createdAt,
      kind: 44_200,
      tags: [
        ["p", identity.info().pubkey],
        ["agent", agent],
      ],
    },
    secret,
  );
}

function encryptFrom(
  senderSecret: Uint8Array,
  recipientPubkey: string,
  payload: Record<string, unknown>,
): string {
  const conversationKey = nip44.v2.utils.getConversationKey(
    senderSecret,
    recipientPubkey,
  );
  return nip44.v2.encrypt(JSON.stringify(payload), conversationKey);
}

function candidate(
  event: Event,
  scopeType: "channel_h" | "owner_p" | "referenced_e",
  scopeValue: string,
): Record<string, unknown> {
  return {
    matched_scope: {
      scope_type: scopeType,
      scope_value: scopeValue,
    },
    raw_event_json: JSON.stringify(event),
  };
}

function parseEvent(raw: string): Event {
  return JSON.parse(raw) as Event;
}
