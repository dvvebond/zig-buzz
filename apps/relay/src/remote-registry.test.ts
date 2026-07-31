import { randomBytes, randomUUID } from "node:crypto";

import { generateSecretKey, getPublicKey } from "nostr-tools/pure";
import { describe, expect, it } from "vitest";
import {
  createRemoteEnvelope,
  type AckPayload,
  type EnrollmentPayload,
} from "@buzz/remote-agent-protocol";

import { RemoteRegistry } from "./remote-registry.js";

const NOW = 1_785_250_000;

describe("remote worker registry", () => {
  it("atomically consumes enrollment and requires owner approval", async () => {
    const registry = new RemoteRegistry();
    const ownerSecret = generateSecretKey();
    const workerSecret = generateSecretKey();
    const ownerPubkey = getPublicKey(ownerSecret);
    const workerPubkey = getPublicKey(workerSecret);
    const minted = await registry.mint({
      capabilities: ["deploy", "status"],
      community: "buzz.example.com",
      now: NOW,
      ownerPubkey,
    });
    const sessionId = randomBytes(16).toString("hex");
    const enrollmentPayload: EnrollmentPayload = {
      body: {
        capabilities: ["deploy", "status"],
        challenge: randomBytes(32).toString("hex"),
        community: "buzz.example.com",
        enrollmentId: minted.record.id,
        ownerPubkey,
        workerName: "worker-1",
        workerPubkey,
        workerVersion: "0.1.0",
      },
      deploymentId: minted.record.id,
      expiresAt: NOW + 30,
      issuedAt: NOW,
      messageId: randomUUID(),
      sequence: 0,
      sessionId,
      type: "enrollment",
      version: 1,
    };
    const enrollmentEvent = createRemoteEnvelope({
      payload: enrollmentPayload,
      recipientPubkey: ownerPubkey,
      senderSecretKey: workerSecret,
      workerPubkey,
    });

    const redeemed = await registry.redeem({
      authenticatedPubkey: workerPubkey,
      community: "buzz.example.com",
      event: enrollmentEvent,
      now: NOW,
      token: minted.token,
    });
    await expect(
      registry.authorizedWorker(workerPubkey, "buzz.example.com"),
    ).resolves.toBeUndefined();
    const retried = await registry.redeem({
      authenticatedPubkey: workerPubkey,
      community: "buzz.example.com",
      event: enrollmentEvent,
      now: NOW,
      token: minted.token,
    });
    expect(retried.binding.workerPubkey).toBe(workerPubkey);
    await expect(
      registry.authorizedWorker(workerPubkey, "buzz.example.com"),
    ).resolves.toBeUndefined();

    const ackPayload: AckPayload = {
      body: {
        commandMessageId: enrollmentPayload.messageId,
        outcome: "completed",
      },
      deploymentId: minted.record.id,
      expiresAt: NOW + 30,
      issuedAt: NOW,
      messageId: randomUUID(),
      sequence: 0,
      sessionId,
      type: "ack",
      version: 1,
    };
    const approvalEvent = createRemoteEnvelope({
      payload: ackPayload,
      recipientPubkey: workerPubkey,
      senderSecretKey: ownerSecret,
      workerPubkey,
    });
    const approved = await registry.approve({
      authenticatedOwnerPubkey: ownerPubkey,
      community: "buzz.example.com",
      enrollmentId: minted.record.id,
      event: approvalEvent,
      now: NOW + 1,
      workerPubkey,
    });

    expect(approved.binding.enrollmentEventId).toBe(redeemed.event.id);
    await expect(
      registry.authorizedWorker(workerPubkey, "buzz.example.com"),
    ).resolves.toMatchObject({ approvedAt: NOW + 1 });
  });

  it("cannot redeem a token from another authenticated worker", async () => {
    const registry = new RemoteRegistry();
    const ownerSecret = generateSecretKey();
    const workerSecret = generateSecretKey();
    const attackerSecret = generateSecretKey();
    const ownerPubkey = getPublicKey(ownerSecret);
    const workerPubkey = getPublicKey(workerSecret);
    const attackerPubkey = getPublicKey(attackerSecret);
    const minted = await registry.mint({
      capabilities: ["status"],
      community: "buzz.example.com",
      now: NOW,
      ownerPubkey,
    });
    const payload: EnrollmentPayload = {
      body: {
        capabilities: ["status"],
        challenge: randomBytes(32).toString("hex"),
        community: "buzz.example.com",
        enrollmentId: minted.record.id,
        ownerPubkey,
        workerName: "worker-1",
        workerPubkey,
        workerVersion: "0.1.0",
      },
      deploymentId: minted.record.id,
      expiresAt: NOW + 30,
      issuedAt: NOW,
      messageId: randomUUID(),
      sequence: 0,
      sessionId: randomBytes(16).toString("hex"),
      type: "enrollment",
      version: 1,
    };
    const event = createRemoteEnvelope({
      payload,
      recipientPubkey: ownerPubkey,
      senderSecretKey: workerSecret,
      workerPubkey,
    });

    await expect(
      registry.redeem({
        authenticatedPubkey: attackerPubkey,
        community: "buzz.example.com",
        event,
        now: NOW,
        token: minted.token,
      }),
    ).rejects.toMatchObject({ code: "ENROLLMENT_INVALID" });
  });
});
