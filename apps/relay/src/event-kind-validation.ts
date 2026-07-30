import {
  effectiveEventAuthor,
  KIND_AGENT_ENGRAM,
  KIND_AGENT_PROFILE,
  KIND_AGENT_TURN_METRIC,
  KIND_EVENT_REMINDER,
  KIND_FORUM_COMMENT,
  KIND_FORUM_POST,
  KIND_FORUM_VOTE,
  KIND_PERSONA,
  KIND_PROFILE,
  KIND_STREAM_MESSAGE_DIFF,
  KIND_STREAM_MESSAGE_EDIT,
  type NostrEvent,
} from "@buzz/core";
import { eventChannelId, type EventStore } from "@buzz/db";
import { RemoteProtocolError } from "@buzz/remote-agent-protocol";

const LOWER_HEX_KEY = /^[0-9a-f]{64}$/;
const PERSONA_SLUG = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const MAX_SAFE_TIMESTAMP = 9_007_199_254_740_991n;

/** Enforce kind-specific public invariants before a signed event can mutate state. */
export async function validateEventKind(
  eventStore: EventStore,
  community: string,
  event: NostrEvent,
  now: number,
  maxReminderDelta = reminderHorizon(),
  relaySelfPubkey?: string,
): Promise<void> {
  switch (event.kind) {
    case KIND_PROFILE:
      validateProfile(event);
      return;
    case KIND_AGENT_PROFILE:
      validateAgentProfile(event);
      return;
    case KIND_STREAM_MESSAGE_EDIT:
      await validateEdit(eventStore, community, event, relaySelfPubkey);
      return;
    case KIND_FORUM_VOTE:
      await validateForumVote(eventStore, community, event);
      return;
    case KIND_STREAM_MESSAGE_DIFF:
      validateDiff(event);
      return;
    case KIND_AGENT_ENGRAM:
      validateEngram(event);
      return;
    case KIND_AGENT_TURN_METRIC:
      await validateAgentTurnMetric(eventStore, community, event);
      return;
    case KIND_EVENT_REMINDER:
      validateReminder(event, now, maxReminderDelta);
      return;
    case KIND_PERSONA:
      validatePersona(event);
  }
}

function validateProfile(event: NostrEvent): void {
  let value: unknown;
  try {
    value = JSON.parse(event.content) as unknown;
  } catch {
    invalid("kind:0 profile content must be valid JSON");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    invalid("kind:0 profile content must be a JSON object");
  }
}

function validateAgentProfile(event: NostrEvent): void {
  let value: unknown;
  try {
    value = JSON.parse(event.content) as unknown;
  } catch {
    invalid("kind:10100 agent profile content must be valid JSON");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    invalid("kind:10100 agent profile content must be a JSON object");
  }
  const policy = (value as { channel_add_policy?: unknown }).channel_add_policy;
  if (policy !== "anyone" && policy !== "owner_only" && policy !== "nobody") {
    invalid(
      "kind:10100 channel_add_policy must be anyone, owner_only, or nobody",
    );
  }
}

async function validateEdit(
  store: EventStore,
  community: string,
  event: NostrEvent,
  relaySelfPubkey: string | undefined,
): Promise<void> {
  const target = await requiredTarget(store, community, event, "edit");
  const channelId = eventChannelId(event);
  if (!channelId || target.channelId !== channelId) {
    invalid("edit target belongs to a different channel");
  }
  if (
    !(await store.canManageAuthor(
      community,
      event.pubkey,
      effectiveEventAuthor(target.event, relaySelfPubkey),
    ))
  ) {
    restricted("must be the event author or its agent owner to edit");
  }
}

async function validateForumVote(
  store: EventStore,
  community: string,
  event: NostrEvent,
): Promise<void> {
  const target = await requiredTarget(store, community, event, "vote");
  if (
    target.event.kind !== KIND_FORUM_POST &&
    target.event.kind !== KIND_FORUM_COMMENT
  ) {
    invalid("vote target must be a forum post or comment");
  }
  const channelId = eventChannelId(event);
  if (!channelId || target.channelId !== channelId) {
    invalid("vote target belongs to a different channel");
  }
}

async function requiredTarget(
  store: EventStore,
  community: string,
  event: NostrEvent,
  label: string,
) {
  const targetId = event.tags.find(
    (tag) =>
      tag[0] === "e" && tag[1] !== undefined && /^[0-9a-f]{64}$/i.test(tag[1]),
  )?.[1];
  if (!targetId) invalid(`missing e tag for ${label} target`);
  const target = await store.getById(community, targetId.toLowerCase());
  if (!target) invalid(`${label} target event not found`);
  return target;
}

