import { randomUUID } from "node:crypto";

import {
  MeshSessionStream,
  type AcquireResult,
  type FencedHeader,
  type Profile,
  type RuntimeId,
  type WireFrame,
} from "@buzz/relay-mesh";
import { afterEach, describe, expect, it } from "vitest";

import { createRelayServer } from "./server.js";

type TestRelay = ReturnType<typeof createRelayServer>;
const relays: TestRelay[] = [];
const communityId = "bc4b3cc8-dfc3-4d37-8636-6b374e1904f3";
const localRuntimeId = "11".repeat(32) as RuntimeId;
const ownerRuntimeId = "22".repeat(32) as RuntimeId;

afterEach(async () => {
  await Promise.all(relays.splice(0).map((relay) => relay.close()));
});

describe("mesh demo HTTP", () => {
  it("is absent unless explicitly configured and validates its boundary", async () => {
    const absent = createRelayServer(baseOptions());
    relays.push(absent);
    const absentBase = await listen(absent);
    expect(
      (
        await fetch(`${absentBase}/_mesh/demo/echo`, {
          body: "{}",
          headers: { "content-type": "application/json" },
          method: "POST",
        })
      ).status,
    ).toBe(404);

    const relay = createRelayServer({
      ...baseOptions(),
      meshDemo: {
        communityId,
        directory: {
          acquire: async () => ownedLease(),
        },
        node: {
          runtimeId: localRuntimeId,
          openSessionStream: () => {
            throw new Error("owned sessions do not open a peer stream");
          },
        },
      },
    });
    relays.push(relay);
    const base = await listen(relay);
    expect(
      (
        await fetch(`${base}/_mesh/demo/echo`, {
          body: JSON.stringify(validRequest()),
          method: "POST",
        })
      ).status,
    ).toBe(415);
    expect(
      (
        await fetch(`${base}/_mesh/demo/echo`, {
          body: JSON.stringify({
            ...validRequest(),
            community_id: randomUUID(),
          }),
          headers: { "content-type": "application/json" },
          method: "POST",
        })
      ).status,
    ).toBe(404);
  });

  it("reports a locally acquired fenced session as owned", async () => {
    const relay = createRelayServer({
      ...baseOptions(),
      meshDemo: {
        communityId,
        directory: { acquire: async () => ownedLease() },
        node: {
          runtimeId: localRuntimeId,
          openSessionStream: () => {
            throw new Error("owned sessions do not open a peer stream");
          },
        },
      },
    });
    relays.push(relay);
    const response = await fetch(
      `${await listen(relay)}/_mesh/demo/echo`,
      jsonPost(validRequest()),
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      generation: "7",
      outcome: "owned",
      owner_runtime_id: localRuntimeId,
    });
  });

  it("round-trips a forwarded payload over the fenced mesh stream", async () => {
    let openedFence: FencedHeader | undefined;
    const relay = createRelayServer({
      ...baseOptions(),
      meshDemo: {
        communityId,
        directory: {
          acquire: async (
            acquiredCommunity: string,
            sessionId: string,
            _runtimeId: RuntimeId,
            profile: Profile,
          ): Promise<AcquireResult> => ({
            lease: {
              communityId: acquiredCommunity,
              generation: "8",
              ownerRuntimeId,
              profile,
              sessionId,
            },
            status: "exists",
          }),
        },
        node: {
          runtimeId: localRuntimeId,
          openSessionStream: (_to, fence, profile) => {
            openedFence = fence;
            let stream: MeshSessionStream;
            const sendFrame = (frame: WireFrame): void => {
              if (frame.type !== "stream_data") return;
              queueMicrotask(() =>
                stream.push(Buffer.from(frame.payload, "base64url")),
              );
            };
            stream = new MeshSessionStream(
              randomUUID(),
              ownerRuntimeId,
              fence,
              profile,
              sendFrame,
              () => undefined,
            );
            return stream;
          },
        },
      },
    });
    relays.push(relay);
    const request = validRequest();
    const response = await fetch(
      `${await listen(relay)}/_mesh/demo/echo`,
      jsonPost(request),
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      echoed_payload: request.payload,
      generation: "8",
      outcome: "forwarded",
      owner_runtime_id: ownerRuntimeId,
    });
    expect(openedFence).toEqual({
      communityId,
      generation: "8",
      ownerRuntimeId,
      sessionId: request.session_id,
    });
  });

  it("fails a silent owner with a bounded gateway timeout", async () => {
    const relay = createRelayServer({
      ...baseOptions(),
      meshDemo: {
        communityId,
        directory: {
          acquire: async (
            acquiredCommunity,
            sessionId,
            _runtimeId,
            profile,
          ) => ({
            lease: {
              communityId: acquiredCommunity,
              generation: "9",
              ownerRuntimeId,
              profile,
              sessionId,
            },
            status: "exists",
          }),
        },
        node: {
          runtimeId: localRuntimeId,
          openSessionStream: (_to, fence, profile) =>
            new MeshSessionStream(
              randomUUID(),
              ownerRuntimeId,
              fence,
              profile,
              () => undefined,
              () => undefined,
            ),
        },
        timeoutMs: 20,
      },
    });
    relays.push(relay);
    const response = await fetch(
      `${await listen(relay)}/_mesh/demo/echo`,
      jsonPost(validRequest()),
    );
    expect(response.status).toBe(504);
    await expect(response.json()).resolves.toEqual({
      error: "timed out waiting for echo",
    });
  });
});

function baseOptions() {
  return {
    community: "localhost",
    host: "127.0.0.1",
    ownerPubkeys: new Set<string>(),
    port: 0,
    publicUrl: new URL("ws://localhost:1/"),
  };
}

function ownedLease(): AcquireResult {
  return {
    lease: {
      communityId,
      generation: "7",
      ownerRuntimeId: localRuntimeId,
      profile: "reliable_stream",
      sessionId: validRequest().session_id,
    },
    status: "acquired",
  };
}

function validRequest() {
  return {
    community_id: communityId,
    payload: "secure mesh echo",
    session_id: "d8f242ff-a066-470a-87a9-a61ac8a85129",
  };
}

function jsonPost(body: unknown): RequestInit {
  return {
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
    method: "POST",
  };
}

async function listen(relay: TestRelay): Promise<string> {
  await relay.listen();
  const address = relay.address();
  if (!address || typeof address === "string") {
    throw new Error("test relay did not bind a TCP port");
  }
  return `http://localhost:${address.port}`;
}
