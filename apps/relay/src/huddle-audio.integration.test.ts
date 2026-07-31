import { randomUUID } from "node:crypto";

import {
  KIND_AUTH,
  KIND_HUDDLE_ENDED,
  KIND_HUDDLE_PARTICIPANT_JOINED,
  KIND_HUDDLE_PARTICIPANT_LEFT,
  signNostrEvent,
  unixNow,
} from "@buzz/core";
import { MemoryEventStore } from "@buzz/db";
import {
  createReadyRecord,
  InMemoryReadyRegistry,
  InMemorySessionDirectory,
  MeshNode,
  RuntimeIdentity,
  type RuntimeId,
} from "@buzz/relay-mesh";
import { generateSecretKey, getPublicKey } from "nostr-tools/pure";
import type { Pool, PoolClient } from "pg";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket, { type RawData } from "ws";

import { RelayMeshDispatcher } from "./mesh-dispatcher.js";
import { createRelayServer } from "./server.js";

type TestRelay = ReturnType<typeof createRelayServer>;
const relays: TestRelay[] = [];
const sockets: WebSocket[] = [];

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.close();
  await Promise.all(relays.splice(0).map((relay) => relay.close()));
});

describe("huddle audio relay", () => {
  it("authenticates channel members, pins v2, and fans opaque Opus frames out", async () => {
    const publicUrl = new URL("ws://localhost:1/");
    const relay = createRelayServer({
      community: "localhost",
      host: "127.0.0.1",
      ownerPubkeys: new Set(),
      port: 0,
      publicUrl,
    });
    relays.push(relay);
    await relay.listen();
    const address = relay.address();
    if (!address || typeof address === "string") {
      throw new Error("test relay did not bind");
    }
    publicUrl.port = String(address.port);
    const channelId = randomUUID();
    const parentChannelId = randomUUID();
    const firstSecret = generateSecretKey();
    const secondSecret = generateSecretKey();
    const first = await audioClient(
      publicUrl,
      channelId,
      parentChannelId,
      firstSecret,
      2,
    );
    const firstJoined = await first.nextText(
      (message) => message.type === "joined" && Array.isArray(message.peers),
    );
    expect(firstJoined.peers).toEqual([
      { peer_index: 0, pubkey: getPublicKey(firstSecret) },
    ]);

    const second = await audioClient(
      publicUrl,
      channelId,
      parentChannelId,
      secondSecret,
      2,
    );
    const secondJoined = await second.nextText(
      (message) => message.type === "joined" && Array.isArray(message.peers),
    );
    expect(secondJoined.peers).toEqual([
      { peer_index: 0, pubkey: getPublicKey(firstSecret) },
      { peer_index: 1, pubkey: getPublicKey(secondSecret) },
    ]);
    await expect(
      first.nextText(
        (message) =>
          message.type === "joined" &&
          message.pubkey === getPublicKey(secondSecret),
      ),
    ).resolves.toMatchObject({ peer_index: 1 });

    const opusFrame = Buffer.from([
      0x00, 0x07, 0x00, 0x00, 0x03, 0xc0, 0xd8, 0x00, 0xf8, 0xff,
    ]);
    first.socket.send(opusFrame);
    await expect(second.nextBinary()).resolves.toEqual(
      Buffer.concat([Buffer.from([0]), opusFrame]),
    );

    first.socket.close();
    await expect(
      second.nextText(
        (message) =>
          message.type === "left" &&
          message.pubkey === getPublicKey(firstSecret),
      ),
    ).resolves.toMatchObject({ peer_index: 0 });
  });

  it("rejects protocol-version mismatch and access-policy denial", async () => {
    const publicUrl = new URL("ws://localhost:1/");
    const relay = createRelayServer({
      community: "localhost",
      host: "127.0.0.1",
      ownerPubkeys: new Set(),
      port: 0,
      publicUrl,
    });
    relays.push(relay);
    await relay.listen();
    const address = relay.address();
    if (!address || typeof address === "string") throw new Error("no address");
    publicUrl.port = String(address.port);
    const channelId = randomUUID();
    const parentChannelId = randomUUID();
    const first = await audioClient(
      publicUrl,
      channelId,
      parentChannelId,
      generateSecretKey(),
      2,
    );
    await first.nextText((message) => message.type === "joined");

    const incompatible = await audioClient(
      publicUrl,
      channelId,
      parentChannelId,
      generateSecretKey(),
      1,
    );
    await expect(
      incompatible.nextText(
        (message) =>
          message.type === "error" && message.code === "upgrade_required",
      ),
    ).resolves.toMatchObject({ protocol_version: 2 });

    const deniedSecret = generateSecretKey();
    // Bind the policy's denied identity to this actual connection.
    const deniedPublicUrl = new URL("ws://localhost:2/");
    const deniedRelay = createRelayServer({
      accessPolicy: {
        canConnect: async (_community, pubkey) =>
          pubkey !== getPublicKey(deniedSecret),
        canPublish: async () => true,
        canRead: async () => true,
      },
      community: "localhost",
      host: "127.0.0.1",
      ownerPubkeys: new Set(),
      port: 0,
      publicUrl: deniedPublicUrl,
    });
    relays.push(deniedRelay);
    await deniedRelay.listen();
    const deniedAddress = deniedRelay.address();
    if (!deniedAddress || typeof deniedAddress === "string") {
      throw new Error("no denied relay address");
    }
    deniedPublicUrl.port = String(deniedAddress.port);
    const denied = await audioClient(
      deniedPublicUrl,
      randomUUID(),
      parentChannelId,
      deniedSecret,
      2,
    );
    await expect(
      denied.nextText((message) => message.type === "error"),
    ).resolves.toMatchObject({
      message: "not authorized for this huddle",
    });
  });

  it("persists owner lifecycle events and archives when the final peer leaves", async () => {
    const communityId = randomUUID();
    const channelId = randomUUID();
    const claimedParentId = randomUUID();
    const eventStore = new MemoryEventStore();
    let archived = false;
    const query = async (sql: string) => {
      if (sql.includes("UPDATE channels ch")) {
        archived = true;
        return rows([{ id: channelId }]);
      }
      if (sql.includes("FROM communities")) {
        return rows([{ id: communityId }]);
      }
      if (sql.includes("FROM channels ch")) {
        return rows([
          {
            archived_at: archived ? new Date() : null,
            created_by: "ab".repeat(32),
            ttl_seconds: null,
            visibility: "open",
          },
        ]);
      }
      return rows([]);
    };
    const client = {
      query,
      release: () => undefined,
    } as unknown as PoolClient;
    const pool = {
      connect: async () => client,
      query,
    } as unknown as Pool;
    const publicUrl = new URL("ws://localhost:1/");
    const relay = createRelayServer({
      community: "localhost",
      eventStore,
      host: "127.0.0.1",
      ownerPubkeys: new Set(),
      pool,
      port: 0,
      publicUrl,
      relaySecretKey: generateSecretKey(),
    });
    relays.push(relay);
    await relay.listen();
    setBoundPort(publicUrl, relay);
    const participantSecret = generateSecretKey();
    const participant = getPublicKey(participantSecret);
    const audio = await audioClient(
      publicUrl,
      channelId,
      claimedParentId,
      participantSecret,
      2,
    );
    await audio.nextText((message) => message.type === "joined");
    await waitForStoredKinds(eventStore, channelId, [
      KIND_HUDDLE_PARTICIPANT_JOINED,
    ]);

    audio.socket.close();
    const lifecycle = await waitForStoredKinds(eventStore, channelId, [
      KIND_HUDDLE_PARTICIPANT_JOINED,
      KIND_HUDDLE_PARTICIPANT_LEFT,
      KIND_HUDDLE_ENDED,
    ]);
    expect(archived).toBe(true);
    expect(lifecycle).toHaveLength(3);
    for (const event of lifecycle) {
      expect(event.tags).toContainEqual(["h", channelId]);
      expect(event.tags).toContainEqual(["p", participant]);
      expect(JSON.parse(event.content)).toEqual({
        ephemeral_channel_id: channelId,
      });
    }
  });

  it("uses one fenced owner room across two authenticated relay pods", async () => {
    const registry = new InMemoryReadyRegistry();
    const directory = new InMemorySessionDirectory(3_000);
    const relaySecret = generateSecretKey();
    const expectedRelayPubkey = getPublicKey(relaySecret) as RuntimeId;
    const firstIdentity = RuntimeIdentity.generate();
    const secondIdentity = RuntimeIdentity.generate();
    const firstDispatcher = new RelayMeshDispatcher(
      directory,
      firstIdentity.runtimeId,
    );
    const secondDispatcher = new RelayMeshDispatcher(
      directory,
      secondIdentity.runtimeId,
    );
    const firstNode = meshNode(
      firstIdentity,
      firstDispatcher,
      registry,
      relaySecret,
      expectedRelayPubkey,
    );
    const secondNode = meshNode(
      secondIdentity,
      secondDispatcher,
      registry,
      relaySecret,
      expectedRelayPubkey,
    );
    try {
      await firstNode.start();
      await secondNode.start();
      await Promise.all([firstNode.reconcile(), secondNode.reconcile()]);
      await waitForCondition(
        () =>
          firstNode.status.peers.some((peer) => peer.connected) &&
          secondNode.status.peers.some((peer) => peer.connected),
      );

      const communityId = randomUUID();
      const firstUrl = new URL("ws://localhost:1/");
      const secondUrl = new URL("ws://localhost:2/");
      const firstRelay = createRelayServer({
        community: "localhost",
        host: "127.0.0.1",
        huddleMesh: {
          communityId,
          directory,
          dispatcher: firstDispatcher,
          node: firstNode,
        },
        ownerPubkeys: new Set(),
        port: 0,
        publicUrl: firstUrl,
      });
      const secondRelay = createRelayServer({
        community: "localhost",
        host: "127.0.0.1",
        huddleMesh: {
          communityId,
          directory,
          dispatcher: secondDispatcher,
          node: secondNode,
        },
        ownerPubkeys: new Set(),
        port: 0,
        publicUrl: secondUrl,
      });
      relays.push(firstRelay, secondRelay);
      await Promise.all([firstRelay.listen(), secondRelay.listen()]);
      setBoundPort(firstUrl, firstRelay);
      setBoundPort(secondUrl, secondRelay);

      const channelId = randomUUID();
      const parentChannelId = randomUUID();
      const firstSecret = generateSecretKey();
      const secondSecret = generateSecretKey();
      const first = await audioClient(
        firstUrl,
        channelId,
        parentChannelId,
        firstSecret,
        2,
      );
      await expect(
        first.nextText((message) => message.type === "joined"),
      ).resolves.toMatchObject({ peer_index: 0 });

      const second = await audioClient(
        secondUrl,
        channelId,
        parentChannelId,
        secondSecret,
        2,
      );
      await expect(
        second.nextText(
          (message) =>
            message.type === "joined" && Array.isArray(message.peers),
        ),
      ).resolves.toMatchObject({
        peer_index: 1,
        peers: [
          { peer_index: 0, pubkey: getPublicKey(firstSecret) },
          { peer_index: 1, pubkey: getPublicKey(secondSecret) },
        ],
      });
      await expect(
        first.nextText(
          (message) =>
            message.type === "joined" &&
            message.pubkey === getPublicKey(secondSecret),
        ),
      ).resolves.toMatchObject({ peer_index: 1 });

      const opusFrame = Buffer.from([
        0x00, 0x07, 0x00, 0x00, 0x03, 0xc0, 0xd8, 0x00, 0xf8, 0xff,
      ]);
      first.socket.send(opusFrame);
      await expect(second.nextBinary()).resolves.toEqual(
        Buffer.concat([Buffer.from([0]), opusFrame]),
      );
      second.socket.send(opusFrame);
      await expect(first.nextBinary()).resolves.toEqual(
        Buffer.concat([Buffer.from([1]), opusFrame]),
      );

      const incompatible = await audioClient(
        secondUrl,
        channelId,
        parentChannelId,
        generateSecretKey(),
        1,
      );
      await expect(
        incompatible.nextText(
          (message) =>
            message.type === "error" && message.code === "upgrade_required",
        ),
      ).resolves.toMatchObject({ protocol_version: 2 });

      second.socket.close();
      await expect(
        first.nextText(
          (message) =>
            message.type === "left" &&
            message.pubkey === getPublicKey(secondSecret),
        ),
      ).resolves.toMatchObject({ peer_index: 1 });
    } finally {
      await Promise.allSettled(
        relays.splice(0).map(async (relay) => await relay.close()),
      );
      await Promise.allSettled([firstNode.close(), secondNode.close()]);
      await Promise.allSettled([registry.close(), directory.close()]);
    }
  });
});

