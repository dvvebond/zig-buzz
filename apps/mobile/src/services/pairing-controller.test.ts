import { nip19 } from "nostr-tools";
import { generateSecretKey } from "nostr-tools/pure";
import { describe, expect, it } from "vitest";

import { decodePairingQr, encodePairingQr } from "@buzz/pairing";

describe("mobile pairing protocol", () => {
  it("uses a bounded NIP-AB QR payload", () => {
    const qr = {
      relays: ["wss://relay.example"],
      sessionSecret: generateSecretKey(),
      sourcePubkey: "a".repeat(64),
      version: 1 as const,
    };
    expect(decodePairingQr(encodePairingQr(qr))).toEqual(qr);
  });

  it("encodes valid Nostr device keys", () => {
    const secret = generateSecretKey();
    const encoded = nip19.nsecEncode(secret);
    expect(nip19.decode(encoded).type).toBe("nsec");
    secret.fill(0);
  });
});
