import { once } from "node:events";

import { signNostrEvent } from "@buzz/core";
import { generateSecretKey, getPublicKey } from "nostr-tools/pure";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";

import { PairRelay } from "./relay.js";

const relays: PairRelay[] = [];

afterEach(async () => {
  await Promise.all(relays.splice(0).map((relay) => relay.close()));
});

describe("PairRelay", () => {
  it("delivers only fresh signed pairing events to one live recipient", async () => {
    const relay = new PairRelay({ port: 0 });
    relays.push(relay);
    const { url } = await relay.listen();
    const recipientKey = generateSecretKey();
    const recipient = getPublicKey(recipientKey);
    recipientKey.fill(0);
    const subscriber = await connect(url);
    subscriber.send(
      JSON.stringify(["REQ", "pair", { "#p": [recipient], kinds: [24134] }]),
    );
    expect(await receive(subscriber)).toEqual(["EOSE", "pair"]);

    const sender = await connect(url);
    const event = pairingEvent(recipient);
    sender.send(JSON.stringify(["EVENT", event]));
    expect(await receive(subscriber)).toEqual([
      "EVENT",
      "pair",
      wireEvent(event),
    ]);
    expect(await receive(sender)).toEqual(["OK", event.id, true, ""]);
  });

  it("has no replay and rejects duplicate subscribers and duplicate events", async () => {
    const relay = new PairRelay({ port: 0 });
    relays.push(relay);
    const { url } = await relay.listen();
    const recipient = "a".repeat(64);
    const sender = await connect(url);
    const event = pairingEvent(recipient);
    sender.send(JSON.stringify(["EVENT", event]));
    expect(await receive(sender)).toEqual([
      "OK",
      event.id,
      false,
      "no live subscriber",
    ]);

    const first = await connect(url);
    first.send(JSON.stringify(["REQ", "one", { "#p": [recipient] }]));
    expect(await receive(first)).toEqual(["EOSE", "one"]);
    const second = await connect(url);
    second.send(JSON.stringify(["REQ", "two", { "#p": [recipient] }]));
    expect(await receive(second)).toEqual([
      "CLOSED",
      "two",
      "error: #p already has a live subscriber",
    ]);

    sender.send(JSON.stringify(["EVENT", event]));
    expect(await receive(first)).toEqual(["EVENT", "one", wireEvent(event)]);
    expect(await receive(sender)).toEqual(["OK", event.id, true, ""]);
    sender.send(JSON.stringify(["EVENT", event]));
    expect(await receive(sender)).toEqual([
      "OK",
      event.id,
      false,
      "duplicate: already seen",
    ]);
  });

  it("rejects malformed filters, stale events, invalid signatures, and binary frames", async () => {
    const relay = new PairRelay({ port: 0 });
    relays.push(relay);
    const { url } = await relay.listen();
    const client = await connect(url);
    client.send(JSON.stringify(["REQ", "bad", { authors: ["a".repeat(64)] }]));
    expect(await receive(client)).toEqual([
      "CLOSED",
      "bad",
      "error: unsupported filter field",
    ]);

    const recipient = "b".repeat(64);
    const stale = pairingEvent(recipient, Math.floor(Date.now() / 1_000) - 121);
    client.send(JSON.stringify(["EVENT", stale]));
    expect((await receive(client))?.[2]).toBe(false);

    const invalid = { ...pairingEvent(recipient), content: "AAAA" };
    client.send(JSON.stringify(["EVENT", invalid]));
    expect((await receive(client))?.[3]).toMatch(/signature or event id/);

    client.send(Buffer.from([1, 2, 3]));
    const [code] = (await once(client, "close")) as [number];
    expect(code).toBe(1003);
  });

  it("serves only the configured pairing path", async () => {
    const relay = new PairRelay({ port: 0 });
    relays.push(relay);
    const { url } = await relay.listen();
    await expect(connect(url.replace("/pair", "/wrong"))).rejects.toThrow();
  });
});

function pairingEvent(
  recipient: string,
  createdAt = Math.floor(Date.now() / 1_000),
) {
  const secret = generateSecretKey();
  const decoded = Buffer.concat([
    Buffer.from([2]),
    Buffer.alloc(32, 1),
    Buffer.alloc(48, 2),
    Buffer.alloc(32, 3),
  ]);
  const event = signNostrEvent(
    {
      content: decoded.toString("base64"),
      created_at: createdAt,
      kind: 24134,
      tags: [["p", recipient]],
    },
    secret,
  );
  secret.fill(0);
  return event;
}

function wireEvent<T>(event: T): T {
  return JSON.parse(JSON.stringify(event)) as T;
}

async function connect(url: string): Promise<WebSocket> {
  const socket = new WebSocket(url);
  await Promise.race([
    once(socket, "open"),
    once(socket, "error").then(([error]) => Promise.reject(error)),
  ]);
  return socket;
}

async function receive(socket: WebSocket): Promise<unknown[]> {
  const [data] = (await once(socket, "message")) as [Buffer];
  return JSON.parse(data.toString()) as unknown[];
}
