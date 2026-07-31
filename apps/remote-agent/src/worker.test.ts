import { randomUUID } from "node:crypto";

import { describe, expect, it, vi } from "vitest";
import type {
  CommandPayload,
  RemoteDeploymentConfig,
} from "@buzz/remote-agent-protocol";

import type { AgentProcessManager } from "./process-manager.js";
import type { EncryptedStateStore, WorkerState } from "./state.js";
import { RemoteWorker } from "./worker.js";

const NOW = 1_785_250_000;

function payload(
  deploymentId: string,
  body: CommandPayload["body"],
): CommandPayload {
  return {
    body,
    deploymentId,
    expiresAt: NOW + 30,
    issuedAt: NOW,
    messageId: randomUUID(),
    sequence: 0,
    sessionId: "a".repeat(32),
    type: "command",
    version: 1,
  };
}

function setup() {
  const state: WorkerState = {
    approved: true,
    community: "buzz.example.com",
    deployments: {},
    ownerPubkey: "a".repeat(64),
    revoked: false,
    version: 1,
    workerName: "worker-1",
    workerSecretKeyHex: "b".repeat(64),
  };
  const save = vi.fn(async () => undefined);
  const start = vi.fn(async () => undefined);
  const stop = vi.fn(async () => undefined);
  const manager = {
    isRunning: vi.fn(() => false),
    readLogTail: vi.fn(async () => "safe log"),
    start,
    stop,
  } as unknown as AgentProcessManager;
  const worker = new RemoteWorker({
    processes: manager,
    state,
    store: { save } as unknown as EncryptedStateStore,
  });
  return { save, start, stop, worker };
}

describe("remote worker lifecycle", () => {
  it("generates the agent key on the remote worker and deploys once", async () => {
    const { save, start, worker } = setup();
    const id = randomUUID();
    const config: RemoteDeploymentConfig = {
      displayName: "Remote helper",
      runtimeId: "buzz-agent",
    };

    const result = await worker.handle(
      payload(id, { action: "deploy", config }),
    );

    expect(result.outcome).toBe("completed");
    expect(start).toHaveBeenCalledOnce();
    expect(worker.state().deployments[id]?.agentSecretKeyHex).toMatch(
      /^[0-9a-f]{64}$/,
    );
    expect(worker.state().deployments[id]?.agentSecretKeyHex).not.toBe(
      "b".repeat(64),
    );
    expect(save).toHaveBeenCalled();
  });

  it("requires explicit destructive confirmation before key erasure", async () => {
    const { worker } = setup();
    const id = randomUUID();
    await worker.handle(
      payload(id, {
        action: "deploy",
        config: { displayName: "Remote helper", runtimeId: "buzz-agent" },
      }),
    );

    const malformed = payload(id, {
      action: "revoke",
      eraseAgentKey: true,
    });
    const result = await worker.handle(malformed);

    expect(result).toMatchObject({
      code: "CONFIG_INVALID",
      outcome: "rejected",
    });
    expect(worker.state().deployments[id]?.agentSecretKeyHex).not.toBe(
      "0".repeat(64),
    );
  });

  it("rejects capabilities disabled by the local operator", async () => {
    const { worker: _worker } = setup();
    const state: WorkerState = {
      approved: true,
      deployments: {},
      revoked: false,
      version: 1,
      workerName: "worker-1",
      workerSecretKeyHex: "b".repeat(64),
    };
    const worker = new RemoteWorker({
      capabilities: ["status"],
      processes: {} as AgentProcessManager,
      state,
      store: {} as EncryptedStateStore,
    });
    const result = await worker.handle(
      payload(randomUUID(), {
        action: "deploy",
        config: { displayName: "No", runtimeId: "buzz-agent" },
      }),
    );

    expect(result).toMatchObject({
      code: "CAPABILITY_DENIED",
      outcome: "rejected",
    });
  });
});
