import { CronExpressionParser } from "cron-parser";
import { parse as parseYamlDocument } from "yaml";

export type WorkflowTrigger =
  | { readonly on: "message_posted"; readonly filter?: string }
  | { readonly on: "reaction_added"; readonly emoji?: string }
  | { readonly on: "diff_posted"; readonly filter?: string }
  | {
      readonly on: "schedule";
      readonly cron?: string;
      readonly interval?: string;
    }
  | { readonly on: "webhook" };

export type WorkflowAction =
  | {
      readonly action: "send_message";
      readonly text: string;
      readonly channel?: string;
    }
  | {
      readonly action: "send_dm";
      readonly to: string;
      readonly text: string;
    }
  | { readonly action: "set_channel_topic"; readonly topic: string }
  | { readonly action: "add_reaction"; readonly emoji: string }
  | {
      readonly action: "call_webhook";
      readonly url: string;
      readonly method?: string;
      readonly headers?: Readonly<Record<string, string>>;
      readonly body?: string;
    }
  | {
      readonly action: "request_approval";
      readonly from: string;
      readonly message: string;
      readonly timeout?: string;
    }
  | { readonly action: "delay"; readonly duration: string };

export type WorkflowStep = WorkflowAction & {
  readonly id: string;
  readonly name?: string;
  readonly if?: string;
  readonly timeout_secs?: number;
};

export type WorkflowDefinition = {
  readonly name: string;
  readonly description?: string;
  readonly trigger: WorkflowTrigger;
  readonly steps: readonly WorkflowStep[];
  readonly enabled: boolean;
};

const TRIGGERS = new Set([
  "message_posted",
  "reaction_added",
  "diff_posted",
  "schedule",
  "webhook",
]);
const ACTIONS = new Set([
  "send_message",
  "send_dm",
  "set_channel_topic",
  "add_reaction",
  "call_webhook",
  "request_approval",
  "delay",
]);
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function parseWorkflowYaml(source: string): {
  readonly definition: WorkflowDefinition;
  readonly canonicalJson: string;
} {
  if (Buffer.byteLength(source, "utf8") > 256 * 1024) {
    throw new WorkflowDefinitionError("workflow YAML exceeds 256 KiB");
  }
  let value: unknown;
  try {
    value = parseYamlDocument(source, {
      maxAliasCount: 20,
      merge: false,
      prettyErrors: false,
      uniqueKeys: true,
    }) as unknown;
  } catch (error) {
    throw new WorkflowDefinitionError(
      `invalid YAML: ${error instanceof Error ? error.message : "parse failed"}`,
    );
  }
  const definition = validateWorkflowDefinition(value);
  return {
    canonicalJson: JSON.stringify(definition),
    definition,
  };
}

export function validateWorkflowDefinition(value: unknown): WorkflowDefinition {
  const object = requiredObject(value, "workflow");
  const name = requiredString(object.name, "name", 255);
  const description = optionalString(object.description, "description", 8_192);
  const enabled =
    object.enabled === undefined
      ? true
      : requiredBoolean(object.enabled, "enabled");
  const trigger = validateTrigger(object.trigger);
  if (!Array.isArray(object.steps) || object.steps.length < 1) {
    throw new WorkflowDefinitionError("at least one step is required");
  }
  if (object.steps.length > 256) {
    throw new WorkflowDefinitionError("workflow exceeds 256 steps");
  }
  const seen = new Set<string>();
  const steps = object.steps.map((step, index) => {
    const parsed = validateStep(step, index);
    if (seen.has(parsed.id)) {
      throw new WorkflowDefinitionError(`duplicate step id: ${parsed.id}`);
    }
    seen.add(parsed.id);
    return parsed;
  });
  return {
    ...(description !== undefined ? { description } : {}),
    enabled,
    name,
    steps,
    trigger,
  };
}

export function workflowRequiresElevatedAuthority(
  definition: WorkflowDefinition,
): boolean {
  return definition.steps.some((step) => step.action === "call_webhook");
}

