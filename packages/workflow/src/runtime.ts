import { createHash, timingSafeEqual } from "node:crypto";

import { CronExpressionParser } from "cron-parser";
import type { PoolClient } from "pg";
import {
  KIND_REACTION,
  KIND_STREAM_MESSAGE,
  KIND_STREAM_MESSAGE_DIFF,
  KIND_WORKFLOW_DEF,
  KIND_WORKFLOW_TRIGGER,
  KIND_APPROVAL_GRANT,
  KIND_APPROVAL_DENY,
  KIND_DELETION,
  type NostrEvent,
} from "@buzz/core";

import { evaluateCondition } from "./condition.js";
import type { WorkflowEngine } from "./engine.js";
import {
  parseDurationSeconds,
  parseWorkflowYaml,
  type WorkflowDefinition,
} from "./schema.js";
import {
  type PostgresWorkflowStore,
  WorkflowStoreAuthorizationError,
  type WorkflowRecord,
} from "./store.js";
import type { TriggerContext, WorkflowTraceEntry } from "./types.js";

const SCHEDULER_TICK_MILLISECONDS = 60_000;

export type PreparedWorkflowControl = {
  readonly channelId?: string;
  readonly apply: (client: PoolClient, communityId: string) => Promise<void>;
  readonly afterCommit: () => Promise<unknown>;
};

export class WorkflowRuntime {
  readonly #intervalAnchors = new Map<string, Date>();

  public constructor(
    private readonly store: PostgresWorkflowStore,
    private readonly engine: WorkflowEngine,
  ) {}

  public async onEvent(
    community: string,
    event: NostrEvent,
    channelId: string | undefined,
  ): Promise<readonly string[]> {
    if (!channelId || (event.kind >= 46_001 && event.kind <= 46_012)) {
      return [];
    }
    const workflows = await this.store.listEnabledForChannel(
      community,
      channelId,
    );
    const trigger = triggerContextFromEvent(event, channelId);
    const runIds: string[] = [];
    for (const workflow of workflows) {
      if (
        !triggerMatches(workflow.definition, event.kind) ||
        !triggerFilterMatches(workflow.definition, trigger) ||
        !(await this.store.checkOwnerAuthority(workflow))
      ) {
        continue;
      }
      const run = await this.store.createRun({
        triggerContext: trigger,
        triggerEventId: event.id,
        workflow,
      });
      runIds.push(run.id);
      await this.executeAndFinalize(workflow, run.id, trigger);
    }
    return runIds;
  }

  public async triggerManually(input: {
    readonly community: string;
    readonly workflowId: string;
    readonly actorPubkey: string;
    readonly fields?: Readonly<Record<string, string>>;
    readonly triggerEventId?: string;
  }): Promise<string> {
    const workflow = await this.store.get(input.community, input.workflowId);
    if (
      !workflow ||
      workflow.ownerPubkey !== input.actorPubkey ||
      !workflow.enabled ||
      workflow.status !== "active" ||
      !(await this.store.checkOwnerAuthority(workflow))
    ) {
      throw new WorkflowStoreAuthorizationError(
        "identity is not authorized to trigger this workflow",
      );
    }
    const trigger: TriggerContext = {
      author: input.actorPubkey,
      channelId: workflow.channelId ?? "",
      emoji: "",
      messageId: input.triggerEventId ?? "",
      text: "",
      timestamp: Math.floor(Date.now() / 1_000),
      webhookFields: input.fields ?? {},
    };
    const run = await this.store.createRun({
      ...(input.triggerEventId ? { triggerEventId: input.triggerEventId } : {}),
      triggerContext: trigger,
      workflow,
    });
    await this.executeAndFinalize(workflow, run.id, trigger);
    return run.id;
  }

  public async triggerWebhook(input: {
    readonly community: string;
    readonly workflowId: string;
    readonly secret: string;
    readonly fields?: Readonly<Record<string, string>>;
  }): Promise<string> {
    const target = await this.store.getWebhookTarget(
      input.community,
      input.workflowId,
    );
    if (
      !target?.secret ||
      !constantTimeSecretEqual(input.secret, target.secret)
    ) {
      throw new WorkflowWebhookAuthenticationError(
        "workflow webhook authentication failed",
      );
    }
    const workflow = target.workflow;
    if (
      workflow.definition.trigger.on !== "webhook" ||
      !workflow.enabled ||
      workflow.status !== "active" ||
      !(await this.store.checkOwnerAuthority(workflow))
    ) {
      throw new WorkflowStoreAuthorizationError("workflow is unavailable");
    }
    const fields = validateWebhookFields(input.fields ?? {});
    const trigger: TriggerContext = {
      author: workflow.ownerPubkey,
      channelId: workflow.channelId ?? "",
      emoji: "",
      messageId: "",
      text: "",
      timestamp: Math.floor(Date.now() / 1_000),
      webhookFields: fields,
    };
    const run = await this.store.createRun({
      triggerContext: trigger,
      workflow,
    });
    void this.executeAndFinalize(workflow, run.id, trigger).catch(async () => {
      await this.store
        .cancelRun(
          workflow.communityId,
          run.id,
          "webhook workflow execution failed",
        )
        .catch(() => undefined);
    });
    return run.id;
  }

