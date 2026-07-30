import { randomUUID } from "node:crypto";

import { evaluateCondition } from "./condition.js";
import type {
  WorkflowAction,
  WorkflowDefinition,
  WorkflowStep,
} from "./schema.js";
import { parseDurationSeconds } from "./schema.js";
import { resolveTemplate } from "./template.js";
import type {
  TriggerContext,
  WorkflowRunResult,
  WorkflowTraceEntry,
} from "./types.js";
import { callWorkflowWebhook } from "./webhook.js";

export type WorkflowActionContext = {
  readonly communityId: string;
  readonly workflowId: string;
  readonly runId: string;
  readonly ownerPubkey: string;
  readonly workflowChannelId?: string;
  readonly signal: AbortSignal;
};

export type WorkflowActionSink = {
  sendMessage(
    input: WorkflowActionContext & {
      readonly channelId: string;
      readonly text: string;
    },
  ): Promise<{ readonly eventId: string }>;
  sendDm(
    input: WorkflowActionContext & {
      readonly recipientPubkey: string;
      readonly text: string;
    },
  ): Promise<{ readonly eventId: string; readonly channelId?: string }>;
  setChannelTopic(
    input: WorkflowActionContext & {
      readonly channelId: string;
      readonly topic: string;
    },
  ): Promise<{ readonly eventId?: string }>;
  addReaction(
    input: WorkflowActionContext & {
      readonly eventId: string;
      readonly emoji: string;
    },
  ): Promise<{ readonly eventId: string }>;
};

export type ExecuteWorkflowInput = {
  readonly definition: WorkflowDefinition;
  readonly trigger: TriggerContext;
  readonly communityId: string;
  readonly workflowId: string;
  readonly ownerPubkey: string;
  readonly workflowChannelId?: string;
  readonly runId?: string;
  readonly startAt?: number;
  readonly priorOutputs?: Readonly<Record<string, unknown>>;
  readonly priorTrace?: readonly WorkflowTraceEntry[];
};

export class WorkflowEngine {
  #activeRuns = 0;
  readonly #maxConcurrent: number;
  readonly #defaultTimeoutSeconds: number;

