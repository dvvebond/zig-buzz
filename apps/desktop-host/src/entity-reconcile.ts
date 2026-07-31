import {
  KIND_MANAGED_AGENT,
  KIND_PERSONA,
  KIND_TEAM,
  type NostrEvent,
} from "@buzz/core";
import { verifyEvent } from "nostr-tools";

import type { DesktopEventBus } from "./event-bus.js";
import type { IdentityService } from "./identity.js";
import type { LocalEntityService } from "./local-entities.js";
import type { ManagedAgentService } from "./managed-agents.js";

const KIND_DELETION = 5;
const D_TAG = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const PUBKEY = /^[0-9a-f]{64}$/;
const HEADS_KEY = "entity-reconcile-heads.v1";

type Head = { createdAt: number; eventId: string };

export class EntityReconcileService {
  readonly #events: DesktopEventBus;
  readonly #identity: IdentityService;
  readonly #local: LocalEntityService;
  readonly #managed: ManagedAgentService;
  #queue: Promise<void> = Promise.resolve();

  constructor(input: {
    events: DesktopEventBus;
    identity: IdentityService;
    localEntities: LocalEntityService;
    managedAgents: ManagedAgentService;
  }) {
    this.#events = input.events;
    this.#identity = input.identity;
    this.#local = input.localEntities;
    this.#managed = input.managedAgents;
  }

  async reconcile(eventJson: unknown): Promise<void> {
    if (
      typeof eventJson !== "string" ||
      Buffer.byteLength(eventJson, "utf8") > 512 * 1024
    ) {
      throw new Error("inbound entity event must be bounded JSON text");
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(eventJson) as unknown;
    } catch {
      throw new Error("failed to parse inbound entity event");
    }
    if (!isEvent(parsed) || !verifyEvent(parsed)) {
      throw new Error("inbound entity event failed signature verification");
    }
    if (parsed.pubkey !== this.#identity.info().pubkey) {
      throw new Error("inbound entity event is not owned by this identity");
    }
    const operation = this.#queue.then(() => this.#apply(parsed));
    this.#queue = operation.catch(() => undefined);
    await operation;
  }

  async #apply(event: NostrEvent): Promise<void> {
    if (event.kind === KIND_DELETION) {
      await this.#applyDeletion(event);
      return;
    }
    if (
      event.kind !== KIND_PERSONA &&
      event.kind !== KIND_TEAM &&
      event.kind !== KIND_MANAGED_AGENT
    ) {
      return;
    }
    const dTag = requireDTag(event);
    const coordinate = `${event.kind}:${dTag}`;
    if (!this.#wins(coordinate, event)) return;
    const eventTime = new Date(event.created_at * 1_000).toISOString();
    if (event.kind === KIND_PERSONA) {
      await this.#local.applyInboundPersona(
        dTag,
        parsePersona(event.content),
        eventTime,
      );
    } else if (event.kind === KIND_TEAM) {
      await this.#local.applyInboundTeam(
        dTag,
        parseTeam(event.content),
        eventTime,
      );
    } else {
      if (!PUBKEY.test(dTag)) {
        throw new Error("managed-agent event d-tag must be a pubkey");
      }
      await this.#managed.applyInboundProjection(
        dTag,
        parseManagedAgent(event.content),
      );
    }
    await this.#recordHead(coordinate, event);
    this.#events.emit("agents-data-changed", {});
  }

  async #applyDeletion(event: NostrEvent): Promise<void> {
    const target = parseDeletion(event);
    if (!target) return;
    const coordinate = `${target.kind}:${target.dTag}`;
    if (!this.#wins(coordinate, event)) return;
    if (target.kind === KIND_MANAGED_AGENT) {
      if (!PUBKEY.test(target.dTag)) return;
      await this.#managed.removeInbound(target.dTag);
    } else {
      await this.#local.removeInbound(target.kind, target.dTag);
    }
    await this.#recordHead(coordinate, event);
    this.#events.emit("agents-data-changed", {});
  }

  #wins(coordinate: string, event: NostrEvent): boolean {
    const current = this.#heads()[coordinate];
    if (!current) {
      const localCreatedAt = this.#localUpdatedAt(coordinate);
      return localCreatedAt === undefined || event.created_at > localCreatedAt;
    }
    return (
      event.created_at > current.createdAt ||
      (event.created_at === current.createdAt && event.id < current.eventId)
    );
  }

  #localUpdatedAt(coordinate: string): number | undefined {
    const separator = coordinate.indexOf(":");
    const kind = Number(coordinate.slice(0, separator));
    const dTag = coordinate.slice(separator + 1);
    let value: unknown;
    if (kind === KIND_PERSONA) {
      value = this.#local
        .personas()
        .find((item) => item.id === dTag)?.updated_at;
    } else if (kind === KIND_TEAM) {
      value = this.#local.teams().find((item) => item.id === dTag)?.updated_at;
    } else if (kind === KIND_MANAGED_AGENT) {
      value = this.#managed
        .list()
        .find((item) => item.pubkey === dTag)?.updated_at;
    }
    if (typeof value !== "string") return undefined;
    const milliseconds = Date.parse(value);
    return Number.isFinite(milliseconds)
      ? Math.floor(milliseconds / 1_000)
      : undefined;
  }

  #heads(): Record<string, Head> {
    const raw = this.#identity.setting<unknown>(HEADS_KEY, {});
    if (!isRecord(raw)) return {};
    const output: Record<string, Head> = {};
    for (const [key, value] of Object.entries(raw)) {
      if (
        isRecord(value) &&
        typeof value.createdAt === "number" &&
        Number.isSafeInteger(value.createdAt) &&
        typeof value.eventId === "string" &&
        /^[0-9a-f]{64}$/.test(value.eventId)
      ) {
        output[key] = {
          createdAt: value.createdAt,
          eventId: value.eventId,
        };
      }
    }
    return output;
  }

  async #recordHead(coordinate: string, event: NostrEvent): Promise<void> {
    const heads = this.#heads();
    heads[coordinate] = {
      createdAt: event.created_at,
      eventId: event.id,
    };
    await this.#identity.setSetting(HEADS_KEY, heads);
  }
}

