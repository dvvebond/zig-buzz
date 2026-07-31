import { KIND_PUSH_LEASE, signNostrEvent } from "@buzz/core";
import { generateSecretKey, getPublicKey } from "nostr-tools/pure";
import { nip44 } from "nostr-tools";
import { describe, expect, it } from "vitest";

import {
  parsePushLeaseEvent,
  type PushLeaseReplacement,
} from "./push-lease.js";

describe("NIP-PL lease validation", () => {
  it("decrypts a strict, self-narrowed active lease", () => {
    const relaySecret = generateSecretKey();
    const authorSecret = generateSecretKey();
    const author = getPublicKey(authorSecret);
    const now = 1_700_000_000;
    const parsed = parsePushLeaseEvent(
      leaseEvent(
        authorSecret,
        relaySecret,
        {
          active: true,
          app_profile: "buzz-ios-production",
          endpoint: "opaque-gateway-grant",
          generation: 7,
          origin: "wss://tenant.example",
          subscriptions: [
            {
              class: "default",
              filter: { "#p": [author], kinds: [9, 1059] },
              ignore: [{ "#e": ["ab".repeat(32)], kinds: [9] }],
              suppress: { p_tags_max: 20 },
            },
          ],
          transport: "apns",
          v: 1,
        },
        now,
      ),
      now,
      "relay-v1",
      relaySecret,
      "wss://tenant.example",
    );
    expect(parsed).toMatchObject<PushLeaseReplacement>({
      active: true,
      appProfile: "buzz-ios-production",
      endpointGrant: "opaque-gateway-grant",
      expiresAt: now + 3_600,
      generation: 7,
      installationId: "installation-1",
    });
    expect(parsed.subscriptions?.[0]).toEqual({
      class: "default",
      filter: { "#p": [author], kinds: [9, 1059] },
      ignore: [{ "#e": ["ab".repeat(32)], kinds: [9] }],
      suppress: { p_tags_max: 20 },
    });
  });

  it("rejects duplicate plaintext keys and public-tag ambiguity", () => {
    const relaySecret = generateSecretKey();
    const authorSecret = generateSecretKey();
    const now = 1_700_000_000;
    const duplicatePlaintext =
      '{"v":1,"origin":"wss://tenant.example","generation":1,"generation":2,"active":false}';
    expect(() =>
      parsePushLeaseEvent(
        leaseEvent(authorSecret, relaySecret, duplicatePlaintext, now),
        now,
        "relay-v1",
        relaySecret,
        "wss://tenant.example",
      ),
    ).toThrow(/duplicate JSON object key/);
    const ambiguous = leaseEvent(
      authorSecret,
      relaySecret,
      {
        active: false,
        generation: 1,
        origin: "wss://tenant.example",
        v: 1,
      },
      now,
    );
    expect(() =>
      parsePushLeaseEvent(
        {
          ...ambiguous,
          tags: [...ambiguous.tags, ["d", "other"]],
        },
        now,
        "relay-v1",
        relaySecret,
        "wss://tenant.example",
      ),
    ).toThrow(/duplicate push lease public tag/);
  });

  it("rejects recipient timing leaks and noncanonical channels", () => {
    const relaySecret = generateSecretKey();
    const authorSecret = generateSecretKey();
    const otherAuthor = getPublicKey(generateSecretKey());
    const now = 1_700_000_000;
    for (const filter of [
      { "#p": [otherAuthor], kinds: [1059] },
      { "#h": ["A39BEE95-83B9-4B91-A261-050C5DB877BA"], kinds: [9] },
      { kinds: [9] },
    ]) {
      expect(() =>
        parsePushLeaseEvent(
          leaseEvent(
            authorSecret,
            relaySecret,
            {
              active: true,
              app_profile: "buzz-ios-sandbox",
              endpoint: "grant",
              generation: 1,
              origin: "wss://tenant.example",
              subscriptions: [{ class: "silent", filter }],
              transport: "apns",
              v: 1,
            },
            now,
          ),
          now,
          "relay-v1",
          relaySecret,
          "wss://tenant.example",
        ),
      ).toThrow();
    }
  });
});

function leaseEvent(
  authorSecret: Uint8Array,
  relaySecret: Uint8Array,
  plaintext: Record<string, unknown> | string,
  now: number,
) {
  const conversationKey = nip44.v2.utils.getConversationKey(
    authorSecret,
    getPublicKey(relaySecret),
  );
  return signNostrEvent(
    {
      content: nip44.v2.encrypt(
        typeof plaintext === "string" ? plaintext : JSON.stringify(plaintext),
        conversationKey,
      ),
      created_at: now,
      kind: KIND_PUSH_LEASE,
      tags: [
        ["d", "installation-1"],
        ["expiration", String(now + 3_600)],
        ["exec", "relay-v1"],
      ],
    },
    authorSecret,
  );
}