  public constructor(
    private readonly sink: WorkflowActionSink,
    options: {
      readonly maxConcurrent?: number;
      readonly defaultTimeoutSeconds?: number;
    } = {},
  ) {
    this.#maxConcurrent = positiveOption(
      options.maxConcurrent ?? 100,
      "maxConcurrent",
      10_000,
    );
    this.#defaultTimeoutSeconds = positiveOption(
      options.defaultTimeoutSeconds ?? 300,
      "defaultTimeoutSeconds",
      86_400,
    );
  }

  public activeRuns(): number {
    return this.#activeRuns;
  }

  public async execute(
    input: ExecuteWorkflowInput,
  ): Promise<WorkflowRunResult> {
    if (this.#activeRuns >= this.#maxConcurrent) {
      throw new WorkflowCapacityError(
        `workflow capacity exceeded (${this.#maxConcurrent})`,
      );
    }
    this.#activeRuns += 1;
    try {
      return await this.#execute(input);
    } finally {
      this.#activeRuns -= 1;
    }
  }

  async #execute(input: ExecuteWorkflowInput): Promise<WorkflowRunResult> {
    const runId = input.runId ?? randomUUID();
    const startAt = input.startAt ?? 0;
    if (
      !Number.isSafeInteger(startAt) ||
      startAt < 0 ||
      startAt > input.definition.steps.length
    ) {
      throw new RangeError("workflow start step is out of range");
    }
    const outputs: Record<string, unknown> = { ...input.priorOutputs };
    const trace: WorkflowTraceEntry[] = [...(input.priorTrace ?? [])];
    for (
      let index = startAt;
      index < input.definition.steps.length;
      index += 1
    ) {
      const step = input.definition.steps[index] as WorkflowStep;
      const startedAt = new Date().toISOString();
      if (
        step.if !== undefined &&
        !evaluateCondition(step.if, input.trigger, outputs)
      ) {
        trace.push({
          completedAt: new Date().toISOString(),
          startedAt,
          status: "skipped",
          stepId: step.id,
          stepIndex: index,
        });
        continue;
      }
      try {
        const timeoutSeconds = step.timeout_secs ?? this.#defaultTimeoutSeconds;
        const output = await withTimeout(
          (signal) =>
            this.#dispatch(
              resolveActionTemplates(step, input.trigger, outputs),
              input,
              runId,
              signal,
            ),
          timeoutSeconds * 1_000,
        );
        if (output.type === "approval") {
          trace.push({
            completedAt: new Date().toISOString(),
            output: { approvalToken: output.token },
            startedAt,
            status: "waiting_approval",
            stepId: step.id,
            stepIndex: index,
          });
          return {
            approval: {
              approver: output.approver,
              expiresAt: output.expiresAt,
              message: output.message,
              stepId: step.id,
              token: output.token,
            },
            currentStep: index,
            outputs,
            status: "waiting_approval",
            trace,
          };
        }
        outputs[step.id] = output.value;
        trace.push({
          completedAt: new Date().toISOString(),
          output: output.value,
          startedAt,
          status: "completed",
          stepId: step.id,
          stepIndex: index,
        });
      } catch (error) {
        const message = safeWorkflowError(error);
        trace.push({
          completedAt: new Date().toISOString(),
          error: message,
          startedAt,
          status: "failed",
          stepId: step.id,
          stepIndex: index,
        });
        return {
          currentStep: index,
          error: message,
          outputs,
          status: "failed",
          trace,
        };
      }
    }
    return {
      currentStep: input.definition.steps.length,
      outputs,
      status: "completed",
      trace,
    };
  }

  async #dispatch(
    action: WorkflowAction,
    input: ExecuteWorkflowInput,
    runId: string,
    signal: AbortSignal,
  ): Promise<
    | { readonly type: "completed"; readonly value: unknown }
    | {
        readonly type: "approval";
        readonly token: string;
        readonly approver: string;
        readonly message: string;
        readonly expiresAt: string;
      }
  > {
    const context: WorkflowActionContext = {
      communityId: input.communityId,
      ownerPubkey: input.ownerPubkey,
      runId,
      signal,
      workflowId: input.workflowId,
      ...(input.workflowChannelId
        ? { workflowChannelId: input.workflowChannelId }
        : {}),
    };
    switch (action.action) {
      case "send_message": {
        const channelId = resolveMessageChannel(
          action.channel,
          input.workflowChannelId,
          input.trigger.channelId,
        );
        const result = await this.sink.sendMessage({
          ...context,
          channelId,
          text: action.text,
        });
        return { type: "completed", value: { sent: true, ...result } };
      }
      case "send_dm": {
        if (!/^[0-9a-f]{64}$/.test(action.to)) {
          throw new WorkflowExecutionError(
            "send_dm recipient must resolve to a lowercase Nostr pubkey",
          );
        }
        const result = await this.sink.sendDm({
          ...context,
          recipientPubkey: action.to,
          text: action.text,
        });
        return { type: "completed", value: { sent: true, ...result } };
      }
      case "set_channel_topic": {
        const channelId = input.workflowChannelId || input.trigger.channelId;
        if (!channelId) {
          throw new WorkflowExecutionError(
            "set_channel_topic requires a channel context",
          );
        }
        const result = await this.sink.setChannelTopic({
          ...context,
          channelId,
          topic: action.topic,
        });
        return { type: "completed", value: { updated: true, ...result } };
      }
      case "add_reaction": {
        if (!/^[0-9a-f]{64}$/.test(input.trigger.messageId)) {
          throw new WorkflowExecutionError(
            "add_reaction requires a triggering event ID",
          );
        }
        const result = await this.sink.addReaction({
          ...context,
          emoji: action.emoji,
          eventId: input.trigger.messageId,
        });
        return { type: "completed", value: { added: true, ...result } };
      }
      case "call_webhook": {
        const result = await callWorkflowWebhook({
          ...(action.body !== undefined ? { body: action.body } : {}),
          ...(action.headers !== undefined ? { headers: action.headers } : {}),
          ...(action.method !== undefined ? { method: action.method } : {}),
          timeoutMilliseconds: 30_000,
          url: action.url,
        });
        if (result.status < 200 || result.status >= 300) {
          throw new WorkflowExecutionError(
            `webhook returned HTTP ${result.status}`,
          );
        }
        return {
          type: "completed",
          value: {
            body: result.body,
            contentType: result.contentType,
            status: result.status,
          },
        };
      }
      case "request_approval": {
        const seconds = parseDurationSeconds(action.timeout ?? "24h");
        const expiresAt = new Date(Date.now() + seconds * 1_000).toISOString();
        return {
          approver: action.from,
          expiresAt,
          message: action.message,
          token: randomUUID(),
          type: "approval",
        };
      }
      case "delay": {
        const seconds = parseDurationSeconds(action.duration);
        await abortableDelay(seconds * 1_000, signal);
        return {
          type: "completed",
          value: { sleptSeconds: seconds },
        };
      }
    }
  }
}

