import { createServer, type RequestListener } from "node:http";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { Event } from "nostr-tools";
import { afterEach, describe, expect, it } from "vitest";

import { IdentityService } from "./identity.js";
import { LocalEntityService } from "./local-entities.js";
import { ManagedAgentService } from "./managed-agents.js";
import { DesktopMediaService } from "./media.js";
import { AgentMemoryService } from "./memory.js";
import { RelayHttpClient } from "./relay-http.js";
import { SnapshotService } from "./snapshot-service.js";
import { decodeAgentSnapshot } from "./snapshots.js";

const closeCallbacks: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(closeCallbacks.splice(0).map((close) => close()));
});

describe("snapshot and memory services", () => {
  it("exports canonical snapshots and imports them with fresh agent keys", async () => {
    const relay = await eventRelay();
    const services = await createServices(relay.url);
    const persona = await services.localEntities.createPersona({
      input: {
        avatarUrl: null,
        behavior: {
          parallelism: 2,
          respondTo: "owner-only",
          respondToAllowlist: [],
        },
        displayName: "Analyst",
        envVars: {},
        model: "gpt-test",
        namePool: [],
        provider: "test",
        runtime: "buzz-agent",
        systemPrompt: "Analyze carefully.",
      },
    });
    const encoded = await services.snapshots.encodeAgent({
      format: "png",
      id: persona.id,
      memoryLevel: "none",
    });
    const decoded = await decodeAgentSnapshot(
      Uint8Array.from(encoded.fileBytes),
    );
    expect(decoded.definition).toMatchObject({
      model: "gpt-test",
      name: "Analyst",
      provider: "test",
      systemPrompt: "Analyze carefully.",
    });

    await expect(
      services.snapshots.previewAgent({
        fileBytes: encoded.fileBytes,
        fileName: encoded.fileName,
      }),
    ).resolves.toMatchObject({
      displayName: "Analyst",
      memoryEntryCount: 0,
      memoryLevel: "none",
    });

    const imported = await services.snapshots.confirmAgent({
      input: { fileBytes: encoded.fileBytes, keepAllowlist: false },
    });
    expect(imported.newPubkey).toMatch(/^[0-9a-f]{64}$/);
    expect(imported.personaId).not.toBe(persona.id);
    expect(imported.memoryWritten).toBe(0);
    expect(services.managedAgents.list()).toHaveLength(1);
    expect(relay.events.some((event) => event.kind === 0)).toBe(true);
  });

  it("publishes, decrypts, and lists NIP-AE engrams", async () => {
    const relay = await eventRelay();
    const services = await createServices(relay.url);
    const created = await services.managedAgents.create({
      input: {
        backend: { type: "local" },
        name: "Memory agent",
        respondTo: "owner-only",
        respondToAllowlist: [],
      },
    });
    const agent = created.agent as { pubkey: string };
    const restored = await services.memory.restore(agent.pubkey, [
      { body: "Profile [[mem/preferences]]", slug: "core" },
      { body: "Likes concise answers", slug: "mem/preferences" },
    ]);
    expect(restored).toEqual({ errors: [], written: 2 });
    const listing = await services.memory.list(agent.pubkey);
    expect(listing.core).toMatchObject({
      body: "Profile [[mem/preferences]]",
      outgoingRefs: ["mem/preferences"],
      slug: "core",
    });
    expect(listing.memories).toHaveLength(1);
    expect(listing.memories[0]).toMatchObject({
      body: "Likes concise answers",
      slug: "mem/preferences",
    });
  });
});

async function createServices(relayHttpUrl: string) {
  const identity = IdentityService.create(undefined, async () => undefined);
  const localEntities = new LocalEntityService(identity);
  const managedAgents = new ManagedAgentService({
    dataDirectory: await mkdtemp(path.join(os.tmpdir(), "buzz-snapshot-test-")),
    defaultRelayUrl: relayHttpUrl.replace(/^http/, "ws"),
    identity,
    localEntities,
  });
  const relay = new RelayHttpClient({
    baseUrl: relayHttpUrl,
    sign: (input) => identity.sign(input),
  });
  const media = new DesktopMediaService({ identity, relayHttpUrl });
  const memory = new AgentMemoryService({ identity, managedAgents, relay });
  const snapshots = new SnapshotService({
    localEntities,
    managedAgents,
    media,
    memory,
  });
  return {
    identity,
    localEntities,
    managedAgents,
    media,
    memory,
    relay,
    snapshots,
  };
}

async function eventRelay(): Promise<{
  readonly events: Event[];
  readonly url: string;
}> {
  const events: Event[] = [];
  const listener: RequestListener = async (request, response) => {
    const body = await readRequest(request);
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
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(
        JSON.stringify(events.filter((event) => event.kind === 30_174)),
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
  closeCallbacks.push(
    () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  );
  return { events, url: `http://127.0.0.1:${address.port}` };
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
