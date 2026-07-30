import { createHash, randomBytes, randomUUID } from "node:crypto";

import { schnorr } from "@noble/curves/secp256k1.js";
import { generateSecretKey, getPublicKey } from "nostr-tools/pure";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import {
  KIND_AGENT_ENGRAM,
  KIND_AUTH,
  KIND_DELETION,
  KIND_EVENT_REMINDER,
  KIND_GIFT_WRAP,
  KIND_HTTP_AUTH,
  KIND_MEMBER_ADDED_NOTIFICATION,
  KIND_MEMBER_REMOVED_NOTIFICATION,
  KIND_NIP29_REMOVE_USER,
  KIND_NIP29_EDIT_METADATA,
  KIND_PRESENCE_UPDATE,
  KIND_REACTION,
  KIND_REMOTE_AGENT_COMMAND,
  KIND_REMOTE_AGENT_ENROLLMENT,
  KIND_THREAD_SUMMARY,
  KIND_WINDOW_BOUNDS,
  signNostrEvent,
  unixNow,
} from "@buzz/core";
import {
  createRemoteEnvelope,
  type AckPayload,
  type CommandPayload,
  type EnrollmentPayload,
} from "@buzz/remote-agent-protocol";
import {
  MemoryEventStore,
  type EventStoreTransactionEffect,
  type RelayAccessPolicy,
  type StoreEventResult,
  type ThreadMetadata,
} from "@buzz/db";
import {
  InMemoryEventBus,
  type RateLimitClaim,
  type RateLimitKind,
} from "@buzz/pubsub";

import { createRelayServer } from "./server.js";
import { resolveThreadMetadata } from "./thread-metadata.js";

type TestRelay = ReturnType<typeof createRelayServer>;
const relays: TestRelay[] = [];

class RevokingMemoryEventStore extends MemoryEventStore {
  public override async store(
    community: string,
    event: import("@buzz/core").NostrEvent,
    channelId?: string,
    transactionEffect?: EventStoreTransactionEffect,
    threadMetadata?: ThreadMetadata,
  ): Promise<StoreEventResult> {
    const result = await super.store(
      community,
      event,
      channelId,
      transactionEffect,
      threadMetadata,
    );
    return event.kind === KIND_NIP29_REMOVE_USER && channelId
      ? {
          ...result,
          revokedChannelMembers: [{ channelId, pubkey: event.pubkey }],
        }
      : event.kind === KIND_NIP29_EDIT_METADATA && channelId
        ? {
            ...result,
            channelAccessChanges: [{ channelId, mode: "all" }],
          }
        : result;
  }
}

class UnavailableAdmissionEventBus extends InMemoryEventBus {
  public override async claimRateLimit(
    _scope: string,
    _principal: string,
    _kind: RateLimitKind,
    _windowSeconds: number,
    _limit: number,
  ): Promise<RateLimitClaim> {
    throw new Error("shared counter unavailable");
  }
}

class BlockingMemoryEventStore extends MemoryEventStore {
  readonly started: Promise<void>;
  readonly #unblocked: Promise<void>;
  #signalStarted!: () => void;
  #unblock!: () => void;

  public constructor() {
    super();
    this.started = new Promise<void>((resolve) => {
      this.#signalStarted = resolve;
    });
    this.#unblocked = new Promise<void>((resolve) => {
      this.#unblock = resolve;
    });
  }

  public release(): void {
    this.#unblock();
  }

  public override async query(
    community: string,
    filter: import("@buzz/core").NostrFilter,
  ): Promise<import("@buzz/core").NostrEvent[]> {
    this.#signalStarted();
    await this.#unblocked;
    return super.query(community, filter);
  }
}

afterEach(async () => {
  await Promise.all(relays.splice(0).map((relay) => relay.close()));
});

