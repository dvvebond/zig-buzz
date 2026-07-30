import { randomBytes, randomUUID } from "node:crypto";

import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { SearchService } from "./search.js";

const databaseUrl = process.env.BUZZ_TEST_DATABASE_URL;
const integrationDescribe = databaseUrl ? describe : describe.skip;

integrationDescribe("Postgres full-text search", () => {
  const pool = new Pool({ connectionString: databaseUrl });
  const communityId = randomUUID();
  const channelId = randomUUID();

  beforeAll(async () => {
    await pool.query("INSERT INTO communities (id, host) VALUES ($1, $2)", [
      communityId,
      `search-${communityId}.test`,
    ]);
    await pool.query(
      `INSERT INTO channels (community_id, id, name, created_by)
       VALUES ($1, $2, 'search-test', $3)`,
      [communityId, channelId, randomBytes(32)],
    );
    await insertEvent("project hummingbird release", channelId, 1);
    await insertEvent("project private note", null, 1);
    await insertEvent("unrelated text", channelId, 1);
  });

  afterAll(async () => {
    await pool.query("DELETE FROM events WHERE community_id = $1", [
      communityId,
    ]);
    await pool.query("DELETE FROM channels WHERE community_id = $1", [
      communityId,
    ]);
    await pool.query("DELETE FROM communities WHERE id = $1", [communityId]);
    await pool.end();
  });

  it("fences by community and channel scope and supports prefix matching", async () => {
    const service = new SearchService(pool);
    const scoped = await service.search({
      channelScope: { type: "channels", channelIds: [channelId] },
      communityId,
      mode: "full-text",
      text: "project hummingbird",
    });
    expect(scoped.hits).toHaveLength(1);
    expect(scoped.hits[0]?.channelId).toBe(channelId);

    const channelLess = await service.search({
      channelScope: { type: "channel-less-only" },
      communityId,
      mode: "prefix",
      text: "priv",
    });
    expect(channelLess.hits).toHaveLength(1);
    expect(channelLess.hits[0]?.channelId).toBeNull();
  });

  async function insertEvent(
    content: string,
    targetChannelId: string | null,
    kind: number,
  ): Promise<void> {
    await pool.query(
      `INSERT INTO events
        (community_id, id, pubkey, created_at, kind, tags, content, sig,
         channel_id)
       VALUES ($1, $2, $3, now(), $4, '[]'::jsonb, $5, $6, $7)`,
      [
        communityId,
        randomBytes(32),
        randomBytes(32),
        kind,
        content,
        randomBytes(64),
        targetChannelId,
      ],
    );
  }
});