function parsePersona(content: string): {
  avatarUrl: string | null;
  displayName: string;
  model: string | null;
  namePool: string[];
  parallelism: number | null;
  provider: string | null;
  respondTo: string | null;
  respondToAllowlist: string[];
  runtime: string | null;
  systemPrompt: string;
} {
  const input = parseContent(content, "persona");
  return {
    avatarUrl: optionalUrl(input.avatar_url),
    displayName: boundedText(input.display_name, "display_name", 128, true),
    model: optionalText(input.model, "model", 512),
    namePool: textArray(input.name_pool, "name_pool", 100, 128),
    parallelism: optionalInteger(input.parallelism, "parallelism", 1, 128),
    provider: optionalText(input.provider, "provider", 128),
    respondTo:
      input.respond_to === undefined || input.respond_to === null
        ? null
        : enumText(input.respond_to, "respond_to", [
            "all",
            "mentions",
            "mentions-and-allowlist",
            "owner-only",
          ]),
    respondToAllowlist: pubkeys(input.respond_to_allowlist),
    runtime: optionalText(input.runtime, "runtime", 128),
    systemPrompt:
      input.system_prompt === undefined || input.system_prompt === null
        ? ""
        : boundedText(input.system_prompt, "system_prompt", 256 * 1024, false),
  };
}

function parseTeam(content: string): {
  description: string | null;
  instructions: string | null | undefined;
  name: string;
  personaIds: string[] | undefined;
} {
  const input = parseContent(content, "team");
  return {
    description: optionalText(input.description, "description", 4_096),
    instructions:
      input.instructions === undefined
        ? undefined
        : optionalText(input.instructions, "instructions", 256 * 1024),
    name: boundedText(input.name, "name", 128, true),
    personaIds:
      input.persona_ids === undefined
        ? undefined
        : textArray(input.persona_ids, "persona_ids", 500, 128),
  };
}

function parseManagedAgent(content: string): {
  model: string | null | undefined;
  name: string;
  parallelism: number;
  personaId: string | null;
  personaSourceVersion: string | null | undefined;
  provider: string | null | undefined;
  respondTo: "owner-only" | "allowlist" | "anyone";
  respondToAllowlist: string[];
  systemPrompt: string | null | undefined;
} {
  const input = parseContent(content, "managed-agent");
  const personaId = optionalText(input.persona_id, "persona_id", 128);
  return {
    model:
      input.model === undefined
        ? undefined
        : optionalText(input.model, "model", 512),
    name: boundedText(input.name, "name", 128, true),
    parallelism: optionalInteger(input.parallelism, "parallelism", 1, 32) ?? 1,
    personaId,
    personaSourceVersion:
      input.persona_source_version === undefined
        ? undefined
        : optionalText(
            input.persona_source_version,
            "persona_source_version",
            256,
          ),
    provider:
      input.provider === undefined
        ? undefined
        : optionalText(input.provider, "provider", 128),
    respondTo: enumText(input.respond_to, "respond_to", [
      "owner-only",
      "allowlist",
      "anyone",
    ]),
    respondToAllowlist: pubkeys(input.respond_to_allowlist),
    systemPrompt:
      input.system_prompt === undefined
        ? undefined
        : optionalText(input.system_prompt, "system_prompt", 256 * 1024),
  };
}

