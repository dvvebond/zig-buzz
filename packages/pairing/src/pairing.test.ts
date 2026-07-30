import { describe, expect, it } from "vitest";
import { verifyNostrEvent } from "@buzz/core";

import {
  PairingSession,
  decodePairingQr,
  deriveSas,
  deriveSessionId,
  deriveTranscriptHash,
  encodePairingQr,
  formatSas,
} from "./index.js";

describe("NIP-AB derivation", () => {
  it("matches the pinned session, SAS, and transcript vectors", () => {
    const sessionSecret = hex(
      "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2",
    );
    const sessionId = deriveSessionId(sessionSecret);
    expect(toHex(sessionId)).toBe(
      "fb357d0f8e8d5a5ba3b2a91cb18c119e1567b07ffa38cdebb73e68df78f5a380",
    );
    const sas = deriveSas(
      hex("9b4b6d6990713d89d6d9982e506ee1bbcde6f05c54d9d2978696e8a7274d4408"),
      sessionSecret,
    );
    expect(toHex(sas.input)).toBe(
      "e8b03a329f3a0ac37fe7fbe929171e14b72812be67e33c5d6e193543c41798d3",
    );
    expect(formatSas(sas.code)).toBe("863346");
    expect(
      toHex(
        deriveTranscriptHash({
          sasInput: sas.input,
          sessionId,
          sessionSecret,
          sourcePubkey: hex(
            "199e64ca60662cb2d6e91d16cb065be51ad74a6ee5f8c5b0fdc53d246611ed9a",
          ),
          targetPubkey: hex(
            "89a9fa762105d0aee2b19678246fe7b823aabbc4f4bf691a1ce8a70fcd36d6e4",
          ),
        }),
      ),
    ).toBe("d662818ff8911fc60a2d025f8b8b4756107104e85888dd202d28db5ca2cf28d3");
  });
});

describe("NIP-AB session", () => {
  it("authenticates relays only with the ephemeral pairing identity", () => {
    const { session } = PairingSession.source("wss://relay.example");
    const event = session.createAuth("relay-challenge", "wss://relay.example");
    expect(event.pubkey).toBe(session.pubkey);
    expect(event.kind).toBe(22_242);
    expect(event.tags).toEqual([
      ["relay", "wss://relay.example/"],
      ["challenge", "relay-challenge"],
    ]);
    expect(verifyNostrEvent(event)).toBe(true);
    session.dispose();
  });

  it("round-trips QR and completes a mutually confirmed encrypted transfer", () => {
    const source = PairingSession.source("wss://relay.example");
    const uri = encodePairingQr(source.qr);
    const qr = decodePairingQr(uri);
    const target = PairingSession.target(qr);
    expect(source.session.handleOffer(target.offer)).toBe(
      target.session.sasCode,
    );
    const confirmation = source.session.confirmSas();
    expect(target.session.handleSasConfirm(confirmation)).toBe(
      source.session.sasCode,
    );
    target.session.confirmTargetSas();
    const payload = source.session.sendPayload("nsec", "nsec1example");
    expect(target.session.handlePayload(payload)).toEqual({
      payload: "nsec1example",
      type: "nsec",
    });
    source.session.handleComplete(target.session.sendComplete());
    expect(source.session.state).toBe("completed");
    expect(target.session.state).toBe("completed");
    source.session.dispose();
    target.session.dispose();
    qr.sessionSecret.fill(0);
    source.qr.sessionSecret.fill(0);
  });

  it("requires explicit target confirmation before accepting payload", () => {
    const source = PairingSession.source("wss://relay.example");
    const target = PairingSession.target(source.qr);
    source.session.handleOffer(target.offer);
    target.session.handleSasConfirm(source.session.confirmSas());
    const payload = source.session.sendPayload("custom", "secret");
    expect(() => target.session.handlePayload(payload)).toThrow(
      /expected target\/transferring/,
    );
  });
});

function hex(value: string): Uint8Array {
  return Uint8Array.from(Buffer.from(value, "hex"));
}

function toHex(value: Uint8Array): string {
  return Buffer.from(value).toString("hex");
}