function meshNode(
  identity: RuntimeIdentity,
  handler: RelayMeshDispatcher,
  registry: InMemoryReadyRegistry,
  relaySecretKey: Uint8Array,
  expectedRelayPubkey: RuntimeId,
): MeshNode {
  return new MeshNode({
    allowInsecureLoopback: true,
    expectedRelayPubkey,
    handler,
    identity,
    readyRecord: createReadyRecord({
      capabilities: ["reliable-stream", "realtime-media", "huddle-control"],
      endpointUrls: ["ws://127.0.0.1:1/_mesh/ws"],
      identity,
      relaySecretKey,
    }),
    registry,
    registryRefreshMs: 60_000,
  });
}

function setBoundPort(publicUrl: URL, relay: TestRelay): void {
  const address = relay.address();
  if (!address || typeof address === "string") {
    throw new Error("test relay did not bind");
  }
  publicUrl.port = String(address.port);
}

async function waitForCondition(
  predicate: () => boolean,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error("timed out waiting for mesh peers");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function audioClient(
  relayUrl: URL,
  channelId: string,
  parentChannelId: string,
  secretKey: Uint8Array,
  protocolVersion: 1 | 2,
): Promise<ReturnType<typeof messageQueue>> {
  const socket = new WebSocket(
    `${relayUrl.toString().replace(/\/$/, "")}/huddle/${channelId}/audio`,
  );
  sockets.push(socket);
  const queue = messageQueue(socket);
  await new Promise<void>((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  const challenge = await queue.nextText(
    (message) =>
      message.type === "challenge" && typeof message.challenge === "string",
  );
  const event = signNostrEvent(
    {
      content: "",
      created_at: unixNow(),
      kind: KIND_AUTH,
      tags: [
        ["relay", relayUrl.toString()],
        ["challenge", challenge.challenge as string],
      ],
    },
    secretKey,
  );
  socket.send(
    JSON.stringify({
      event,
      parent_channel_id: parentChannelId,
      protocol_version: protocolVersion,
      type: "auth",
    }),
  );
  return queue;
}

function messageQueue(socket: WebSocket) {
  const text: Record<string, unknown>[] = [];
  const binary: Buffer[] = [];
  const textWaiters: Array<{
    predicate: (message: Record<string, unknown>) => boolean;
    resolve: (message: Record<string, unknown>) => void;
  }> = [];
  const binaryWaiters: Array<(value: Buffer) => void> = [];
  socket.on("message", (data: RawData, isBinary: boolean) => {
    const bytes = Buffer.isBuffer(data)
      ? data
      : Array.isArray(data)
        ? Buffer.concat(data)
        : Buffer.from(data);
    if (isBinary) {
      const waiter = binaryWaiters.shift();
      if (waiter) waiter(bytes);
      else binary.push(bytes);
      return;
    }
    const parsed = JSON.parse(bytes.toString("utf8")) as Record<
      string,
      unknown
    >;
    const index = textWaiters.findIndex((waiter) => waiter.predicate(parsed));
    if (index >= 0) {
      const [waiter] = textWaiters.splice(index, 1);
      waiter?.resolve(parsed);
    } else {
      text.push(parsed);
    }
  });
  return {
    nextBinary: () =>
      binary.length > 0
        ? Promise.resolve(binary.shift()!)
        : timeoutPromise<Buffer>((resolve) => binaryWaiters.push(resolve)),
    nextText: (predicate: (message: Record<string, unknown>) => boolean) => {
      const index = text.findIndex(predicate);
      if (index >= 0) {
        return Promise.resolve(text.splice(index, 1)[0]!);
      }
      return timeoutPromise<Record<string, unknown>>((resolve) =>
        textWaiters.push({ predicate, resolve }),
      );
    },
    socket,
  };
}

function timeoutPromise<T>(
  register: (resolve: (value: T) => void) => void,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("timed out waiting for audio message")),
      5_000,
    );
    register((value) => {
      clearTimeout(timer);
      resolve(value);
    });
  });
}

async function waitForStoredKinds(
  eventStore: MemoryEventStore,
  channelId: string,
  kinds: readonly number[],
): Promise<Awaited<ReturnType<MemoryEventStore["query"]>>> {
  const deadline = Date.now() + 5_000;
  for (;;) {
    const events = await eventStore.query("localhost", {
      "#h": [channelId],
      kinds,
      limit: 100,
    });
    if (kinds.every((kind) => events.some((event) => event.kind === kind))) {
      return events;
    }
    if (Date.now() >= deadline) {
      throw new Error("timed out waiting for durable huddle lifecycle");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function rows(values: readonly Record<string, unknown>[]): {
  readonly rowCount: number;
  readonly rows: readonly Record<string, unknown>[];
} {
  return { rowCount: values.length, rows: values };
}
