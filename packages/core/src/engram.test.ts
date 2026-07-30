import { describe, expect, it } from "vitest";

import {
  buildEngramEvent,
  engramConversationKey,
  engramDTag,
  normalizeEngramSlug,
  parseEngramBody,
  serializeEngramBody,
  validateAndDecryptEngram,
} from "./engram.js";
import { getPublicKey } from "nostr-tools/pure";

const AGENT = secret(1);
const OWNER = secret(2);

describe("NIP-AE engrams", () => {
  it("matches the Rust reference HMAC vectors", () => {
    const key = engramConversationKey(AGENT, getPublicKey(OWNER));
    expect(toHex(key)).toBe(
      "c41c775356fd92eadc63ff5a0dc1da211b268cbea22316767095b2871ea1412d",
    );
    expect(engramDTag(key, "core")).toBe(
      "bdc233238ffe52e272b44cc233c8f33a2bc510b08be04495b225964283be4a90",
    );
    expect(engramDTag(key, "mem/example")).toBe(
      "72d4f9629106451505d7d341ea85bb3ebad4f654fcfd2aad100d5a35f8a85cba",
    );
  });

  it("serializes byte-exact bodies and rejects duplicate keys", () => {
    expect(serializeEngramBody({ slug: "mem/example", value: "hello" })).toBe(
      '{"slug":"mem/example","value":"hello"}',
    );
    expect(() =>
      parseEngramBody('{"slug":"mem/x","slug":"mem/y","value":"v"}'),
    ).toThrow("duplicate");
  });

  it("builds, signs, decrypts, and validates an engram", () => {
    const event = buildEngramEvent({
      agentSecretKey: AGENT,
      body: { slug: "mem/example", value: "hello" },
      createdAt: 1_700_000_000,
      ownerPubkey: getPublicKey(OWNER),
    });
    expect(
      validateAndDecryptEngram({
        event,
        expectedAgent: getPublicKey(AGENT),
        expectedOwner: getPublicKey(OWNER),
        mySecretKey: OWNER,
        theirPubkey: getPublicKey(AGENT),
      }),
    ).toEqual({ slug: "mem/example", value: "hello" });
  });

  it("normalizes safe shorthand slugs", () => {
    expect(normalizeEngramSlug("notes/today")).toBe("mem/notes/today");
    expect(() => normalizeEngramSlug("../escape")).toThrow();
  });
});

function secret(lastByte: number): Uint8Array {
  const value = new Uint8Array(32);
  value[31] = lastByte;
  return value;
}

function toHex(value: Uint8Array): string {
  return Array.from(value, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}
