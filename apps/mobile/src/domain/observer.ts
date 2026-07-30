import {
  decryptObserverPayload,
  KIND_AGENT_OBSERVER_FRAME,
  type NostrEvent,
} from "@buzz/core";

import { firstTag, validPubkey } from "./models";

export type ObserverFrame = {
  readonly seq: number;
  readonly timestamp: string;
  readonly kind: string;
  readonly agentIndex?: number;
  readonly channelId?: string;
  readonly sessionId?: string;
  readonly turnId?: string;
  readonly payload: unknown;
};

export type TranscriptItem =
  | {
      readonly id: string;
      readonly type: "message";
      readonly role: "user" | "assistant";
      readonly title: string;
      readonly text: string;
      readonly timestamp: string;
    }
  | {
      readonly id: string;
      readonly type: "thought" | "lifecycle";
      readonly title: string;
      readonly text: string;
      readonly timestamp: string;
    }
  | {
      readonly id: string;
      readonly type: "tool";
      readonly title: string;
      readonly toolName: string;
      readonly status: "executing" | "completed" | "failed" | "pending";
      readonly args: Readonly<Record<string, unknown>>;
      readonly result: string;
      readonly timestamp: string;
    };

export function decodeObserverFrame(
  event: NostrEvent,
  ownerPubkey: string,
  secretKey: Uint8Array,
): ObserverFrame | undefined {
  if (
    event.kind !== KIND_AGENT_OBSERVER_FRAME ||
    firstTag(event, "frame") !== "telemetry" ||
    firstTag(event, "p") !== ownerPubkey
  ) {
    return undefined;
  }
  const agent = validPubkey(firstTag(event, "agent"));
  if (!agent || agent !== event.pubkey) return undefined;
  let value: unknown;
  try {
    value = decryptObserverPayload(secretKey, event);
  } catch {
    return undefined;
  }
  return parseObserverFrame(value);
}

export function parseObserverFrame(value: unknown): ObserverFrame | undefined {
  if (!isRecord(value)) return undefined;
  const seq = safeInteger(value.seq);
  const timestamp = boundedString(value.timestamp, 128);
  const kind = boundedString(value.kind, 128);
  if (seq === undefined || !timestamp || !kind) return undefined;
  const parsedTimestamp = Date.parse(timestamp);
  if (!Number.isFinite(parsedTimestamp)) return undefined;
  const agentIndex = safeInteger(value.agentIndex);
  const channelId = boundedString(value.channelId, 256);
  const sessionId = boundedString(value.sessionId, 256);
  const turnId = boundedString(value.turnId, 256);
  return {
    kind,
    payload: value.payload,
    seq,
    timestamp,
    ...(agentIndex === undefined ? {} : { agentIndex }),
    ...(channelId ? { channelId } : {}),
    ...(sessionId ? { sessionId } : {}),
    ...(turnId ? { turnId } : {}),
  };
}

