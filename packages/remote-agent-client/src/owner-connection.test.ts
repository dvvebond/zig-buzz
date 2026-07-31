import { randomBytes, randomUUID } from "node:crypto";

import { generateSecretKey, getPublicKey } from "nostr-tools/pure";
import { describe, expect, it } from "vitest";
import {
  KIND_REMOTE_AGENT_ENROLLMENT,
  unixNow,
  verifyNostrEvent,
} from "@buzz/core";
import {
  createRemoteEnvelope,
  openRemoteEnvelope,
  ReplayGuard,
  type EnrollmentPayload,
  type StatusPayload,
} from "@buzz/remote-agent-protocol";

import {
  RemoteAgentOwnerConnection,
  type OwnerConnectionEvent,
  type SocketLike,
} from "./owner-connection.js";

describe("remote-agent owner connection", () => {
  it("authenticates, decrypts enrollment, and sends signed approval", async () => {
    const ownerSecret = generateSecretKey();
    const workerSecret = generateSecretKey();
    const ownerPubkey = getPublicKey(ownerSecret);
    const workerPubkey = getPublicKey(workerSecret);
    const socket = new FakeSocket();
    const received: OwnerConnectionEvent[] = [];
    const connection = new RemoteAgentOwnerConnection({
      allowInsecureLocalhost: true,
      ownerSecretKey: ownerSecret,
      relayUrl: "ws://localhost:3000/",
      socketFactory: () => socket,
    });
    connection.on((event) => received.push(event));
    await connection.connect();

    socket.receive(["AUTH", "c".repeat(64)]);
    const auth = socket.sent.at(-1);
    expect(auth?.[0]).toBe("AUTH");
    expect(verifyNostrEvent(auth?.[1])).toBe(true);
    const authEvent = auth?.[1] as { id: string };
    socket.receive(["OK", authEvent.id, true, ""]);
    expect(socket.sent.at(-1)?.[0]).toBe("REQ");

    const enrollment = enrollmentPayload({
      ownerPubkey,
      workerPubkey,
    });
    const event = createRemoteEnvelope({
      payload: enrollment,
      recipientPubkey: ownerPubkey,
      senderSecretKey: workerSecret,
      workerPubkey,
    });
    socket.receive(["EVENT", "brap-owner", event]);
    expect(received.at(-1)).toMatchObject({
      payload: { body: { workerPubkey } },
      type: "enrollment",
    });

    const approvalId = connection.approveEnrollment({
      enrollment,
      workerPubkey,
    });
    const approval = socket.sent.at(-1);
    expect(approval?.slice(0, 4)).toEqual([
      "BRAP",
      "APPROVE",
      enrollment.deploymentId,
      workerPubkey,
    ]);
    expect((approval?.[4] as { id?: string }).id).toBe(approvalId);

    const hello = helloPayload(enrollment.deploymentId);
    const helloEvent = createRemoteEnvelope({
      payload: hello,
      recipientPubkey: ownerPubkey,
      senderSecretKey: workerSecret,
      workerPubkey,
    });
    socket.receive(["EVENT", "brap-owner", helloEvent]);
    const helloAckEvent = socket.sent.at(-1)?.[1];
    const workerReplay = new ReplayGuard();
    const helloAck = openRemoteEnvelope({
      event: helloAckEvent,
      expectedSenderPubkey: ownerPubkey,
      expectedWorkerPubkey: workerPubkey,
      now: hello.issuedAt,
      recipientPubkey: workerPubkey,
      recipientSecretKey: workerSecret,
      replayGuard: workerReplay,
    });
    expect(helloAck).toMatchObject({
      body: { challenge: hello.body.challenge },
      sequence: 0,
      sessionId: hello.sessionId,
      type: "ack",
    });

    connection.sendCommand({
      body: { action: "status" },
      deploymentId: enrollment.deploymentId,
      workerPubkey,
    });
    const command = openRemoteEnvelope({
      event: socket.sent.at(-1)?.[1],
      expectedSenderPubkey: ownerPubkey,
      expectedWorkerPubkey: workerPubkey,
      recipientPubkey: workerPubkey,
      recipientSecretKey: workerSecret,
      replayGuard: workerReplay,
    });
    expect(command).toMatchObject({
      body: { action: "status" },
      sequence: 1,
      sessionId: hello.sessionId,
      type: "command",
    });
  });
});

class FakeSocket implements SocketLike {
  public readyState = 1;
  public readonly sent: unknown[][] = [];
  readonly #listeners = new Map<string, Array<(event?: never) => void>>();

  public constructor() {
    queueMicrotask(() => this.#dispatch("open"));
  }

  public addEventListener(
    type: "open" | "close" | "error" | "message",
    listener: ((event: { readonly data: unknown }) => void) | (() => void),
  ): void {
    const listeners = this.#listeners.get(type) ?? [];
    listeners.push(listener as (event?: never) => void);
    this.#listeners.set(type, listeners);
  }

  public send(data: string): void {
    this.sent.push(JSON.parse(data) as unknown[]);
  }

  public close(): void {
    this.readyState = 3;
    this.#dispatch("close");
  }

  public receive(message: unknown[]): void {
    for (const listener of this.#listeners.get("message") ?? []) {
      (listener as unknown as (event: { data: string }) => void)({
        data: JSON.stringify(message),
      });
    }
  }

  #dispatch(type: string): void {
    for (const listener of this.#listeners.get(type) ?? []) listener();
  }
}

function helloPayload(deploymentId: string): StatusPayload {
  const now = unixNow();
  return {
    body: {
      capabilities: ["deploy", "status"],
      challenge: randomBytes(32).toString("hex"),
      state: "hello",
      workerVersion: "0.1.0",
    },
    deploymentId,
    expiresAt: now + 30,
    issuedAt: now,
    messageId: randomUUID(),
    sequence: 0,
    sessionId: randomBytes(16).toString("hex"),
    type: "status",
    version: 1,
  };
}

function enrollmentPayload(input: {
  readonly ownerPubkey: string;
  readonly workerPubkey: string;
}): EnrollmentPayload {
  const enrollmentId = randomUUID();
  const now = unixNow();
  return {
    body: {
      capabilities: ["deploy", "status"],
      challenge: randomBytes(32).toString("hex"),
      community: "localhost",
      enrollmentId,
      ownerPubkey: input.ownerPubkey,
      workerName: "remote-1",
      workerPubkey: input.workerPubkey,
      workerVersion: "0.1.0",
    },
    deploymentId: enrollmentId,
    expiresAt: now + 30,
    issuedAt: now,
    messageId: randomUUID(),
    sequence: 0,
    sessionId: randomBytes(16).toString("hex"),
    type: "enrollment",
    version: 1,
  };
}

expect(KIND_REMOTE_AGENT_ENROLLMENT).toBe(24210);
