import {
  KIND_GIFT_WRAP,
  KIND_STREAM_MESSAGE,
  signNostrEvent,
} from "@buzz/core";
import { generateSecretKey, getPublicKey } from "nostr-tools/pure";
import { describe, expect, it } from "vitest";

import { matchPushSubscriptions } from "./push-runtime.js";
import type { PushSubscription } from "./push-lease.js";

describe("push matcher authorization", () => {
  it("chooses the highest matching class after ignore and suppression", () => {
    const owner = getPublicKey(generateSecretKey());
    const event = signedEvent(KIND_STREAM_MESSAGE, [
      ["p", owner],
      ["p", getPublicKey(generateSecretKey())],
    ]);
    const subscriptions: PushSubscription[] = [
      {
        class: "silent",
        filter: { "#p": [owner], kinds: [KIND_STREAM_MESSAGE] },
        ignore: [],
      },
      {
        class: "time_sensitive",
        filter: { "#p": [owner], kinds: [KIND_STREAM_MESSAGE] },
        ignore: [],
        suppress: { p_tags_max: 1 },
      },
      {
        class: "default",
        filter: { "#p": [owner], kinds: [KIND_STREAM_MESSAGE] },
        ignore: [{ "#e": ["ff".repeat(32)], kinds: [KIND_STREAM_MESSAGE] }],
      },
    ];
    expect(
      matchPushSubscriptions({
        author: owner,
        event,
        leaseExpiresAt: event.created_at + 10_000,
        member: true,
        now: event.created_at,
        subscriptions,
      }),
    ).toEqual({
      class: "default",
      expiresAt: event.created_at + 3_600,
    });
  });

  it("fails closed for private-channel membership and gift-wrap recipients", () => {
    const owner = getPublicKey(generateSecretKey());
    const other = getPublicKey(generateSecretKey());
    const message = signedEvent(KIND_STREAM_MESSAGE, [["p", owner]]);
    const subscription: PushSubscription = {
      class: "default",
      filter: { "#p": [owner], kinds: [KIND_STREAM_MESSAGE] },
      ignore: [],
    };
    expect(
      matchPushSubscriptions({
        author: owner,
        event: message,
        leaseExpiresAt: message.created_at + 100,
        member: false,
        now: message.created_at,
        subscriptions: [subscription],
      }),
    ).toBeUndefined();

    const giftWrap = signedEvent(KIND_GIFT_WRAP, [["p", other]]);
    expect(
      matchPushSubscriptions({
        author: owner,
        event: giftWrap,
        leaseExpiresAt: giftWrap.created_at + 100,
        member: true,
        now: giftWrap.created_at,
        subscriptions: [
          {
            class: "default",
            filter: { "#p": [owner], kinds: [KIND_GIFT_WRAP] },
            ignore: [],
          },
        ],
      }),
    ).toBeUndefined();
  });

  it("drops events whose useful or lease lifetime has ended", () => {
    const owner = getPublicKey(generateSecretKey());
    const event = signedEvent(KIND_STREAM_MESSAGE, [["p", owner]]);
    expect(
      matchPushSubscriptions({
        author: owner,
        event,
        leaseExpiresAt: event.created_at + 10,
        member: true,
        now: event.created_at + 10,
        subscriptions: [
          {
            class: "default",
            filter: { "#p": [owner], kinds: [KIND_STREAM_MESSAGE] },
            ignore: [],
          },
        ],
      }),
    ).toBeUndefined();
  });
});

function signedEvent(kind: number, tags: string[][]) {
  return signNostrEvent(
    {
      content: "opaque",
      created_at: 1_700_000_000,
      kind,
      tags,
    },
    generateSecretKey(),
  );
}
