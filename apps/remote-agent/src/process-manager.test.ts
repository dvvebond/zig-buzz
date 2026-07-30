import { randomUUID } from "node:crypto";
import { readdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { AgentProcessManager } from "./process-manager.js";
import type { DeploymentState } from "./state.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { force: true, recursive: true })),
  );
});

async function openDescriptorCount(): Promise<number> {
  return (await readdir("/dev/fd")).length;
}

function deployment(overrides: Partial<DeploymentState> = {}): DeploymentState {
  return {
    agentSecretKeyHex: "c".repeat(64),
    config: {
      displayName: "Remote helper",
      runtimeId: "buzz-agent",
      secretReferences: { PROVIDER_KEY: "env://BUZZ_TEST_ABSENT_SECRET" },
    },
    id: randomUUID(),
    status: "stopped",
    updatedAt: 1_785_250_000,
    ...overrides,
  };
}

describe("AgentProcessManager", () => {
  it("does not leak a log descriptor when a deployment is rejected", async () => {
    delete process.env.BUZZ_TEST_ABSENT_SECRET;
    const dataDirectory = await mkdtemp(join(tmpdir(), "buzz-remote-agent-"));
    directories.push(dataDirectory);
    const manager = new AgentProcessManager({
      dataDirectory,
      ownerPubkey: "a".repeat(64),
      relayUrl: "wss://buzz.example.com/",
    });

    // Warm the first call so one-time module resolution is not counted.
    await expect(manager.start(deployment())).rejects.toMatchObject({
      code: "SECRET_REFERENCE_MISSING",
    });
    const before = await openDescriptorCount();
    for (let attempt = 0; attempt < 25; attempt += 1) {
      await expect(manager.start(deployment())).rejects.toMatchObject({
        code: "SECRET_REFERENCE_MISSING",
      });
    }

    expect(await openDescriptorCount()).toBeLessThan(before + 5);
  });

  it("rejects a runtime that is not on the worker allowlist", async () => {
    const dataDirectory = await mkdtemp(join(tmpdir(), "buzz-remote-agent-"));
    directories.push(dataDirectory);
    const manager = new AgentProcessManager({
      dataDirectory,
      ownerPubkey: "a".repeat(64),
      relayUrl: "wss://buzz.example.com/",
    });

    await expect(
      manager.start(
        deployment({
          config: { displayName: "Shell", runtimeId: "arbitrary-shell" },
        }),
      ),
    ).rejects.toMatchObject({ code: "CONFIG_INVALID" });
  });
});
