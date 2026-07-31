import { randomUUID } from "node:crypto";

import type { Pool } from "pg";
import { generateSecretKey, getPublicKey } from "nostr-tools/pure";
import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  PostgresWorkflowStore,
  WorkflowRecord,
  WorkflowRunRecord,
} from "@buzz/workflow";

import { createRelayServer } from "./server.js";

type TestRelay = ReturnType<typeof createRelayServer>;
const relays: TestRelay[] = [];

afterEach(async () => {
  await Promise.all(relays.splice(0).map((relay) => relay.close()));
});

describe("workflow webhook HTTP trigger", () => {
  it("authenticates a one-time secret and creates an owner-authorized run", async () => {
    const workflow = webhookWorkflow();
    const runId = randomUUID();
    const store = fakeWorkflowStore(workflow, runId, "hook-secret");
    const { baseUrl } = await startRelay(store);
    const response = await fetch(`${baseUrl}/hooks/${workflow.id}`, {
      body: JSON.stringify({
        count: 3,
        severity: "critical",
      }),
      headers: {
        "Content-Type": "application/json",
        "X-Webhook-Secret": "hook-secret",
      },
      method: "POST",
    });

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toEqual({
      run_id: runId,
      status: "pending",
      workflow_id: workflow.id,
    });
    expect(store.checkOwnerAuthority).toHaveBeenCalledWith(workflow);
    expect(store.createRun).toHaveBeenCalledWith({
      triggerContext: {
        author: workflow.ownerPubkey,
        channelId: workflow.channelId,
        emoji: "",
        messageId: "",
        text: "",
        timestamp: expect.any(Number),
        webhookFields: {
          count: "3",
          severity: "critical",
        },
      },
      workflow,
    });
  });

  it("does not reveal whether a workflow or secret exists", async () => {
    const workflow = webhookWorkflow();
    const store = fakeWorkflowStore(workflow, randomUUID(), "correct");
    const { baseUrl } = await startRelay(store);

    const denied = await fetch(`${baseUrl}/hooks/${workflow.id}?secret=wrong`, {
      method: "POST",
    });
    expect(denied.status).toBe(401);
    await expect(denied.json()).resolves.toEqual({
      error: "authentication failed",
    });
    expect(store.createRun).not.toHaveBeenCalled();

    store.getWebhookTarget.mockResolvedValueOnce(undefined);
    const absent = await fetch(
      `${baseUrl}/hooks/${randomUUID()}?secret=anything`,
      { method: "POST" },
    );
    expect(absent.status).toBe(401);
    await expect(absent.json()).resolves.toEqual({
      error: "authentication failed",
    });
  });
});

function fakeWorkflowStore(
  workflow: WorkflowRecord,
  runId: string,
  secret: string,
) {
  const run: WorkflowRunRecord = {
    communityId: workflow.communityId,
    currentStep: 0,
    id: runId,
    status: "running",
    trace: [],
    triggerContext: {
      author: workflow.ownerPubkey,
      channelId: workflow.channelId ?? "",
      emoji: "",
      messageId: "",
      text: "",
      timestamp: 0,
      webhookFields: {},
    },
    workflowId: workflow.id,
  };
  const getWebhookTarget = vi.fn(
    async (): Promise<
      { readonly secret: string; readonly workflow: WorkflowRecord } | undefined
    > => ({ secret, workflow }),
  );
  return {
    cancelRun: vi.fn(async () => undefined),
    checkOwnerAuthority: vi.fn(async () => true),
    createRun: vi.fn(async () => run),
    finalizeRun: vi.fn(async () => undefined),
    getWebhookTarget,
    listEnabledSchedules: vi.fn(async () => []),
  };
}

function webhookWorkflow(): WorkflowRecord {
  return {
    channelId: randomUUID(),
    communityHost: "localhost",
    communityId: randomUUID(),
    definition: {
      enabled: true,
      name: "Incoming webhook",
      steps: [
        {
          action: "delay",
          duration: "0",
          id: "ack",
        },
      ],
      trigger: { on: "webhook" },
    },
    enabled: true,
    id: randomUUID(),
    name: "Incoming webhook",
    ownerPubkey: getPublicKey(generateSecretKey()),
    status: "active",
  };
}

async function startRelay(
  store: ReturnType<typeof fakeWorkflowStore>,
): Promise<{ baseUrl: string; relay: TestRelay }> {
  const publicUrl = new URL("ws://localhost:1/");
  const relay = createRelayServer({
    community: "localhost",
    host: "127.0.0.1",
    ownerPubkeys: new Set(),
    port: 0,
    publicUrl,
    workflow: {
      pool: {} as Pool,
      relaySecretKey: generateSecretKey(),
      store: store as unknown as PostgresWorkflowStore,
    },
  });
  relays.push(relay);
  await relay.listen();
  const address = relay.address();
  if (!address || typeof address === "string") {
    throw new Error("test relay did not bind a TCP port");
  }
  publicUrl.port = String(address.port);
  return {
    baseUrl: `http://localhost:${address.port}`,
    relay,
  };
}
