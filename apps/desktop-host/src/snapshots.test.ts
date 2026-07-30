import { describe, expect, it } from "vitest";

import {
  decodeAgentSnapshot,
  decodeTeamSnapshot,
  encodeAgentSnapshot,
  encodeTeamSnapshot,
  type AgentSnapshot,
  type TeamSnapshot,
} from "./snapshots.js";

const agent: AgentSnapshot = {
  definition: {
    name: "Analyst",
    respondTo: "owner-only",
    systemPrompt: "Analyze carefully.",
  },
  format: "buzz-agent-snapshot",
  memory: {
    entries: [{ body: "Identity [[mem/preferences]]", slug: "core" }],
    level: "core",
  },
  profile: { displayName: "Analyst" },
  version: 1,
};

describe("TypeScript snapshot codec", () => {
  it("round-trips canonical agent JSON and PNG snapshots", async () => {
    const json = await encodeAgentSnapshot(agent, "json");
    await expect(decodeAgentSnapshot(json)).resolves.toEqual(agent);

    const png = await encodeAgentSnapshot(agent, "png");
    expect(Buffer.from(png.subarray(0, 8)).toString("hex")).toBe(
      "89504e470d0a1a0a",
    );
    await expect(decodeAgentSnapshot(png)).resolves.toEqual(agent);
  });

  it("round-trips canonical team snapshots without cross-decoding", async () => {
    const team: TeamSnapshot = {
      format: "buzz-team-snapshot",
      members: [agent],
      team: { description: "Research team", name: "Research" },
      version: 1,
    };
    const png = await encodeTeamSnapshot(team, "png");
    await expect(decodeTeamSnapshot(png)).resolves.toEqual(team);
    await expect(decodeAgentSnapshot(png)).rejects.toThrow(
      /buzz_agent_snapshot/,
    );
  });

  it("rejects internally inconsistent memory snapshots", async () => {
    const invalid = {
      ...agent,
      memory: {
        entries: [{ body: "should not exist", slug: "core" }],
        level: "none",
      },
    } as unknown as AgentSnapshot;
    await expect(encodeAgentSnapshot(invalid, "json")).rejects.toThrow(
      /memory level none/,
    );
  });
});