export function buildObserverTranscript(
  frames: readonly ObserverFrame[],
): readonly TranscriptItem[] {
  const items: TranscriptItem[] = [];
  const byId = new Map<string, number>();
  const sorted = [...frames].sort(
    (left, right) =>
      Date.parse(left.timestamp) - Date.parse(right.timestamp) ||
      left.seq - right.seq,
  );

  const upsert = (item: TranscriptItem, append = false) => {
    const index = byId.get(item.id);
    if (index === undefined) {
      byId.set(item.id, items.length);
      items.push(item);
      return;
    }
    const current = items[index];
    if (
      append &&
      current &&
      "text" in current &&
      "text" in item &&
      current.type === item.type
    ) {
      items[index] = { ...current, text: `${current.text}${item.text}` };
    } else {
      items[index] = item;
    }
  };

  for (const frame of sorted) {
    const payload = isRecord(frame.payload) ? frame.payload : {};
    if (frame.kind === "turn_started") {
      upsert({
        id: `turn:${frame.turnId ?? frame.seq}`,
        text: describeTurn(payload),
        timestamp: frame.timestamp,
        title: "Turn started",
        type: "lifecycle",
      });
      continue;
    }
    if (frame.kind === "session_resolved") {
      upsert({
        id: `session:${frame.turnId ?? frame.seq}`,
        text: describeSession(payload),
        timestamp: frame.timestamp,
        title: "Session ready",
        type: "lifecycle",
      });
      continue;
    }
    if (frame.kind === "acp_parse_error") {
      upsert({
        id: `parse-error:${frame.seq}`,
        text: extractText(frame.payload),
        timestamp: frame.timestamp,
        title: "Wire parse error",
        type: "lifecycle",
      });
      continue;
    }
    const method = boundedString(payload.method, 128);
    if (frame.kind === "acp_write" && method === "session/prompt") {
      const prompt = isRecord(payload.params)
        ? extractText(payload.params.prompt)
        : "";
      if (prompt) {
        upsert({
          id: `prompt:${frame.turnId ?? frame.seq}`,
          role: "user",
          text: prompt,
          timestamp: frame.timestamp,
          title: "Prompt",
          type: "message",
        });
      }
      continue;
    }
    if (frame.kind !== "acp_read" || method !== "session/update") continue;
    const params = isRecord(payload.params) ? payload.params : {};
    const update = isRecord(params.update) ? params.update : {};
    const updateType = boundedString(update.sessionUpdate, 128);
    const turnKey = frame.turnId ?? frame.sessionId ?? String(frame.seq);
    const messageId = boundedString(update.messageId, 256) ?? turnKey;
    const content = extractText(update.content);
    if (updateType === "agent_message_chunk") {
      upsert(
        {
          id: `assistant:${messageId}`,
          role: "assistant",
          text: content,
          timestamp: frame.timestamp,
          title: "Assistant",
          type: "message",
        },
        true,
      );
    } else if (updateType === "user_message_chunk") {
      upsert(
        {
          id: `user:${messageId}`,
          role: "user",
          text: content,
          timestamp: frame.timestamp,
          title: "User",
          type: "message",
        },
        true,
      );
    } else if (updateType === "agent_thought_chunk" || updateType === "plan") {
      upsert(
        {
          id: `${updateType}:${messageId}`,
          text: content || safeJson(update),
          timestamp: frame.timestamp,
          title: updateType === "plan" ? "Plan" : "Thinking",
          type: "thought",
        },
        true,
      );
    } else if (
      updateType === "tool_call" ||
      updateType === "tool_call_update"
    ) {
      const toolId =
        boundedString(update.toolCallId, 256) ?? `tool:${frame.seq}`;
      const toolName =
        boundedString(update.toolName, 256) ??
        boundedString(update.name, 256) ??
        boundedString(update.title, 256) ??
        "tool";
      upsert({
        args: recordValue(update.args ?? update.arguments ?? update.input),
        id: `tool:${toolId}`,
        result: extractText(update.rawOutput ?? update.content),
        status: normalizeToolStatus(update.status),
        timestamp: frame.timestamp,
        title: boundedString(update.title, 256) ?? titleCase(toolName),
        toolName,
        type: "tool",
      });
    }
  }
  return items;
}

function extractText(value: unknown): string {
  if (typeof value === "string") return value.slice(0, 65_535);
  if (Array.isArray(value)) {
    return value.map(extractText).filter(Boolean).join("\n").slice(0, 65_535);
  }
  if (!isRecord(value)) return "";
  if (typeof value.text === "string") return value.text.slice(0, 65_535);
  if (typeof value.content === "string") {
    return value.content.slice(0, 65_535);
  }
  const nested = extractText(value.content);
  return (nested || extractText(value.rawOutput)).slice(0, 65_535);
}

function describeTurn(payload: Record<string, unknown>): string {
  const ids = Array.isArray(payload.triggeringEventIds)
    ? payload.triggeringEventIds.filter(
        (value): value is string => typeof value === "string",
      )
    : [];
  return ids.length
    ? `Triggered by ${ids.map(short).join(", ")}.`
    : "Heartbeat or internal turn.";
}

function describeSession(payload: Record<string, unknown>): string {
  const sessionId = boundedString(payload.sessionId, 256);
  return sessionId
    ? `${payload.isNewSession === true ? "Created" : "Using"} session ${short(sessionId)}.`
    : "Using existing ACP session.";
}

function normalizeToolStatus(
  value: unknown,
): "executing" | "completed" | "failed" | "pending" {
  const status = typeof value === "string" ? value.toLowerCase() : "";
  if (/complete|success|done/.test(status)) return "completed";
  if (/fail|error/.test(status)) return "failed";
  if (status.includes("pending")) return "pending";
  return "executing";
}

function titleCase(value: string): string {
  return value
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (character) => character.toUpperCase());
}

function short(value: string): string {
  return value.length > 14 ? `${value.slice(0, 8)}…${value.slice(-4)}` : value;
}

function recordValue(value: unknown): Readonly<Record<string, unknown>> {
  return isRecord(value) ? value : {};
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value).slice(0, 65_535);
  } catch {
    return String(value).slice(0, 65_535);
  }
}

function boundedString(value: unknown, maximum: number): string | undefined {
  return typeof value === "string" &&
    value.length > 0 &&
    value.length <= maximum
    ? value
    : undefined;
}

function safeInteger(value: unknown): number | undefined {
  return Number.isSafeInteger(value) && Number(value) >= 0
    ? Number(value)
    : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