function resolveActionTemplates(
  step: WorkflowStep,
  trigger: TriggerContext,
  outputs: Readonly<Record<string, unknown>>,
): WorkflowAction {
  const resolve = (value: string): string =>
    resolveTemplate(value, trigger, outputs);
  switch (step.action) {
    case "send_message":
      return {
        action: step.action,
        ...(step.channel ? { channel: resolve(step.channel) } : {}),
        text: resolve(step.text),
      };
    case "send_dm":
      return {
        action: step.action,
        text: resolve(step.text),
        to: resolve(step.to),
      };
    case "set_channel_topic":
      return { action: step.action, topic: resolve(step.topic) };
    case "add_reaction":
      return { action: step.action, emoji: resolve(step.emoji) };
    case "call_webhook": {
      const headers = step.headers
        ? Object.fromEntries(
            Object.entries(step.headers).map(([key, value]) => [
              key,
              resolve(value),
            ]),
          )
        : undefined;
      return {
        action: step.action,
        ...(step.body !== undefined ? { body: resolve(step.body) } : {}),
        ...(headers !== undefined ? { headers } : {}),
        ...(step.method !== undefined ? { method: step.method } : {}),
        url: resolve(step.url),
      };
    }
    case "request_approval":
      return {
        action: step.action,
        from: resolve(step.from),
        message: resolve(step.message),
        ...(step.timeout !== undefined ? { timeout: step.timeout } : {}),
      };
    case "delay":
      return { action: step.action, duration: step.duration };
  }
}

function resolveMessageChannel(
  override: string | undefined,
  workflowChannel: string | undefined,
  triggerChannel: string,
): string {
  if (workflowChannel && override && override !== workflowChannel) {
    throw new WorkflowExecutionError(
      "send_message channel override must match the workflow channel",
    );
  }
  const channel = workflowChannel ?? override ?? triggerChannel;
  if (!channel) {
    throw new WorkflowExecutionError("send_message requires a channel context");
  }
  return channel;
}

async function withTimeout<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  milliseconds: number,
): Promise<T> {
  const controller = new AbortController();
  return new Promise<T>((resolve, reject) => {
    const timeout = setTimeout(() => {
      controller.abort();
      reject(new WorkflowExecutionError("workflow step timed out"));
    }, milliseconds);
    void operation(controller.signal).then(
      (value) => {
        clearTimeout(timeout);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timeout);
        reject(error);
      },
    );
  });
}

function abortableDelay(
  milliseconds: number,
  signal: AbortSignal,
): Promise<void> {
  if (signal.aborted) {
    return Promise.reject(new WorkflowExecutionError("workflow step aborted"));
  }
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(done, milliseconds);
    signal.addEventListener("abort", aborted, { once: true });
    function done(): void {
      signal.removeEventListener("abort", aborted);
      resolve();
    }
    function aborted(): void {
      clearTimeout(timeout);
      reject(new WorkflowExecutionError("workflow step aborted"));
    }
  });
}

function positiveOption(value: number, name: string, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new RangeError(`${name} must be between 1 and ${maximum}`);
  }
  return value;
}

function safeWorkflowError(error: unknown): string {
  const message =
    error instanceof Error ? error.message : "workflow step failed";
  return message.slice(0, 2_048).replaceAll(/[\r\n\t]/g, " ");
}

export class WorkflowExecutionError extends Error {
  public override readonly name = "WorkflowExecutionError";
}

export class WorkflowCapacityError extends Error {
  public override readonly name = "WorkflowCapacityError";
}
