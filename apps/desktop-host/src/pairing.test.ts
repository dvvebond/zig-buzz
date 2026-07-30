import { createServer } from "node:http";

import { PairingSession, decodePairingQr } from "@buzz/pairing";
import { verifyNostrEvent, type NostrEvent } from "@buzz/core";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket, { WebSocketServer } from "ws";

import { DesktopEventBus } from "./event-bus.js";
import { IdentityService } from "./identity.js";
import { PairingService } from "./pairing.js";

const cleanup: Array<() => void | Promise<void>> = [];

afterEach(async () => {
  await Promise.allSettled(cleanup.splice(0).map((close) => close()));
});

describe("PairingService", () => {
  it("authenticates ephemerally and completes a SAS-bound credential transfer", async () => {
    const server = createServer((_request, response) => {
      response.writeHead(200, { "Content-Type": "application/nostr+json" });
      response.end("{}");
    });
    const websocketServer = new WebSocketServer({
      maxPayload: 1024 * 1024,
      server,
    });
    cleanup.push(
      () =>
        new Promise<void>((resolve) => {
          websocketServer.close(() => resolve());
          for (const client of websocketServer.clients) client.terminate();
        }),
      () =>
        new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        }),
    );
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.off("error", reject);
        resolve();
      });
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("no address");
    const httpUrl = `http://127.0.0.1:${address.port}/`;
    const wsUrl = `ws://127.0.0.1:${address.port}/`;
    const received: unknown[][] = [];
    let peer: WebSocket | undefined;
    websocketServer.on("connection", (socket) => {
      peer = socket;
      socket.send(JSON.stringify(["AUTH", "ephemeral-challenge"]));
      socket.on("message", (data) => {
        const frame = JSON.parse(data.toString("utf8")) as unknown[];
        received.push(frame);
        if (frame[0] === "AUTH" && isEvent(frame[1])) {
          socket.send(
            JSON.stringify(["OK", frame[1].id, true, "authenticated"]),
          );
        }
      });
    });

    const identity = IdentityService.create(undefined, async () => undefined);
    const events = new DesktopEventBus();
    const pairing = new PairingService({
      events,
      identity,
      workspace: {
        relayHttpUrl: () => httpUrl,
        relayUrl: () => wsUrl,
      },
    });
    cleanup.push(() => pairing.shutdown());

    const qrUri = await pairing.start();
    const qr = decodePairingQr(qrUri);
    const authFrame = await waitForFrame(
      received,
      (frame) => frame[0] === "AUTH" && isEvent(frame[1]),
    );
    const authEvent = authFrame[1] as NostrEvent;
    expect(authEvent.pubkey).toBe(qr.sourcePubkey);
    expect(authEvent.pubkey).not.toBe(identity.info().pubkey);
    expect(authEvent.kind).toBe(22_242);
    expect(verifyNostrEvent(authEvent)).toBe(true);

    const target = PairingSession.target(qr);
    peer?.send(JSON.stringify(["EVENT", "pair", target.offer]));
    await waitFor(() => events.poll(0).events.length > 0);
    const sasBatch = events.poll(0);
    expect(sasBatch.events[0]).toMatchObject({
      event: "pairing-sas-received",
      payload: { sas: target.session.sasCode },
    });

    await pairing.confirmSas();
    const published = await waitForPublishedEvents(received, 2);
    const confirmation = published[0]?.[1];
    const payloadEvent = published[1]?.[1];
    if (!isEvent(confirmation) || !isEvent(payloadEvent)) {
      throw new Error("pairing relay did not receive valid events");
    }
    expect(target.session.handleSasConfirm(confirmation)).toBe(
      target.session.sasCode,
    );
    target.session.confirmTargetSas();
    const transferred = target.session.handlePayload(payloadEvent);
    expect(transferred.type).toBe("custom");
    expect(JSON.parse(transferred.payload)).toEqual({
      nsec: identity.nsec(),
      pubkey: identity.info().pubkey,
      relayUrl: httpUrl,
    });

    peer?.send(
      JSON.stringify(["EVENT", "pair", target.session.sendComplete()]),
    );
    await waitFor(() =>
      events
        .poll(sasBatch.cursor)
        .events.some((event) => event.event === "pairing-complete"),
    );
    expect(
      events
        .poll(sasBatch.cursor)
        .events.some((event) => event.event === "pairing-complete"),
    ).toBe(true);
    target.session.dispose();
    qr.sessionSecret.fill(0);
  });
});

async function waitForPublishedEvents(
  frames: unknown[][],
  count: number,
): Promise<unknown[][]> {
  await waitFor(
    () => frames.filter((frame) => frame[0] === "EVENT").length >= count,
  );
  return frames.filter((frame) => frame[0] === "EVENT").slice(0, count);
}

async function waitForFrame(
  frames: unknown[][],
  predicate: (frame: unknown[]) => boolean,
): Promise<unknown[]> {
  await waitFor(() => frames.some(predicate));
  const frame = frames.find(predicate);
  if (!frame) throw new Error("frame disappeared");
  return frame;
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("test timed out");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function isEvent(value: unknown): value is NostrEvent {
  return (
    typeof value === "object" &&
    value !== null &&
    "id" in value &&
    typeof value.id === "string" &&
    "pubkey" in value &&
    typeof value.pubkey === "string" &&
    "kind" in value &&
    typeof value.kind === "number" &&
    "created_at" in value &&
    typeof value.created_at === "number" &&
    "tags" in value &&
    Array.isArray(value.tags) &&
    "content" in value &&
    typeof value.content === "string" &&
    "sig" in value &&
    typeof value.sig === "string"
  );
}