function parseDeletion(event: NostrEvent):
  | {
      kind: typeof KIND_PERSONA | typeof KIND_TEAM | typeof KIND_MANAGED_AGENT;
      dTag: string;
    }
  | undefined {
  for (const tag of event.tags) {
    if (tag[0] !== "a" || typeof tag[1] !== "string") continue;
    const match = /^(30175|30176|30177):([0-9a-f]{64}):(.+)$/.exec(tag[1]);
    if (!match || match[2] !== event.pubkey || !D_TAG.test(match[3] ?? "")) {
      continue;
    }
    const kind = Number(match[1]);
    if (
      kind === KIND_PERSONA ||
      kind === KIND_TEAM ||
      kind === KIND_MANAGED_AGENT
    ) {
      return { dTag: match[3] as string, kind };
    }
  }
  return undefined;
}

function requireDTag(event: NostrEvent): string {
  const tags = event.tags.filter((tag) => tag[0] === "d");
  if (
    tags.length !== 1 ||
    typeof tags[0]?.[1] !== "string" ||
    tags[0].length !== 2 ||
    !D_TAG.test(tags[0][1])
  ) {
    throw new Error("inbound entity event has an invalid d-tag");
  }
  return tags[0][1];
}

function parseContent(content: string, name: string): Record<string, unknown> {
  if (Buffer.byteLength(content, "utf8") > 256 * 1024) {
    throw new Error(`${name} event content is too large`);
  }
  let value: unknown;
  try {
    value = JSON.parse(content) as unknown;
  } catch {
    throw new Error(`${name} event content is malformed`);
  }
  if (!isRecord(value))
    throw new Error(`${name} event content must be an object`);
  return value;
}

function boundedText(
  value: unknown,
  name: string,
  maxBytes: number,
  nonempty: boolean,
): string {
  if (
    typeof value !== "string" ||
    (nonempty && value.trim().length === 0) ||
    Buffer.byteLength(value, "utf8") > maxBytes
  ) {
    throw new Error(`${name} is invalid`);
  }
  return value;
}

function optionalText(
  value: unknown,
  name: string,
  maxBytes: number,
): string | null {
  if (value === undefined || value === null || value === "") return null;
  return boundedText(value, name, maxBytes, false);
}

function optionalUrl(value: unknown): string | null {
  const text = optionalText(value, "avatar_url", 2_048);
  if (!text) return null;
  const url = new URL(text);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password
  ) {
    throw new Error("avatar_url is invalid");
  }
  return url.toString();
}

function textArray(
  value: unknown,
  name: string,
  maxItems: number,
  maxBytes: number,
): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > maxItems) {
    throw new Error(`${name} is invalid`);
  }
  return value.map((item) => boundedText(item, name, maxBytes, true));
}

function pubkeys(value: unknown): string[] {
  return textArray(value, "respond_to_allowlist", 500, 64).map((entry) => {
    if (!PUBKEY.test(entry))
      throw new Error("allowlist contains an invalid pubkey");
    return entry;
  });
}

function optionalInteger(
  value: unknown,
  name: string,
  min: number,
  max: number,
): number | null {
  if (value === undefined || value === null) return null;
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < min ||
    value > max
  ) {
    throw new Error(`${name} is invalid`);
  }
  return value;
}

function enumText<T extends string>(
  value: unknown,
  name: string,
  allowed: readonly T[],
): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    throw new Error(`${name} is invalid`);
  }
  return value as T;
}

function isEvent(value: unknown): value is NostrEvent {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.pubkey === "string" &&
    typeof value.created_at === "number" &&
    typeof value.kind === "number" &&
    Array.isArray(value.tags) &&
    typeof value.content === "string" &&
    typeof value.sig === "string"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