  public async respondToApproval(input: {
    readonly community: string;
    readonly token: string;
    readonly approverPubkey: string;
    readonly granted: boolean;
    readonly note?: string;
  }): Promise<string> {
    const approval = await this.store.approve(input);
    return this.finishApproval(input, approval);
  }

  public async prepareControlEvent(
    community: string,
    event: NostrEvent,
    channelId: string | undefined,
  ): Promise<PreparedWorkflowControl | undefined> {
    if (event.kind === KIND_WORKFLOW_DEF) {
      if (!channelId) throw new Error("workflow definition requires a channel");
      const workflowId = exactTag(event, "d");
      const definition = parseWorkflowYaml(event.content).definition;
      let issuedWebhookSecret: string | undefined;
      return {
        channelId,
        apply: async (client, communityId) => {
          const saved = await this.store.upsertDefinitionInTransaction(
            client,
            communityId,
            community,
            {
              channelId,
              definition,
              ownerPubkey: event.pubkey,
              workflowId,
            },
          );
          issuedWebhookSecret = saved.issuedWebhookSecret;
        },
        afterCommit: async () => ({
          workflow_id: workflowId,
          ...(issuedWebhookSecret
            ? { webhook_secret: issuedWebhookSecret }
            : {}),
        }),
      };
    }
    if (event.kind === KIND_WORKFLOW_TRIGGER) {
      const workflowId = exactTag(event, "d");
      const fields = jsonStringFields(event.content);
      const preflight = await this.store.get(community, workflowId);
      if (
        !preflight ||
        preflight.ownerPubkey !== event.pubkey ||
        !preflight.channelId
      ) {
        throw new WorkflowStoreAuthorizationError(
          "identity is not authorized to trigger this workflow",
        );
      }
      let prepared:
        | Awaited<
            ReturnType<PostgresWorkflowStore["createManualRunInTransaction"]>
          >
        | undefined;
      return {
        channelId: preflight.channelId,
        apply: async (client, communityId) => {
          prepared = await this.store.createManualRunInTransaction(
            client,
            communityId,
            community,
            {
              actorPubkey: event.pubkey,
              createdAt: event.created_at,
              fields,
              triggerEventId: event.id,
              workflowId,
            },
          );
        },
        afterCommit: async () => {
          if (!prepared) {
            throw new Error("manual workflow run was not committed");
          }
          await this.executeAndFinalize(
            prepared.workflow,
            prepared.run.id,
            prepared.run.triggerContext,
          );
          return prepared.run.id;
        },
      };
    }
    if (
      event.kind === KIND_APPROVAL_GRANT ||
      event.kind === KIND_APPROVAL_DENY
    ) {
      const tokenHashHex = exactTag(event, "d");
      const preflight = await this.store.getApprovalWorkflow(
        community,
        tokenHashHex,
      );
      if (!preflight?.channelId) {
        throw new WorkflowStoreAuthorizationError("approval is unavailable");
      }
      const granted = event.kind === KIND_APPROVAL_GRANT;
      let approval:
        | {
            readonly communityId: string;
            readonly runId: string;
            readonly workflowId: string;
            readonly stepIndex: number;
          }
        | undefined;
      return {
        channelId: preflight.channelId,
        apply: async (client, communityId) => {
          approval = await this.store.approveByHashInTransaction(
            client,
            communityId,
            {
              approverPubkey: event.pubkey,
              granted,
              ...(event.content ? { note: event.content } : {}),
              tokenHashHex,
            },
          );
        },
        afterCommit: async () => {
          if (!approval) throw new Error("workflow approval was not committed");
          return this.finishApproval(
            {
              approverPubkey: event.pubkey,
              community,
              granted,
              ...(event.content ? { note: event.content } : {}),
              token: "",
            },
            approval,
          );
        },
      };
    }
    if (event.kind === KIND_DELETION) {
      const address = event.tags.find((tag) => tag[0] === "a")?.[1];
      const match = /^30620:([0-9a-f]{64}):([0-9a-f-]{36})$/.exec(
        address ?? "",
      );
      if (match?.[1] !== event.pubkey || !match[2]) return undefined;
      const workflowId = match[2];
      const preflight = await this.store.get(community, workflowId);
      if (!preflight?.channelId || preflight.ownerPubkey !== event.pubkey) {
        throw new WorkflowStoreAuthorizationError(
          "workflow is unavailable or belongs to another owner",
        );
      }
      return {
        channelId: preflight.channelId,
        apply: async (client, communityId) => {
          await this.store.archiveDefinitionInTransaction(
            client,
            communityId,
            workflowId,
            event.pubkey,
          );
        },
        afterCommit: async () => ({ archived: true, workflowId }),
      };
    }
    return undefined;
  }

