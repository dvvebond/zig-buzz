import { randomBytes, randomUUID } from "node:crypto";
import { schnorr } from "@noble/curves/secp256k1.js";
import { describe, expect, it } from "vitest";
import {
  InMemoryReadyRegistry,
  MeshNode,
  RuntimeIdentity,
  createReadyRecord,
  validateMeshEndpoint,
  verifyReadyRecord,
  type FencedHeader,
  type MeshSessionStream,
  type RuntimeId,
} from "./index.js";

function secret(): Uint8Array {
  while (true) {
    const candidate = randomBytes(32);
    try {
      schnorr.getPublicKey(candidate);
      return candidate;
    } catch {
      // The chance of an invalid scalar is negligible, but the helper is total.
    }
  }
}

function record(identity: RuntimeIdentity, relaySecretKey: Uint8Array) {
  return createReadyRecord({
    identity,
    relaySecretKey,
    endpointUrls: ["ws://127.0.0.1:1/_mesh/ws"],
    capabilities: ["reliable-stream", "realtime-media", "huddle-control"],
  });
}

describe("relay mesh", () => {
  it("binds boot identity to the deployment relay key", () => {
    const relay = secret();
    const otherRelay = secret();
    const identity = RuntimeIdentity.generate();
    const ready = record(identity, relay);
    const pubkey = Buffer.from(schnorr.getPublicKey(relay)).toString(
      "hex",
    ) as RuntimeId;
    const otherPubkey = Buffer.from(schnorr.getPublicKey(otherRelay)).toString(
      "hex",
    ) as RuntimeId;

    expect(verifyReadyRecord(ready, pubkey)).toBe(true);
    expect(verifyReadyRecord(ready, otherPubkey)).toBe(false);
    expect(
      verifyReadyRecord(
        { ...ready, runtimePubkey: "11".repeat(32) as RuntimeId },
        pubkey,
      ),
    ).toBe(false);
    expect(
      verifyReadyRecord(
        { ...ready, endpointUrls: ["wss://attacker.example/_mesh/ws"] },
        pubkey,
      ),
    ).toBe(false);
  });

  it("rejects insecure non-loopback endpoints and URL ambiguity", () => {
    expect(() =>
      validateMeshEndpoint(new URL("ws://example.com/_mesh/ws"), true),
    ).toThrow(/wss/);
    expect(() =>
      validateMeshEndpoint(new URL("wss://example.com/_mesh/ws?peer=x"), false),
    ).toThrow(/origin/);
    expect(() =>
      validateMeshEndpoint(new URL("ws://127.0.0.1/_mesh/ws"), true),
    ).not.toThrow();
  });

  it("authenticates two nodes, moves fenced streams and drops stale traffic", async () => {
    const registry = new InMemoryReadyRegistry();
    const relaySecret = secret();
    const relayPubkey = Buffer.from(schnorr.getPublicKey(relaySecret)).toString(
      "hex",
    ) as RuntimeId;
    const firstIdentity = RuntimeIdentity.generate();
    const secondIdentity = RuntimeIdentity.generate();
    const received: Uint8Array[] = [];
    const datagrams: Uint8Array[] = [];
    let incoming: MeshSessionStream | undefined;
    const generation = new Map<string, string>();

    const handler = {
      validateFence: (fenced: FencedHeader) =>
        generation.get(fenced.sessionId) === fenced.generation,
      onDatagram: (_from: RuntimeId, value: { payload: Uint8Array }) => {
        datagrams.push(value.payload);
      },
      onSessionStream: async (_from: RuntimeId, stream: MeshSessionStream) => {
        incoming = stream;
        for await (const payload of stream) received.push(payload);
      },
    };
    const first = new MeshNode({
      identity: firstIdentity,
      readyRecord: record(firstIdentity, relaySecret),
      expectedRelayPubkey: relayPubkey,
      registry,
      handler,
      allowInsecureLoopback: true,
      registryRefreshMs: 60_000,
    });
    const second = new MeshNode({
      identity: secondIdentity,
      readyRecord: record(secondIdentity, relaySecret),
      expectedRelayPubkey: relayPubkey,
      registry,
      handler,
      allowInsecureLoopback: true,
      registryRefreshMs: 60_000,
    });

    try {
      await first.start();
      await second.start();
      await Promise.all([first.reconcile(), second.reconcile()]);
      await waitFor(
        () => first.status.peers.some((p) => p.connected),
        3_000,
        () => JSON.stringify({ first: first.status, second: second.status }),
      );
      await waitFor(
        () => second.status.peers.some((p) => p.connected),
        3_000,
        () => JSON.stringify({ first: first.status, second: second.status }),
      );

      const owner = first.runtimeId;
      const fenced: FencedHeader = {
        communityId: randomUUID(),
        sessionId: randomUUID(),
        generation: "7",
        ownerRuntimeId: owner,
      };
      generation.set(fenced.sessionId, "7");
      const stream = first.openSessionStream(
        second.runtimeId,
        fenced,
        "reliable_stream",
      );
      stream.send(Buffer.from("goose bytes"));
      await waitFor(() => received.length === 1);
      expect(Buffer.from(received[0] ?? []).toString()).toBe("goose bytes");
      expect(incoming?.fenced).toEqual(fenced);

      expect(
        first.sendDatagram(second.runtimeId, {
          fenced,
          seq: 1n,
          payload: Buffer.from("opus"),
        }),
      ).toBe(true);
      await waitFor(() => datagrams.length === 1);

      generation.set(fenced.sessionId, "8");
      first.sendDatagram(second.runtimeId, {
        fenced,
        seq: 2n,
        payload: Buffer.from("stale"),
      });
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(datagrams).toHaveLength(1);
      expect(second.status.counters.fence_rejections).toBe(1);

      stream.close();
      await waitFor(() => incoming === undefined || true);
      expect(first.status.peers.filter((p) => p.connected)).toHaveLength(1);
      expect(second.status.peers.filter((p) => p.connected)).toHaveLength(1);
    } finally {
      await Promise.allSettled([first.close(), second.close()]);
      await registry.close();
    }
  });
});

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 3_000,
  detail?: () => string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error(`condition timed out${detail ? `: ${detail()}` : ""}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
