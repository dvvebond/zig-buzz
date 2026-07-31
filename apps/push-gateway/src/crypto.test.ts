import { describe, expect, it } from "vitest";

import { GrantKeyring, TokenKeyring } from "./crypto.js";

describe("push gateway keyrings", () => {
  it("rotates grants while authenticating the routing key id", () => {
    const old = new GrantKeyring([{ id: "old", key: Buffer.alloc(32, 7) }]);
    const grant = {
      app_profile: "buzz-ios-production" as const,
      delegation_id: "00000000-0000-0000-0000-000000000000",
      endpoint_epoch: 1,
      expires_at: 99,
      generation: 2,
      relay_pubkey: "11".repeat(32),
      v: 1 as const,
    };
    const sealed = old.issue(grant);
    const rotated = new GrantKeyring([
      { id: "current", key: Buffer.alloc(32, 8) },
      { id: "old", key: Buffer.alloc(32, 7) },
    ]);
    expect(rotated.open(sealed)).toEqual(grant);
    expect(() => rotated.open(sealed.replace("old.", "current."))).toThrow();
  });

  it("keeps APNs token custody separate and tamper-evident", () => {
    const ring = new TokenKeyring([{ id: "token", key: Buffer.alloc(32, 9) }]);
    const sealed = ring.seal(Buffer.from("device-token"));
    expect(ring.open(sealed).toString()).toBe("device-token");
    const tampered = Buffer.from(sealed);
    tampered[tampered.length - 1] =
      (tampered[tampered.length - 1] as number) ^ 1;
    expect(() => ring.open(tampered)).toThrow();
  });
});
