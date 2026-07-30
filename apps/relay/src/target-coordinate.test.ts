import { generateSecretKey, getPublicKey } from "nostr-tools/pure";
import { describe, expect, it } from "vitest";
import {
  KIND_DELETION,
  KIND_NIP29_DELETE_EVENT,
  KIND_REACTION,
  KIND_STREAM_MESSAGE,
  signNostrEvent,
  unixNow,
} from "@buzz/core";
import { MemoryEventStore } from "@buzz/db";

import { resolveTargetCoordinate } from "./target-coordinate.js";

describe("target-derived coordinates", () => {
  it("derives a reaction coordinate from the stored target, not a claimed h tag", async () => {
    const store = new MemoryEventStore();
    const secret = generateSecretKey();
    const targetChannel = "00000000-0000-4000-8000-000000000001";
    const forgedChannel = "00000000-0000-4000-8000-000000000002";
    const target = signNostrEvent(
      {
        content: "target",
        created_at: unixNow(),
        kind: KIND_STREAM_MESSAGE,
        tags: [["h", targetChannel]],
      },
      secret,
    );
    await store.store("relay.example", target, targetChannel);
    const reaction = signNostrEvent(
      {
        content: "👍",
        created_at: unixNow(),
        kind: KIND_REACTION,
        tags: [
          ["e", target.id],
          ["h", forgedChannel],
        ],
      },
      secret,
    );

    await expect(
      resolveTargetCoordinate(store, "relay.example", reaction),
    ).resolves.toBe(targetChannel);
  });

  it("rejects missing targets and overlong reaction values", async () => {
    const store = new MemoryEventStore();
    const secret = generateSecretKey();
    const missing = signNostrEvent(
      {
        content: "+",
        created_at: unixNow(),
        kind: KIND_REACTION,
        tags: [["e", "ab".repeat(32)]],
      },
      secret,
    );
    await expect(
      resolveTargetCoordinate(store, "relay.example", missing),
    ).rejects.toThrow(/not found/);

    const target = signNostrEvent(
      {
        content: "target",
        created_at: unixNow(),
        kind: 1,
        tags: [],
      },
      secret,
    );
    await store.store("relay.example", target);
    const oversized = signNostrEvent(
      {
        content: "x".repeat(65),
        created_at: unixNow(),
        kind: KIND_REACTION,
        tags: [["e", target.id]],
      },
      secret,
    );
    await expect(
      resolveTargetCoordinate(store, "relay.example", oversized),
    ).rejects.toThrow(/exceeds 64/);
  });

  it("authorizes exact self-deletions and derives the target channel", async () => {
    const store = new MemoryEventStore();
    const author = generateSecretKey();
    const attacker = generateSecretKey();
    const channelId = "00000000-0000-4000-8000-000000000001";
    const target = signNostrEvent(
      {
        content: "target",
        created_at: unixNow(),
        kind: KIND_STREAM_MESSAGE,
        tags: [["h", channelId]],
      },
      author,
    );
    await store.store("relay.example", target, channelId);
    const deletion = (secret: Uint8Array, kind: number = KIND_DELETION) =>
      signNostrEvent(
        {
          content: "",
          created_at: unixNow(),
          kind,
          tags:
            kind === KIND_NIP29_DELETE_EVENT
              ? [
                  ["h", channelId],
                  ["e", target.id],
                ]
              : [["e", target.id]],
        },
        secret,
      );

    await expect(
      resolveTargetCoordinate(store, "relay.example", deletion(author)),
    ).resolves.toBe(channelId);
    await expect(
      resolveTargetCoordinate(store, "relay.example", deletion(attacker)),
    ).rejects.toThrow(/event author/);
    await expect(
      resolveTargetCoordinate(
        store,
        "relay.example",
        deletion(attacker, KIND_NIP29_DELETE_EVENT),
      ),
    ).rejects.toThrow(/channel owner\/admin/);
  });

  it("trusts attributed authors only when the stored event is relay-signed", async () => {
    const store = new MemoryEventStore();
    const relay = generateSecretKey();
    const author = generateSecretKey();
    const attacker = generateSecretKey();
    const relayPubkey = getPublicKey(relay);
    const authorPubkey = getPublicKey(author);
    const channelId = "00000000-0000-4000-8000-000000000003";
    const relaySigned = signNostrEvent(
      {
        content: "REST-created message",
        created_at: unixNow(),
        kind: KIND_STREAM_MESSAGE,
        tags: [
          ["h", channelId],
          ["p", authorPubkey],
        ],
      },
      relay,
    );
    await store.store("relay.example", relaySigned, channelId);
    const deletion = signNostrEvent(
      {
        content: "",
        created_at: unixNow(),
        kind: KIND_NIP29_DELETE_EVENT,
        tags: [
          ["h", channelId],
          ["e", relaySigned.id],
        ],
      },
      author,
    );
    await expect(
      resolveTargetCoordinate(store, "relay.example", deletion, relayPubkey),
    ).resolves.toBe(channelId);

    const forgedAttribution = signNostrEvent(
      {
        content: "attacker-signed message",
        created_at: unixNow() + 1,
        kind: KIND_STREAM_MESSAGE,
        tags: [
          ["h", channelId],
          ["actor", authorPubkey],
        ],
      },
      attacker,
    );
    await store.store("relay.example", forgedAttribution, channelId);
    const forgedDeletion = signNostrEvent(
      {
        content: "",
        created_at: unixNow() + 1,
        kind: KIND_NIP29_DELETE_EVENT,
        tags: [
          ["h", channelId],
          ["e", forgedAttribution.id],
        ],
      },
      author,
    );
    await expect(
      resolveTargetCoordinate(
        store,
        "relay.example",
        forgedDeletion,
        relayPubkey,
      ),
    ).rejects.toThrow(/channel owner\/admin/);
  });
});
