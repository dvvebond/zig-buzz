import { mkdtemp, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { CommandRegistry } from "./commands.js";
import { AgentModelService } from "./agent-models.js";
import { ArchiveService } from "./archive.js";
import { BuilderlabService } from "./builderlab.js";
import { ChannelService } from "./channels.js";
import { DesktopEventBus } from "./event-bus.js";
import { EntityReconcileService } from "./entity-reconcile.js";
import { IdentityService } from "./identity.js";
import { HuddleService } from "./huddle.js";
import { IdentityArchiveService } from "./identity-archive.js";
import { LocalEntityService } from "./local-entities.js";
import { ManagedAgentService } from "./managed-agents.js";
import { ManagedAgentMessageService } from "./managed-agent-messages.js";
import { DesktopMediaService } from "./media.js";
import { AgentMemoryService } from "./memory.js";
import { MeshComputeService } from "./mesh-compute.js";
import { PairingService } from "./pairing.js";
import { ProfileService } from "./profile.js";
import { ProjectGitService } from "./project-git.js";
import { RelayHttpClient } from "./relay-http.js";
import { RuntimeCatalogService } from "./runtime-catalog.js";
import { DesktopResetService } from "./reset.js";
import { startDesktopServer } from "./server.js";
import { SocialService } from "./social.js";
import { SnapshotService } from "./snapshot-service.js";
import { WorkspaceService } from "./workspace.js";
import { WorkflowService } from "./workflows.js";

describe("desktop IPC server", () => {
  it("requires the per-launch secret and same origin for every invocation", async () => {
    const dist = await mkdtemp(path.join(os.tmpdir(), "buzz-desktop-dist-"));
    await writeFile(
      path.join(dist, "index.html"),
      "<!doctype html><p>Buzz</p>",
    );
    const identity = IdentityService.create(undefined, async () => undefined);
    const commands = createCommands(identity);
    const server = await startDesktopServer({
      bootToken: "test-secret",
      commands,
      distDirectory: dist,
    });
    try {
      const denied = await fetch(`${server.origin}/api/invoke`, {
        body: JSON.stringify({ args: {}, command: "get_identity" }),
        headers: {
          "Content-Type": "application/json",
          Origin: server.origin,
        },
        method: "POST",
      });
      expect(denied.status).toBe(401);

      const crossOrigin = await fetch(`${server.origin}/api/invoke`, {
        body: JSON.stringify({ args: {}, command: "get_identity" }),
        headers: {
          "Content-Type": "application/json",
          Origin: "https://attacker.example",
          "X-Buzz-Desktop-Token": "test-secret",
        },
        method: "POST",
      });
      expect(crossOrigin.status).toBe(403);

      const accepted = await fetch(`${server.origin}/api/invoke`, {
        body: JSON.stringify({ args: {}, command: "get_identity" }),
        headers: {
          "Content-Type": "application/json",
          Origin: server.origin,
          "X-Buzz-Desktop-Token": "test-secret",
        },
        method: "POST",
      });
      expect(accepted.status).toBe(200);
      const payload = (await accepted.json()) as {
        result: { pubkey: string };
      };
      expect(payload.result.pubkey).toMatch(/^[0-9a-f]{64}$/);
    } finally {
      await server.close();
    }
  });

  it("does not expose unregistered native commands", async () => {
    const identity = IdentityService.create(undefined, async () => undefined);
    const commands = createCommands(identity);
    await expect(commands.invoke("shell", {})).rejects.toThrow(
      /not been ported/,
    );
  });

  it("returns verified media payloads over the authenticated binary endpoint", async () => {
    const snapshot = Buffer.from(
      JSON.stringify({
        definition: { name: "Analyst" },
        format: "buzz-agent-snapshot",
        memory: { entries: [], level: "none" },
        profile: { displayName: "Analyst" },
        version: 1,
      }),
    );
    const sha256 = createHash("sha256").update(snapshot).digest("hex");
    const relayServer = createServer((request, response) => {
      if (request.url !== `/media/${sha256}.agent.json`) {
        response.writeHead(404).end();
        return;
      }
      response.writeHead(200, {
        "Content-Length": snapshot.byteLength,
        "Content-Type": "application/octet-stream",
      });
      response.end(snapshot);
    });
    await new Promise<void>((resolve, reject) => {
      relayServer.once("error", reject);
      relayServer.listen(0, "127.0.0.1", () => {
        relayServer.off("error", reject);
        resolve();
      });
    });
    const address = relayServer.address();
    if (!address || typeof address === "string")
      throw new Error("no relay address");
    const relayHttpUrl = `http://127.0.0.1:${address.port}`;
    const dist = await mkdtemp(path.join(os.tmpdir(), "buzz-desktop-dist-"));
    await writeFile(
      path.join(dist, "index.html"),
      "<!doctype html><p>Buzz</p>",
    );
    const identity = IdentityService.create(undefined, async () => undefined);
    const server = await startDesktopServer({
      bootToken: "test-secret",
      commands: createCommands(identity, relayHttpUrl),
      distDirectory: dist,
    });
    try {
      const response = await fetch(`${server.origin}/api/binary/invoke`, {
        body: JSON.stringify({
          args: {
            expectedSha256: sha256,
            expectedSize: snapshot.byteLength,
            filename: "analyst.agent.json",
            url: `${relayHttpUrl}/media/${sha256}.agent.json`,
          },
          command: "fetch_snapshot_bytes",
        }),
        headers: {
          "Content-Type": "application/json",
          Origin: server.origin,
          "X-Buzz-Desktop-Token": "test-secret",
        },
        method: "POST",
      });
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe(
        "application/octet-stream",
      );
      expect(Buffer.from(await response.arrayBuffer())).toEqual(snapshot);

      const metadata = Buffer.from(
        JSON.stringify({
          command: "preview_agent_snapshot_import",
          fileName: "analyst.agent.json",
        }),
        "utf8",
      ).toString("base64url");
      const previewResponse = await fetch(
        `${server.origin}/api/binary/snapshot`,
        {
          body: snapshot,
          headers: {
            "Content-Type": "application/octet-stream",
            Origin: server.origin,
            "X-Buzz-Desktop-Token": "test-secret",
            "X-Buzz-Snapshot-Metadata": metadata,
          },
          method: "POST",
        },
      );
      expect(previewResponse.status).toBe(200);
      await expect(previewResponse.json()).resolves.toMatchObject({
        ok: true,
        result: {
          displayName: "Analyst",
          memoryEntryCount: 0,
        },
      });
    } finally {
      await server.close();
      await new Promise<void>((resolve, reject) => {
        relayServer.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });
});

function createCommands(
  identity: IdentityService,
  relayHttpUrl = "http://127.0.0.1:3000",
): CommandRegistry {
  const relay = new RelayHttpClient({
    baseUrl: relayHttpUrl,
    sign: (input) => identity.sign(input),
  });
  const builderlab = new BuilderlabService({
    identity,
    openExternal: () => undefined,
  });
  const localEntities = new LocalEntityService(identity);
  const runtimeCatalog = new RuntimeCatalogService(identity);
  const managedAgents = new ManagedAgentService({
    dataDirectory: path.join(os.tmpdir(), "buzz-desktop-test-agents"),
    defaultRelayUrl: "ws://127.0.0.1:3000",
    identity,
    localEntities,
    runtimeCatalog,
  });
  const media = new DesktopMediaService({
    identity,
    relayHttpUrl,
  });
  const memory = new AgentMemoryService({ identity, managedAgents, relay });
  const archive = ArchiveService.memory({
    identity,
    relay,
    relayUrl: relayHttpUrl.replace(/^http/, "ws"),
  });
  const snapshots = new SnapshotService({
    localEntities,
    managedAgents,
    media,
    memory,
  });
  const profiles = new ProfileService(identity, relay);
  const channels = new ChannelService({
    identity,
    profiles,
    relay,
    relayScope: relayHttpUrl,
  });
  const workspace = new WorkspaceService({
    archive,
    channels,
    dataDirectory: path.join(os.tmpdir(), "buzz-desktop-test-workspace"),
    defaultRelayHttpUrl: relayHttpUrl,
    defaultRelayUrl: relayHttpUrl.replace(/^http/, "ws"),
    identity,
    managedAgents,
    media,
    relay,
  });
  const identityArchive = new IdentityArchiveService({
    identity,
    relay,
    relaySelf: async () => null,
  });
  const projectGit = new ProjectGitService({
    identity,
    managedAgents,
    relay,
    workspace,
  });
  const events = new DesktopEventBus();
  const pairing = new PairingService({
    events,
    identity,
    workspace,
  });
  const entityReconcile = new EntityReconcileService({
    events,
    identity,
    localEntities,
    managedAgents,
  });
  const huddle = new HuddleService({
    channels,
    events,
    identity,
    relay,
    workspace,
  });
  const meshCompute = new MeshComputeService({
    dataDirectory: path.join(os.tmpdir(), "buzz-desktop-test-mesh"),
    events,
    identity,
    workspace,
  });
  const agentModels = new AgentModelService({
    localEntities,
    managedAgents,
    mesh: meshCompute,
    runtimeCatalog,
  });
  return new CommandRegistry({
    agentModels,
    archive,
    builderlab,
    channels,
    events,
    huddle,
    entityReconcile,
    identity,
    identityArchive,
    localEntities,
    managedAgents,
    managedAgentMessages: new ManagedAgentMessageService(managedAgents, relay),
    media,
    memory,
    meshCompute,
    pairing,
    profiles,
    projectGit,
    reset: new DesktopResetService(
      path.join(os.tmpdir(), "buzz-desktop-test-reset"),
    ),
    runtimeCatalog,
    social: new SocialService(identity, relay),
    snapshots,
    workspace,
    workflows: new WorkflowService(identity, relay),
  });
}