export function parseDurationSeconds(value: string): number {
  const match = /^([0-9]+)\s*([hms]?)$/.exec(value.trim());
  if (!match?.[1])
    throw new WorkflowDefinitionError(`invalid duration: ${value}`);
  const amount = Number(match[1]);
  const factor = match[2] === "h" ? 3_600 : match[2] === "m" ? 60 : 1;
  const seconds = amount * factor;
  if (!Number.isSafeInteger(seconds)) {
    throw new WorkflowDefinitionError(`duration overflow: ${value}`);
  }
  return seconds;
}

function validateTrigger(value: unknown): WorkflowTrigger {
  const object = requiredObject(value, "trigger");
  const on = requiredString(object.on, "trigger.on", 64);
  if (!TRIGGERS.has(on)) {
    throw new WorkflowDefinitionError(`unknown trigger: ${on}`);
  }
  if (on === "message_posted" || on === "diff_posted") {
    const filter = optionalString(object.filter, "trigger.filter", 4_096, true);
    return {
      ...(filter !== undefined ? { filter } : {}),
      on,
    };
  }
  if (on === "reaction_added") {
    const emoji = optionalString(object.emoji, "trigger.emoji", 256, true);
    return {
      ...(emoji !== undefined ? { emoji } : {}),
      on,
    };
  }
  if (on === "schedule") {
    const cron = optionalString(object.cron, "trigger.cron", 512);
    const interval = optionalString(object.interval, "trigger.interval", 64);
    if ((cron === undefined) === (interval === undefined)) {
      throw new WorkflowDefinitionError(
        "schedule trigger requires exactly one of cron or interval",
      );
    }
    if (cron !== undefined) {
      try {
        CronExpressionParser.parse(cron, { tz: "UTC" });
      } catch (error) {
        throw new WorkflowDefinitionError(
          `invalid cron expression: ${error instanceof Error ? error.message : "parse failed"}`,
        );
      }
    }
    if (interval !== undefined && parseDurationSeconds(interval) < 60) {
      throw new WorkflowDefinitionError(
        "schedule interval must be at least 60s",
      );
    }
    return {
      ...(cron !== undefined ? { cron } : {}),
      ...(interval !== undefined ? { interval } : {}),
      on,
    };
  }
  return { on: "webhook" };
}

