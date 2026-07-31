import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { nip19 } from "nostr-tools";
import { describe, expect, it } from "vitest";

import { IdentityService } from "./identity.js";
import { LocalEntityService } from "./local-entities.js";
import { ManagedAgentService } from "./managed-agents.js";

describe("ManagedAgentService", () => {
  it("mints an owner-attested agent while keeping its key out of summaries", async () => {
    let state:
      | { identitySecretHex: string; settings: Record<string, unknown> }
      | undefined;
    const identity = IdentityService.create(undefined, async (next) => {
      state = structuredClone(next);
    });
    const localEntities = new LocalEntityService(identity);
    const service = new ManagedAgentService({
      dataDirectory: await mkdtemp(path.join(os.tmpdir(), "buzz-agent-test-")),
      defaultRelayUrl: "ws://127.0.0.1:9",
      identity,
      localEntities,
    });
    const result = await service.create({
      input: {
        envVars: { OPENAI_API_KEY: "test-value" },
        name: "TypeScript Agent",
        respondTo: "owner-only",
      },
    });
    const privateKey = result.private_key_nsec;
    expect(typeof privateKey).toBe("string");
    expect(nip19.decode(privateKey as string).type).toBe("nsec");
    const summary = service.list()[0];
    expect(summary?.status).toBe("stopped");
    expect(JSON.stringify(summary)).not.toContain(privateKey as string);
    expect(JSON.stringify(summary)).not.toContain("privateKeyHex");
    expect(state?.settings).toHaveProperty("managed-agents.v1");
  });

  it("fails closed for unsafe environment keys and unsupported provider execution", async () => {
    const identity = IdentityService.create(undefined, async () => undefined);
    const localEntities = new LocalEntityService(identity);
    const service = new ManagedAgentService({
      dataDirectory: await mkdtemp(path.join(os.tmpdir(), "buzz-agent-test-")),
      defaultRelayUrl: "ws://localhost:3000",
      identity,
      localEntities,
    });
    await expect(
      service.create({
        input: {
          envVars: { BUZZ_PRIVATE_KEY: "attacker-controlled" },
          name: "Unsafe",
        },
      }),
    ).rejects.toThrow(/reserved/);
    await expect(
      service.create({
        input: {
          backend: { config: {}, id: "unknown", type: "provider" },
          name: "Provider",
        },
      }),
    ).rejects.toThrow(/secure remote worker/);
  });
});
