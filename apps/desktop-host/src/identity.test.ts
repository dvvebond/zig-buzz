import { createHash } from "node:crypto";

import { schnorr } from "@noble/curves/secp256k1.js";
import {
  generateSecretKey,
  getPublicKey,
  nip44,
  verifyEvent,
} from "nostr-tools";
import { describe, expect, it } from "vitest";

import { IdentityService } from "./identity.js";

describe("IdentityService", () => {
  it("creates, persists, signs, exports, and imports a Nostr identity", async () => {
    let saved:
      | { identitySecretHex: string; settings: Record<string, unknown> }
      | undefined;
    const identity = IdentityService.create(undefined, async (state) => {
      saved = structuredClone(state);
    });

    expect(identity.info().lost).toBe(true);
    const durable = await identity.persistCurrent();
    expect(durable.lost).toBe(false);
    expect(saved?.identitySecretHex).toMatch(/^[0-9a-f]{64}$/);

    const event = identity.sign({
      content: "hello",
      createdAt: 1_700_000_000,
      kind: 1,
      tags: [["t", "buzz"]],
    });
    expect(event.pubkey).toBe(durable.pubkey);
    expect(verifyEvent(event)).toBe(true);

    const second = IdentityService.create(undefined, async () => undefined);
    await second.import(identity.nsec());
    expect(second.info().pubkey).toBe(durable.pubkey);
  });

  it("preserves the exact valid NIP-42 relay URL in the signed tag", () => {
    const identity = IdentityService.create(undefined, async () => undefined);
    const event = identity.createAuth("challenge", "ws://127.0.0.1:3000");
    expect(event.tags).toContainEqual(["relay", "ws://127.0.0.1:3000"]);
    expect(event.tags).toContainEqual(["challenge", "challenge"]);
    expect(verifyEvent(event)).toBe(true);
  });

  it("round trips NIP-44 encryption to self and rejects oversized content", () => {
    const identity = IdentityService.create(undefined, async () => undefined);
    const ciphertext = identity.encryptToSelf("private state");
    expect(identity.decryptFromSelf(ciphertext)).toBe("private state");
    expect(() =>
      identity.sign({
        content: "x".repeat(256 * 1024 + 1),
        kind: 1,
        tags: [],
      }),
    ).toThrow(/exceeds/);
  });

  it("creates a verifiable domain-separated NIP-OA owner credential", () => {
    const identity = IdentityService.create(undefined, async () => undefined);
    const agentPubkey = getPublicKey(generateSecretKey());
    const tag = identity.ownerAuthTag(agentPubkey);
    const digest = createHash("sha256")
      .update(`nostr:agent-auth:${agentPubkey}:`, "utf8")
      .digest();

    expect(tag.slice(0, 3)).toEqual(["auth", identity.info().pubkey, ""]);
    expect(
      schnorr.verify(
        Buffer.from(tag[3], "hex"),
        digest,
        Buffer.from(tag[1], "hex"),
      ),
    ).toBe(true);
  });

  it("builds encrypted, signed observer control frames for one agent", () => {
    const identity = IdentityService.create(undefined, async () => undefined);
    const agentSecret = generateSecretKey();
    const agentPubkey = getPublicKey(agentSecret);
    const event = identity.buildObserverControlEvent(agentPubkey, {
      action: "cancel",
      turnId: "turn-1",
    });
    expect(verifyEvent(event)).toBe(true);
    expect(event.kind).toBe(24_200);
    expect(event.tags).toEqual([
      ["p", agentPubkey],
      ["agent", agentPubkey],
      ["frame", "control"],
    ]);
    const conversationKey = nip44.v2.utils.getConversationKey(
      agentSecret,
      identity.info().pubkey,
    );
    expect(
      JSON.parse(nip44.v2.decrypt(event.content, conversationKey)),
    ).toEqual({
      action: "cancel",
      turnId: "turn-1",
    });
  });

  it("signs a tightly bound HTTPS identity challenge", () => {
    const identity = IdentityService.create(undefined, async () => undefined);
    const event = identity.signIdentityBinding({
      challengeId: "123e4567-e89b-42d3-a456-426614174000",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      nonce: "a".repeat(43),
      origin: "https://accounts.example/",
      verificationCode: "123456",
    });
    expect(verifyEvent(event)).toBe(true);
    expect(event.kind).toBe(24_243);
    expect(event.tags).toContainEqual(["audience", "buzz:nostr-identity"]);
    expect(() =>
      identity.signIdentityBinding({
        challengeId: "123e4567-e89b-42d3-a456-426614174000",
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        nonce: "a".repeat(43),
        origin: "http://accounts.example/",
        verificationCode: "123456",
      }),
    ).toThrow(/HTTPS/);
  });
});
