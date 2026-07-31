import { randomUUID } from "node:crypto";

import { generateSecretKey, getPublicKey } from "nostr-tools/pure";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { parseWorkflowYaml } from "./schema.js";
import {
  PostgresWorkflowStore,
  WorkflowStoreAuthorizationError,
} from "./store.js";
import type { TriggerContext, WorkflowRunResult } from "./types.js";

const databaseUrl = process.env.BUZZ_TEST_DATABASE_URL;
const pool = databaseUrl
  ? new Pool({ connectionString: databaseUrl, max: 4 })
  : undefined;
const community = `workflow-${randomUUID()}.example`;
const channelId = randomUUID();
const ownerPubkey = getPublicKey(generateSecretKey());
const memberPubkey = getPublicKey(generateSecretKey());
const trigger: TriggerContext = {
  author: memberPubkey,
  channelId,
  emoji: "",
  messageId: "a".repeat(64),
  text: "trigger",
  timestamp: Math.floor(Date.now() / 1_000),
  webhookFields: {},
};

describe.skipIf(!pool)("Postgres workflow store", () => {
  beforeAll(async () => {
    if (!pool) return;
    const inserted = await pool.query<{ readonly id: string }>(
      "INSERT INTO communities (host) VALUES ($1) RETURNING id",
      [community],
    );
    const communityId = inserted.rows[0]?.id as string;
    await pool.query(
      `INSERT INTO users (community_id, pubkey)
       VALUES ($1, decode($2, 'hex')), ($1, decode($3, 'hex'))`,
      [communityId, ownerPubkey, memberPubkey],
    );
    await pool.query(
      `INSERT INTO channels (
         community_id, id, name, created_by
       )
       VALUES ($1, $2::uuid, 'workflows', decode($3, 'hex'))`,
      [communityId, channelId, ownerPubkey],
    );
    await pool.query(
      `INSERT INTO channel_members (
         community_id, channel_id, pubkey, role
       )
       VALUES
         ($1, $2::uuid, decode($3, 'hex'), 'owner'),
         ($1, $2::uuid, decode($4, 'hex'), 'member')`,
      [communityId, channelId, ownerPubkey, memberPubkey],
    );
  });

  afterAll(async () => {
    await pool?.end();
  });

  it("upserts a tenant-scoped definition without changing its owner or channel", async () => {
    if (!pool) throw new Error("test pool is unavailable");
    const store = new PostgresWorkflowStore(pool);
    const workflowId = randomUUID();
    const definition = parseWorkflowYaml(`
name: Notify
trigger: { on: message_posted }
steps:
  - { id: notify, action: send_message, text: hi }
`).definition;
    const workflow = await store.upsertDefinition({
      channelId,
      community,
      definition,
      ownerPubkey: memberPubkey,
      workflowId,
    });
    expect(workflow.id).toBe(workflowId);
    expect(workflow.ownerPubkey).toBe(memberPubkey);
    expect(
      await store.listEnabledForChannel(community, channelId),
    ).toContainEqual(workflow);
    await expect(
      store.upsertDefinition({
        channelId,
        community,
        definition: { ...definition, name: "hijack" },
        ownerPubkey,
        workflowId,
      }),
    ).rejects.toBeInstanceOf(WorkflowStoreAuthorizationError);
  });

  it("requires elevated current authority for exfiltration-capable definitions", async () => {
    if (!pool) throw new Error("test pool is unavailable");
    const store = new PostgresWorkflowStore(pool);
    const definition = parseWorkflowYaml(`
name: Webhook
trigger: { on: message_posted }
steps:
  - id: send
    action: call_webhook
    url: https://example.com/hook
`).definition;
    await expect(
      store.upsertDefinition({
        channelId,
        community,
        definition,
        ownerPubkey: memberPubkey,
        workflowId: randomUUID(),
      }),
    ).rejects.toBeInstanceOf(WorkflowStoreAuthorizationError);
    await expect(
      store.upsertDefinition({
        channelId,
        community,
        definition,
        ownerPubkey,
        workflowId: randomUUID(),
      }),
    ).resolves.toMatchObject({ ownerPubkey });
  });

  it("issues webhook secrets once, keeps them private, and rotates after removal", async () => {
    if (!pool) throw new Error("test pool is unavailable");
    const store = new PostgresWorkflowStore(pool);
    const workflowId = randomUUID();
    const webhookDefinition = parseWorkflowYaml(`
name: Incoming
trigger: { on: webhook }
steps:
  - { id: notify, action: send_message, text: received }
`).definition;

    const created = await store.upsertDefinition({
      channelId,
      community,
      definition: webhookDefinition,
      ownerPubkey,
      workflowId,
    });
    expect(created.issuedWebhookSecret).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    const firstSecret = created.issuedWebhookSecret as string;
    expect(created.definition).not.toHaveProperty("_webhook_secret");

    const target = await store.getWebhookTarget(community, workflowId);
    expect(target?.secret).toBe(firstSecret);
    expect(target?.workflow.definition).not.toHaveProperty("_webhook_secret");
    expect(
      (await store.get(community, workflowId))?.definition,
    ).not.toHaveProperty("_webhook_secret");

    const updated = await store.upsertDefinition({
      channelId,
      community,
      definition: { ...webhookDefinition, name: "Incoming updated" },
      ownerPubkey,
      workflowId,
    });
    expect(updated.issuedWebhookSecret).toBeUndefined();
    expect((await store.getWebhookTarget(community, workflowId))?.secret).toBe(
      firstSecret,
    );

    await store.upsertDefinition({
      channelId,
      community,
      definition: parseWorkflowYaml(`
name: Manual only
trigger: { on: message_posted }
steps:
  - { id: notify, action: send_message, text: received }
`).definition,
      ownerPubkey,
      workflowId,
    });
    expect(
      (await store.getWebhookTarget(community, workflowId))?.secret,
    ).toBeUndefined();

    const restored = await store.upsertDefinition({
      channelId,
      community,
      definition: webhookDefinition,
      ownerPubkey,
      workflowId,
    });
    expect(restored.issuedWebhookSecret).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(restored.issuedWebhookSecret).not.toBe(firstSecret);
  });

  it("persists runs, hashed approval tokens, and one-time approval transitions", async () => {
    if (!pool) throw new Error("test pool is unavailable");
    const store = new PostgresWorkflowStore(pool);
    const workflow = await store.upsertDefinition({
      channelId,
      community,
      definition: parseWorkflowYaml(`
name: Approval
trigger: { on: webhook }
steps:
  - id: gate
    action: request_approval
    from: "${ownerPubkey}"
    message: approve
`).definition,
      ownerPubkey,
      workflowId: randomUUID(),
    });
    const run = await store.createRun({ triggerContext: trigger, workflow });
    const token = randomUUID();
    const result: WorkflowRunResult = {
      approval: {
        approver: ownerPubkey,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        message: "approve",
        stepId: "gate",
        token,
      },
      currentStep: 0,
      outputs: {},
      status: "waiting_approval",
      trace: [],
    };
    await store.finalizeRun(workflow.communityId, run.id, result);
    await expect(
      store.approve({
        approverPubkey: memberPubkey,
        community,
        granted: true,
        token,
      }),
    ).rejects.toBeInstanceOf(WorkflowStoreAuthorizationError);
    await expect(
      store.approve({
        approverPubkey: ownerPubkey,
        community,
        granted: true,
        token,
      }),
    ).resolves.toMatchObject({ runId: run.id, workflowId: workflow.id });
    await expect(
      store.approve({
        approverPubkey: ownerPubkey,
        community,
        granted: true,
        token,
      }),
    ).rejects.toBeInstanceOf(WorkflowStoreAuthorizationError);

    const storedToken = await pool.query<{ readonly token: string }>(
      `SELECT encode(wa.token, 'hex') AS token
       FROM workflow_approvals wa
       WHERE wa.community_id = $1 AND wa.run_id = $2::uuid`,
      [workflow.communityId, run.id],
    );
    expect(storedToken.rows[0]?.token).not.toContain(token.replaceAll("-", ""));
  });
});
