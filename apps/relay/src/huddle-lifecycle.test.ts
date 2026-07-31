import { randomUUID } from "node:crypto";

import { MemoryEventStore } from "@buzz/db";
import { generateSecretKey, getPublicKey } from "nostr-tools/pure";
import type { Pool, PoolClient } from "pg";
import { describe, expect, it, vi } from "vitest";

import { RelayHuddleLifecycle } from "./huddle-lifecycle.js";

describe("huddle lifecycle authorization", () => {
  it("verifies the creator-signed parent link before auto-adding a parent member", async () => {
    const channelId = randomUUID();
    const parentChannelId = randomUUID();
    const communityId = randomUUID();
    const creator = getPublicKey(generateSecretKey());
    const participant = getPublicKey(generateSecretKey());
    const insertedMembers: unknown[][] = [];
    const query = vi.fn(async (sql: string, values?: readonly unknown[]) => {
      if (sql.includes("FROM communities")) {
        return rows([{ id: communityId }]);
      }
      if (sql.includes("FROM channels ch")) {
        return rows([
          {
            archived_at: null,
            created_by: creator,
            ttl_seconds: 300,
            visibility: "private",
          },
        ]);
      }
      if (sql.includes("FROM events")) {
        return rows([
          {
            content: JSON.stringify({
              ephemeral_channel_id: channelId,
            }),
            tags: [["h", parentChannelId]],
          },
        ]);
      }
      if (sql.includes("FROM channel_members")) {
        return rows(values?.[1] === parentChannelId ? [{}] : []);
      }
      if (sql.includes("INSERT INTO channel_members")) {
        insertedMembers.push([...(values ?? [])]);
      }
      return rows([]);
    });
    const lifecycle = lifecycleWithQuery(query);

    await expect(
      lifecycle.authorizeJoin({
        channelId,
        parentChannelId,
        pubkey: participant,
      }),
    ).resolves.toEqual({ parentChannelId });
    expect(insertedMembers).toEqual([
      [communityId, channelId, participant, creator],
    ]);
  });

  it("rejects JSONB-containment lookalike tags with extra elements", async () => {
    const channelId = randomUUID();
    const parentChannelId = randomUUID();
    const communityId = randomUUID();
    const creator = getPublicKey(generateSecretKey());
    const query = vi.fn(async (sql: string) => {
      if (sql.includes("FROM communities")) {
        return rows([{ id: communityId }]);
      }
      if (sql.includes("FROM channels ch")) {
        return rows([
          {
            archived_at: null,
            created_by: creator,
            ttl_seconds: 300,
            visibility: "private",
          },
        ]);
      }
      if (sql.includes("FROM events")) {
        return rows([
          {
            content: JSON.stringify({
              ephemeral_channel_id: channelId,
            }),
            tags: [["h", parentChannelId, "extra"]],
          },
        ]);
      }
      return rows([]);
    });
    const lifecycle = lifecycleWithQuery(query);

    await expect(
      lifecycle.authorizeJoin({
        channelId,
        parentChannelId,
        pubkey: getPublicKey(generateSecretKey()),
      }),
    ).rejects.toThrow(/not linked/);
    expect(
      query.mock.calls.some(([sql]) =>
        String(sql).includes("INSERT INTO channel_members"),
      ),
    ).toBe(false);
  });
});

function lifecycleWithQuery(
  query: ReturnType<typeof vi.fn>,
): RelayHuddleLifecycle {
  const client = {
    query,
    release: vi.fn(),
  } as unknown as PoolClient;
  const pool = {
    connect: vi.fn(async () => client),
    query,
  } as unknown as Pool;
  return new RelayHuddleLifecycle({
    community: "relay.example",
    eventStore: new MemoryEventStore(),
    pool,
    publishEvent: async () => undefined,
    relaySecretKey: generateSecretKey(),
  });
}

function rows(values: readonly Record<string, unknown>[]): {
  readonly rowCount: number;
  readonly rows: readonly Record<string, unknown>[];
} {
  return { rowCount: values.length, rows: values };
}