  private async finishApproval(
    input: {
      readonly community: string;
      readonly token: string;
      readonly approverPubkey: string;
      readonly granted: boolean;
      readonly note?: string;
    },
    approval: {
      readonly communityId: string;
      readonly runId: string;
      readonly workflowId: string;
      readonly stepIndex: number;
    },
  ): Promise<string> {
    if (!input.granted) {
      await this.store.cancelRun(
        approval.communityId,
        approval.runId,
        "approval denied",
      );
      return approval.runId;
    }
    const [workflow, run] = await Promise.all([
      this.store.get(input.community, approval.workflowId),
      this.store.getRun(approval.communityId, approval.runId),
    ]);
    if (!workflow || !run || run.status !== "waiting_approval") {
      throw new WorkflowStoreAuthorizationError("approval run is unavailable");
    }
    if (!(await this.store.checkOwnerAuthority(workflow))) {
      await this.store.cancelRun(
        approval.communityId,
        approval.runId,
        "workflow owner authority was revoked",
      );
      throw new WorkflowStoreAuthorizationError(
        "workflow owner no longer has channel authority",
      );
    }
    const outputs = outputsFromTrace(run.trace);
    const result = await this.engine.execute({
      communityId: workflow.communityId,
      definition: workflow.definition,
      ownerPubkey: workflow.ownerPubkey,
      priorOutputs: outputs,
      priorTrace: run.trace,
      runId: run.id,
      startAt: approval.stepIndex + 1,
      trigger: run.triggerContext,
      ...(workflow.channelId ? { workflowChannelId: workflow.channelId } : {}),
      workflowId: workflow.id,
    });
    await this.store.finalizeRun(workflow.communityId, run.id, result);
    return run.id;
  }

  public async tick(now = new Date()): Promise<readonly string[]> {
    const workflows = await this.store.listEnabledSchedules();
    const runIds: string[] = [];
    for (const workflow of workflows) {
      const schedule = workflow.definition.trigger;
      if (
        schedule.on !== "schedule" ||
        !workflow.channelId ||
        !(await this.store.checkOwnerAuthority(workflow))
      ) {
        continue;
      }
      const scheduledFor =
        schedule.cron !== undefined
          ? cronFireInWindow(schedule.cron, now)
          : await this.intervalFire(workflow, schedule.interval as string, now);
      if (
        !scheduledFor ||
        !(await this.store.claimScheduledFire(workflow, scheduledFor))
      ) {
        continue;
      }
      const trigger: TriggerContext = {
        author: workflow.ownerPubkey,
        channelId: workflow.channelId,
        emoji: "",
        messageId: "",
        text: "",
        timestamp: Math.floor(now.getTime() / 1_000),
        webhookFields: {},
      };
      const run = await this.store.createRun({
        triggerContext: trigger,
        workflow,
      });
      await this.store.attachScheduledRun(workflow, scheduledFor, run.id);
      runIds.push(run.id);
      await this.executeAndFinalize(workflow, run.id, trigger);
    }
    return runIds;
  }

  public async runScheduler(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      await waitForTick(signal);
      if (signal.aborted) return;
      await this.tick();
    }
  }

  private async intervalFire(
    workflow: WorkflowRecord,
    duration: string,
    now: Date,
  ): Promise<Date | undefined> {
    const seconds = parseDurationSeconds(duration);
    const key = `${workflow.communityId}:${workflow.id}`;
    const memoryAnchor = this.#intervalAnchors.get(key);
    const durableAnchor =
      memoryAnchor ?? (await this.store.latestScheduledFire(workflow));
    if (!durableAnchor) {
      this.#intervalAnchors.set(key, now);
      return undefined;
    }
    if (now.getTime() - durableAnchor.getTime() < seconds * 1_000) {
      return undefined;
    }
    const scheduledFor = new Date(
      Math.floor(now.getTime() / (seconds * 1_000)) * seconds * 1_000,
    );
    this.#intervalAnchors.set(key, scheduledFor);
    return scheduledFor;
  }

  private async executeAndFinalize(
    workflow: WorkflowRecord,
    runId: string,
    trigger: TriggerContext,
  ): Promise<void> {
    const result = await this.engine.execute({
      communityId: workflow.communityId,
      definition: workflow.definition,
      ownerPubkey: workflow.ownerPubkey,
      runId,
      trigger,
      ...(workflow.channelId ? { workflowChannelId: workflow.channelId } : {}),
      workflowId: workflow.id,
    });
    await this.store.finalizeRun(workflow.communityId, runId, result);
  }
}

