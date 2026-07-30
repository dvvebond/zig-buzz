import { createServer, type RequestListener } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { type Event, verifyEvent } from "nostr-tools";
import { afterEach, describe, expect, it } from "vitest";

import { IdentityService } from "./identity.js";
import { LocalEntityService } from "./local-entities.js";
import { ManagedAgentMessageService } from "./managed-agent-messages.js";
import { ManagedAgentService } from "./managed-agents.js";
import { RelayHttpClient, type RelayFilter } from "./relay-http.js";

const cleanup: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((operation) => operation()));
});

describe("managed agent channel messages", () => {
  it("publishes as the agent with owner authorization and deduplicates markers", async () => {
    const relay = await eventRelay();
    const identity = IdentityService.create(undefined, async () => undefined);
    const dataDirectory = await mkdtemp(
      path.join(os.tmpdir(), "buzz-managed-message-test-"),
    );
    cleanup.push(() => rm(dataDirectory, { force: true, recursive: true }));
    const managedAgents = new ManagedAgentService({
      dataDirectory,
      defaultRelayUrl: relay.url.replace(/^http/, "ws"),
      identity,
      localEntities: new LocalEntityService(identity),
    });
    const created = await managedAgents.create({
      input: {
        name: "Message agent",
        respondTo: "owner-only",
      },
    });
    const agentPubkey = (created.agent as { pubkey: string }).pubkey;
    const sharedRelay = new RelayHttpClient({
      baseUrl: relay.url,
      sign: (input) => identity.sign(input),
    });
    const messages = new ManagedAgentMessageService(managedAgents, sharedRelay);
    const channelId = "123e4567-e89b-42d3-a456-426614174000";

    const first = await messages.send({
      agentPubkey,
      channelId,
      content: "Deployment complete.",
      marker: "deployment:42",
      mentionPubkeys: [identity.info().pubkey],
    });
    const repeated = await messages.send({
      agentPubkey,
      channelId,
      content: "This must not be published.",
      marker: "deployment:42",
    });

    expect(repeated.event_id).toBe(first.event_id);
    const publishedMessages = relay.events.filter((event) => event.kind === 9);
    expect(publishedMessages).toHaveLength(1);
    expect(publishedMessages[0]?.pubkey).toBe(agentPubkey);
    expect(publishedMessages[0]?.tags).toEqual(
      expect.arrayContaining([
        ["h", channelId],
        ["p", identity.info().pubkey],
        ["client", "deployment:42"],
      ]),
    );
    expect(verifyEvent(publishedMessages[0] as Event)).toBe(true);
    expect(
      relay.authEvents.some(
        (event) =>
          event.pubkey === agentPubkey &&
          event.tags.some(
            (tag) =>
              tag[0] === "auth" &&
              tag[1] === identity.info().pubkey &&
              tag.length === 4,
          ),
      ),
    ).toBe(true);
    await expect(
      messages.hasMarker({
        agentPubkey,
        channelId,
        marker: "deployment:42",
      }),
    ).resolves.toBe(true);
    await expect(
      messages.hasMarker({
        channelId,
        marker: "deployment:42",
        markerScope: "channel",
      }),
    ).resolves.toBe(true);
  });
});

async function eventRelay(): Promise<{
  authEvents: Event[];
  events: Event[];
  url: string;
}> {
  const events: Event[] = [];
  const authEvents: Event[] = [];
  const listener: RequestListener = async (request, response) => {
    const body = await readRequest(request);
    const encoded = request.headers.authorization?.replace(/^Nostr\s+/, "");
    if (encoded) {
      authEvents.push(
        JSON.parse(Buffer.from(encoded, "base64").toString("utf8")) as Event,
      );
    }
    if (request.url === "/events" && request.method === "POST") {
      const event = JSON.parse(body) as Event;
      events.push(event);
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(
        JSON.stringify({
          accepted: true,
          event_id: event.id,
          message: "stored",
        }),
      );
      return;
    }
    if (request.url === "/query" && request.method === "POST") {
      const filters = JSON.parse(body) as RelayFilter[];
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(
        JSON.stringify(
          events.filter((event) =>
            filters.some((filter) => matches(event, filter)),
          ),
        ),
      );
      return;
    }
    response.writeHead(404).end();
  };
  const server = createServer(listener);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no address");
  cleanup.push(
    () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  );
  return {
    authEvents,
    events,
    url: `http://127.0.0.1:${address.port}`,
  };
}

function matches(event: Event, filter: RelayFilter): boolean {
  if (
    Array.isArray(filter.ids) &&
    !filter.ids.some((value) => value === event.id)
  ) {
    return false;
  }
  if (
    Array.isArray(filter.authors) &&
    !filter.authors.some((value) => value === event.pubkey)
  ) {
    return false;
  }
  if (
    Array.isArray(filter.kinds) &&
    !filter.kinds.some((value) => value === event.kind)
  ) {
    return false;
  }
  if (typeof filter.until === "number" && event.created_at > filter.until) {
    return false;
  }
  for (const [key, values] of Object.entries(filter)) {
    if (!key.startsWith("#") || !Array.isArray(values)) continue;
    if (
      !event.tags.some(
        (tag) =>
          tag[0] === key.slice(1) &&
          typeof tag[1] === "string" &&
          values.includes(tag[1]),
      )
    ) {
      return false;
    }
  }
  return true;
}

async function readRequest(
  request: import("node:http").IncomingMessage,
): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}