describe("BRAP relay integration", () => {
  it("fails closed when shared WebSocket admission is unavailable", async () => {
    const publicUrl = new URL("ws://localhost:1/");
    const relay = createRelayServer({
      community: "localhost",
      eventBus: new UnavailableAdmissionEventBus(),
      host: "127.0.0.1",
      ownerPubkeys: new Set(),
      port: 0,
      publicUrl,
    });
    relays.push(relay);
    await relay.listen();
    const address = relay.address();
    if (!address || typeof address === "string") {
      throw new Error("test relay did not bind a TCP port");
    }
    publicUrl.port = String(address.port);
    const client = await authenticatedClient(
      publicUrl.toString(),
      generateSecretKey(),
    );
    client.socket.send(JSON.stringify(["REQ", "blocked", { kinds: [1] }]));
    await expect(
      client.next(
        (message) => message[0] === "CLOSED" && message[1] === "blocked",
      ),
    ).resolves.toEqual([
      "CLOSED",
      "blocked",
      "rate-limited: shared admission unavailable",
    ]);
    client.socket.close();
  });

  it("rejects work immediately when the global handler capacity is occupied", async () => {
    const eventStore = new BlockingMemoryEventStore();
    const publicUrl = new URL("ws://localhost:1/");
    const relay = createRelayServer({
      community: "localhost",
      eventStore,
      host: "127.0.0.1",
      maxConcurrentHandlers: 1,
      ownerPubkeys: new Set(),
      port: 0,
      publicUrl,
    });
    relays.push(relay);
    await relay.listen();
    const address = relay.address();
    if (!address || typeof address === "string") {
      throw new Error("test relay did not bind a TCP port");
    }
    publicUrl.port = String(address.port);
    const first = await authenticatedClient(
      publicUrl.toString(),
      generateSecretKey(),
    );
    const second = await authenticatedClient(
      publicUrl.toString(),
      generateSecretKey(),
    );

    first.socket.send(JSON.stringify(["REQ", "held", { kinds: [1] }]));
    await eventStore.started;
    second.socket.send(JSON.stringify(["REQ", "overflow", { kinds: [1] }]));
    await expect(
      second.next(
        (message) => message[0] === "CLOSED" && message[1] === "overflow",
      ),
    ).resolves.toEqual([
      "CLOSED",
      "overflow",
      "rate-limited: too many concurrent requests",
    ]);
    eventStore.release();
    await first.next(
      (message) => message[0] === "EOSE" && message[1] === "held",
    );
    first.socket.close();
    second.socket.close();
  });

  it("closes channel-scoped subscriptions immediately after membership revocation", async () => {
    const publicUrl = new URL("ws://localhost:1/");
    const relay = createRelayServer({
      community: "localhost",
      eventStore: new RevokingMemoryEventStore(),
      host: "127.0.0.1",
      ownerPubkeys: new Set(),
      port: 0,
      publicUrl,
    });
    relays.push(relay);
    await relay.listen();
    const address = relay.address();
    if (!address || typeof address === "string") {
      throw new Error("test relay did not bind a TCP port");
    }
    publicUrl.port = String(address.port);
    const secret = generateSecretKey();
    const pubkey = getPublicKey(secret);
    const channelId = randomUUID();
    const client = await authenticatedClient(publicUrl.toString(), secret);
    client.socket.send(
      JSON.stringify(["REQ", "channel", { "#h": [channelId] }]),
    );
    await client.next(
      (message) => message[0] === "EOSE" && message[1] === "channel",
    );
    const removal = signNostrEvent(
      {
        content: "",
        created_at: unixNow(),
        kind: KIND_NIP29_REMOVE_USER,
        tags: [
          ["h", channelId],
          ["p", pubkey],
        ],
      },
      secret,
    );
    client.socket.send(JSON.stringify(["EVENT", removal]));
    await client.next(
      (message) =>
        message[0] === "CLOSED" &&
        message[1] === "channel" &&
        message[2] === "restricted: channel access revoked",
    );

    await client.next(
      (message) =>
        message[0] === "OK" && message[1] === removal.id && message[2] === true,
    );
    client.socket.close();
  });

  it("requires p-gated global subscriptions to target only the authenticated pubkey", async () => {
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
      throw new Error("test relay did not bind a TCP port");
    }
    publicUrl.port = String(address.port);
    const secret = generateSecretKey();
    const pubkey = getPublicKey(secret);
    const other = getPublicKey(generateSecretKey());
    const client = await authenticatedClient(publicUrl.toString(), secret);

    client.socket.send(
      JSON.stringify([
        "REQ",
        "wildcard",
        { kinds: [KIND_MEMBER_ADDED_NOTIFICATION] },
      ]),
    );
    await client.next(
      (message) =>
        message[0] === "CLOSED" &&
        message[1] === "wildcard" &&
        String(message[2]).startsWith("restricted:"),
    );

    client.socket.send(
      JSON.stringify([
        "REQ",
        "wrong-recipient",
        {
          "#p": [pubkey, other],
          kinds: [
            KIND_MEMBER_ADDED_NOTIFICATION,
            KIND_MEMBER_REMOVED_NOTIFICATION,
          ],
        },
      ]),
    );
    await client.next(
      (message) => message[0] === "CLOSED" && message[1] === "wrong-recipient",
    );

    client.socket.send(
      JSON.stringify([
        "REQ",
        "foreign-engram",
        { authors: [other], kinds: [KIND_AGENT_ENGRAM] },
      ]),
    );
    await client.next(
      (message) => message[0] === "CLOSED" && message[1] === "foreign-engram",
    );

    client.socket.send(
      JSON.stringify([
        "REQ",
        "foreign-reminders",
        { authors: [other], kinds: [KIND_EVENT_REMINDER] },
      ]),
    );
    await client.next(
      (message) =>
        message[0] === "CLOSED" && message[1] === "foreign-reminders",
    );

    client.socket.send(
      JSON.stringify([
        "REQ",
        "own-engram",
        { authors: [pubkey], kinds: [KIND_AGENT_ENGRAM] },
      ]),
    );
    await client.next(
      (message) => message[0] === "EOSE" && message[1] === "own-engram",
    );

    client.socket.send(
      JSON.stringify([
        "REQ",
        "own-recipient",
        {
          "#p": [pubkey],
          kinds: [
            KIND_MEMBER_ADDED_NOTIFICATION,
            KIND_MEMBER_REMOVED_NOTIFICATION,
          ],
        },
      ]),
    );
    await client.next(
      (message) => message[0] === "EOSE" && message[1] === "own-recipient",
    );
    client.socket.send(JSON.stringify(["CLOSE", "own-recipient"]));
    await client.next(
      (message) =>
        message[0] === "CLOSED" &&
        message[1] === "own-recipient" &&
        message[2] === "",
    );
    client.socket.close();
  });

  it("applies cluster connection-control commands to live sockets", async () => {
    const eventBus = new InMemoryEventBus();
    const communityId = "5ec803a4-d307-42cc-b67b-8755992fb71e";
    const publicUrl = new URL("ws://localhost:1/");
    const relay = createRelayServer({
      community: "localhost",
      eventBus,
      host: "127.0.0.1",
      ownerPubkeys: new Set(),
      port: 0,
      publicUrl,
      search: {
        communityId,
        service: { search: async () => ({ hits: [], page: 0 }) },
      },
    });
    relays.push(relay);
    await relay.listen();
    const address = relay.address();
    if (!address || typeof address === "string") {
      throw new Error("test relay did not bind a TCP port");
    }
    publicUrl.port = String(address.port);
    const secret = generateSecretKey();
    const pubkey = getPublicKey(secret);
    const client = await authenticatedClient(publicUrl.toString(), secret);
    const eventId = "c".repeat(64);

    await eventBus.publishControl(communityId, {
      event_id: eventId,
      op: "DisconnectPubkey",
      pubkey: [...Buffer.from(pubkey, "hex")],
      reason: "blocked: cluster ban",
    });
    await client.next(
      (message) =>
        message[0] === "OK" && message[1] === eventId && message[2] === false,
    );
    await new Promise<void>((resolve) => {
      if (client.socket.readyState === WebSocket.CLOSED) {
        resolve();
      } else {
        client.socket.once("close", () => resolve());
      }
    });
  });

  it("evicts archived-channel subscriptions across relay pods", async () => {
    const eventBus = new InMemoryEventBus();
    const communityId = "221ea6c9-2cc2-4438-abac-019e392f6852";
    const search = {
      communityId,
      service: { search: async () => ({ hits: [], page: 0 }) },
    };
    const firstUrl = new URL("ws://localhost:1/");
    const secondUrl = new URL("ws://localhost:1/");
    const firstRelay = createRelayServer({
      community: "localhost",
      eventBus,
      eventStore: new RevokingMemoryEventStore(),
      host: "127.0.0.1",
      ownerPubkeys: new Set(),
      port: 0,
      publicUrl: firstUrl,
      search,
    });
    const secondRelay = createRelayServer({
      community: "localhost",
      eventBus,
      host: "127.0.0.1",
      ownerPubkeys: new Set(),
      port: 0,
      publicUrl: secondUrl,
      search,
    });
    relays.push(firstRelay, secondRelay);
    await firstRelay.listen();
    await secondRelay.listen();
    const firstAddress = firstRelay.address();
    const secondAddress = secondRelay.address();
    if (
      !firstAddress ||
      typeof firstAddress === "string" ||
      !secondAddress ||
      typeof secondAddress === "string"
    ) {
      throw new Error("test relays did not bind TCP ports");
    }
    firstUrl.port = String(firstAddress.port);
    secondUrl.port = String(secondAddress.port);
    const secret = generateSecretKey();
    const channelId = randomUUID();
    const publisher = await authenticatedClient(firstUrl.toString(), secret);
    const subscriber = await authenticatedClient(secondUrl.toString(), secret);
    subscriber.socket.send(
      JSON.stringify(["REQ", "channel", { "#h": [channelId] }]),
    );
    await subscriber.next(
      (message) => message[0] === "EOSE" && message[1] === "channel",
    );
    const archive = signNostrEvent(
      {
        content: "",
        created_at: unixNow(),
        kind: KIND_NIP29_EDIT_METADATA,
        tags: [
          ["h", channelId],
          ["archived", "true"],
        ],
      },
      secret,
    );
    publisher.socket.send(JSON.stringify(["EVENT", archive]));
    await subscriber.next(
      (message) =>
        message[0] === "CLOSED" &&
        message[1] === "channel" &&
        message[2] === "restricted: channel access revoked",
    );
    publisher.socket.close();
    subscriber.socket.close();
  });

  it("serves NIP-11, liveness, dependency readiness, status, and Prometheus metrics", async () => {
    let dependenciesReady = false;
    const publicUrl = new URL("ws://localhost:1/");
    const relay = createRelayServer({
      community: "localhost",
      host: "127.0.0.1",
      ownerPubkeys: new Set(),
      port: 0,
      publicUrl,
      readinessCheck: async () => {
        if (!dependenciesReady) throw new Error("dependency unavailable");
      },
    });
    relays.push(relay);
    await relay.listen();
    const address = relay.address();
    if (!address || typeof address === "string") {
      throw new Error("test relay did not bind a TCP port");
    }
    const baseUrl = `http://localhost:${address.port}`;

    const liveness = await fetch(`${baseUrl}/_liveness`);
    expect(liveness.status).toBe(200);
    await expect(liveness.json()).resolves.toEqual({ status: "ok" });
    expect((await fetch(`${baseUrl}/_readiness`)).status).toBe(503);
    dependenciesReady = true;
    expect((await fetch(`${baseUrl}/health/ready`)).status).toBe(200);

    const nip11 = await fetch(`${baseUrl}/`, {
      headers: { Accept: "application/nostr+json" },
    });
    expect(nip11.headers.get("content-type")).toContain(
      "application/nostr+json",
    );
    await expect(nip11.json()).resolves.toMatchObject({
      limitation: {
        auth_required: true,
        due_delivery_mode: "push",
        max_filters: 10,
        max_limit: 10_000,
        max_message_length: 512 * 1024,
        max_not_before_delta: 31_536_000,
        max_subid_length: 256,
        max_subscriptions: 1_024,
      },
      name: "Buzz Relay",
      supported_nips: [1, 2, 10, 11, 16, 17, 23, 25, 29, 33, 38, 42, 56],
    });
    const info = await fetch(`${baseUrl}/info`);
    expect(await info.json()).toEqual(
      await (await fetch(`${baseUrl}/`)).json(),
    );

    const status = await fetch(`${baseUrl}/_status`);
    await expect(status.json()).resolves.toMatchObject({
      activeConnections: 0,
      community: "localhost",
      status: "ok",
    });
    const metrics = await (await fetch(`${baseUrl}/metrics`)).text();
    expect(metrics).toContain("buzz_ws_connections_active 0");
    expect(metrics).toContain("buzz_http_requests_total");
  });

  it("advertises the relay signing identity and NIP-43 only when configured", async () => {
    const relaySelfPubkey = "ab".repeat(32);
    const relay = createRelayServer({
      community: "localhost",
      host: "127.0.0.1",
      advertiseNip43: true,
      nip43: true,
      ownerPubkeys: new Set(),
      port: 0,
      publicUrl: new URL("ws://localhost:1/"),
      relaySelfPubkey,
    });
    relays.push(relay);
    await relay.listen();
    const address = relay.address();
    if (!address || typeof address === "string") {
      throw new Error("test relay did not bind a TCP port");
    }
    const response = await fetch(`http://localhost:${address.port}/`, {
      headers: { Accept: "application/nostr+json" },
    });
    await expect(response.json()).resolves.toMatchObject({
      pubkey: null,
      self: relaySelfPubkey,
      supported_nips: [1, 2, 10, 11, 16, 17, 23, 25, 29, 33, 38, 42, 43, 56],
    });
  });

  it("stores, replays, counts, and live-routes normal signed events", async () => {
    const authorSecret = generateSecretKey();
    const readerSecret = generateSecretKey();
    const authorPubkey = getPublicKey(authorSecret);
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
      throw new Error("test relay did not bind a TCP port");
    }
    publicUrl.port = String(address.port);
    const relayUrl = publicUrl.toString();
    const author = await authenticatedClient(relayUrl, authorSecret);
    const reader = await authenticatedClient(relayUrl, readerSecret);
    reader.socket.send(
      JSON.stringify(["REQ", "notes", { authors: [authorPubkey], kinds: [1] }]),
    );
    await reader.next(
      (message) => message[0] === "EOSE" && message[1] === "notes",
    );

    const note = signNostrEvent(
      {
        content: "normal TypeScript relay event",
        created_at: unixNow(),
        kind: 1,
        tags: [],
      },
      authorSecret,
    );
    author.socket.send(JSON.stringify(["EVENT", note]));
    await author.next(
      (message) =>
        message[0] === "OK" && message[1] === note.id && message[2] === true,
    );
    await reader.next(
      (message) =>
        message[0] === "EVENT" &&
        message[1] === "notes" &&
        (message[2] as { id?: string } | undefined)?.id === note.id,
    );

    const historical = await authenticatedClient(relayUrl, generateSecretKey());
    historical.socket.send(
      JSON.stringify(["REQ", "history", { ids: [note.id.slice(0, 12)] }]),
    );
    await historical.next(
      (message) =>
        message[0] === "EVENT" &&
        message[1] === "history" &&
        (message[2] as { id?: string } | undefined)?.id === note.id,
    );
    await historical.next(
      (message) => message[0] === "EOSE" && message[1] === "history",
    );
    historical.socket.send(JSON.stringify(["COUNT", "count", { kinds: [1] }]));
    const count = await historical.next(
      (message) => message[0] === "COUNT" && message[1] === "count",
    );
    expect(count[2]).toEqual({ count: 1 });
    author.socket.close();
    reader.socket.close();
    historical.socket.close();
  });

  it("accepts and privately routes an unlinkable NIP-17 gift-wrap signer", async () => {
    const senderSecret = generateSecretKey();
    const recipientSecret = generateSecretKey();
    const recipientPubkey = getPublicKey(recipientSecret);
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
      throw new Error("test relay did not bind a TCP port");
    }
    publicUrl.port = String(address.port);
    const sender = await authenticatedClient(
      publicUrl.toString(),
      senderSecret,
    );
    const recipient = await authenticatedClient(
      publicUrl.toString(),
      recipientSecret,
    );
    recipient.socket.send(
      JSON.stringify([
        "REQ",
        "gift-wraps",
        { "#p": [recipientPubkey], kinds: [KIND_GIFT_WRAP] },
      ]),
    );
    await recipient.next(
      (message) => message[0] === "EOSE" && message[1] === "gift-wraps",
    );

    const wrap = signNostrEvent(
      {
        content: "opaque nip-44 payload",
        created_at: unixNow(),
        kind: KIND_GIFT_WRAP,
        tags: [["p", recipientPubkey]],
      },
      generateSecretKey(),
    );
    expect(wrap.pubkey).not.toBe(getPublicKey(senderSecret));
    sender.socket.send(JSON.stringify(["EVENT", wrap]));
    await sender.next(
      (message) =>
        message[0] === "OK" && message[1] === wrap.id && message[2] === true,
    );
    await recipient.next(
      (message) =>
        message[0] === "EVENT" &&
        message[1] === "gift-wraps" &&
        (message[2] as { id?: string } | undefined)?.id === wrap.id,
    );
    sender.socket.close();
    recipient.socket.close();
  });

  it("stores reactions under the referenced event's channel coordinate", async () => {
    const secret = generateSecretKey();
    const targetChannel = "00000000-0000-4000-8000-000000000001";
    const forgedChannel = "00000000-0000-4000-8000-000000000002";
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
      throw new Error("test relay did not bind a TCP port");
    }
    publicUrl.port = String(address.port);
    const client = await authenticatedClient(publicUrl.toString(), secret);
    const target = signNostrEvent(
      {
        content: "react to this",
        created_at: unixNow(),
        kind: 9,
        tags: [["h", targetChannel]],
      },
      secret,
    );
    client.socket.send(JSON.stringify(["EVENT", target]));
    await client.next(
      (message) =>
        message[0] === "OK" && message[1] === target.id && message[2] === true,
    );
    const reaction = signNostrEvent(
      {
        content: "✅",
        created_at: unixNow(),
        kind: KIND_REACTION,
        tags: [
          ["e", target.id],
          ["h", forgedChannel],
        ],
      },
      secret,
    );
    client.socket.send(JSON.stringify(["EVENT", reaction]));
    await client.next(
      (message) =>
        message[0] === "OK" &&
        message[1] === reaction.id &&
        message[2] === true,
    );
    await expect(
      relay.eventStore.getById("localhost", reaction.id),
    ).resolves.toMatchObject({ channelId: targetChannel });
    const duplicate = signNostrEvent(
      {
        content: "✅",
        created_at: unixNow() + 1,
        kind: KIND_REACTION,
        tags: [["e", target.id]],
      },
      secret,
    );
    client.socket.send(JSON.stringify(["EVENT", duplicate]));
    const duplicateResult = await client.next(
      (message) =>
        message[0] === "OK" &&
        message[1] === duplicate.id &&
        message[2] === false,
    );
    expect(duplicateResult[3]).toBe("duplicate: reaction already exists");
    await expect(
      relay.eventStore.getById("localhost", duplicate.id),
    ).resolves.toBeUndefined();
    client.socket.close();
  });

  it("authorizes and applies NIP-09 deletion without trusting a supplied channel", async () => {
    const authorSecret = generateSecretKey();
    const attackerSecret = generateSecretKey();
    const channelId = "00000000-0000-4000-8000-000000000001";
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
      throw new Error("test relay did not bind a TCP port");
    }
    publicUrl.port = String(address.port);
    const author = await authenticatedClient(
      publicUrl.toString(),
      authorSecret,
    );
    const attacker = await authenticatedClient(
      publicUrl.toString(),
      attackerSecret,
    );
    const target = signNostrEvent(
      {
        content: "delete me",
        created_at: unixNow(),
        kind: 9,
        tags: [["h", channelId]],
      },
      authorSecret,
    );
    author.socket.send(JSON.stringify(["EVENT", target]));
    await author.next(
      (message) =>
        message[0] === "OK" && message[1] === target.id && message[2] === true,
    );
    const forged = signNostrEvent(
      {
        content: "",
        created_at: unixNow(),
        kind: KIND_DELETION,
        tags: [["e", target.id]],
      },
      attackerSecret,
    );
    attacker.socket.send(JSON.stringify(["EVENT", forged]));
    await attacker.next(
      (message) =>
        message[0] === "OK" && message[1] === forged.id && message[2] === false,
    );
    const deletion = signNostrEvent(
      {
        content: "",
        created_at: unixNow(),
        kind: KIND_DELETION,
        tags: [["e", target.id]],
      },
      authorSecret,
    );
    author.socket.send(JSON.stringify(["EVENT", deletion]));
    await author.next(
      (message) =>
        message[0] === "OK" &&
        message[1] === deletion.id &&
        message[2] === true,
    );
    await expect(
      relay.eventStore.getById("localhost", target.id),
    ).resolves.toBeUndefined();
    await expect(
      relay.eventStore.getById("localhost", target.id, {
        includeDeleted: true,
      }),
    ).resolves.toMatchObject({ channelId, event: target });
    author.socket.close();
    attacker.socket.close();
  });

  it("treats NIP-50 hits as candidates and re-authorizes full events", async () => {
    const secretKey = generateSecretKey();
    const visible = signNostrEvent(
      {
        content: "visible search result",
        created_at: unixNow(),
        kind: 1,
        tags: [],
      },
      secretKey,
    );
    const hidden = signNostrEvent(
      {
        content: "hidden search result",
        created_at: unixNow() - 1,
        kind: 1,
        tags: [],
      },
      secretKey,
    );
    const publicUrl = new URL("ws://localhost:1/");
    const relay = createRelayServer({
      accessPolicy: {
        canConnect: async () => true,
        canPublish: async () => true,
        canRead: async (_community, _pubkey, event) =>
          event.content !== hidden.content,
      },
      community: "localhost",
      host: "127.0.0.1",
      ownerPubkeys: new Set(),
      port: 0,
      publicUrl,
      search: {
        communityId: "00000000-0000-4000-8000-000000000001",
        service: {
          search: async (query) => ({
            hits:
              (query.page ?? 1) === 1
                ? [hidden, visible].map((event, index) => ({
                    channelId: null,
                    createdAt: event.created_at,
                    eventId: event.id,
                    kind: event.kind,
                    pubkey: event.pubkey,
                    rank: 1 - index / 10,
                  }))
                : [],
            page: query.page ?? 1,
          }),
        },
      },
    });
    relays.push(relay);
    await relay.eventStore.store("localhost", visible);
    await relay.eventStore.store("localhost", hidden);
    await relay.listen();
    const address = relay.address();
    if (!address || typeof address === "string") {
      throw new Error("test relay did not bind a TCP port");
    }
    publicUrl.port = String(address.port);
    const reader = await authenticatedClient(
      publicUrl.toString(),
      generateSecretKey(),
    );
    reader.socket.send(
      JSON.stringify(["REQ", "search", { search: "result", kinds: [1] }]),
    );
    await reader.next(
      (message) => message[0] === "EOSE" && message[1] === "search",
    );
    const deliveredIds = reader.messages
      .filter((message) => message[0] === "EVENT" && message[1] === "search")
      .map((message) => (message[2] as { readonly id: string }).id);
    expect(deliveredIds).toEqual([visible.id]);
    reader.socket.close();
  });

  it("enrolls, requires owner approval, and routes an encrypted command over one socket per side", async () => {
    const ownerSecret = generateSecretKey();
    const workerSecret = generateSecretKey();
    const ownerPubkey = getPublicKey(ownerSecret);
    const workerPubkey = getPublicKey(workerSecret);
    const publicUrl = new URL("ws://localhost:1/");
    const relay = createRelayServer({
      community: "localhost",
      host: "127.0.0.1",
      ownerPubkeys: new Set([ownerPubkey]),
      port: 0,
      publicUrl,
    });
    relays.push(relay);
    await relay.listen();
    const address = relay.address();
    if (!address || typeof address === "string") {
      throw new Error("test relay did not bind a TCP port");
    }
    publicUrl.port = String(address.port);
    const relayUrl = publicUrl.toString();
    const owner = await authenticatedClient(relayUrl, ownerSecret);
    const worker = await authenticatedClient(relayUrl, workerSecret);

    owner.socket.send(
      JSON.stringify([
        "REQ",
        "enrollments",
        {
          "#p": [ownerPubkey],
          kinds: [KIND_REMOTE_AGENT_ENROLLMENT],
        },
      ]),
    );
    await owner.next(
      (message) => message[0] === "EOSE" && message[1] === "enrollments",
    );
    const now = unixNow();
    const minted = await relay.registry.mint({
      capabilities: ["deploy", "status", "revoke"],
      community: "localhost",
      now,
      ownerPubkey,
    });
    const sessionId = randomBytes(16).toString("hex");
    const enrollmentPayload: EnrollmentPayload = {
      body: {
        capabilities: ["deploy", "status", "revoke"],
        challenge: randomBytes(32).toString("hex"),
        community: "localhost",
        enrollmentId: minted.record.id,
        ownerPubkey,
        workerName: "integration-worker",
        workerPubkey,
        workerVersion: "0.1.0",
      },
      deploymentId: minted.record.id,
      expiresAt: now + 30,
      issuedAt: now,
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
    worker.socket.send(
      JSON.stringify(["BRAP", "ENROLL", minted.token, enrollmentEvent]),
    );

    const deliveredEnrollment = await owner.next(
      (message) =>
        message[0] === "EVENT" &&
        message[1] === "enrollments" &&
        (message[2] as { id?: string } | undefined)?.id === enrollmentEvent.id,
    );
    expect(
      (deliveredEnrollment[2] as { content: string }).content,
    ).not.toContain("integration-worker");
    await expect(
      relay.registry.authorizedWorker(workerPubkey, "localhost"),
    ).resolves.toBeUndefined();

    const approvalPayload: AckPayload = {
      body: {
        commandMessageId: enrollmentPayload.messageId,
        outcome: "completed",
      },
      deploymentId: minted.record.id,
      expiresAt: now + 30,
      issuedAt: now,
      messageId: randomUUID(),
      sequence: 0,
      sessionId,
      type: "ack",
      version: 1,
    };
    const approvalEvent = createRemoteEnvelope({
      payload: approvalPayload,
      recipientPubkey: workerPubkey,
      senderSecretKey: ownerSecret,
      workerPubkey,
    });
    owner.socket.send(
      JSON.stringify([
        "BRAP",
        "APPROVE",
        minted.record.id,
        workerPubkey,
        approvalEvent,
      ]),
    );
    await worker.next(
      (message) =>
        message[0] === "BRAP" &&
        message[1] === "APPROVED" &&
        message[2] === minted.record.id,
    );
    await expect(
      relay.registry.authorizedWorker(workerPubkey, "localhost"),
    ).resolves.toMatchObject({ ownerPubkey });

    worker.socket.send(
      JSON.stringify([
        "REQ",
        "commands",
        {
          "#p": [workerPubkey],
          kinds: [KIND_REMOTE_AGENT_COMMAND],
        },
      ]),
    );
    await worker.next(
      (message) => message[0] === "EOSE" && message[1] === "commands",
    );
    const commandPayload: CommandPayload = {
      body: { action: "status" },
      deploymentId: minted.record.id,
      expiresAt: now + 30,
      issuedAt: now,
      messageId: randomUUID(),
      sequence: 0,
      sessionId: randomBytes(16).toString("hex"),
      type: "command",
      version: 1,
    };
    const commandEvent = createRemoteEnvelope({
      payload: commandPayload,
      recipientPubkey: workerPubkey,
      senderSecretKey: ownerSecret,
      workerPubkey,
    });
    owner.socket.send(JSON.stringify(["EVENT", commandEvent]));

    const deliveredCommand = await worker.next(
      (message) =>
        message[0] === "EVENT" &&
        message[1] === "commands" &&
        (message[2] as { id?: string } | undefined)?.id === commandEvent.id,
    );
    expect((deliveredCommand[2] as { content: string }).content).not.toContain(
      "status",
    );

    const revokePayload: CommandPayload = {
      body: {
        action: "revoke",
        destructiveConfirmation: "ERASE_REMOTE_AGENT_KEY",
        eraseAgentKey: true,
      },
      deploymentId: minted.record.id,
      expiresAt: now + 30,
      issuedAt: now,
      messageId: randomUUID(),
      sequence: 0,
      sessionId: randomBytes(16).toString("hex"),
      type: "command",
      version: 1,
    };
    const revokeEvent = createRemoteEnvelope({
      payload: revokePayload,
      recipientPubkey: workerPubkey,
      senderSecretKey: ownerSecret,
      workerPubkey,
    });
    owner.socket.send(
      JSON.stringify(["BRAP", "REVOKE", workerPubkey, revokeEvent]),
    );
    await worker.next(
      (message) =>
        message[0] === "EVENT" &&
        (message[2] as { id?: string } | undefined)?.id === revokeEvent.id,
    );
    await owner.next(
      (message) =>
        message[0] === "BRAP" &&
        message[1] === "REVOKED" &&
        message[2] === minted.record.id &&
        message[3] === workerPubkey,
    );
    await expect(
      relay.registry.authorizedWorker(workerPubkey, "localhost"),
    ).resolves.toBeUndefined();

    owner.socket.send(JSON.stringify(["EVENT", commandEvent]));
    await owner.next(
      (message) =>
        message[0] === "OK" &&
        message[1] === commandEvent.id &&
        message[2] === false &&
        typeof message[3] === "string" &&
        message[3].startsWith("restricted:"),
    );
    owner.socket.close();
    worker.socket.close();
  });

  it("admits an owner-authorized agent over one NIP-42 connection without role inheritance", async () => {
    const ownerSecret = generateSecretKey();
    const agentSecret = generateSecretKey();
    const ownerPubkey = getPublicKey(ownerSecret);
    const agentPubkey = getPublicKey(agentSecret);
    const authTag = ownerAuthTag(ownerSecret, agentPubkey);
    const policy: RelayAccessPolicy = {
      async canConnect(_community, pubkey, delegatedBy) {
        return (
          pubkey === ownerPubkey ||
          (pubkey === agentPubkey && delegatedBy === ownerPubkey)
        );
      },
      async canPublish(_community, pubkey, event, delegatedBy) {
        if (event.pubkey !== pubkey) return false;
        if (pubkey === ownerPubkey) return true;
        return (
          pubkey === agentPubkey &&
          delegatedBy === ownerPubkey &&
          !event.tags.some((tag) => tag[0] === "h")
        );
      },
      async canRead(_community, pubkey, event, delegatedBy) {
        if (pubkey === ownerPubkey) return true;
        return (
          pubkey === agentPubkey &&
          delegatedBy === ownerPubkey &&
          !event.tags.some((tag) => tag[0] === "h")
        );
      },
    };
    const publicUrl = new URL("ws://localhost:1/");
    const relay = createRelayServer({
      accessPolicy: policy,
      community: "localhost",
      host: "127.0.0.1",
      ownerPubkeys: new Set([ownerPubkey]),
      port: 0,
      publicUrl,
    });
    relays.push(relay);
    await relay.listen();
    const address = relay.address();
    if (!address || typeof address === "string") {
      throw new Error("test relay did not bind a TCP port");
    }
    publicUrl.port = String(address.port);
    const agent = await authenticatedClient(
      publicUrl.toString(),
      agentSecret,
      authTag,
    );
    const profile = signNostrEvent(
      {
        content: JSON.stringify({ name: "owner-backed-agent" }),
        created_at: unixNow(),
        kind: 0,
        tags: [authTag],
      },
      agentSecret,
    );
    agent.socket.send(JSON.stringify(["EVENT", profile]));
    await agent.next(
      (message) =>
        message[0] === "OK" && message[1] === profile.id && message[2] === true,
    );

    const channelMessage = signNostrEvent(
      {
        content: "owner membership must not leak into channels",
        created_at: unixNow(),
        kind: 9,
        tags: [["h", "00000000-0000-4000-8000-000000000001"]],
      },
      agentSecret,
    );
    agent.socket.send(JSON.stringify(["EVENT", channelMessage]));
    await agent.next(
      (message) =>
        message[0] === "OK" &&
        message[1] === channelMessage.id &&
        message[2] === false &&
        typeof message[3] === "string" &&
        message[3].startsWith("restricted:"),
    );
    agent.socket.close();
  });

  it("serves a signed, gap-free top-level channel window with summaries and bounds", async () => {
    const relaySecret = generateSecretKey();
    const readerSecret = generateSecretKey();
    const authorSecret = generateSecretKey();
    const publicUrl = new URL("ws://localhost:1/");
    const relay = createRelayServer({
      community: "localhost",
      host: "127.0.0.1",
      ownerPubkeys: new Set(),
      port: 0,
      publicUrl,
      relaySecretKey: relaySecret,
    });
    relays.push(relay);
    await relay.listen();
    const address = relay.address();
    if (!address || typeof address === "string") {
      throw new Error("test relay did not bind a TCP port");
    }
    publicUrl.port = String(address.port);
    const channelId = randomUUID();
    const root = signNostrEvent(
      {
        content: "root",
        created_at: unixNow() - 1,
        kind: 9,
        tags: [["h", channelId]],
      },
      authorSecret,
    );
    await relay.eventStore.store("localhost", root, channelId);
    const reply = signNostrEvent(
      {
        content: "reply",
        created_at: unixNow(),
        kind: 9,
        tags: [
          ["h", channelId],
          ["e", root.id, "", "root"],
          ["e", root.id, "", "reply"],
        ],
      },
      authorSecret,
    );
    const metadata = await resolveThreadMetadata(
      relay.eventStore,
      "localhost",
      reply,
      channelId,
    );
    await relay.eventStore.store(
      "localhost",
      reply,
      channelId,
      undefined,
      metadata,
    );

    const body = Buffer.from(
      JSON.stringify([
        {
          "#h": [channelId],
          include_summaries: true,
          limit: 1,
          top_level: true,
        },
      ]),
    );
    const url = `http://localhost:${address.port}/query`;
    const response = await fetch(url, {
      body,
      headers: {
        Authorization: nip98Header(readerSecret, url, body),
        "Content-Type": "application/json",
      },
      method: "POST",
    });
    expect(response.status).toBe(200);
    const events = (await response.json()) as Array<{
      readonly content: string;
      readonly id: string;
      readonly kind: number;
    }>;
    expect(events.map((event) => event.kind)).toEqual([
      9,
      KIND_THREAD_SUMMARY,
      KIND_WINDOW_BOUNDS,
    ]);
    expect(events[0]?.id).toBe(root.id);
    expect(JSON.parse(events[1]?.content ?? "{}")).toMatchObject({
      descendant_count: 1,
      reply_count: 1,
    });
    expect(JSON.parse(events[2]?.content ?? "{}")).toEqual({
      has_more: false,
      next_cursor: null,
    });
  });

  it("tracks ephemeral presence across pods and clears it only after the final socket closes", async () => {
    const eventBus = new InMemoryEventBus();
    const relaySecret = generateSecretKey();
    const userSecret = generateSecretKey();
    const readerSecret = generateSecretKey();
    const userPubkey = getPublicKey(userSecret);
    const publicUrl = new URL("ws://localhost:1/");
    const relay = createRelayServer({
      community: "localhost",
      eventBus,
      host: "127.0.0.1",
      ownerPubkeys: new Set(),
      port: 0,
      publicUrl,
      relaySecretKey: relaySecret,
    });
    relays.push(relay);
    await relay.listen();
    const address = relay.address();
    if (!address || typeof address === "string") {
      throw new Error("test relay did not bind a TCP port");
    }
    publicUrl.port = String(address.port);
    const first = await authenticatedClient(publicUrl.toString(), userSecret);
    const second = await authenticatedClient(publicUrl.toString(), userSecret);
    const presence = signNostrEvent(
      {
        content: JSON.stringify({ status: "online" }),
        created_at: unixNow(),
        kind: KIND_PRESENCE_UPDATE,
        tags: [],
      },
      userSecret,
    );
    first.socket.send(JSON.stringify(["EVENT", presence]));
    await first.next(
      (message) =>
        message[0] === "OK" &&
        message[1] === presence.id &&
        message[2] === true,
    );
    await expect(
      eventBus.getPresenceBulk("localhost", [userPubkey]),
    ).resolves.toEqual(new Map([[userPubkey, "online"]]));

    const body = Buffer.from(
      JSON.stringify([
        {
          authors: [userPubkey],
          kinds: [KIND_PRESENCE_UPDATE],
        },
      ]),
    );
    const url = `http://localhost:${address.port}/query`;
    const response = await fetch(url, {
      body,
      headers: {
        Authorization: nip98Header(readerSecret, url, body),
        "Content-Type": "application/json",
      },
      method: "POST",
    });
    const synthesized = (await response.json()) as Array<{
      readonly content: string;
      readonly kind: number;
      readonly pubkey: string;
      readonly tags: string[][];
    }>;
    expect(synthesized).toHaveLength(1);
    expect(synthesized[0]).toMatchObject({
      content: "online",
      kind: KIND_PRESENCE_UPDATE,
      pubkey: getPublicKey(relaySecret),
    });
    expect(synthesized[0]?.tags).toContainEqual(["p", userPubkey]);

    first.socket.close();
    await waitFor(() => first.socket.readyState === WebSocket.CLOSED);
    await expect(
      eventBus.getPresenceBulk("localhost", [userPubkey]),
    ).resolves.toEqual(new Map([[userPubkey, "online"]]));
    second.socket.close();
    await waitFor(
      async () =>
        (await eventBus.getPresenceBulk("localhost", [userPubkey])).size === 0,
    );
  });
});

