import { generateSecretKey, getPublicKey } from "nostr-tools/pure";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import {
  RemoteAgentOwnerConnection,
  type OwnerConnectionEvent,
  type SocketLike,
} from "@buzz/remote-agent-client";
import { RelayConnection } from "@buzz/remote-agent/connection";
import { InMemoryEventBus } from "@buzz/pubsub";

import { RemoteRegistry } from "./remote-registry.js";
import { createRelayServer } from "./server.js";

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
});

describe("BRAP full-stack connection", () => {
  it("enrolls when owner and worker land on different relay instances", async () => {
    const ownerSecret = generateSecretKey();
    const workerSecret = generateSecretKey();
    const ownerPubkey = getPublicKey(ownerSecret);
    const eventBus = new InMemoryEventBus();
    const registry = new RemoteRegistry();
    const ownerUrl = new URL("ws://localhost:1/");
    const workerUrl = new URL("ws://localhost:2/");
    const ownerRelay = createRelayServer({
      community: "localhost",
      eventBus,
      host: "127.0.0.1",
      ownerPubkeys: new Set([ownerPubkey]),
      port: 0,
      publicUrl: ownerUrl,
      registry,
    });
    const workerRelay = createRelayServer({
      community: "localhost",
      eventBus,
      host: "127.0.0.1",
      ownerPubkeys: new Set([ownerPubkey]),
      port: 0,
      publicUrl: workerUrl,
      registry,
    });
    await ownerRelay.listen();
    await workerRelay.listen();
    cleanups.push(() => eventBus.close());
    cleanups.push(() => ownerRelay.close());
    cleanups.push(() => workerRelay.close());
    setActualPort(ownerRelay, ownerUrl);
    setActualPort(workerRelay, workerUrl);
    const minted = await registry.mint({
      capabilities: ["status"],
      community: "localhost",
      now: Math.floor(Date.now() / 1_000),
      ownerPubkey,
    });

    const owner = new RemoteAgentOwnerConnection({
      allowInsecureLocalhost: true,
      ownerSecretKey: ownerSecret,
      relayUrl: ownerUrl.toString(),
      socketFactory: nodeSocket,
    });
    cleanups.push(() => owner.close());
    const ownerConnected = waitForOwnerEvent(
      owner,
      (event) => event.type === "connected",
    );
    const enrollment = waitForOwnerEvent(
      owner,
      (event): event is Extract<OwnerConnectionEvent, { type: "enrollment" }> =>
        event.type === "enrollment",
    );
    await owner.connect();
    await ownerConnected;
    const worker = new RelayConnection({
      approved: false,
      capabilities: ["status"],
      community: "localhost",
      enrollmentId: minted.record.id,
      enrollmentToken: minted.token,
      ownerPubkey,
      relayUrl: workerUrl,
      workerName: "cross-node-worker",
      workerSecretKey: workerSecret,
      workerVersion: "0.1.0-test",
    });
    const workerRun = worker.run();
    cleanups.push(async () => {
      worker.stop();
      await workerRun;
    });
    const request = await enrollment;
    const ready = waitForWorkerEvent(worker, "ready");
    owner.approveEnrollment({
      enrollment: request.payload,
      workerPubkey: request.payload.body.workerPubkey,
    });
    await ready;
    expect(request.payload.body.workerName).toBe("cross-node-worker");
  });

  it("enrolls and exchanges an encrypted command through one socket per endpoint", async () => {
    const ownerSecret = generateSecretKey();
    const workerSecret = generateSecretKey();
    const ownerPubkey = getPublicKey(ownerSecret);
    const publicUrl = new URL("ws://localhost:1/");
    const relay = createRelayServer({
      community: "localhost",
      host: "127.0.0.1",
      ownerPubkeys: new Set([ownerPubkey]),
      port: 0,
      publicUrl,
    });
    await relay.listen();
    cleanups.push(() => relay.close());
    const address = relay.address();
    if (!address || typeof address === "string") {
      throw new Error("relay did not bind a TCP port");
    }
    publicUrl.port = String(address.port);
    const relayUrl = publicUrl.toString();
    const minted = await relay.registry.mint({
      capabilities: ["status", "revoke"],
      community: "localhost",
      now: Math.floor(Date.now() / 1_000),
      ownerPubkey,
    });

    const owner = new RemoteAgentOwnerConnection({
      allowInsecureLocalhost: true,
      ownerSecretKey: ownerSecret,
      relayUrl,
      socketFactory: nodeSocket,
    });
    cleanups.push(() => owner.close());
    const ownerConnected = waitForOwnerEvent(
      owner,
      (event) => event.type === "connected",
    );
    const enrollment = waitForOwnerEvent(
      owner,
      (event): event is Extract<OwnerConnectionEvent, { type: "enrollment" }> =>
        event.type === "enrollment",
    );
    await owner.connect();
    await ownerConnected;

    const worker = new RelayConnection({
      approved: false,
      capabilities: ["status", "revoke"],
      community: "localhost",
      enrollmentId: minted.record.id,
      enrollmentToken: minted.token,
      ownerPubkey,
      relayUrl: publicUrl,
      workerName: "full-stack-worker",
      workerSecretKey: workerSecret,
      workerVersion: "0.1.0-test",
    });
    const workerRun = worker.run();
    cleanups.push(async () => {
      worker.stop();
      await workerRun;
    });
    const request = await enrollment;
    expect(request.payload.body.workerName).toBe("full-stack-worker");
    const workerReady = waitForWorkerEvent(worker, "ready");
    owner.approveEnrollment({
      enrollment: request.payload,
      workerPubkey: request.payload.body.workerPubkey,
    });
    await workerReady;

    worker.on("command", (payload) => {
      worker.sendAck({
        command: payload,
        message: "remote status is healthy",
        outcome: "completed",
      });
    });
    const acknowledgement = await owner.sendCommandAndWait({
      body: { action: "status" },
      deploymentId: minted.record.id,
      workerPubkey: request.payload.body.workerPubkey,
    });
    expect(acknowledgement).toMatchObject({
      body: {
        message: "remote status is healthy",
        outcome: "completed",
      },
      sequence: 1,
      type: "ack",
    });
    await expect(
      relay.registry.authorizedWorker(
        request.payload.body.workerPubkey,
        "localhost",
      ),
    ).resolves.toMatchObject({ ownerPubkey });
  });
});

