import { generateSecretKey } from "nostr-tools/pure";
import { describe, expect, it } from "vitest";
import {
  KIND_AGENT_ENGRAM,
  KIND_AGENT_PROFILE,
  KIND_EVENT_REMINDER,
  KIND_FORUM_POST,
  KIND_FORUM_VOTE,
  KIND_PERSONA,
  KIND_STREAM_MESSAGE_DIFF,
  KIND_STREAM_MESSAGE_EDIT,
  signNostrEvent,
  unixNow,
} from "@buzz/core";
import { MemoryEventStore } from "@buzz/db";

import { validateEventKind } from "./event-kind-validation.js";

describe("kind-specific event validation", () => {
  it("enforces edit ownership and forum vote target type/channel", async () => {
    const store = new MemoryEventStore();
    const author = generateSecretKey();
    const attacker = generateSecretKey();
    const channelId = "00000000-0000-4000-8000-000000000001";
    const message = signed(author, 9, [["h", channelId]], "message");
    const forumPost = signed(
      author,
      KIND_FORUM_POST,
      [["h", channelId]],
      "post",
    );
    await store.store("relay.example", message, channelId);
    await store.store("relay.example", forumPost, channelId);

    await expect(
      validateEventKind(
        store,
        "relay.example",
        signed(
          author,
          KIND_STREAM_MESSAGE_EDIT,
          [
            ["h", channelId],
            ["e", message.id],
          ],
          "edited",
        ),
        unixNow(),
      ),
    ).resolves.toBeUndefined();
    await expect(
      validateEventKind(
        store,
        "relay.example",
        signed(
          attacker,
          KIND_STREAM_MESSAGE_EDIT,
          [
            ["h", channelId],
            ["e", message.id],
          ],
          "forged",
        ),
        unixNow(),
      ),
    ).rejects.toThrow(/event author/);
    await expect(
      validateEventKind(
        store,
        "relay.example",
        signed(
          author,
          KIND_FORUM_VOTE,
          [
            ["h", channelId],
            ["e", message.id],
          ],
          "+",
        ),
        unixNow(),
      ),
    ).rejects.toThrow(/forum post or comment/);
    await expect(
      validateEventKind(
        store,
        "relay.example",
        signed(
          author,
          KIND_FORUM_VOTE,
          [
            ["h", channelId],
            ["e", forumPost.id],
          ],
          "+",
        ),
        unixNow(),
      ),
    ).resolves.toBeUndefined();
  });

  it("validates diffs, persona slugs/sharing, and reminder schedules", async () => {
    const store = new MemoryEventStore();
    const secret = generateSecretKey();
    const channelId = "00000000-0000-4000-8000-000000000001";
    const now = unixNow();
    await expect(
      validateEventKind(
        store,
        "relay.example",
        signed(
          secret,
          KIND_STREAM_MESSAGE_DIFF,
          [
            ["h", channelId],
            ["commit", "abc1234"],
          ],
          "diff",
        ),
        now,
      ),
    ).rejects.toThrow(/repo tag/);
    await expect(
      validateEventKind(
        store,
        "relay.example",
        signed(
          secret,
          KIND_PERSONA,
          [
            ["d", "Bad Slug"],
            ["shared", "false"],
          ],
          "{}",
        ),
        now,
      ),
    ).rejects.toThrow(/persona/);
    await expect(
      validateEventKind(
        store,
        "relay.example",
        signed(
          secret,
          KIND_EVENT_REMINDER,
          [
            ["d", "reminder"],
            ["not_before", String(now + 3_601)],
          ],
          "opaque",
        ),
        now,
        3_600,
      ),
    ).rejects.toThrow(/too far/);
  });

  it("requires structurally plausible NIP-44 v2 engrams", async () => {
    const store = new MemoryEventStore();
    const secret = generateSecretKey();
    const owner = "ab".repeat(32);
    const dTag = "cd".repeat(32);
    const validCiphertext = Buffer.concat([
      Buffer.from([0x02]),
      Buffer.alloc(98, 7),
    ]).toString("base64");
    await expect(
      validateEventKind(
        store,
        "relay.example",
        signed(
          secret,
          KIND_AGENT_ENGRAM,
          [
            ["d", dTag],
            ["p", owner],
          ],
          validCiphertext,
        ),
        unixNow(),
      ),
    ).resolves.toBeUndefined();
    await expect(
      validateEventKind(
        store,
        "relay.example",
        signed(
          secret,
          KIND_AGENT_ENGRAM,
          [
            ["d", dTag],
            ["p", owner],
          ],
          "not-ciphertext",
        ),
        unixNow(),
      ),
    ).rejects.toThrow(/base64/);
  });

  it("requires a closed agent channel-add policy", async () => {
    const store = new MemoryEventStore();
    const secret = generateSecretKey();
    await expect(
      validateEventKind(
        store,
        "relay.example",
        signed(
          secret,
          KIND_AGENT_PROFILE,
          [],
          JSON.stringify({ channel_add_policy: "owner_only" }),
        ),
        unixNow(),
      ),
    ).resolves.toBeUndefined();
    await expect(
      validateEventKind(
        store,
        "relay.example",
        signed(
          secret,
          KIND_AGENT_PROFILE,
          [],
          JSON.stringify({ channel_add_policy: "surprise" }),
        ),
        unixNow(),
      ),
    ).rejects.toThrow(/channel_add_policy/);
  });
});

function signed(
  secret: Uint8Array,
  kind: number,
  tags: string[][],
  content: string,
) {
  return signNostrEvent(
    {
      content,
      created_at: unixNow(),
      kind,
      tags,
    },
    secret,
  );
}