function constantTimeSecretEqual(provided: string, expected: string): boolean {
  const left = createHash("sha256").update(provided, "utf8").digest();
  const right = createHash("sha256").update(expected, "utf8").digest();
  return timingSafeEqual(left, right);
}

function validateWebhookFields(
  fields: Readonly<Record<string, string>>,
): Readonly<Record<string, string>> {
  const entries = Object.entries(fields);
  if (entries.length > 100) {
    throw new WorkflowStoreAuthorizationError(
      "webhook body contains too many fields",
    );
  }
  const output: Record<string, string> = {};
  for (const [key, value] of entries) {
    if (
      key.length === 0 ||
      Buffer.byteLength(key, "utf8") > 256 ||
      Buffer.byteLength(value, "utf8") > 64 * 1024
    ) {
      throw new WorkflowStoreAuthorizationError(
        "webhook body contains an invalid field",
      );
    }
    output[key] = value;
  }
  return output;
}

function exactTag(event: NostrEvent, name: string): string {
  const values = event.tags.filter((tag) => tag[0] === name);
  if (values.length !== 1 || values[0]?.length !== 2 || !values[0][1]) {
    throw new Error(`workflow control event requires exactly one ${name} tag`);
  }
  return values[0][1];
}

export class WorkflowWebhookAuthenticationError extends Error {
  public override readonly name = "WorkflowWebhookAuthenticationError";
}

function jsonStringFields(content: string): Readonly<Record<string, string>> {
  if (!content) return {};
  const value = JSON.parse(content) as unknown;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("workflow trigger inputs must be a JSON object");
  }
  if (Object.keys(value).length > 256) {
    throw new Error("workflow trigger inputs exceed 256 fields");
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      typeof item === "string" ? item : JSON.stringify(item),
    ]),
  );
}

export function triggerContextFromEvent(
  event: NostrEvent,
  channelId: string,
): TriggerContext {
  const actor =
    event.tags.find(
      (tag) =>
        tag[0] === "actor" &&
        tag.length === 2 &&
        /^[0-9a-f]{64}$/.test(tag[1] ?? ""),
    )?.[1] ?? event.pubkey;
  const target =
    event.kind === KIND_REACTION
      ? ([...event.tags]
          .reverse()
          .find(
            (tag) =>
              tag[0] === "e" &&
              tag.length >= 2 &&
              /^[0-9a-f]{64}$/.test(tag[1] ?? ""),
          )?.[1] ?? event.id)
      : event.id;
  return {
    author: actor,
    channelId,
    emoji: event.kind === KIND_REACTION ? event.content : "",
    messageId: target,
    text: event.content,
    timestamp: event.created_at,
    webhookFields: {},
  };
}

export function triggerMatches(
  definition: WorkflowDefinition,
  kind: number,
): boolean {
  const trigger = definition.trigger;
  return (
    (trigger.on === "message_posted" && kind === KIND_STREAM_MESSAGE) ||
    (trigger.on === "reaction_added" && kind === KIND_REACTION) ||
    (trigger.on === "diff_posted" && kind === KIND_STREAM_MESSAGE_DIFF)
  );
}

function triggerFilterMatches(
  definition: WorkflowDefinition,
  trigger: TriggerContext,
): boolean {
  const rule = definition.trigger;
  if (
    rule.on === "reaction_added" &&
    rule.emoji !== undefined &&
    rule.emoji !== trigger.emoji
  ) {
    return false;
  }
  if (
    (rule.on === "message_posted" || rule.on === "diff_posted") &&
    rule.filter !== undefined
  ) {
    try {
      return evaluateCondition(rule.filter, trigger, {});
    } catch {
      return false;
    }
  }
  return true;
}

function cronFireInWindow(expression: string, now: Date): Date | undefined {
  const schedule = CronExpressionParser.parse(expression, {
    currentDate: now,
    tz: "UTC",
  });
  const previous = schedule.prev().toDate();
  return now.getTime() - previous.getTime() <= SCHEDULER_TICK_MILLISECONDS
    ? previous
    : undefined;
}

function outputsFromTrace(
  trace: readonly WorkflowTraceEntry[],
): Readonly<Record<string, unknown>> {
  return Object.fromEntries(
    trace
      .filter(
        (entry) => entry.status === "completed" && entry.output !== undefined,
      )
      .map((entry) => [entry.stepId, entry.output]),
  );
}

function waitForTick(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timeout = setTimeout(done, SCHEDULER_TICK_MILLISECONDS);
    timeout.unref();
    signal.addEventListener("abort", done, { once: true });
    function done(): void {
      clearTimeout(timeout);
      signal.removeEventListener("abort", done);
      resolve();
    }
  });
}