function nodeSocket(url: string): SocketLike {
  return new WebSocket(url, {
    perMessageDeflate: false,
  }) as unknown as SocketLike;
}

function setActualPort(
  relay: ReturnType<typeof createRelayServer>,
  url: URL,
): void {
  const address = relay.address();
  if (!address || typeof address === "string") {
    throw new Error("relay did not bind a TCP port");
  }
  url.port = String(address.port);
}

function waitForOwnerEvent<T extends OwnerConnectionEvent>(
  owner: RemoteAgentOwnerConnection,
  predicate: (event: OwnerConnectionEvent) => event is T,
): Promise<T>;
function waitForOwnerEvent(
  owner: RemoteAgentOwnerConnection,
  predicate: (event: OwnerConnectionEvent) => boolean,
): Promise<OwnerConnectionEvent>;
function waitForOwnerEvent(
  owner: RemoteAgentOwnerConnection,
  predicate: (event: OwnerConnectionEvent) => boolean,
): Promise<OwnerConnectionEvent> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("timed out waiting for owner event")),
      5_000,
    );
    const unsubscribe = owner.on((event) => {
      if (!predicate(event)) return;
      clearTimeout(timeout);
      unsubscribe();
      resolve(event);
    });
  });
}

function waitForWorkerEvent(
  worker: RelayConnection,
  event: "approved" | "ready",
): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error(`timed out waiting for worker ${event}`)),
      5_000,
    );
    worker.once(event, () => {
      clearTimeout(timeout);
      resolve();
    });
  });
}
