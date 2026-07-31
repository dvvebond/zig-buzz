import { describe, expect, it } from "vitest";

import { IdentityService } from "./identity.js";
import { LocalEntityService } from "./local-entities.js";

describe("LocalEntityService", () => {
  it("persists validated persona, team, and channel-template relationships", async () => {
    let state:
      | { identitySecretHex: string; settings: Record<string, unknown> }
      | undefined;
    const identity = IdentityService.create(undefined, async (next) => {
      state = structuredClone(next);
    });
    const entities = new LocalEntityService(identity);
    const persona = await entities.createPersona({
      input: {
        behavior: { parallelism: 2, respondTo: "mentions" },
        displayName: "Review Agent",
        envVars: { API_ENDPOINT: "https://example.test" },
        systemPrompt: "Review code carefully.",
      },
    });
    const team = await entities.createTeam({
      input: {
        name: "Review Team",
        personaIds: [persona.id],
      },
    });
    const template = await entities.createTemplate({
      input: {
        agents: {
          personas: [{ personaId: persona.id }],
          teams: [{ teamId: team.id }],
        },
        name: "Review Room",
      },
    });

    expect(entities.personas()).toHaveLength(1);
    expect(entities.teams()[0]?.persona_ids).toEqual([persona.id]);
    expect(entities.templates()[0]?.id).toBe(template.id);
    expect(state?.settings).toHaveProperty("personas.v1");

    const restoredIdentity = IdentityService.create(
      state,
      async () => undefined,
    );
    const restored = new LocalEntityService(restoredIdentity);
    expect(restored.personas()[0]?.display_name).toBe("Review Agent");
    expect(restored.teams()[0]?.name).toBe("Review Team");
  });

  it("rejects reserved secret-bearing process variables and dangling references", async () => {
    const identity = IdentityService.create(undefined, async () => undefined);
    const entities = new LocalEntityService(identity);
    await expect(
      entities.createPersona({
        input: {
          displayName: "Unsafe",
          envVars: { BUZZ_PRIVATE_KEY: "secret" },
          systemPrompt: "No",
        },
      }),
    ).rejects.toThrow(/reserved/);
    await expect(
      entities.createTeam({
        input: {
          name: "Dangling",
          personaIds: ["00000000-0000-4000-8000-000000000000"],
        },
      }),
    ).rejects.toThrow(/not found/);
  });
});
