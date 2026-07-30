import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { DesktopEventBus } from "./event-bus.js";
import { EntityReconcileService } from "./entity-reconcile.js";
import { IdentityService } from "./identity.js";
import { LocalEntityService } from "./local-entities.js";
import { ManagedAgentService } from "./managed-agents.js";

describe("EntityReconcileService", () => {
  it("applies only newer verified owner projections and preserves local secrets", async () => {
    const identity = IdentityService.create(undefined, async () => undefined);
    const local = new LocalEntityService(identity);
    const persona = await local.createPersona({
      input: {
        avatarUrl: null,
        displayName: "Local",
        envVars: { OPENAI_API_KEY: "keep-me" },
        model: "local-model",
        namePool: [],
        provider: "local-provider",
        runtime: "buzz-agent",
        systemPrompt: "local prompt",
      },
    });
    const managed = new ManagedAgentService({
      dataDirectory: await mkdtemp(path.join(os.tmpdir(), "buzz-reconcile-")),
      defaultRelayUrl: "ws://127.0.0.1:3000",
      identity,
      localEntities: local,
    });
    const created = await managed.create({
      input: {
        envVars: { API_TOKEN: "agent-secret" },
        name: "Local agent",
        personaId: persona.id,
      },
    });
    const agentPubkey = String(
      (created.agent as Record<string, unknown>).pubkey,
    );
    const originalCredential = managed.signingCredential(agentPubkey);
    const events = new DesktopEventBus();
    const reconcile = new EntityReconcileService({
      events,
      identity,
      localEntities: local,
      managedAgents: managed,
    });
    const base = Math.floor(Date.now() / 1_000) + 10;

    const personaEvent = identity.sign({
      content: JSON.stringify({
        avatar_url: "https://example.test/avatar.png",
        display_name: "Remote edit",
        model: "remote-model",
        name_pool: ["Ada"],
        parallelism: 2,
        provider: "remote-provider",
        respond_to: "owner-only",
        respond_to_allowlist: [],
        runtime: "buzz-agent",
        system_prompt: "remote prompt",
      }),
      createdAt: base,
      kind: 30_175,
      tags: [["d", persona.id]],
    });
    await reconcile.reconcile(JSON.stringify(personaEvent));
    expect(local.personas()[0]).toMatchObject({
      display_name: "Remote edit",
      env_vars: { OPENAI_API_KEY: "keep-me" },
      system_prompt: "remote prompt",
    });

    const agentEvent = identity.sign({
      content: JSON.stringify({
        backend: { config: { stolen: true }, type: "provider" },
        env_vars: { API_TOKEN: "replace" },
        name: "Remote agent edit",
        parallelism: 3,
        persona_id: null,
        privateKeyHex: "00".repeat(32),
        respond_to: "owner-only",
        respond_to_allowlist: [],
        system_prompt: "new prompt",
      }),
      createdAt: base + 1,
      kind: 30_177,
      tags: [["d", agentPubkey]],
    });
    await reconcile.reconcile(JSON.stringify(agentEvent));
    expect(managed.list()[0]).toMatchObject({
      backend: { type: "local" },
      env_vars: { API_TOKEN: "agent-secret" },
      name: "Remote agent edit",
      system_prompt: "new prompt",
    });
    expect(managed.signingCredential(agentPubkey)).toEqual(originalCredential);

    const stale = identity.sign({
      content: JSON.stringify({
        display_name: "Stale",
        system_prompt: "stale",
      }),
      createdAt: base - 1,
      kind: 30_175,
      tags: [["d", persona.id]],
    });
    await reconcile.reconcile(JSON.stringify(stale));
    expect(local.personas()[0]?.display_name).toBe("Remote edit");
    expect(
      events
        .poll(0)
        .events.filter((event) => event.event === "agents-data-changed"),
    ).toHaveLength(2);
  });

  it("rejects forged and foreign events and honors scoped tombstones", async () => {
    const identity = IdentityService.create(undefined, async () => undefined);
    const local = new LocalEntityService(identity);
    const persona = await local.createPersona({
      input: {
        displayName: "Delete me",
        namePool: [],
        systemPrompt: "",
      },
    });
    const managed = new ManagedAgentService({
      dataDirectory: await mkdtemp(path.join(os.tmpdir(), "buzz-reconcile-")),
      defaultRelayUrl: "ws://127.0.0.1:3000",
      identity,
      localEntities: local,
    });
    const reconcile = new EntityReconcileService({
      events: new DesktopEventBus(),
      identity,
      localEntities: local,
      managedAgents: managed,
    });

    const valid = identity.sign({
      content: "",
      createdAt: Math.floor(Date.now() / 1_000) + 10,
      kind: 5,
      tags: [["a", `30175:${identity.info().pubkey}:${persona.id}`]],
    });
    const forged = { ...valid, content: "tampered" };
    await expect(reconcile.reconcile(JSON.stringify(forged))).rejects.toThrow(
      /signature/,
    );

    const foreign = IdentityService.create(undefined, async () => undefined);
    const foreignEvent = foreign.sign({
      content: "{}",
      kind: 30_175,
      tags: [["d", persona.id]],
    });
    await expect(
      reconcile.reconcile(JSON.stringify(foreignEvent)),
    ).rejects.toThrow(/not owned/);
    await reconcile.reconcile(JSON.stringify(valid));
    expect(local.personas()).toEqual([]);
  });
});
