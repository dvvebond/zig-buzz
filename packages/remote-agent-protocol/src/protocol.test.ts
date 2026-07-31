import { randomBytes, randomUUID } from "node:crypto";

import { generateSecretKey, getPublicKey } from "nostr-tools/pure";
import { describe, expect, it } from "vitest";

import {
  createRemoteEnvelope,
  mintEnrollmentToken,
  openRemoteEnvelope,
  parseEnrollmentToken,
  redactSensitiveText,
  RemoteProtocolError,
  ReplayGuard,
  validateRemoteRelayUrl,
  verifyEnrollmentToken,
  type CommandPayload,
} from "./index.js";

const NOW = 1_785_250_000;

function commandPayload(sequence = 0): CommandPayload {
  return {
    body: { action: "status" },
    deploymentId: randomUUID(),
    expiresAt: NOW + 30,
    issuedAt: NOW,
    messageId: randomUUID(),
    sequence,
    sessionId: randomBytes(16).toString("hex"),
    type: "command",
    version: 1,
  };
}

describe("BRAP envelope", () => {
  it("round-trips a signed and NIP-44 encrypted command", () => {
    const ownerSecret = generateSecretKey();
    const workerSecret = generateSecretKey();
    const ownerPubkey = getPublicKey(ownerSecret);
    const workerPubkey = getPublicKey(workerSecret);
    const payload = commandPayload();

    const event = createRemoteEnvelope({
      payload,
      recipientPubkey: workerPubkey,
      senderSecretKey: ownerSecret,
      workerPubkey,
    });
    expect(event.content).not.toContain("status");

    expect(
      openRemoteEnvelope({
        event,
        expectedSenderPubkey: ownerPubkey,
        expectedWorkerPubkey: workerPubkey,
        now: NOW,
        recipientPubkey: workerPubkey,
        recipientSecretKey: workerSecret,
        replayGuard: new ReplayGuard(),
      }),
    ).toEqual(payload);
  });

  it("rejects replay without consuming state on an invalid message", () => {
    const ownerSecret = generateSecretKey();
    const workerSecret = generateSecretKey();
    const workerPubkey = getPublicKey(workerSecret);
    const event = createRemoteEnvelope({
      payload: commandPayload(),
      recipientPubkey: workerPubkey,
      senderSecretKey: ownerSecret,
      workerPubkey,
    });
    const guard = new ReplayGuard();
    const input = {
      event,
      expectedSenderPubkey: getPublicKey(ownerSecret),
      expectedWorkerPubkey: workerPubkey,
      now: NOW,
      recipientPubkey: workerPubkey,
      recipientSecretKey: workerSecret,
      replayGuard: guard,
    };

    openRemoteEnvelope(input);
    expect(() => openRemoteEnvelope(input)).toThrowError(
      expect.objectContaining({ code: "REPLAY_DETECTED" }),
    );
  });

  it("keeps accepting ordered commands on a session that idles past one command lifetime", () => {
    const ownerSecret = generateSecretKey();
    const workerSecret = generateSecretKey();
    const ownerPubkey = getPublicKey(ownerSecret);
    const workerPubkey = getPublicKey(workerSecret);
    const guard = new ReplayGuard();
    const sessionId = randomBytes(16).toString("hex");
    const deploymentId = randomUUID();

    const open = (sequence: number, issuedAt: number): void => {
      const event = createRemoteEnvelope({
        payload: {
          body: { action: "status" },
          deploymentId,
          expiresAt: issuedAt + 30,
          issuedAt,
          messageId: randomUUID(),
          sequence,
          sessionId,
          type: "command",
          version: 1,
        },
        recipientPubkey: workerPubkey,
        senderSecretKey: ownerSecret,
        workerPubkey,
      });
      openRemoteEnvelope({
        event,
        expectedSenderPubkey: ownerPubkey,
        expectedWorkerPubkey: workerPubkey,
        now: issuedAt,
        recipientPubkey: workerPubkey,
        recipientSecretKey: workerSecret,
        replayGuard: guard,
      });
    };

    open(0, NOW);
    // A worker that sits idle longer than a single command lifetime must still
    // require the next sequence, not silently restart the session at zero.
    expect(() => open(1, NOW + 600)).not.toThrow();
    expect(() => open(1, NOW + 620)).toThrowError(
      expect.objectContaining({ code: "SEQUENCE_INVALID" }),
    );
  });

  it("rejects a tampered outer event before decryption", () => {
    const ownerSecret = generateSecretKey();
    const workerSecret = generateSecretKey();
    const workerPubkey = getPublicKey(workerSecret);
    const event = createRemoteEnvelope({
      payload: commandPayload(),
      recipientPubkey: workerPubkey,
      senderSecretKey: ownerSecret,
      workerPubkey,
    });

    expect(() =>
      openRemoteEnvelope({
        event: { ...event, content: `${event.content}A` },
        expectedSenderPubkey: getPublicKey(ownerSecret),
        expectedWorkerPubkey: workerPubkey,
        now: NOW,
        recipientPubkey: workerPubkey,
        recipientSecretKey: workerSecret,
        replayGuard: new ReplayGuard(),
      }),
    ).toThrowError(expect.objectContaining({ code: "SIGNATURE_INVALID" }));
  });
});

describe("BRAP enrollment", () => {
  it("mints and verifies an expiring one-time token without storing its secret", () => {
    const minted = mintEnrollmentToken({
      capabilities: ["deploy", "status"],
      community: "buzz.example.com",
      now: NOW,
      ownerPubkey: "a".repeat(64),
    });
    const parsed = parseEnrollmentToken(minted.token);

    expect(minted.record.secretHash).not.toContain(parsed.secret);
    expect(() =>
      verifyEnrollmentToken(minted.token, minted.record, NOW + 10),
    ).not.toThrow();
    expect(() =>
      verifyEnrollmentToken(
        minted.token,
        { ...minted.record, usedAt: NOW + 1 },
        NOW + 10,
      ),
    ).toThrowError(expect.objectContaining({ code: "ENROLLMENT_USED" }));
  });
});

describe("BRAP secure defaults", () => {
  it("requires WSS except for explicitly enabled loopback development", () => {
    expect(validateRemoteRelayUrl("wss://buzz.example.com").protocol).toBe(
      "wss:",
    );
    expect(() => validateRemoteRelayUrl("ws://buzz.example.com")).toThrow(
      RemoteProtocolError,
    );
    expect(validateRemoteRelayUrl("ws://127.0.0.1:3000", true).protocol).toBe(
      "ws:",
    );
  });

  it("redacts configured and recognizable secrets", () => {
    const explicit = "very-sensitive-provider-value";
    const output = redactSensitiveText(
      `api_key=sk-ant-example123456 and ${explicit}`,
      [explicit],
    );
    expect(output).not.toContain("sk-ant-example123456");
    expect(output).not.toContain(explicit);
  });

  it("redacts an enrollment token that reaches a log or error path", () => {
    const minted = mintEnrollmentToken({
      capabilities: ["deploy"],
      community: "buzz.example.com",
      now: NOW,
      ownerPubkey: "a".repeat(64),
    });
    const output = redactSensitiveText(
      `worker enrollment failed for ${minted.token}`,
    );
    expect(output).not.toContain(parseEnrollmentToken(minted.token).secret);
    expect(output).toContain("[REDACTED]");
  });
});