function validateDiff(event: NostrEvent): void {
  if (Buffer.byteLength(event.content, "utf8") > 61_440) {
    invalid("diff content exceeds 60KB limit");
  }
  let hasRepo = false;
  let hasCommit = false;
  for (const tag of event.tags) {
    if (tag.length < 2) continue;
    const value = tag[1] as string;
    switch (tag[0]) {
      case "repo": {
        let protocol: string | undefined;
        try {
          protocol = new URL(value).protocol;
        } catch {
          // Rejected below.
        }
        if (protocol !== "http:" && protocol !== "https:") {
          invalid("repo URL must be http or https");
        }
        hasRepo = true;
        break;
      }
      case "commit":
        if (!/^[0-9a-f]{7,}$/i.test(value)) {
          invalid("commit SHA must be at least 7 hex characters");
        }
        hasCommit = true;
        break;
      case "parent-commit":
        if (!/^[0-9a-f]{7,}$/i.test(value)) {
          invalid("parent-commit SHA must be at least 7 hex characters");
        }
        break;
      case "branch":
        if (tag.length < 3 || value.length === 0 || tag[2]?.length === 0) {
          invalid("branch tag requires both source and target");
        }
        break;
      case "pr":
        if (!/^[1-9][0-9]*$/.test(value) || Number(value) > 4_294_967_295) {
          invalid("pr number must be a positive 32-bit integer");
        }
    }
  }
  if (!hasRepo) invalid("diff event requires a repo tag");
  if (!hasCommit) invalid("diff event requires a commit tag");
}

function validateEngram(event: NostrEvent): void {
  const d = exactTagValues(event, "d");
  const p = exactTagValues(event, "p");
  if (d.length !== 1) {
    invalid(`agent-engram event must have exactly one d tag (got ${d.length})`);
  }
  if (p.length !== 1) {
    invalid(`agent-engram event must have exactly one p tag (got ${p.length})`);
  }
  if (!LOWER_HEX_KEY.test(d[0] as string)) {
    invalid("agent-engram d tag must be 64 lowercase hex characters");
  }
  if (!LOWER_HEX_KEY.test(p[0] as string)) {
    invalid("agent-engram p tag must be a lowercase pubkey");
  }
  validateNip44V2(event.content, "agent-engram");
}

async function validateAgentTurnMetric(
  store: EventStore,
  community: string,
  event: NostrEvent,
): Promise<void> {
  if (event.tags.some((tag) => tag[0] === "h")) {
    invalid("agent-turn-metric must not contain an h tag");
  }
  const owners = exactTagValues(event, "p");
  const agents = exactTagValues(event, "agent");
  if (owners.length !== 1 || !LOWER_HEX_KEY.test(owners[0] as string)) {
    invalid("agent-turn-metric requires exactly one lowercase p pubkey");
  }
  if (
    agents.length !== 1 ||
    !LOWER_HEX_KEY.test(agents[0] as string) ||
    agents[0] !== event.pubkey
  ) {
    invalid("agent-turn-metric agent tag must equal the event pubkey");
  }
  validateNip44V2(event.content, "agent-turn-metric");
  if (
    !(await store.canManageAuthor(community, owners[0] as string, event.pubkey))
  ) {
    restricted("agent-turn-metric p tag must be the registered owner");
  }
}

function validatePersona(event: NostrEvent): void {
  const d = exactTagValues(event, "d");
  if (d.length !== 1 || !PERSONA_SLUG.test(d[0] as string)) {
    invalid(
      "persona event requires one d tag matching [a-z0-9][a-z0-9_-]{0,63}",
    );
  }
  const shared = event.tags.filter((tag) => tag[0] === "shared");
  if (
    shared.length > 1 ||
    shared.some((tag) => tag.length !== 2 || tag[1] !== "true")
  ) {
    invalid('persona shared tag must be exactly ["shared","true"]');
  }
}

function validateReminder(
  event: NostrEvent,
  now: number,
  maxDelta: number,
): void {
  const d = exactTagValues(event, "d");
  if (d.length !== 1 || d[0]?.length === 0) {
    invalid("event reminder requires exactly one non-empty d tag");
  }
  const notBeforeTags = exactTagValues(event, "not_before");
  if (notBeforeTags.length > 1) invalid("malformed not_before");
  if (notBeforeTags.length === 0) return;
  const raw = notBeforeTags[0] as string;
  if (!/^(?:0|[1-9][0-9]*)$/.test(raw) || BigInt(raw) > MAX_SAFE_TIMESTAMP) {
    invalid("malformed not_before");
  }
  const notBefore = Number(raw);
  if (notBefore > now + maxDelta) invalid("not_before too far in future");
  const expiration = exactTagValues(event, "expiration").at(-1);
  if (
    expiration &&
    /^(?:0|[1-9][0-9]*)$/.test(expiration) &&
    BigInt(expiration) <= BigInt(raw)
  ) {
    invalid("expiration before not_before");
  }
}

function exactTagValues(event: NostrEvent, name: string): string[] {
  return event.tags
    .filter((tag) => tag.length >= 2 && tag[0] === name)
    .map((tag) => tag[1] as string);
}

function validateNip44V2(content: string, label: string): void {
  if (
    content.length === 0 ||
    content.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]*={0,2}$/.test(content) ||
    (content.indexOf("=") >= 0 && content.indexOf("=") < content.length - 2)
  ) {
    invalid(`${label} content is not valid base64`);
  }
  const decoded = Buffer.from(content, "base64");
  if (decoded.length < 99)
    invalid(`${label} content is too short for NIP-44 v2`);
  if (decoded[0] !== 0x02) {
    invalid(`${label} content is not NIP-44 v2`);
  }
}

function reminderHorizon(): number {
  const configured = Number(process.env["SPROUT_MAX_NOT_BEFORE_DELTA"]);
  return Number.isSafeInteger(configured) && configured >= 0
    ? configured
    : 31_536_000;
}

function invalid(message: string): never {
  throw new RemoteProtocolError("CONFIG_INVALID", message);
}

function restricted(message: string): never {
  throw new RemoteProtocolError("CAPABILITY_DENIED", message);
}
