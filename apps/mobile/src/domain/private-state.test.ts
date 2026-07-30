import { generateSecretKey, getPublicKey } from "nostr-tools";
import { describe, expect, it } from "vitest";

import { signNostrEvent } from "@buzz/core";

import { decryptPrivateState, encryptPrivateState } from "./private-state";

describe("encrypted client state", () => {
  it("round-trips a signed self-encrypted payload", () => {
    const secretKey = generateSecretKey();
    const pubkey = getPublicKey(secretKey);
    const content = encryptPrivateState(secretKey, pubkey, {
      sections: ["work"],
      version: 1,
    });
    const event = signNostrEvent(
      {
        content,
        created_at: 1_700_000_000,
        kind: 30_078,
        tags: [["d", "channel-sections"]],
      },
      secretKey,
    );
    expect(decryptPrivateState(secretKey, event, pubkey)).toEqual({
      sections: ["work"],
      version: 1,
    });
    secretKey.fill(0);
  });
});
