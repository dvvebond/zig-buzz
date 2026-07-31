import { createHash, randomUUID } from "node:crypto";

import type { Pool, PoolClient } from "pg";

import {
  validateWorkflowDefinition,
  workflowRequiresElevatedAuthority,
  type WorkflowDefinition,
} from "./schema.js";
import type {
  TriggerContext,
  WorkflowRunResult,
  WorkflowTraceEntry,
} from "./types.js";

export type WorkflowRecord = {
  readonly communityId: string;
  readonly communityHost: string;
  readonly id: string;
  readonly name: string;
  readonly ownerPubkey: string;
  readonly channelId?: string;
  readonly definition: WorkflowDefinition;
  readonly enabled: boolean;
  readonly status: "active" | "disabled" | "archived";
  /** Returned only by the write that first enables a webhook trigger. */
  readonly issuedWebhookSecret?: string;
};

export type WorkflowWebhookTarget = {
  readonly secret?: string;
  readonly workflow: WorkflowRecord;
};

export type WorkflowRunRecord = {
  readonly communityId: string;
  readonly id: string;
  readonly workflowId: string;
  readonly status:
    | "pending"
    | "running"
    | "waiting_approval"
    | "completed"
    | "failed"
    | "cancelled";
  readonly currentStep: number;
  readonly triggerContext: TriggerContext;
  readonly trace: readonly WorkflowTraceEntry[];
};

export class PostgresWorkflowStore {
  public constructor(private readonly pool: Pool) {}

