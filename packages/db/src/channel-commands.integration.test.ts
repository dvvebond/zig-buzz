import { randomUUID } from "node:crypto";

import { generateSecretKey, getPublicKey } from "nostr-tools/pure";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  KIND_NIP29_CREATE_GROUP,
  KIND_NIP29_EDIT_METADATA,
  KIND_NIP29_LEAVE_REQUEST,
  KIND_NIP29_PUT_USER,
  signNostrEvent,
} from "@buzz/core";

import { PostgresEventStore } from "./event-store.js";

const databaseUrl = process.env.BUZZ_TEST_DATABASE_URL;
const pool = databaseUrl
  ? new Pool({ connectionString: databaseUrl, max: 4 })
  : undefined;
const community = `channels-${randomUUID()}.example`;

describe.skipIf(!pool)("Postgres channel command transactions", () => {
  beforeAll(async () => {
    await pool?.query("INSERT INTO communities (host) VALUES ($1)", [
      community,
    ]);
  });

  afterAll(async () => {
    await pool?.end();
  });

  it("creates a channel and its initial owner in the event transaction", async () => {
    if (!pool) throw new Error("test pool is unavailable");
    const store = new PostgresEventStore(pool);
    const owner = generateSecretKey();
    const ownerPubkey = getPublicKey(owner);
    const channelId = randomUUID();
    const create = signNostrEvent(
      {
        content: "",
        created_at: Math.floor(Date.now() / 1_000),
        kind: KIND_NIP29_CREATE_GROUP,
        tags: [
          ["h", channelId],
          ["name", "## general "],
          ["visibility", "open"],
          ["channel_type", "workflow"],
          ["ttl", "3600"],
        ],
      },
      owner,
    );

    await expect(store.store(community, create, channelId)).resolves.toEqual({
      status: "inserted",
    });
    const state = await pool.query<{
      readonly name: string;
      readonly channel_type: string;
      readonly ttl_seconds: number;
      readonly pubkey: string;
      readonly role: string;
    }>(
      `SELECT ch.name, ch.channel_type::text, ch.ttl_seconds,
              encode(cm.pubkey, 'hex') AS pubkey, cm.role::text
       FROM channels ch
       JOIN communities c ON c.id = ch.community_id
       JOIN channel_members cm
         ON cm.community_id = ch.community_id AND cm.channel_id = ch.id
       WHERE c.host = $1 AND ch.id = $2::uuid`,
      [community, channelId],
    );
    expect(state.rows).toEqual([
      {
        channel_type: "workflow",
        name: "general",
        pubkey: ownerPubkey,
        role: "owner",
        ttl_seconds: 3600,
      },
    ]);
  });

  it("exposes relay-signed canonical metadata and membership snapshots", async () => {
    if (!pool) throw new Error("test pool is unavailable");
    const relaySecretKey = generateSecretKey();
    const store = new PostgresEventStore(pool, { relaySecretKey });
    const owner = generateSecretKey();
    const ownerPubkey = getPublicKey(owner);
    const channelId = randomUUID();
    const create = signNostrEvent(
      {
        content: "",
        created_at: Math.floor(Date.now() / 1_000),
        kind: KIND_NIP29_CREATE_GROUP,
        tags: [
          ["h", channelId],
          ["name", "snapshot-room"],
          ["visibility", "open"],
          ["channel_type", "stream"],
        ],
      },
      owner,
    );

    const result = await store.store(community, create, channelId);
    expect(result.status).toBe("inserted");
    expect(result.derivedEvents?.map((event) => event.kind)).toEqual([
      40_099, 44_100, 39_000, 39_001, 39_002,
    ]);
    const snapshots = result.derivedEvents?.filter((event) =>
      [39_000, 39_001, 39_002].includes(event.kind),
    );
    expect(
      snapshots?.every(
        (event) =>
          event.pubkey === getPublicKey(relaySecretKey) &&
          event.tags.some((tag) => tag[0] === "d" && tag[1] === channelId),
      ),
    ).toBe(true);

    const metadata = await store.query(community, {
      "#d": [channelId],
      kinds: [39_000],
      limit: 1,
    });
    expect(metadata[0]?.tags).toContainEqual(["name", "snapshot-room"]);
    const membership = await store.query(community, {
      "#p": [ownerPubkey],
      kinds: [39_002],
      limit: 1,
    });
    expect(membership[0]?.tags).toContainEqual(["p", ownerPubkey, "", "owner"]);
  });

  it("rolls back both event and state when a channel command is invalid", async () => {
    if (!pool) throw new Error("test pool is unavailable");
    const store = new PostgresEventStore(pool);
    const owner = generateSecretKey();
    const target = getPublicKey(generateSecretKey());
    const channelId = randomUUID();
    const now = Math.floor(Date.now() / 1_000);
    const create = signNostrEvent(
      {
        content: "",
        created_at: now,
        kind: KIND_NIP29_CREATE_GROUP,
        tags: [
          ["h", channelId],
          ["name", "atomic"],
        ],
      },
      owner,
    );
    await store.store(community, create, channelId);
    const invalid = signNostrEvent(
      {
        content: "",
        created_at: now + 1,
        kind: KIND_NIP29_PUT_USER,
        tags: [
          ["h", channelId],
          ["p", target],
          ["role", "superuser"],
        ],
      },
      owner,
    );

    await expect(store.store(community, invalid, channelId)).rejects.toThrow(
      "member role is invalid",
    );
    await expect(
      store.query(community, { ids: [invalid.id] }),
    ).resolves.toEqual([]);
    const member = await pool.query(
      `SELECT 1
       FROM channel_members cm
       JOIN communities c ON c.id = cm.community_id
       WHERE c.host = $1
         AND cm.channel_id = $2::uuid
         AND cm.pubkey = decode($3, 'hex')
         AND cm.removed_at IS NULL`,
      [community, channelId, target],
    );
    expect(member.rowCount).toBe(0);
  });

  it("updates metadata and refuses to orphan the final owner", async () => {
    if (!pool) throw new Error("test pool is unavailable");
    const store = new PostgresEventStore(pool);
    const owner = generateSecretKey();
    const channelId = randomUUID();
    const now = Math.floor(Date.now() / 1_000);
    await store.store(
      community,
      signNostrEvent(
        {
          content: "",
          created_at: now,
          kind: KIND_NIP29_CREATE_GROUP,
          tags: [
            ["h", channelId],
            ["name", "before"],
          ],
        },
        owner,
      ),
      channelId,
    );
    await store.store(
      community,
      signNostrEvent(
        {
          content: "",
          created_at: now + 1,
          kind: KIND_NIP29_EDIT_METADATA,
          tags: [
            ["h", channelId],
            ["name", "#after"],
            ["visibility", "private"],
            ["topic", "secure work"],
          ],
        },
        owner,
      ),
      channelId,
    );
    const leave = signNostrEvent(
      {
        content: "",
        created_at: now + 2,
        kind: KIND_NIP29_LEAVE_REQUEST,
        tags: [["h", channelId]],
      },
      owner,
    );

    await expect(store.store(community, leave, channelId)).rejects.toThrow(
      "cannot remove the last owner",
    );
    const state = await pool.query<{
      readonly name: string;
      readonly visibility: string;
      readonly topic: string;
    }>(
      `SELECT ch.name, ch.visibility::text, ch.topic
       FROM channels ch
       JOIN communities c ON c.id = ch.community_id
       WHERE c.host = $1 AND ch.id = $2::uuid`,
      [community, channelId],
    );
    expect(state.rows[0]).toEqual({
      name: "after",
      topic: "secure work",
      visibility: "private",
    });
    await expect(store.query(community, { ids: [leave.id] })).resolves.toEqual(
      [],
    );
  });
});
