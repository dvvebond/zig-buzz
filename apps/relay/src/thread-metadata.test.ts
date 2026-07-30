import { generateSecretKey } from "nostr-tools/pure";
import { describe, expect, it } from "vitest";
import { signNostrEvent } from "@buzz/core";
import { MemoryEventStore } from "@buzz/db";

import { resolveThreadMetadata } from "./thread-metadata.js";

describe("NIP-10 thread metadata", () => {
  it("derives nested ancestry from relay state and rejects a forged root", async () => {
    const store = new MemoryEventStore();
    const secret = generateSecretKey();
    const channelId = "00000000-0000-4000-8000-000000000001";
    const otherChannel = "00000000-0000-4000-8000-000000000002";
    const root = signNostrEvent(
      { content: "root", created_at: 100, kind: 9, tags: [["h", channelId]] },
      secret,
    );
    await store.store("relay.example", root, channelId);
    const reply = signNostrEvent(
      {
        content: "reply",
        created_at: 101,
        kind: 9,
        tags: [
          ["h", channelId],
          ["e", root.id, "", "root"],
          ["e", root.id, "", "reply"],
        ],
      },
      secret,
    );
    const replyMetadata = await resolveThreadMetadata(
      store,
      "relay.example",
      reply,
      channelId,
    );
    expect(replyMetadata).toMatchObject({
      depth: 1,
      parentEventId: root.id,
      rootEventId: root.id,
    });
    await store.store(
      "relay.example",
      reply,
      channelId,
      undefined,
      replyMetadata,
    );

    const forged = signNostrEvent(
      {
        content: "nested",
        created_at: 102,
        kind: 9,
        tags: [
          ["h", channelId],
          ["e", "11".repeat(32), "", "root"],
          ["e", reply.id, "", "reply"],
        ],
      },
      secret,
    );
    await expect(
      resolveThreadMetadata(store, "relay.example", forged, channelId),
    ).rejects.toThrow(/root tag does not match/);

    const crossChannel = signNostrEvent(
      {
        content: "cross",
        created_at: 103,
        kind: 9,
        tags: [
          ["h", otherChannel],
          ["e", root.id, "", "reply"],
        ],
      },
      secret,
    );
    await expect(
      resolveThreadMetadata(store, "relay.example", crossChannel, otherChannel),
    ).rejects.toThrow(/different channel/);
  });

  it("updates window counters atomically in the memory conformance store", async () => {
    const store = new MemoryEventStore();
    const secret = generateSecretKey();
    const channelId = "00000000-0000-4000-8000-000000000003";
    const root = signNostrEvent(
      { content: "root", created_at: 100, kind: 9, tags: [["h", channelId]] },
      secret,
    );
    await store.store("relay.example", root, channelId);
    const reply = signNostrEvent(
      {
        content: "reply",
        created_at: 101,
        kind: 9,
        tags: [
          ["h", channelId],
          ["e", root.id, "", "reply"],
        ],
      },
      secret,
    );
    const metadata = await resolveThreadMetadata(
      store,
      "relay.example",
      reply,
      channelId,
    );
    await store.store("relay.example", reply, channelId, undefined, metadata);

    const window = await store.queryChannelWindow("relay.example", channelId, {
      limit: 50,
    });
    expect(window.rows.map((row) => row.storedEvent.event.id)).toEqual([
      root.id,
    ]);
    expect(window.rows[0]?.threadSummary).toMatchObject({
      descendantCount: 1,
      replyCount: 1,
    });
  });
});
