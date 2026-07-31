import { randomUUID } from "node:crypto";

import { InMemoryEventBus } from "@buzz/pubsub";
import { generateSecretKey, getPublicKey } from "nostr-tools/pure";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { KIND_NIP43_MEMBERSHIP_LIST, type NostrEvent } from "@buzz/core";

import { BuzzAdmin } from "./admin.js";

const databaseUrl = process.env.BUZZ_TEST_DATABASE_URL;
const pool = databaseUrl
  ? new Pool({ connectionString: databaseUrl })
  : undefined;
const community = `admin-${randomUUID()}.example`;
const relaySecret = generateSecretKey();
const owner = getPublicKey(generateSecretKey());

describe.skipIf(!pool)("BuzzAdmin PostgreSQL contract", () => {
  beforeAll(async () => {
    if (!pool) return;
    const inserted = await pool.query<{ readonly id: string }>(
      "INSERT INTO communities (host) VALUES ($1) RETURNING id",
      [community],
    );
    await pool.query(
      `INSERT INTO relay_members (community_id, pubkey, role)
       VALUES ($1, $2, 'owner')`,
      [inserted.rows[0]?.id, owner],
    );
  });

  afterAll(async () => {
    await pool?.end();
  });

  it("adds idempotently, publishes the authoritative roster, and removes safely", async () => {
    if (!pool) throw new Error("test pool is unavailable");
    const bus = new InMemoryEventBus();
    const published: NostrEvent[] = [];
    await bus.subscribe(community, (event) => {
      published.push(event);
    });
    const admin = new BuzzAdmin(pool, community, relaySecret, bus);
    const member = getPublicKey(generateSecretKey());
    await expect(admin.addMember(member, "admin")).resolves.toMatchObject({
      changed: true,
      pubkey: member,
      role: "admin",
    });
    await expect(admin.addMember(member, "admin")).resolves.toMatchObject({
      changed: false,
    });
    expect(published).toHaveLength(1);
    expect(published[0]).toMatchObject({ kind: KIND_NIP43_MEMBERSHIP_LIST });
    expect(
      published[0]?.tags.some(
        (tag) => tag[0] === "member" && tag[1] === member && tag[2] === "admin",
      ),
    ).toBe(true);
    await expect(admin.removeMember(owner)).rejects.toThrow(/cannot remove/);
    await expect(admin.removeMember(member, "member")).rejects.toThrow(
      /role mismatch/,
    );
    await expect(admin.removeMember(member, "admin")).resolves.toEqual({
      pubkey: member,
      removed: true,
    });
    expect(await admin.listMembers()).toHaveLength(1);
  });
});
