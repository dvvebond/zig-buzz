import { randomUUID } from "node:crypto";

import { Pool } from "pg";
import { generateSecretKey, getPublicKey } from "nostr-tools/pure";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { signNostrEvent } from "@buzz/core";
import {
  KIND_DM_ADD_MEMBER,
  KIND_DM_HIDE,
  KIND_DM_OPEN,
  KIND_DM_VISIBILITY,
  KIND_NIP43_MEMBERSHIP_LIST,
  RELAY_ADMIN_ADD_MEMBER,
  RELAY_ADMIN_CHANGE_ROLE,
  RELAY_ADMIN_REMOVE_MEMBER,
} from "@buzz/core";

import { PostgresEventStore } from "./event-store.js";

const databaseUrl = process.env.BUZZ_TEST_DATABASE_URL;
const pool = databaseUrl
  ? new Pool({ connectionString: databaseUrl, max: 4 })
  : undefined;
const communities = [
  `events-a-${randomUUID()}.example`,
  `events-b-${randomUUID()}.example`,
] as const;

describe.skipIf(!pool)("Postgres event store", () => {
  beforeAll(async () => {
    for (const community of communities) {
      await pool?.query("INSERT INTO communities (host) VALUES ($1)", [
        community,
      ]);
    }
  });

  afterAll(async () => {
    await pool?.end();
  });

  it("persists signed events with tenant isolation and indexed tag filters", async () => {
    if (!pool) throw new Error("test pool is unavailable");
    const store = new PostgresEventStore(pool);
    const secret = generateSecretKey();
    const target = "a".repeat(64);
    const event = signNostrEvent(
      {
        content: "tenant-isolated",
        created_at: Math.floor(Date.now() / 1_000),
        kind: 1,
        tags: [["p", target]],
      },
      secret,
    );
    await expect(store.store(communities[0], event)).resolves.toEqual({
      status: "inserted",
    });
    await expect(store.store(communities[0], event)).resolves.toEqual({
      status: "duplicate",
    });
    await expect(
      store.query(communities[0], {
        "#p": [target],
        ids: [event.id.slice(0, 8)],
      }),
    ).resolves.toEqual([event]);
    await expect(
      store.query(communities[1], { "#p": [target] }),
    ).resolves.toEqual([]);
  });

  it("atomically rejects an older parameterized replaceable event", async () => {
    if (!pool) throw new Error("test pool is unavailable");
    const store = new PostgresEventStore(pool);
    const secret = generateSecretKey();
    const now = Math.floor(Date.now() / 1_000);
    const newer = signNostrEvent(
      {
        content: "new",
        created_at: now,
        kind: 30_123,
        tags: [["d", "same"]],
      },
      secret,
    );
    const older = signNostrEvent(
      {
        content: "old",
        created_at: now - 1,
        kind: 30_123,
        tags: [["d", "same"]],
      },
      secret,
    );
    await store.store(communities[0], newer);
    await expect(store.store(communities[0], older)).resolves.toEqual({
      status: "superseded",
    });
    await expect(
      store.query(communities[0], { "#d": ["same"], kinds: [30_123] }),
    ).resolves.toEqual([newer]);
  });

  it("synchronizes host-scoped NIP-05 profiles without losing contested updates", async () => {
    if (!pool) throw new Error("test pool is unavailable");
    const store = new PostgresEventStore(pool);
    const alice = generateSecretKey();
    const bob = generateSecretKey();
    const alicePubkey = getPublicKey(alice);
    const bobPubkey = getPublicKey(bob);
    const now = Math.floor(Date.now() / 1_000);
    const aliceProfile = signNostrEvent(
      {
        content: JSON.stringify({
          about: "TypeScript profile",
          display_name: "Alice",
          nip05: `Alice@${communities[0].toUpperCase()}`,
          picture: "https://example.com/alice.png",
        }),
        created_at: now,
        kind: 0,
        tags: [],
      },
      alice,
    );
    await store.store(communities[0], aliceProfile);

    const profile = await pool.query<{
      about: string | null;
      display_name: string | null;
      metadata_event_id: string | null;
      nip05_handle: string | null;
    }>(
      `SELECT about, display_name, nip05_handle,
              encode(metadata_event_id, 'hex') AS metadata_event_id
       FROM users u
       JOIN communities c ON c.id = u.community_id
       WHERE lower(c.host) = lower($1)
         AND u.pubkey = decode($2, 'hex')`,
      [communities[0], alicePubkey],
    );
    expect(profile.rows[0]).toEqual({
      about: "TypeScript profile",
      display_name: "Alice",
      metadata_event_id: aliceProfile.id,
      nip05_handle: `alice@${communities[0]}`,
    });

    const contested = signNostrEvent(
      {
        content: JSON.stringify({
          display_name: "Bob still updates",
          nip05: `alice@${communities[0]}`,
        }),
        created_at: now + 1,
        kind: 0,
        tags: [],
      },
      bob,
    );
    await expect(store.store(communities[0], contested)).resolves.toEqual({
      status: "inserted",
    });
    const bobProfile = await pool.query<{
      display_name: string | null;
      nip05_handle: string | null;
    }>(
      `SELECT display_name, nip05_handle
       FROM users u
       JOIN communities c ON c.id = u.community_id
       WHERE lower(c.host) = lower($1)
         AND u.pubkey = decode($2, 'hex')`,
      [communities[0], bobPubkey],
    );
    expect(bobProfile.rows[0]).toEqual({
      display_name: "Bob still updates",
      nip05_handle: null,
    });

    const secondTenant = signNostrEvent(
      {
        content: JSON.stringify({
          display_name: "Alice elsewhere",
          nip05: `alice@${communities[1]}`,
        }),
        created_at: now + 2,
        kind: 0,
        tags: [],
      },
      alice,
    );
    await store.store(communities[1], secondTenant);
    const scoped = await pool.query<{ nip05_handle: string }>(
      `SELECT u.nip05_handle
       FROM users u
       JOIN communities c ON c.id = u.community_id
       WHERE u.pubkey = decode($1, 'hex')
       ORDER BY c.host`,
      [alicePubkey],
    );
    expect(scoped.rows.map((row) => row.nip05_handle).sort()).toEqual(
      [`alice@${communities[0]}`, `alice@${communities[1]}`].sort(),
    );
  });

  it("rolls back the event and its domain mutation when a transaction effect fails", async () => {
    if (!pool) throw new Error("test pool is unavailable");
    const store = new PostgresEventStore(pool);
    const secret = generateSecretKey();
    const sideEffectPubkey = getPublicKey(generateSecretKey());
    const event = signNostrEvent(
      {
        content: "must-not-survive",
        created_at: Math.floor(Date.now() / 1_000),
        kind: 1,
        tags: [],
      },
      secret,
    );
    await expect(
      store.store(
        communities[0],
        event,
        undefined,
        async (client, communityId) => {
          await client.query(
            `INSERT INTO users (community_id, pubkey)
             VALUES ($1, decode($2, 'hex'))`,
            [communityId, sideEffectPubkey],
          );
          throw new Error("reject command");
        },
      ),
    ).rejects.toThrow("reject command");
    await expect(
      store.query(communities[0], { ids: [event.id] }),
    ).resolves.toEqual([]);
    const user = await pool.query(
      `SELECT 1
       FROM users u
       JOIN communities c ON c.id = u.community_id
       WHERE lower(c.host) = lower($1)
         AND u.pubkey = decode($2, 'hex')`,
      [communities[0], sideEffectPubkey],
    );
    expect(user.rowCount).toBe(0);
  });

  it("opens, reuses, hides, reopens, and forks DMs atomically", async () => {
    if (!pool) throw new Error("test pool is unavailable");
    const relaySecret = generateSecretKey();
    const store = new PostgresEventStore(pool, {
      relaySecretKey: relaySecret,
    });
    const alice = generateSecretKey();
    const bob = generateSecretKey();
    const carol = generateSecretKey();
    const outsider = generateSecretKey();
    const alicePubkey = getPublicKey(alice);
    const bobPubkey = getPublicKey(bob);
    const carolPubkey = getPublicKey(carol);
    const now = Math.floor(Date.now() / 1_000);
    const open = signNostrEvent(
      {
        content: "",
        created_at: now,
        kind: KIND_DM_OPEN,
        tags: [["p", bobPubkey]],
      },
      alice,
    );
    const opened = await store.store(communities[0], open);
    expect(opened.status).toBe("inserted");
    expect(opened.derivedEvents?.map((event) => event.kind)).toEqual([
      39_000,
      39_001,
      39_002,
      KIND_DM_VISIBILITY,
    ]);
    const response = JSON.parse(
      opened.message?.slice("response:".length) ?? "null",
    ) as { readonly channel_id: string; readonly created: boolean };
    expect(response.created).toBe(true);
    expect(response.channel_id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );

    const state = await pool.query<{
      readonly channel_id: string;
      readonly participants: string[];
    }>(
      `SELECT ch.id::text AS channel_id,
              array_agg(encode(cm.pubkey, 'hex') ORDER BY cm.pubkey) AS participants
       FROM channels ch
       JOIN communities c ON c.id = ch.community_id
       JOIN channel_members cm
         ON cm.community_id = ch.community_id AND cm.channel_id = ch.id
       WHERE c.host = $1
         AND ch.id = $2::uuid
         AND ch.channel_type = 'dm'
         AND cm.removed_at IS NULL
       GROUP BY ch.id`,
      [communities[0], response.channel_id],
    );
    expect(state.rows[0]).toEqual({
      channel_id: response.channel_id,
      participants: [alicePubkey, bobPubkey].sort(),
    });

    const reopenedSame = await store.store(
      communities[0],
      signNostrEvent(
        {
          content: "",
          created_at: now + 1,
          kind: KIND_DM_OPEN,
          tags: [["p", bobPubkey]],
        },
        alice,
      ),
    );
    expect(reopenedSame.message).toBe(
      `response:${JSON.stringify({
        channel_id: response.channel_id,
        created: false,
      })}`,
    );

    const hidden = await store.store(
      communities[0],
      signNostrEvent(
        {
          content: "",
          created_at: now + 2,
          kind: KIND_DM_HIDE,
          tags: [["h", response.channel_id]],
        },
        alice,
      ),
      response.channel_id,
    );
    expect(
      hidden.derivedEvents?.find((event) => event.kind === KIND_DM_VISIBILITY)
        ?.tags,
    ).toContainEqual(["h", response.channel_id]);
    const aliceVisibility = await store.query(communities[0], {
      "#p": [alicePubkey],
      kinds: [KIND_DM_VISIBILITY],
      limit: 1,
    });
    expect(aliceVisibility[0]?.tags).toContainEqual(["h", response.channel_id]);
    const bobVisibility = await store.query(communities[0], {
      "#p": [bobPubkey],
      kinds: [KIND_DM_VISIBILITY],
      limit: 1,
    });
    expect(bobVisibility[0]?.tags ?? []).not.toContainEqual([
      "h",
      response.channel_id,
    ]);

    await store.store(
      communities[0],
      signNostrEvent(
        {
          content: "",
          created_at: now + 3,
          kind: KIND_DM_OPEN,
          tags: [["p", bobPubkey]],
        },
        alice,
      ),
    );
    const visibleAgain = await store.query(communities[0], {
      "#p": [alicePubkey],
      kinds: [KIND_DM_VISIBILITY],
      limit: 1,
    });
    expect(visibleAgain[0]?.tags).not.toContainEqual([
      "h",
      response.channel_id,
    ]);

    const group = await store.store(
      communities[0],
      signNostrEvent(
        {
          content: "",
          created_at: now + 4,
          kind: KIND_DM_ADD_MEMBER,
          tags: [
            ["h", response.channel_id],
            ["p", carolPubkey],
          ],
        },
        alice,
      ),
      response.channel_id,
    );
    const groupResponse = JSON.parse(
      group.message?.slice("response:".length) ?? "null",
    ) as { readonly channel_id: string; readonly created: boolean };
    expect(groupResponse.created).toBe(true);
    expect(groupResponse.channel_id).not.toBe(response.channel_id);

    const unauthorized = signNostrEvent(
      {
        content: "",
        created_at: now + 5,
        kind: KIND_DM_ADD_MEMBER,
        tags: [
          ["h", response.channel_id],
          ["p", carolPubkey],
        ],
      },
      outsider,
    );
    await expect(
      store.store(communities[0], unauthorized, response.channel_id),
    ).rejects.toThrow("only a DM member");
    await expect(
      store.query(communities[0], { ids: [unauthorized.id] }),
    ).resolves.toEqual([]);

    const mention = await pool.query<{ readonly channel_id: string }>(
      `SELECT em.channel_id::text
       FROM event_mentions em
       JOIN communities c ON c.id = em.community_id
       WHERE c.host = $1
         AND em.event_id = decode($2, 'hex')
         AND em.pubkey_hex = $3`,
      [communities[0], open.id, bobPubkey],
    );
    expect(mention.rows[0]?.channel_id).toBe(response.channel_id);
  });

  it("enforces NIP-43 relay administration and emits canonical snapshots", async () => {
    if (!pool) throw new Error("test pool is unavailable");
    const relaySecret = generateSecretKey();
    const owner = generateSecretKey();
    const admin = generateSecretKey();
    const member = generateSecretKey();
    const outsider = generateSecretKey();
    const ownerPubkey = getPublicKey(owner);
    const adminPubkey = getPublicKey(admin);
    const memberPubkey = getPublicKey(member);
    await pool.query(
      `INSERT INTO relay_members (community_id, pubkey, role)
       SELECT id, $2, 'owner'
       FROM communities WHERE host = $1
       ON CONFLICT DO NOTHING`,
      [communities[0], ownerPubkey],
    );
    const store = new PostgresEventStore(pool, {
      relaySecretKey: relaySecret,
    });
    const now = Math.floor(Date.now() / 1_000);
    const addAdmin = signNostrEvent(
      {
        content: "",
        created_at: now,
        kind: RELAY_ADMIN_ADD_MEMBER,
        tags: [
          ["p", adminPubkey],
          ["role", "admin"],
        ],
      },
      owner,
    );
    const added = await store.store(communities[0], addAdmin);
    expect(added.derivedEvents?.map((event) => event.kind)).toEqual([
      8_000,
      KIND_NIP43_MEMBERSHIP_LIST,
    ]);

    const forbiddenGrant = signNostrEvent(
      {
        content: "",
        created_at: now + 1,
        kind: RELAY_ADMIN_ADD_MEMBER,
        tags: [
          ["p", memberPubkey],
          ["role", "admin"],
        ],
      },
      admin,
    );
    await expect(store.store(communities[0], forbiddenGrant)).rejects.toThrow(
      "only a relay owner",
    );
    await expect(
      store.query(communities[0], { ids: [forbiddenGrant.id] }),
    ).resolves.toEqual([]);

    await store.store(
      communities[0],
      signNostrEvent(
        {
          content: "",
          created_at: now + 2,
          kind: RELAY_ADMIN_ADD_MEMBER,
          tags: [
            ["p", memberPubkey],
            ["role", "member"],
          ],
        },
        admin,
      ),
    );
    await store.store(
      communities[0],
      signNostrEvent(
        {
          content: "",
          created_at: now + 3,
          kind: RELAY_ADMIN_CHANGE_ROLE,
          tags: [
            ["p", memberPubkey],
            ["role", "admin"],
          ],
        },
        owner,
      ),
    );
    const adminCannotRemoveAdmin = signNostrEvent(
      {
        content: "",
        created_at: now + 4,
        kind: RELAY_ADMIN_REMOVE_MEMBER,
        tags: [["p", memberPubkey]],
      },
      admin,
    );
    await expect(
      store.store(communities[0], adminCannotRemoveAdmin),
    ).rejects.toThrow("admins may remove only members");

    await store.store(
      communities[0],
      signNostrEvent(
        {
          content: "",
          created_at: now + 5,
          kind: RELAY_ADMIN_REMOVE_MEMBER,
          tags: [["p", memberPubkey]],
        },
        owner,
      ),
    );
    const outsiderAttempt = signNostrEvent(
      {
        content: "",
        created_at: now + 6,
        kind: RELAY_ADMIN_ADD_MEMBER,
        tags: [
          ["p", memberPubkey],
          ["role", "member"],
        ],
      },
      outsider,
    );
    await expect(store.store(communities[0], outsiderAttempt)).rejects.toThrow(
      "relay admin or owner",
    );

    const [snapshot] = await store.query(communities[0], {
      kinds: [KIND_NIP43_MEMBERSHIP_LIST],
      limit: 1,
    });
    expect(snapshot?.pubkey).toBe(getPublicKey(relaySecret));
    expect(snapshot?.tags).toContainEqual(["member", ownerPubkey, "owner"]);
    expect(snapshot?.tags).toContainEqual(["member", adminPubkey, "admin"]);
    expect(
      snapshot?.tags.some(
        (tag) => tag[0] === "member" && tag[1] === memberPubkey,
      ),
    ).toBe(false);
  });
});
