import { randomUUID } from "node:crypto";

import { generateSecretKey, getPublicKey } from "nostr-tools/pure";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { AcpHarness, type AcpHarnessEvent } from "@buzz/acp";
import {
  KIND_STREAM_MESSAGE,
  signNostrEvent,
  unixNow,
  type NostrEvent,
} from "@buzz/core";
import { AuthenticatedRelayClient, type RelaySocket } from "@buzz/ws-client";

import { createRelayServer } from "./server.js";

const FAKE_AGENT = String.raw`
const readline = require("node:readline");
const rl = readline.createInterface({ input: process.stdin });
const send = (value) => process.stdout.write(JSON.stringify(value) + "\n");
rl.on("line", (line) => {
  const request = JSON.parse(line);
  if (request.method === "initialize") {
    send({ jsonrpc: "2.0", id: request.id, result: {
      protocolVersion: request.params.protocolVersion,
      agentCapabilities: { loadSession: false }
    }});
  } else if (request.method === "session/new") {
    send({ jsonrpc: "2.0", id: request.id, result: {
      sessionId: "channel-session"
    }});
  } else if (request.method === "session/prompt") {
    send({ jsonrpc: "2.0", method: "session/update", params: {
      sessionId: request.params.sessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "turn accepted" }
      }
    }});
    send({ jsonrpc: "2.0", id: request.id, result: {
      stopReason: "end_turn"
    }});
  }
});
`;

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

describe("TypeScript ACP harness", () => {
  it("authenticates, gates the owner, dispatches a turn, and publishes built-in agent text", async () => {
    const ownerSecretKey = generateSecretKey();
    const agentSecretKey = generateSecretKey();
    const strangerSecretKey = generateSecretKey();
    const ownerPubkey = getPublicKey(ownerSecretKey);
    const agentPubkey = getPublicKey(agentSecretKey);
    const channelId = randomUUID();
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

    const harness = new AcpHarness({
      agent: {
        args: ["-e", FAKE_AGENT],
        command: process.execPath,
        cwd: process.cwd(),
        inheritEnvironment: false,
        requestTimeoutMilliseconds: 5_000,
        turnTimeoutMilliseconds: 10_000,
      },
      allowInsecureLocalhost: true,
      initialChannelIds: [channelId],
      ownerPubkey,
      presenceEnabled: false,
      publishAgentText: true,
      relayUrl,
      respondTo: "owner-only",
      secretKey: agentSecretKey,
      socketFactory: nodeSocket,
      typingEnabled: false,
    });
    cleanups.push(() => harness.stop());
    await harness.start();

    const owner = new AuthenticatedRelayClient({
      allowInsecureLocalhost: true,
      relayUrl,
      secretKey: ownerSecretKey,
      socketFactory: nodeSocket,
    });
    const stranger = new AuthenticatedRelayClient({
      allowInsecureLocalhost: true,
      relayUrl,
      secretKey: strangerSecretKey,
      socketFactory: nodeSocket,
    });
    cleanups.push(() => owner.close());
    cleanups.push(() => stranger.close());
    await owner.connect();
    await stranger.connect();
    const replySubscription = owner.subscribe(
      [
        {
          "#h": [channelId],
          authors: [agentPubkey],
          kinds: [KIND_STREAM_MESSAGE],
        },
      ],
      "agent-replies",
    );
    const replyReceived = Promise.race([
      waitForRelayEvent(owner, "agent-replies"),
      waitForHarnessEvent(harness, (event) => event.type === "error").then(
        (event) => {
          if (event.type === "error") throw event.error;
          throw new Error("unexpected harness event");
        },
      ),
    ]);
    cleanups.push(() => {
      replySubscription.close();
    });
    const ignored = messageEvent(
      strangerSecretKey,
      agentPubkey,
      channelId,
      "ignore this stranger",
    );
    await stranger.publish(ignored);
    await new Promise((resolve) => setTimeout(resolve, 25));

    const accepted = messageEvent(
      ownerSecretKey,
      agentPubkey,
      channelId,
      "please handle this",
    );
    const completed = waitForHarnessEvent(
      harness,
      (event) =>
        event.type === "turn-completed" && event.eventId === accepted.id,
    );
    await owner.publish(accepted);
    const event = await completed;
    expect(event).toMatchObject({
      channelId,
      eventId: accepted.id,
      type: "turn-completed",
    });
    const reply = await replyReceived;
    expect(reply).toMatchObject({
      content: "turn accepted",
      kind: KIND_STREAM_MESSAGE,
      pubkey: agentPubkey,
    });
    expect(reply.tags).toContainEqual(["h", channelId]);
    expect(reply.tags).toContainEqual(["p", ownerPubkey]);
    expect(reply.tags).toContainEqual(["e", accepted.id, "", "root"]);
  });
});

function messageEvent(
  secretKey: Uint8Array,
  agentPubkey: string,
  channelId: string,
  content: string,
) {
  return signNostrEvent(
    {
      content,
      created_at: unixNow(),
      kind: KIND_STREAM_MESSAGE,
      tags: [
        ["h", channelId],
        ["p", agentPubkey],
      ],
    },
    secretKey,
  );
}

function nodeSocket(url: string): RelaySocket {
  return new WebSocket(url, {
    perMessageDeflate: false,
  }) as unknown as RelaySocket;
}

function waitForHarnessEvent(
  harness: AcpHarness,
  predicate: (event: AcpHarnessEvent) => boolean,
): Promise<AcpHarnessEvent> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("timed out waiting for ACP harness event")),
      5_000,
    );
    const unsubscribe = harness.on((event) => {
      if (!predicate(event)) return;
      clearTimeout(timeout);
      unsubscribe();
      resolve(event);
    });
  });
}

function waitForRelayEvent(
  client: AuthenticatedRelayClient,
  subscriptionId: string,
): Promise<NostrEvent> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      unsubscribe();
      reject(new Error("timed out waiting for relay event"));
    }, 5_000);
    const unsubscribe = client.on((event) => {
      if (event.type !== "event" || event.subscriptionId !== subscriptionId) {
        return;
      }
      clearTimeout(timeout);
      unsubscribe();
      resolve(event.event);
    });
  });
}
