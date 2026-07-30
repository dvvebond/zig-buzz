import { createHash, randomBytes } from "node:crypto";
import { schnorr } from "@noble/curves/secp256k1.js";
import { describe, expect, it } from "vitest";
import {
  parseArmor,
  signPayload,
  validateConditions,
  verifyArmored,
  type OwnerAttestation,
} from "./index.js";

function key(): Uint8Array {
  while (true) {
    const value = randomBytes(32);
    try {
      schnorr.getPublicKey(value);
      return value;
    } catch {}
  }
}

describe("NIP-GS signing", () => {
  it("signs and verifies the canonical armored envelope", () => {
    const secretKey = key();
    const payload = Buffer.from("tree deadbeef\n\ncommit message\n");
    const signed = signPayload({
      payload,
      secretKey,
      timestamp: 1_700_000_000,
      keyId: Buffer.from(schnorr.getPublicKey(secretKey)).toString("hex"),
    });
    expect(JSON.parse(parseArmor(signed.armored))).toEqual(signed.envelope);
    expect(verifyArmored(signed.armored, payload)).toMatchObject({
      ownerAttestationStatus: "none",
    });
    expect(() =>
      verifyArmored(signed.armored, Buffer.from("tampered")),
    ).toThrow(/verification failed/);
  });

  it("binds and verifies an owner attestation", () => {
    const agent = key();
    const owner = key();
    const agentPubkey = Buffer.from(schnorr.getPublicKey(agent)).toString(
      "hex",
    );
    const ownerPubkey = Buffer.from(schnorr.getPublicKey(owner)).toString(
      "hex",
    );
    const conditions = "created_at>1600000000&created_at<1800000000";
    const digest = createHash("sha256")
      .update(`nostr:agent-auth:${agentPubkey}:${conditions}`)
      .digest();
    const oa: OwnerAttestation = [
      ownerPubkey,
      conditions,
      Buffer.from(schnorr.sign(digest, owner)).toString("hex"),
    ];
    const signed = signPayload({
      payload: Buffer.from("payload"),
      secretKey: agent,
      ownerAttestation: oa,
      timestamp: 1_700_000_000,
    });
    expect(
      verifyArmored(signed.armored, Buffer.from("payload"))
        .ownerAttestationStatus,
    ).toBe("valid");
  });

  it("rejects ambiguous condition grammar and malformed armor", () => {
    expect(validateConditions("kind=01")).toBe(false);
    expect(validateConditions("created_at<10&&kind=1")).toBe(false);
    expect(() =>
      parseArmor(
        "-----BEGIN SIGNED MESSAGE-----\ndGVzdA==\n-----END SIGNED MESSAGE-----",
      ),
    ).toThrow(/newline/);
  });
});
