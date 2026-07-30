import { generateSecretKey, getPublicKey } from "nostr-tools/pure";
import { describe, expect, it } from "vitest";

import {
  buildObserverFrame,
  decryptObserverPayload,
  encryptObserverPayload,
  observerContentLooksEncrypted,
} from "./observer.js";

describe("observer frames", () => {
  it("round-trips owner-encrypted telemetry", () => {
    const agent = generateSecretKey();
    const owner = generateSecretKey();
    const encrypted = encryptObserverPayload(agent, getPublicKey(owner), {
      kind: "turn_started",
      turnId: "turn-1",
    });
    expect(observerContentLooksEncrypted(encrypted)).toBe(true);
    const event = buildObserverFrame({
      agentPubkey: getPublicKey(agent),
      content: encrypted,
      frame: "telemetry",
      recipientPubkey: getPublicKey(owner),
      secretKey: agent,
    });
    expect(event.kind).toBe(24_200);
    expect(decryptObserverPayload(owner, event)).toEqual({
      kind: "turn_started",
      turnId: "turn-1",
    });
  });

  it("rejects plaintext observer content", () => {
    expect(observerContentLooksEncrypted("not encrypted")).toBe(false);
  });
});