async function authenticatedClient(
  relayUrl: string,
  secretKey: Uint8Array,
  ownerCredential?: readonly [string, string, string, string],
): Promise<{
  readonly socket: WebSocket;
  readonly messages: readonly unknown[][];
  readonly next: (
    predicate: (message: unknown[]) => boolean,
  ) => Promise<unknown[]>;
}> {
  const socket = new WebSocket(relayUrl, {
    perMessageDeflate: false,
  });
  const queue: unknown[][] = [];
  const messages: unknown[][] = [];
  const waiters: Array<{
    predicate: (message: unknown[]) => boolean;
    resolve: (message: unknown[]) => void;
  }> = [];
  socket.on("message", (raw) => {
    const parsed = JSON.parse(raw.toString()) as unknown;
    if (!Array.isArray(parsed)) return;
    const message = parsed as unknown[];
    messages.push(message);
    const index = waiters.findIndex((waiter) => waiter.predicate(message));
    if (index >= 0) {
      const [waiter] = waiters.splice(index, 1);
      waiter?.resolve(message);
      return;
    }
    queue.push(message);
  });
  await new Promise<void>((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  const next = async (
    predicate: (message: unknown[]) => boolean,
  ): Promise<unknown[]> => {
    const existingIndex = queue.findIndex(predicate);
    if (existingIndex >= 0) {
      const [existing] = queue.splice(existingIndex, 1);
      return existing as unknown[];
    }
    return new Promise<unknown[]>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error("timed out waiting for relay message")),
        5_000,
      );
      waiters.push({
        predicate,
        resolve: (message) => {
          clearTimeout(timeout);
          resolve(message);
        },
      });
    });
  };

  const challengeMessage = await next(
    (message) => message[0] === "AUTH" && typeof message[1] === "string",
  );
  const authEvent = signNostrEvent(
    {
      content: "",
      created_at: unixNow(),
      kind: KIND_AUTH,
      tags: [
        ["relay", relayUrl],
        ["challenge", challengeMessage[1] as string],
        ...(ownerCredential ? [[...ownerCredential]] : []),
      ],
    },
    secretKey,
  );
  socket.send(JSON.stringify(["AUTH", authEvent]));
  await next(
    (message) =>
      message[0] === "OK" && message[1] === authEvent.id && message[2] === true,
  );
  return { messages, next, socket };
}

function ownerAuthTag(
  ownerSecret: Uint8Array,
  agentPubkey: string,
): [string, string, string, string] {
  const digest = createHash("sha256")
    .update(`nostr:agent-auth:${agentPubkey}:`)
    .digest();
  return [
    "auth",
    getPublicKey(ownerSecret),
    "",
    Buffer.from(schnorr.sign(digest, ownerSecret)).toString("hex"),
  ];
}

function nip98Header(secretKey: Uint8Array, url: string, body: Buffer): string {
  const event = signNostrEvent(
    {
      content: "",
      created_at: unixNow(),
      kind: KIND_HTTP_AUTH,
      tags: [
        ["u", url],
        ["method", "POST"],
        ["payload", createHash("sha256").update(body).digest("hex")],
      ],
    },
    secretKey,
  );
  return `Nostr ${Buffer.from(JSON.stringify(event)).toString("base64")}`;
}

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMilliseconds = 2_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMilliseconds;
  while (!(await predicate())) {
    if (Date.now() >= deadline) throw new Error("condition timed out");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