function validateStep(value: unknown, index: number): WorkflowStep {
  const object = requiredObject(value, `steps[${index}]`);
  const id = requiredString(object.id, `steps[${index}].id`, 64);
  if (!/^[A-Za-z0-9_]+$/.test(id)) {
    throw new WorkflowDefinitionError(
      `step id '${id}' must contain only ASCII letters, digits, and underscores`,
    );
  }
  const name = optionalString(object.name, `steps[${index}].name`, 255);
  const condition = optionalString(object.if, `steps[${index}].if`, 4_096);
  const timeout =
    object.timeout_secs === undefined
      ? undefined
      : positiveInteger(
          object.timeout_secs,
          `steps[${index}].timeout_secs`,
          86_400,
        );
  const action = requiredString(object.action, `steps[${index}].action`, 64);
  if (!ACTIONS.has(action)) {
    throw new WorkflowDefinitionError(`unknown action: ${action}`);
  }
  const common = {
    id,
    ...(name !== undefined ? { name } : {}),
    ...(condition !== undefined ? { if: condition } : {}),
    ...(timeout !== undefined ? { timeout_secs: timeout } : {}),
  };
  switch (action) {
    case "send_message": {
      const channel = optionalString(object.channel, "channel", 64);
      if (channel !== undefined && !UUID.test(channel)) {
        throw new WorkflowDefinitionError(
          "send_message channel must be a UUID",
        );
      }
      return {
        ...common,
        action,
        ...(channel !== undefined ? { channel } : {}),
        text: requiredString(object.text, "text", 64 * 1024, true),
      };
    }
    case "send_dm":
      return {
        ...common,
        action,
        text: requiredString(object.text, "text", 64 * 1024, true),
        to: requiredString(object.to, "to", 1_024),
      };
    case "set_channel_topic":
      return {
        ...common,
        action,
        topic: requiredString(object.topic, "topic", 8_192, true),
      };
    case "add_reaction":
      return {
        ...common,
        action,
        emoji: requiredString(object.emoji, "emoji", 256),
      };
    case "call_webhook": {
      const method = optionalString(object.method, "method", 16);
      if (
        method !== undefined &&
        !["POST", "PUT", "PATCH"].includes(method.toUpperCase())
      ) {
        throw new WorkflowDefinitionError(
          "webhook method must be POST, PUT, or PATCH",
        );
      }
      const headers = optionalHeaders(object.headers);
      const body = optionalString(object.body, "body", 256 * 1024, true);
      return {
        ...common,
        action,
        ...(body !== undefined ? { body } : {}),
        ...(headers !== undefined ? { headers } : {}),
        ...(method !== undefined ? { method: method.toUpperCase() } : {}),
        url: requiredString(object.url, "url", 4_096),
      };
    }
    case "request_approval": {
      const approvalTimeout = optionalString(object.timeout, "timeout", 64);
      if (
        approvalTimeout !== undefined &&
        parseDurationSeconds(approvalTimeout) < 1
      ) {
        throw new WorkflowDefinitionError("approval timeout must be positive");
      }
      return {
        ...common,
        action,
        from: requiredString(object.from, "from", 1_024),
        message: requiredString(object.message, "message", 8_192, true),
        ...(approvalTimeout !== undefined ? { timeout: approvalTimeout } : {}),
      };
    }
    case "delay": {
      const duration = requiredString(object.duration, "duration", 64);
      const seconds = parseDurationSeconds(duration);
      if (seconds > 270) {
        throw new WorkflowDefinitionError(
          "delay exceeds 270 seconds; use a schedule for longer waits",
        );
      }
      return { ...common, action, duration };
    }
  }
  throw new WorkflowDefinitionError("unreachable workflow action");
}

function optionalHeaders(
  value: unknown,
): Readonly<Record<string, string>> | undefined {
  if (value === undefined) return undefined;
  const object = requiredObject(value, "headers");
  const entries = Object.entries(object);
  if (entries.length > 64) {
    throw new WorkflowDefinitionError("webhook exceeds 64 headers");
  }
  const result: Record<string, string> = {};
  for (const [name, raw] of entries) {
    if (
      !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name) ||
      ["host", "content-length", "connection", "transfer-encoding"].includes(
        name.toLowerCase(),
      )
    ) {
      throw new WorkflowDefinitionError(`webhook header is forbidden: ${name}`);
    }
    result[name] = requiredString(raw, `header ${name}`, 8_192, true);
  }
  return result;
}

function requiredObject(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new WorkflowDefinitionError(`${name} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requiredString(
  value: unknown,
  name: string,
  maxBytes: number,
  allowEmpty = false,
): string {
  if (
    typeof value !== "string" ||
    (!allowEmpty && value.trim().length === 0) ||
    Buffer.byteLength(value, "utf8") > maxBytes
  ) {
    throw new WorkflowDefinitionError(`${name} must be a valid string`);
  }
  return value;
}

function optionalString(
  value: unknown,
  name: string,
  maxBytes: number,
  allowEmpty = false,
): string | undefined {
  return value === undefined
    ? undefined
    : requiredString(value, name, maxBytes, allowEmpty);
}

function requiredBoolean(value: unknown, name: string): boolean {
  if (typeof value !== "boolean") {
    throw new WorkflowDefinitionError(`${name} must be boolean`);
  }
  return value;
}

function positiveInteger(
  value: unknown,
  name: string,
  maximum: number,
): number {
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < 1 ||
    (value as number) > maximum
  ) {
    throw new WorkflowDefinitionError(
      `${name} must be an integer between 1 and ${maximum}`,
    );
  }
  return value as number;
}

export class WorkflowDefinitionError extends Error {
  public override readonly name = "WorkflowDefinitionError";
}
