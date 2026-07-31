import { createServer } from "node:http";
import { generateSecretKey } from "nostr-tools";
import { verifyNostrEvent, type NostrEvent } from "@buzz/core";
import { WebSocketServer } from "ws";
import { describe, expect, it } from "vitest";
import { BuzzTestClient } from "./index.js";

describe("BuzzTestClient", () => {
  it("authenticates, publishes and collects through the actual socket protocol", async () => {
    const server = createServer();
    const wss = new WebSocketServer({ server });
    let published: NostrEvent | undefined;
    wss.on("connection", (socket) => {
      socket.send(JSON.stringify(["AUTH", "c".repeat(64)]));
      socket.on("message", (raw) => {
        const message = JSON.parse(raw.toString()) as unknown[];
        if (message[0] === "AUTH" && verifyNostrEvent(message[1])) {
          const event = message[1] as NostrEvent;
          socket.send(JSON.stringify(["OK", event.id, true, ""]));
        } else if (message[0] === "EVENT" && verifyNostrEvent(message[1])) {
          published = message[1] as NostrEvent;
          socket.send(JSON.stringify(["OK", published.id, true, "stored"]));
        } else if (message[0] === "REQ" && typeof message[1] === "string") {
          if (published) {
            socket.send(JSON.stringify(["EVENT", message[1], published]));
          }
          socket.send(JSON.stringify(["EOSE", message[1]]));
        }
      });
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", () => resolve()),
    );
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("bind failed");
    const secretKey = generateSecretKey();
    const client = await BuzzTestClient.connect(
      `ws://127.0.0.1:${address.port}`,
      secretKey,
      { allowInsecureLocalhost: true },
    );
    try {
      const response = await client.sendTextMessage({
        secretKey,
        channelId: "channel",
        content: "hello",
      });
      expect(response).toMatchObject({ accepted: true, message: "stored" });
      const events = await client.collectUntilEose([{ kinds: [9] }]);
      expect(events.map((event) => event.content)).toEqual(["hello"]);
    } finally {
      client.disconnect();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