  public async upsertDefinition(input: {
    readonly community: string;
    readonly workflowId: string;
    readonly channelId: string;
    readonly ownerPubkey: string;
    readonly definition: WorkflowDefinition;
  }): Promise<WorkflowRecord> {
    assertUuid(input.workflowId, "workflowId");
    assertUuid(input.channelId, "channelId");
    assertPubkey(input.ownerPubkey, "ownerPubkey");
    const definition = validateWorkflowDefinition(input.definition);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const communityId = await resolveCommunityId(
        client,
        input.community,
        true,
      );
      const workflow = await this.upsertDefinitionInTransaction(
        client,
        communityId,
        input.community,
        { ...input, definition },
      );
      await client.query("COMMIT");
      return workflow;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  public async upsertDefinitionInTransaction(
    client: PoolClient,
    communityId: string,
    communityHost: string,
    input: {
      readonly workflowId: string;
      readonly channelId: string;
      readonly ownerPubkey: string;
      readonly definition: WorkflowDefinition;
    },
  ): Promise<WorkflowRecord> {
    assertUuid(communityId, "communityId");
    assertUuid(input.workflowId, "workflowId");
    assertUuid(input.channelId, "channelId");
    assertPubkey(input.ownerPubkey, "ownerPubkey");
    const definition = validateWorkflowDefinition(input.definition);
    await client.query(
      `INSERT INTO users (community_id, pubkey)
       VALUES ($1, decode($2, 'hex'))
       ON CONFLICT (community_id, pubkey) DO NOTHING`,
      [communityId, input.ownerPubkey],
    );
    const authority = await client.query<{ readonly role: string }>(
      `SELECT cm.role::text AS role
       FROM channels ch
       JOIN channel_members cm
         ON cm.community_id = ch.community_id AND cm.channel_id = ch.id
       WHERE ch.community_id = $1
         AND ch.id = $2::uuid
         AND ch.archived_at IS NULL
         AND ch.deleted_at IS NULL
         AND cm.pubkey = decode($3, 'hex')
         AND cm.removed_at IS NULL
       FOR UPDATE OF ch, cm`,
      [communityId, input.channelId, input.ownerPubkey],
    );
    const role = authority.rows[0]?.role;
    if (
      role === undefined ||
      (workflowRequiresElevatedAuthority(definition) &&
        role !== "owner" &&
        role !== "admin")
    ) {
      throw new WorkflowStoreAuthorizationError(
        "workflow owner lacks current channel authority",
      );
    }
    const existing = await client.query<{
      readonly definition: unknown;
    }>(
      `SELECT definition
       FROM workflows
       WHERE community_id = $1 AND id = $2::uuid
       LIMIT 1
       FOR UPDATE`,
      [communityId, input.workflowId],
    );
    const existingSecret = webhookSecretFromDefinition(
      existing.rows[0]?.definition,
    );
    const webhookSecret =
      definition.trigger.on === "webhook"
        ? (existingSecret ?? randomUUID())
        : undefined;
    const persistedDefinition = webhookSecret
      ? { ...definition, _webhook_secret: webhookSecret }
      : definition;
    const canonicalJson = JSON.stringify(persistedDefinition);
    const hash = createHash("sha256").update(canonicalJson).digest();
    const result = await client.query<WorkflowRow>(
      `INSERT INTO workflows (
         community_id, id, name, owner_pubkey, channel_id, definition,
         definition_hash, status, enabled
       )
       VALUES (
         $1, $2::uuid, $3, decode($4, 'hex'), $5::uuid, $6::jsonb,
         $7, 'active', $8
       )
       ON CONFLICT (community_id, id)
       DO UPDATE SET
         name = EXCLUDED.name,
         definition = EXCLUDED.definition,
         definition_hash = EXCLUDED.definition_hash,
         enabled = EXCLUDED.enabled,
         status = CASE
           WHEN workflows.status = 'archived' THEN workflows.status
           ELSE 'active'::workflow_status
         END,
         updated_at = now()
       WHERE workflows.owner_pubkey = EXCLUDED.owner_pubkey
         AND workflows.channel_id IS NOT DISTINCT FROM EXCLUDED.channel_id
       RETURNING id, name, encode(owner_pubkey, 'hex') AS owner_pubkey,
                 channel_id, definition, enabled, status::text`,
      [
        communityId,
        input.workflowId,
        definition.name,
        input.ownerPubkey,
        input.channelId,
        canonicalJson,
        hash,
        definition.enabled,
      ],
    );
    const row = result.rows[0];
    if (!row) {
      throw new WorkflowStoreAuthorizationError(
        "workflow belongs to a different owner or channel",
      );
    }
    return {
      ...workflowFromRow(row, communityId, communityHost),
      ...(webhookSecret && !existingSecret
        ? { issuedWebhookSecret: webhookSecret }
        : {}),
    };
  }

  public async get(
    community: string,
    workflowId: string,
  ): Promise<WorkflowRecord | undefined> {
    assertUuid(workflowId, "workflowId");
    const result = await this.pool.query<
      WorkflowRow & {
        readonly community_id: string;
        readonly community_host: string;
      }
    >(
      `${workflowSelect()}
       WHERE lower(c.host) = lower($1) AND w.id = $2::uuid
       LIMIT 1`,
      [community, workflowId],
    );
    const row = result.rows[0];
    return row
      ? workflowFromRow(row, row.community_id, row.community_host)
      : undefined;
  }

  public async getWebhookTarget(
    community: string,
    workflowId: string,
  ): Promise<WorkflowWebhookTarget | undefined> {
    assertUuid(workflowId, "workflowId");
    const result = await this.pool.query<
      WorkflowRow & {
        readonly community_id: string;
        readonly community_host: string;
      }
    >(
      `${workflowSelect()}
       WHERE lower(c.host) = lower($1)
         AND c.archived_at IS NULL
         AND w.id = $2::uuid
       LIMIT 1`,
      [community, workflowId],
    );
    const row = result.rows[0];
    if (!row) return undefined;
    const secret = webhookSecretFromDefinition(row.definition);
    return {
      ...(secret ? { secret } : {}),
      workflow: workflowFromRow(row, row.community_id, row.community_host),
    };
  }

  public async listEnabledForChannel(
    community: string,
    channelId: string,
  ): Promise<WorkflowRecord[]> {
    assertUuid(channelId, "channelId");
    const result = await this.pool.query<
      WorkflowRow & {
        readonly community_id: string;
        readonly community_host: string;
      }
    >(
      `${workflowSelect()}
       WHERE lower(c.host) = lower($1)
         AND c.archived_at IS NULL
         AND w.channel_id = $2::uuid
         AND w.enabled = true
         AND w.status = 'active'
       ORDER BY w.id`,
      [community, channelId],
    );
    return result.rows.map((row) =>
      workflowFromRow(row, row.community_id, row.community_host),
    );
  }

  public async listEnabledSchedules(): Promise<WorkflowRecord[]> {
    const result = await this.pool.query<
      WorkflowRow & {
        readonly community_id: string;
        readonly community_host: string;
      }
    >(
      `${workflowSelect()}
       WHERE c.archived_at IS NULL
         AND w.enabled = true
         AND w.status = 'active'
         AND w.definition->'trigger'->>'on' = 'schedule'
       ORDER BY w.community_id, w.id`,
    );
    return result.rows.map((row) =>
      workflowFromRow(row, row.community_id, row.community_host),
    );
  }

  public async archiveDefinition(
    community: string,
    workflowId: string,
    ownerPubkey: string,
  ): Promise<void> {
    assertUuid(workflowId, "workflowId");
    assertPubkey(ownerPubkey, "ownerPubkey");
    const result = await this.pool.query(
      `UPDATE workflows w
       SET status = 'archived', enabled = false, updated_at = now()
       FROM communities c
       WHERE w.community_id = c.id
         AND lower(c.host) = lower($1)
         AND w.id = $2::uuid
         AND w.owner_pubkey = decode($3, 'hex')
         AND w.status <> 'archived'`,
      [community, workflowId, ownerPubkey],
    );
    if (result.rowCount !== 1) {
      throw new WorkflowStoreAuthorizationError(
        "workflow is unavailable or belongs to another owner",
      );
    }
  }

  public async archiveDefinitionInTransaction(
    client: PoolClient,
    communityId: string,
    workflowId: string,
    ownerPubkey: string,
  ): Promise<void> {
    assertUuid(communityId, "communityId");
    assertUuid(workflowId, "workflowId");
    assertPubkey(ownerPubkey, "ownerPubkey");
    const result = await client.query(
      `UPDATE workflows
       SET status = 'archived', enabled = false, updated_at = now()
       WHERE community_id = $1
         AND id = $2::uuid
         AND owner_pubkey = decode($3, 'hex')
         AND status <> 'archived'`,
      [communityId, workflowId, ownerPubkey],
    );
    if (result.rowCount !== 1) {
      throw new WorkflowStoreAuthorizationError(
        "workflow is unavailable or belongs to another owner",
      );
    }
  }

  public async checkOwnerAuthority(workflow: WorkflowRecord): Promise<boolean> {
    if (!workflow.channelId) return false;
    const result = await this.pool.query<{ readonly role: string }>(
      `SELECT cm.role::text AS role
       FROM channel_members cm
       JOIN channels ch
         ON ch.community_id = cm.community_id AND ch.id = cm.channel_id
       WHERE cm.community_id = $1
         AND cm.channel_id = $2::uuid
         AND cm.pubkey = decode($3, 'hex')
         AND cm.removed_at IS NULL
         AND ch.archived_at IS NULL
         AND ch.deleted_at IS NULL
       LIMIT 1`,
      [workflow.communityId, workflow.channelId, workflow.ownerPubkey],
    );
    const role = result.rows[0]?.role;
    return (
      role !== undefined &&
      (!workflowRequiresElevatedAuthority(workflow.definition) ||
        role === "owner" ||
        role === "admin")
    );
  }

  public async createRun(input: {
    readonly workflow: WorkflowRecord;
    readonly triggerContext: TriggerContext;
    readonly triggerEventId?: string;
  }): Promise<WorkflowRunRecord> {
    if (input.triggerEventId) assertEventId(input.triggerEventId);
    const id = randomUUID();
    const result = await this.pool.query<RunRow>(
      `INSERT INTO workflow_runs (
         community_id, id, workflow_id, status, trigger_event_id,
         trigger_context, started_at
       )
       VALUES (
         $1, $2::uuid, $3::uuid, 'running',
         CASE WHEN $4::text IS NULL THEN NULL ELSE decode($4, 'hex') END,
         $5::jsonb, now()
       )
       RETURNING id, workflow_id, status::text, current_step,
                 trigger_context, execution_trace`,
      [
        input.workflow.communityId,
        id,
        input.workflow.id,
        input.triggerEventId ?? null,
        JSON.stringify(input.triggerContext),
      ],
    );
    return runFromRow(result.rows[0] as RunRow, input.workflow.communityId);
  }

  public async createManualRunInTransaction(
    client: PoolClient,
    communityId: string,
    communityHost: string,
    input: {
      readonly workflowId: string;
      readonly actorPubkey: string;
      readonly fields: Readonly<Record<string, string>>;
      readonly triggerEventId: string;
      readonly createdAt: number;
    },
  ): Promise<{
    readonly workflow: WorkflowRecord;
    readonly run: WorkflowRunRecord;
  }> {
    assertUuid(communityId, "communityId");
    assertUuid(input.workflowId, "workflowId");
    assertPubkey(input.actorPubkey, "actorPubkey");
    assertEventId(input.triggerEventId);
    const selected = await client.query<WorkflowRow>(
      `${workflowSelectForCommunity()}
       WHERE w.community_id = $1 AND w.id = $2::uuid
       LIMIT 1
       FOR UPDATE OF w`,
      [communityId, input.workflowId],
    );
    const row = selected.rows[0];
    if (!row) {
      throw new WorkflowStoreAuthorizationError(
        "identity is not authorized to trigger this workflow",
      );
    }
    const workflow = workflowFromRow(row, communityId, communityHost);
    if (
      workflow.ownerPubkey !== input.actorPubkey ||
      !workflow.enabled ||
      workflow.status !== "active" ||
      !(await checkOwnerAuthorityWithClient(client, workflow, true))
    ) {
      throw new WorkflowStoreAuthorizationError(
        "identity is not authorized to trigger this workflow",
      );
    }
    const trigger: TriggerContext = {
      author: input.actorPubkey,
      channelId: workflow.channelId ?? "",
      emoji: "",
      messageId: input.triggerEventId,
      text: "",
      timestamp: input.createdAt,
      webhookFields: input.fields,
    };
    const id = randomUUID();
    const inserted = await client.query<RunRow>(
      `INSERT INTO workflow_runs (
         community_id, id, workflow_id, status, trigger_event_id,
         trigger_context, started_at
       )
       VALUES (
         $1, $2::uuid, $3::uuid, 'running', decode($4, 'hex'),
         $5::jsonb, now()
       )
       RETURNING id, workflow_id, status::text, current_step,
                 trigger_context, execution_trace`,
      [
        communityId,
        id,
        workflow.id,
        input.triggerEventId,
        JSON.stringify(trigger),
      ],
    );
    return {
      run: runFromRow(inserted.rows[0] as RunRow, communityId),
      workflow,
    };
  }

  public async finalizeRun(
    communityId: string,
    runId: string,
    result: WorkflowRunResult,
  ): Promise<void> {
    assertUuid(communityId, "communityId");
    assertUuid(runId, "runId");
    const error = result.status === "failed" ? result.error : null;
    const updated = await this.pool.query(
      `UPDATE workflow_runs
       SET status = $3::run_status,
           current_step = $4,
           execution_trace = $5::jsonb,
           error_message = $6,
           completed_at = CASE
             WHEN $3 IN ('completed', 'failed', 'cancelled') THEN now()
             ELSE NULL
           END
       WHERE community_id = $1 AND id = $2::uuid`,
      [
        communityId,
        runId,
        result.status,
        result.currentStep,
        JSON.stringify(result.trace),
        error,
      ],
    );
    if (updated.rowCount !== 1) throw new WorkflowStoreError("run not found");
    if (result.status === "waiting_approval") {
      await this.saveApproval({
        communityId,
        expiresAt: result.approval.expiresAt,
        approver: result.approval.approver,
        runId,
        stepId: result.approval.stepId,
        stepIndex: result.currentStep,
        token: result.approval.token,
      });
    }
  }

  public async getRun(
    communityId: string,
    runId: string,
  ): Promise<WorkflowRunRecord | undefined> {
    const result = await this.pool.query<RunRow>(
      `SELECT id, workflow_id, status::text, current_step,
              trigger_context, execution_trace
       FROM workflow_runs
       WHERE community_id = $1 AND id = $2::uuid
       LIMIT 1`,
      [communityId, runId],
    );
    const row = result.rows[0];
    return row ? runFromRow(row, communityId) : undefined;
  }

  public async cancelRun(
    communityId: string,
    runId: string,
    message: string,
  ): Promise<void> {
    const updated = await this.pool.query(
      `UPDATE workflow_runs
       SET status = 'cancelled',
           error_message = $3,
           completed_at = now()
       WHERE community_id = $1
         AND id = $2::uuid
         AND status IN ('pending', 'running', 'waiting_approval')`,
      [communityId, runId, message.slice(0, 2_048)],
    );
    if (updated.rowCount !== 1) {
      throw new WorkflowStoreError("run is not cancellable");
    }
  }

  public async claimScheduledFire(
    workflow: WorkflowRecord,
    scheduledFor: Date,
  ): Promise<boolean> {
    const result = await this.pool.query(
      `INSERT INTO scheduled_workflow_fires (
         community_id, workflow_id, scheduled_for
       )
       VALUES ($1, $2::uuid, $3)
       ON CONFLICT DO NOTHING
       RETURNING workflow_id`,
      [workflow.communityId, workflow.id, scheduledFor],
    );
    return result.rowCount === 1;
  }

  public async latestScheduledFire(
    workflow: WorkflowRecord,
  ): Promise<Date | undefined> {
    const result = await this.pool.query<{ readonly scheduled_for: Date }>(
      `SELECT scheduled_for
       FROM scheduled_workflow_fires
       WHERE community_id = $1 AND workflow_id = $2::uuid
       ORDER BY scheduled_for DESC
       LIMIT 1`,
      [workflow.communityId, workflow.id],
    );
    return result.rows[0]?.scheduled_for;
  }

  public async attachScheduledRun(
    workflow: WorkflowRecord,
    scheduledFor: Date,
    runId: string,
  ): Promise<void> {
    await this.pool.query(
      `UPDATE scheduled_workflow_fires
       SET workflow_run_id = $4::uuid
       WHERE community_id = $1
         AND workflow_id = $2::uuid
         AND scheduled_for = $3`,
      [workflow.communityId, workflow.id, scheduledFor, runId],
    );
  }

  public async approve(input: {
    readonly community: string;
    readonly token: string;
    readonly approverPubkey: string;
    readonly granted: boolean;
    readonly note?: string;
  }): Promise<{
    readonly communityId: string;
    readonly runId: string;
    readonly workflowId: string;
    readonly stepIndex: number;
  }> {
    return this.approveUsingHash({
      ...input,
      tokenHash: hashToken(input.token),
    });
  }

  public async approveByHash(input: {
    readonly community: string;
    readonly tokenHashHex: string;
    readonly approverPubkey: string;
    readonly granted: boolean;
    readonly note?: string;
  }): Promise<{
    readonly communityId: string;
    readonly runId: string;
    readonly workflowId: string;
    readonly stepIndex: number;
  }> {
    if (!/^[0-9a-f]{64}$/.test(input.tokenHashHex)) {
      throw new WorkflowStoreAuthorizationError(
        "approval token hash is invalid",
      );
    }
    return this.approveUsingHash({
      ...input,
      tokenHash: Buffer.from(input.tokenHashHex, "hex"),
    });
  }

  public async getApprovalWorkflow(
    community: string,
    tokenHashHex: string,
  ): Promise<WorkflowRecord | undefined> {
    if (!/^[0-9a-f]{64}$/.test(tokenHashHex)) {
      throw new WorkflowStoreAuthorizationError(
        "approval token hash is invalid",
      );
    }
    const result = await this.pool.query<
      WorkflowRow & {
        readonly community_id: string;
        readonly community_host: string;
      }
    >(
      `${workflowSelect()}
       JOIN workflow_approvals wa
         ON wa.community_id = w.community_id AND wa.workflow_id = w.id
       WHERE lower(c.host) = lower($1)
         AND wa.token = decode($2, 'hex')
         AND wa.status = 'pending'
         AND wa.expires_at >= now()
       LIMIT 1`,
      [community, tokenHashHex],
    );
    const row = result.rows[0];
    return row
      ? workflowFromRow(row, row.community_id, row.community_host)
      : undefined;
  }

  public async approveByHashInTransaction(
    client: PoolClient,
    communityId: string,
    input: {
      readonly tokenHashHex: string;
      readonly approverPubkey: string;
      readonly granted: boolean;
      readonly note?: string;
    },
  ): Promise<{
    readonly communityId: string;
    readonly runId: string;
    readonly workflowId: string;
    readonly stepIndex: number;
  }> {
    if (!/^[0-9a-f]{64}$/.test(input.tokenHashHex)) {
      throw new WorkflowStoreAuthorizationError(
        "approval token hash is invalid",
      );
    }
    return approveUsingHashWithClient(client, {
      ...input,
      communityId,
      tokenHash: Buffer.from(input.tokenHashHex, "hex"),
    });
  }

  private async approveUsingHash(input: {
    readonly community: string;
    readonly tokenHash: Buffer;
    readonly approverPubkey: string;
    readonly granted: boolean;
    readonly note?: string;
  }): Promise<{
    readonly communityId: string;
    readonly runId: string;
    readonly workflowId: string;
    readonly stepIndex: number;
  }> {
    assertPubkey(input.approverPubkey, "approverPubkey");
    if (Buffer.byteLength(input.note ?? "", "utf8") > 8_192) {
      throw new WorkflowStoreError("approval note exceeds 8192 bytes");
    }
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const communityId = await resolveCommunityId(
        client,
        input.community,
        true,
      );
      const result = await approveUsingHashWithClient(client, {
        ...input,
        communityId,
      });
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async saveApproval(input: {
    readonly communityId: string;
    readonly runId: string;
    readonly stepId: string;
    readonly stepIndex: number;
    readonly approver: string;
    readonly token: string;
    readonly expiresAt: string;
  }): Promise<void> {
    const run = await this.pool.query<{ readonly workflow_id: string }>(
      `SELECT workflow_id FROM workflow_runs
       WHERE community_id = $1 AND id = $2::uuid`,
      [input.communityId, input.runId],
    );
    const workflowId = run.rows[0]?.workflow_id;
    if (!workflowId) throw new WorkflowStoreError("run not found");
    await this.pool.query(
      `INSERT INTO workflow_approvals (
         community_id, token, workflow_id, run_id, step_id, step_index,
         approver_spec, expires_at
       )
       VALUES ($1, $2, $3::uuid, $4::uuid, $5, $6, $7, $8)`,
      [
        input.communityId,
        hashToken(input.token),
        workflowId,
        input.runId,
        input.stepId,
        input.stepIndex,
        input.approver,
        input.expiresAt,
      ],
    );
  }
}

type WorkflowRow = {
  readonly id: string;
  readonly name: string;
  readonly owner_pubkey: string;
  readonly channel_id: string | null;
  readonly definition: unknown;
  readonly enabled: boolean;
  readonly status: "active" | "disabled" | "archived";
};

type RunRow = {
  readonly id: string;
  readonly workflow_id: string;
  readonly status: WorkflowRunRecord["status"];
  readonly current_step: number;
  readonly trigger_context: unknown;
  readonly execution_trace: unknown;
};

function workflowSelect(): string {
  return `SELECT w.id, w.name, encode(w.owner_pubkey, 'hex') AS owner_pubkey,
                 w.channel_id, w.definition, w.enabled, w.status::text,
                 c.id AS community_id, c.host AS community_host
          FROM workflows w
          JOIN communities c ON c.id = w.community_id`;
}

function workflowSelectForCommunity(): string {
  return `SELECT w.id, w.name, encode(w.owner_pubkey, 'hex') AS owner_pubkey,
                 w.channel_id, w.definition, w.enabled, w.status::text
          FROM workflows w`;
}

async function checkOwnerAuthorityWithClient(
  client: PoolClient,
  workflow: WorkflowRecord,
  lock: boolean,
): Promise<boolean> {
  if (!workflow.channelId) return false;
  const result = await client.query<{ readonly role: string }>(
    `SELECT cm.role::text AS role
     FROM channel_members cm
     JOIN channels ch
       ON ch.community_id = cm.community_id AND ch.id = cm.channel_id
     WHERE cm.community_id = $1
       AND cm.channel_id = $2::uuid
       AND cm.pubkey = decode($3, 'hex')
       AND cm.removed_at IS NULL
       AND ch.archived_at IS NULL
       AND ch.deleted_at IS NULL
     LIMIT 1
     ${lock ? "FOR UPDATE OF cm, ch" : ""}`,
    [workflow.communityId, workflow.channelId, workflow.ownerPubkey],
  );
  const role = result.rows[0]?.role;
  return (
    role !== undefined &&
    (!workflowRequiresElevatedAuthority(workflow.definition) ||
      role === "owner" ||
      role === "admin")
  );
}

async function approveUsingHashWithClient(
  client: PoolClient,
  input: {
    readonly communityId: string;
    readonly tokenHash: Buffer;
    readonly approverPubkey: string;
    readonly granted: boolean;
    readonly note?: string;
  },
): Promise<{
  readonly communityId: string;
  readonly runId: string;
  readonly workflowId: string;
  readonly stepIndex: number;
}> {
  assertUuid(input.communityId, "communityId");
  assertPubkey(input.approverPubkey, "approverPubkey");
  if (Buffer.byteLength(input.note ?? "", "utf8") > 8_192) {
    throw new WorkflowStoreError("approval note exceeds 8192 bytes");
  }
  const approval = await client.query<{
    readonly run_id: string;
    readonly workflow_id: string;
    readonly step_index: number;
    readonly approver_spec: string;
  }>(
    `SELECT run_id, workflow_id, step_index, approver_spec
     FROM workflow_approvals
     WHERE community_id = $1
       AND token = $2
       AND status = 'pending'
       AND expires_at >= now()
     FOR UPDATE`,
    [input.communityId, input.tokenHash],
  );
  const row = approval.rows[0];
  if (!row) {
    throw new WorkflowStoreAuthorizationError("approval is unavailable");
  }
  if (
    row.approver_spec !== "" &&
    row.approver_spec !== "any" &&
    row.approver_spec.toLowerCase() !== input.approverPubkey
  ) {
    throw new WorkflowStoreAuthorizationError(
      "identity is not the designated approver",
    );
  }
  await client.query(
    `UPDATE workflow_approvals
     SET status = $3::approval_status,
         approver_pubkey = decode($4, 'hex'),
         note = $5,
         granted_at = CASE WHEN $3 = 'granted' THEN now() ELSE NULL END,
         denied_at = CASE WHEN $3 = 'denied' THEN now() ELSE NULL END
     WHERE community_id = $1 AND token = $2`,
    [
      input.communityId,
      input.tokenHash,
      input.granted ? "granted" : "denied",
      input.approverPubkey,
      input.note ?? null,
    ],
  );
  return {
    communityId: input.communityId,
    runId: row.run_id,
    stepIndex: row.step_index,
    workflowId: row.workflow_id,
  };
}

function webhookSecretFromDefinition(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const secret = (value as Record<string, unknown>)._webhook_secret;
  return typeof secret === "string" &&
    secret.length > 0 &&
    Buffer.byteLength(secret, "utf8") <= 256
    ? secret
    : undefined;
}

function workflowFromRow(
  row: WorkflowRow,
  communityId: string,
  communityHost: string,
): WorkflowRecord {
  return {
    ...(row.channel_id ? { channelId: row.channel_id } : {}),
    communityHost,
    communityId,
    definition: validateWorkflowDefinition(row.definition),
    enabled: row.enabled,
    id: row.id,
    name: row.name,
    ownerPubkey: row.owner_pubkey,
    status: row.status,
  };
}

function runFromRow(row: RunRow, communityId: string): WorkflowRunRecord {
  const triggerContext = validateTriggerContext(row.trigger_context);
  const trace = validateTrace(row.execution_trace);
  return {
    communityId,
    currentStep: row.current_step,
    id: row.id,
    status: row.status,
    trace,
    triggerContext,
    workflowId: row.workflow_id,
  };
}

function validateTriggerContext(value: unknown): TriggerContext {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new WorkflowStoreError("stored trigger context is invalid");
  }
  const object = value as Record<string, unknown>;
  if (
    typeof object.text !== "string" ||
    typeof object.author !== "string" ||
    typeof object.channelId !== "string" ||
    typeof object.timestamp !== "number" ||
    typeof object.emoji !== "string" ||
    typeof object.messageId !== "string" ||
    typeof object.webhookFields !== "object" ||
    object.webhookFields === null ||
    Array.isArray(object.webhookFields)
  ) {
    throw new WorkflowStoreError("stored trigger context is invalid");
  }
  const webhookFields = object.webhookFields as Record<string, unknown>;
  if (!Object.values(webhookFields).every((item) => typeof item === "string")) {
    throw new WorkflowStoreError("stored webhook context is invalid");
  }
  return object as TriggerContext;
}

function validateTrace(value: unknown): readonly WorkflowTraceEntry[] {
  if (!Array.isArray(value)) {
    throw new WorkflowStoreError("stored workflow trace is invalid");
  }
  return value as WorkflowTraceEntry[];
}

async function resolveCommunityId(
  client: PoolClient,
  community: string,
  lock: boolean,
): Promise<string> {
  const result = await client.query<{ readonly id: string }>(
    `SELECT id FROM communities
     WHERE lower(host) = lower($1) AND archived_at IS NULL
     ${lock ? "FOR SHARE" : ""}
     LIMIT 1`,
    [community],
  );
  const id = result.rows[0]?.id;
  if (!id) throw new WorkflowStoreError("community is unavailable");
  return id;
}

function hashToken(token: string): Buffer {
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      token,
    )
  ) {
    throw new WorkflowStoreAuthorizationError("approval token is invalid");
  }
  return createHash("sha256").update(token).digest();
}

function assertUuid(value: string, name: string): void {
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      value,
    )
  ) {
    throw new TypeError(`${name} must be a UUID`);
  }
}

function assertPubkey(value: string, name: string): void {
  if (!/^[0-9a-f]{64}$/.test(value)) {
    throw new TypeError(`${name} must be a lowercase Nostr pubkey`);
  }
}

function assertEventId(value: string): void {
  if (!/^[0-9a-f]{64}$/.test(value)) {
    throw new TypeError("triggerEventId must be a lowercase Nostr event ID");
  }
}

export class WorkflowStoreError extends Error {
  public override readonly name: string = "WorkflowStoreError";
}

export class WorkflowStoreAuthorizationError extends WorkflowStoreError {
  public override readonly name = "WorkflowStoreAuthorizationError";
}
