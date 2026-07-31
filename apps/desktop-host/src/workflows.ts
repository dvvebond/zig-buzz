import { randomUUID } from "node:crypto";

import {
  buildWorkflowApproval,
  buildWorkflowDefinition,
  buildWorkflowDelete,
  buildWorkflowTrigger,
  type EventTemplate,
} from "@buzz/sdk";
import { parseWorkflowYaml } from "@buzz/workflow";
import type { Event } from "nostr-tools";

import type { IdentityService } from "./identity.js";
import type { RelayHttpClient } from "./relay-http.js";

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export class WorkflowService {
  readonly #identity: IdentityService;
  readonly #relay: RelayHttpClient;

  constructor(identity: IdentityService, relay: RelayHttpClient) {
    this.#identity = identity;
    this.#relay = relay;
  }

  async forChannel(
    channelIdValue: unknown,
  ): Promise<Array<Record<string, unknown>>> {
    const channelId = requireUuid(channelIdValue, "channelId");
    const events = await this.#relay.query([
      { "#h": [channelId], kinds: [30_620] },
    ]);
    return latestDefinitions(events).map((event) => workflowFromEvent(event));
  }

  async forChannels(
    channelIdsValue: unknown,
  ): Promise<Array<Record<string, unknown>>> {
    if (!Array.isArray(channelIdsValue) || channelIdsValue.length > 500) {
      throw new Error("channelIds must contain at most 500 UUIDs");
    }
    if (channelIdsValue.length === 0) return [];
    const channelIds = channelIdsValue.map((value) =>
      requireUuid(value, "channelId"),
    );
    const events = await this.#relay.query([
      { "#h": channelIds, kinds: [30_620] },
    ]);
    return latestDefinitions(events).map((event) => workflowFromEvent(event));
  }

  async get(workflowIdValue: unknown): Promise<Record<string, unknown>> {
    const workflowId = requireUuid(workflowIdValue, "workflowId");
    const events = await this.#relay.query([
      { "#d": [workflowId], kinds: [30_620] },
    ]);
    const event = latestDefinitions(events)[0];
    if (!event) throw new Error("workflow not found");
    return workflowFromEvent(event);
  }

  async create(
    channelIdValue: unknown,
    yamlValue: unknown,
  ): Promise<Record<string, unknown>> {
    const channelId = requireUuid(channelIdValue, "channelId");
    const yaml = requireYaml(yamlValue);
    const workflowId = randomUUID();
    const { event, message } = await this.#publishWithAcknowledgement(
      buildWorkflowDefinition({ channelId, workflowId, yaml }),
    );
    return {
      ...workflowFromEvent(event),
      webhook_secret: webhookSecretFromResponse(message),
    };
  }

  async update(
    workflowIdValue: unknown,
    yamlValue: unknown,
  ): Promise<Record<string, unknown>> {
    const prior = await this.get(workflowIdValue);
    const channelId = requireUuid(prior.channel_id, "channelId");
    const workflowId = requireUuid(workflowIdValue, "workflowId");
    const event = await this.#publish(
      buildWorkflowDefinition({
        channelId,
        workflowId,
        yaml: requireYaml(yamlValue),
      }),
    );
    return {
      ...workflowFromEvent(event, prior.created_at as number),
      webhook_secret: null,
    };
  }

  async remove(workflowIdValue: unknown): Promise<void> {
    const workflowId = requireUuid(workflowIdValue, "workflowId");
    await this.get(workflowId);
    await this.#publish(
      buildWorkflowDelete(this.#identity.info().pubkey, workflowId),
    );
  }

  async trigger(workflowIdValue: unknown): Promise<Record<string, unknown>> {
    const workflowId = requireUuid(workflowIdValue, "workflowId");
    await this.get(workflowId);
    const event = await this.#publish(buildWorkflowTrigger(workflowId));
    return {
      run_id: event.id,
      status: "submitted",
      workflow_id: workflowId,
    };
  }

  async approval(
    granted: boolean,
    tokenValue: unknown,
    noteValue: unknown,
  ): Promise<Record<string, unknown>> {
    const token = requireUuid(tokenValue, "token");
    const note =
      noteValue === undefined || noteValue === null
        ? ""
        : requireText(noteValue, "note", 8_192);
    const event = await this.#publish(
      buildWorkflowApproval(token, granted, note),
    );
    return {
      run_id: event.id,
      status: granted ? "granted" : "denied",
      token,
      workflow_id: "",
    };
  }

  runs(): [] {
    return [];
  }

  approvals(): [] {
    return [];
  }

  async #publish(template: EventTemplate): Promise<Event> {
    return (await this.#publishWithAcknowledgement(template)).event;
  }

  async #publishWithAcknowledgement(
    template: EventTemplate,
  ): Promise<{ readonly event: Event; readonly message: string }> {
    const event = this.#identity.sign(
      template as unknown as Record<string, unknown>,
    );
    const acknowledgement = await this.#relay.publish(event);
    return { event, message: acknowledgement.message };
  }
}

function webhookSecretFromResponse(message: string): string | null {
  if (!message.startsWith("response:")) return null;
  let value: unknown;
  try {
    value = JSON.parse(message.slice("response:".length));
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const secret = (value as Record<string, unknown>).webhook_secret;
  return typeof secret === "string" &&
    secret.length > 0 &&
    Buffer.byteLength(secret, "utf8") <= 256
    ? secret
    : null;
}

function workflowFromEvent(
  event: Event,
  createdAt = event.created_at,
): Record<string, unknown> {
  const id = exactTag(event, "d") ?? "";
  let definition: Record<string, unknown> = {};
  try {
    definition = parseWorkflowYaml(event.content)
      .definition as unknown as Record<string, unknown>;
  } catch {
    // Keep malformed legacy definitions isolated to their own record.
  }
  return {
    channel_id: exactTag(event, "h"),
    created_at: createdAt,
    definition,
    id,
    name:
      typeof definition.name === "string" && definition.name.trim()
        ? definition.name
        : id,
    owner_pubkey: event.pubkey,
    status: "active",
    updated_at: event.created_at,
  };
}

function latestDefinitions(events: Event[]): Event[] {
  const latest = new Map<string, Event>();
  for (const event of events) {
    const id = exactTag(event, "d");
    if (!id || !UUID.test(id)) continue;
    const coordinate = `${event.pubkey}:${id}`;
    const prior = latest.get(coordinate);
    if (
      !prior ||
      event.created_at > prior.created_at ||
      (event.created_at === prior.created_at && event.id > prior.id)
    ) {
      latest.set(coordinate, event);
    }
  }
  return [...latest.values()].sort(
    (left, right) =>
      right.created_at - left.created_at || right.id.localeCompare(left.id),
  );
}

function exactTag(event: Event, name: string): string | null {
  return event.tags.find((tag) => tag[0] === name)?.[1] ?? null;
}

function requireYaml(value: unknown): string {
  const yaml = requireText(value, "yamlDefinition", 256 * 1024);
  parseWorkflowYaml(yaml);
  return yaml;
}

function requireUuid(value: unknown, name: string): string {
  if (typeof value !== "string" || !UUID.test(value)) {
    throw new Error(`${name} must be a UUID`);
  }
  return value.toLowerCase();
}

function requireText(value: unknown, name: string, maxBytes: number): string {
  if (typeof value !== "string") throw new Error(`${name} must be a string`);
  if (Buffer.byteLength(value, "utf8") > maxBytes) {
    throw new Error(`${name} exceeds its size limit`);
  }
  return value;
}
