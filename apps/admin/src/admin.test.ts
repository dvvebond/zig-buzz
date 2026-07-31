import { nip19 } from "nostr-tools";
import { generateSecretKey, getPublicKey } from "nostr-tools/pure";
import { describe, expect, it } from "vitest";

import { parsePubkey, validateMutableRole } from "./admin.js";

describe("admin input validation", () => {
  it("normalizes hex and npub public keys", () => {
    const pubkey = getPublicKey(generateSecretKey());
    expect(parsePubkey(pubkey.toUpperCase())).toBe(pubkey);
    expect(parsePubkey(nip19.npubEncode(pubkey))).toBe(pubkey);
    expect(() => parsePubkey("not-a-key")).toThrow();
  });

  it("permits only mutable roles", () => {
    expect(validateMutableRole("member")).toBe("member");
    expect(validateMutableRole("admin")).toBe("admin");
    expect(() => validateMutableRole("owner")).toThrow(/cannot be assigned/);
    expect(() => validateMutableRole("bot")).toThrow();
  });
});
